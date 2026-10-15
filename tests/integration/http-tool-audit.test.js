/** Failure modes: HTTP 200 hides a denial; result text impersonates a denial;
 * concurrent calls mix principals/outcomes; failed sinks alter authorization.
 * Exercise real SDK transports and built-in dispatch with synthetic identities.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";
import { createHttpAuditWriter } from "../../src/lib/http-audit.js";
import { callTool } from "../../src/lib/dispatch.js";
import { allDefinitions } from "../../src/tools/index.js";

const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); vi.unstubAllEnvs(); });

async function start(sink) {
  vi.stubEnv("DRUPAL_BASE_URL", "https://drupal.example");
  const writer = createHttpAuditWriter({ sink });
  const buildServer = createConnectorServerFactory({
    serverInfo: { name: "audit-proof", version: "1.0.0" },
    tools: {
      definitions: allDefinitions,
      call: async (name, args) => {
        if (name === "drupal_get_node") {
          await new Promise((resolve) => setImmediate(resolve));
          return { isError: true, content: [{ type: "text", text: "Access denied: untrusted upstream text" }] };
        }
        return callTool(name, args, { sites: [{ _name: "synthetic", security: { preset: "development" } }], grants: { pilot: ["synthetic"] } });
      },
    },
    resources: { definitions: [], read: async () => ({}) },
    prompts: { definitions: [], get: () => [] },
  });
  const modern = createMcpHandler(buildServer, { legacy: "reject" });
  const legacy = createLegacySessionHandler({ buildServer, mode: "serve" });
  const handler = createMcpRequestHandler({
    authenticate: async (req) => ["Bearer synthetic-secret", "Bearer second-synthetic-secret"].includes(req.headers.authorization)
      ? { ok: true, identity: { sub: req.headers.authorization === "Bearer synthetic-secret" ? "verified-user" : "second-user", clientId: "pilot", tenant: "verified-tenant", scopes: ["mcp_read"] } }
      : { ok: false, status: 401 },
    modernHandler: toNodeHandler(modern), legacyHandler: legacy, auditWriter: writer,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  closers.push(async () => {
    await modern.close();
    await legacy.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, rows: writer.rows };
}

async function post(url, body, headers = {}) {
  if ((headers["mcp-protocol-version"] ?? "2026-07-28") === "2026-07-28") {
    body = { ...body, params: { ...body.params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "audit-proof", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } };
    headers = { "mcp-method": body.method, ...(body.params?.name ? { "mcp-name": body.params.name } : {}), ...headers };
  }
  const response = await fetch(url, { method: "POST", headers: {
    authorization: "Bearer synthetic-secret", "content-type": "application/json",
    accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", ...headers,
  }, body: JSON.stringify(body) });
  const text = await response.text();
  const payload = text.startsWith("event:") ? JSON.parse(text.split("data: ")[1].split("\n")[0]) : JSON.parse(text || "{}");
  return { response, payload };
}

describe("authoritative tool outcomes on HTTP audit rows", () => {
  it.each(["2026-07-28", "2025-11-25"])("records denials and tool results on %s without changing HTTP semantics", async (protocol) => {
    const { url, rows } = await start(() => {});
    const headers = { "mcp-protocol-version": protocol };
    if (protocol === "2025-11-25") {
      const init = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: protocol, capabilities: {}, clientInfo: { name: "audit-proof", version: "1.0.0" },
      } }, headers);
      headers["mcp-session-id"] = init.response.headers.get("mcp-session-id");
      expect(headers["mcp-session-id"]).toBeTruthy();
      await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
    }
    const cases = [
      ["drupal_create_node", "denied"], ["drupal_config_get", "denied"],
      ["drupal_config_set", "denied"], ["drupal_list_sites", "success"],
      ["drupal_get_node", "error"],
    ];
    const startRows = rows.length;
    await Promise.all(cases.map(async ([name, outcome], index) => {
      const id = `request-${index}`;
      const alternate = protocol === "2026-07-28" && index % 2 === 1;
      const authorization = alternate ? "Bearer second-synthetic-secret" : "Bearer synthetic-secret";
      const { response, payload } = await post(url, { jsonrpc: "2.0", id: index + 2,
        method: "tools/call", params: { name, arguments: { tenant: "forged-tenant", marker: "private-argument" } },
      }, { ...headers, authorization, "x-request-id": id, cookie: "private-cookie" });
      expect(response.status, JSON.stringify(payload)).toBe(200);
      expect(Boolean(payload.result?.isError), JSON.stringify(payload)).toBe(outcome !== "success");
      const matching = rows.filter((row) => row.requestId === id);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({ status: 200, code: "ok", toolOutcome: outcome,
        principal: alternate ? "second-user" : "verified-user", tenant: "verified-tenant" });
    }));
    expect(rows.length - startRows).toBe(cases.length);
    const denial = await post(url, { jsonrpc: "2.0", id: 90, method: "tools/list" }, { ...headers, authorization: "" });
    expect(denial.response.status).toBe(401);
    expect(rows.at(-1).toolOutcome).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/synthetic-secret|private-cookie|private-argument|forged-tenant|Access denied|untrusted upstream/);
  });

  it("keeps a policy denial when the audit sink throws", async () => {
    const { url, rows } = await start(() => { throw new Error("sink unavailable"); });
    const { response, payload } = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "drupal_config_set", arguments: {} } });
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.result.isError).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolOutcome).toBe("denied");
  });
});
