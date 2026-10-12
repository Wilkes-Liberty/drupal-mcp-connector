/**
 * T8 (DEV-858 / R-A1): every hosted HTTP request leaves exactly one audit row,
 * refused ones included.
 *
 * Covers a missing-token 401, a 429, a bad-Origin 403, and a legitimate
 * allow, each with the closed denial code. A sentinel bearer token is fed
 * and must appear in no row.
 *
 * Mutant (dependency swap): `auditWriter: null` so the finish hook writes
 * nothing. The row assertions then fail, proving the check can go red.
 */

import { defineCase } from "../harness/case.js";
import {
  expectAllowed,
  expectAuditRow,
  expectEqual,
  expectNoSecretInAudit,
  expectRefused,
} from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

const EVIL_ORIGIN = "https://evil.example";
const SENTINEL = "SENTINEL_TOKEN_DEV858_DO_NOT_LOG_9f3c2a1b";

function t8ClientKey(req) {
  const key = req.headers["x-rate-key"];
  if (typeof key === "string" && key) return key;
  return `t8-${Math.random()}`;
}

function t8CheckOrigin(req) {
  return req.headers.origin !== EVIL_ORIGIN;
}

defineCase({
  id: "T8",
  title: "hosted HTTP requests each leave one audit row, refusals included",
  harness: {
    rateLimit: 1,
    clientKey: t8ClientKey,
    checkOrigin: t8CheckOrigin,
  },
  async run(h) {
    const missing = await h.send(modernPost("tools/list"), { requestId: "t8-missing-token" });
    expectRefused(h, "missing token", missing);

    await h.send(modernPost("ping"), {
      requestId: "t8-flood-1",
      headers: { "x-rate-key": "t8-flood" },
    });
    const limited = await h.send(modernPost("ping"), {
      requestId: "t8-rate-limited",
      headers: { "x-rate-key": "t8-flood" },
    });
    expectEqual(h, "rate-limited status", limited.status, 429);

    const origin = await h.send(modernPost("tools/list"), {
      requestId: "t8-bad-origin",
      headers: { origin: EVIL_ORIGIN },
    });
    expectEqual(h, "bad-Origin status", origin.status, 403);

    const token = await h.tokenFor("A");
    const allowed = await h.send(modernPost("server/discover"), {
      token,
      requestId: "t8-ok",
    });
    expectAllowed(h, "legitimate request", allowed);

    await h.send(modernPost("tools/list"), {
      token: SENTINEL,
      requestId: "t8-sentinel",
      headers: { cookie: `auth=${SENTINEL}` },
    });

    expectEqual(h, "one row per request", h.auditRows.length, 6);
    expectAuditRow(h, "missing-token 401", "t8-missing-token", { code: "unauthenticated", status: 401 });
    expectAuditRow(h, "429", "t8-rate-limited", { code: "rate_limited", status: 429 });
    expectAuditRow(h, "bad-Origin", "t8-bad-origin", { code: "bad_origin", status: 403 });
    expectAuditRow(h, "legitimate", "t8-ok", { code: "ok", status: 200 });
    expectAuditRow(h, "sentinel 401", "t8-sentinel", { code: "invalid_token", status: 401 });
    expectNoSecretInAudit(h, "sentinel token", SENTINEL);

    const okRow = h.auditRows.find((row) => row.requestId === "t8-ok");
    expectEqual(h, "principal recorded when known", typeof okRow?.principal, "string");
    const missingRow = h.auditRows.find((row) => row.requestId === "t8-missing-token");
    expectEqual(h, "no principal on missing-token row", missingRow?.principal, undefined);
  },
});
