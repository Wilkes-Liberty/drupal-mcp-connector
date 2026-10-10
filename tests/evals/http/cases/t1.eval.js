/**
 * T1 (DEV-866 increment 1; vault note "Hosted MCP connector — HTTP transport
 * evals, guardrails, and CI harness (2026-10-10)", section 1).
 *
 * POST /mcp with no Authorization (initialize, tools/list, tools/call,
 * resources/list, prompts/list, ping, a notification, an empty body), and GET
 * and DELETE /mcp with and without Mcp-Session-Id, against the hosted
 * (resource-server) configuration.
 *
 * Expected: 401; error="invalid_token", description "Bearer token required";
 * body "Unauthorized"; Ch = 0, Ct = 0, Cu = 0; no Mcp-Session-Id issued; the
 * request body is not read.
 *
 * Not asserted here: "one refusal record". No refusal record exists in the
 * connector today (requirement R-A1, increment 5).
 *
 * Mutant (dependency swap): the handler defaults `authenticate: null,
 * checkAuth: () => true`, so each request dispatches under null identity.
 */

import { expect } from "vitest";
import { defineCase } from "../harness/case.js";
import { expectEqual, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { emptyPost, legacyInitialize, legacyPost, modernPost, sessionRequest } from "../harness/requests.js";

const UNAUTHENTICATED = [
  ["POST initialize", legacyInitialize()],
  ["POST server/discover", modernPost("server/discover")],
  ["POST tools/list", modernPost("tools/list")],
  ["POST tools/call", modernPost("tools/call", { name: "drupal_list_nodes", arguments: {} }, { name: "drupal_list_nodes" })],
  ["POST resources/list", modernPost("resources/list")],
  ["POST prompts/list", modernPost("prompts/list")],
  ["POST ping", legacyPost("ping")],
  ["POST notification", legacyPost("notifications/initialized", {}, { notification: true })],
  ["POST empty body", emptyPost()],
  ["GET without session", sessionRequest("GET")],
  ["GET with session", sessionRequest("GET", { sessionId: "eval-session-not-issued" })],
  ["DELETE without session", sessionRequest("DELETE")],
  ["DELETE with session", sessionRequest("DELETE", { sessionId: "eval-session-not-issued" })],
];

defineCase({
  id: "T1",
  title: "missing identity is refused with 401 before dispatch",
  async run(h) {
    for (const [label, request] of UNAUTHENTICATED) {
      const res = await h.send(request);
      expectRefused(h, label, res);
      expectNoDispatch(h, label);
    }
    await h.waitServerSide(UNAUTHENTICATED.length);
    // The body is never read on a refusal (one server-side record per request).
    expectEqual(h, "body not read on any refusal", h.tap.serverSide.map((entry) => entry.bodyRead), UNAUTHENTICATED.map(() => false));
    expect(h.tap.serverSide).toHaveLength(UNAUTHENTICATED.length);
  },
});
