/**
 * T8 (DEV-858 / R-A1): every hosted HTTP request leaves exactly one audit row,
 * refused ones included. Increment 2 covers `/mcp`, `/usage`, and `/assessor`
 * on the same writer (no double-writes), a throwing sink that still refuses,
 * and a writer-disabled mutant.
 */

import { defineCase } from "../harness/case.js";
import {
  expectAllowed,
  expectAuditRow,
  expectEqual,
  expectNoSecretInAudit,
  expectRefused,
} from "../harness/assert.js";
import { assessorGet, modernPost, usageGet } from "../harness/requests.js";

const EVIL_ORIGIN = "https://evil.example";
const SENTINEL = "SENTINEL_TOKEN_DEV858_DO_NOT_LOG_9f3c2a1b";

function t8ClientKey(req) {
  const key = req.headers["x-rate-key"];
  if (typeof key === "string" && key) return key;
  return `t8-${Math.random()}`;
}

defineCase({
  id: "T8",
  title: "hosted HTTP requests each leave one audit row, refusals included",
  harness: {
    rateLimit: 1,
    clientKey: t8ClientKey,
    edge: true,
  },
  mutants: [
    { id: "T8", expectedLabel: "missing-token 401: exactly one row" },
  ],
  async run(h) {
    const missing = await h.send(modernPost("tools/list"), { requestId: "t8-missing-token" });
    expectRefused(h, "missing token", missing);
    expectAuditRow(h, "missing-token 401", "t8-missing-token", { code: "unauthenticated", status: 401 });

    await h.send(modernPost("ping"), {
      requestId: "t8-flood-1",
      headers: { "x-rate-key": "t8-flood" },
    });
    const limited = await h.send(modernPost("ping"), {
      requestId: "t8-rate-limited",
      headers: { "x-rate-key": "t8-flood" },
    });
    expectEqual(h, "rate-limited status", limited.status, 429);

    const token = await h.tokenFor("A");
    const origin = await h.send(modernPost("tools/list"), {
      token,
      requestId: "t8-bad-origin",
      headers: { origin: EVIL_ORIGIN },
    });
    expectEqual(h, "bad-Origin status", origin.status, 403);

    const allowed = await h.send(modernPost("server/discover"), {
      token,
      requestId: "t8-ok",
    });
    expectAllowed(h, "legitimate request", allowed);

    const failingSink = await h.send(modernPost("tools/list"), { requestId: "t8-failing-sink" });
    expectRefused(h, "failing-sink request still refused", failingSink);

    await h.send(modernPost("tools/list"), {
      token: SENTINEL,
      requestId: "t8-sentinel",
      headers: { cookie: `auth=${SENTINEL}` },
    });

    const edgeMissingUsage = await h.send(usageGet(), {
      requestId: "t8-usage-missing",
      base: h.edgeUrl,
    });
    expectRefused(h, "edge /usage missing token", edgeMissingUsage);
    const edgeMissingAssessor = await h.send(assessorGet(), {
      requestId: "t8-assessor-missing",
      base: h.edgeUrl,
    });
    expectRefused(h, "edge /assessor missing token", edgeMissingAssessor);
    const edgeOkUsage = await h.send(usageGet(), {
      token,
      requestId: "t8-usage-ok",
      base: h.edgeUrl,
    });
    expectEqual(h, "edge /usage authenticated status", edgeOkUsage.status, 200);
    const edgeOkAssessor = await h.send(assessorGet(), {
      token,
      requestId: "t8-assessor-ok",
      base: h.edgeUrl,
    });
    expectEqual(h, "edge /assessor authenticated status", edgeOkAssessor.status, 200);

    expectEqual(h, "one row per request (no double-writes)", h.auditRows.length, 11);
    expectAuditRow(h, "missing-token 401", "t8-missing-token", { code: "unauthenticated", status: 401 });
    expectAuditRow(h, "429", "t8-rate-limited", { code: "rate_limited", status: 429 });
    expectAuditRow(h, "bad-Origin", "t8-bad-origin", { code: "bad_origin", status: 403 });
    expectAuditRow(h, "legitimate", "t8-ok", { code: "ok", status: 200 });
    expectAuditRow(h, "failing-sink 401", "t8-failing-sink", { code: "unauthenticated", status: 401 });
    expectAuditRow(h, "sentinel 401", "t8-sentinel", { code: "invalid_token", status: 401 });
    expectAuditRow(h, "usage missing", "t8-usage-missing", { code: "unauthenticated", status: 401, route: "/usage" });
    expectAuditRow(h, "assessor missing", "t8-assessor-missing", { code: "unauthenticated", status: 401, route: "/assessor" });
    expectAuditRow(h, "usage ok", "t8-usage-ok", { code: "ok", status: 200, route: "/usage" });
    expectAuditRow(h, "assessor ok", "t8-assessor-ok", { code: "ok", status: 200, route: "/assessor" });
    expectNoSecretInAudit(h, "sentinel token", SENTINEL);

    const okRow = h.auditRows.find((row) => row.requestId === "t8-ok");
    expectEqual(h, "principal recorded when known", typeof okRow?.principal, "string");
    const missingRow = h.auditRows.find((row) => row.requestId === "t8-missing-token");
    expectEqual(h, "no principal on missing-token row", missingRow?.principal, undefined);
  },
});
