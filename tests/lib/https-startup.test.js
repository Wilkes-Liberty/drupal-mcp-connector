import { describe, expect, it } from "vitest";
import { NON_LOOPBACK_UNAUTHENTICATED_REASON } from "../../src/lib/http-auth.js";
import { createStartupRateLimiter, startHttpsTransport } from "../../src/lib/https-startup.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

const dummyServer = createConnectorServerFactory({
  serverInfo: { name: "https-startup-test", version: "0" },
  tools: { definitions: [], list: async () => [], call: async () => ({}) },
  resources: { definitions: [], read: async () => ({}) },
  prompts: { definitions: [], get: () => [] },
});

describe("startHttpsTransport", () => {
  it("is fatal for a non-loopback bind with MCP_ALLOW_UNAUTHENTICATED and does not listen", async () => {
    const exits = [];
    const result = await startHttpsTransport({
      bindHost: "0.0.0.0",
      port: 0,
      allowHttp: true,
      allowUnauth: true,
      sharedToken: "",
      inboundCfg: { issuer: "", audience: "" },
      buildServer: dummyServer,
      toolCount: 0,
      listenHost: "127.0.0.1",
      exit: (code, reason) => { exits.push({ code, reason }); },
      log: () => {},
    });
    expect(result.started).toBe(false);
    expect(result.inboundMode).toEqual({
      mode: "fatal",
      reason: NON_LOOPBACK_UNAUTHENTICATED_REASON,
    });
    expect(exits).toEqual([{ code: 1, reason: NON_LOOPBACK_UNAUTHENTICATED_REASON }]);
  });
});

describe("createStartupRateLimiter", () => {
  it("defaults off on loopback without TLS", () => {
    expect(createStartupRateLimiter({ hasTls: false, loopbackBind: true, env: {} })).toBeNull();
  });
});
