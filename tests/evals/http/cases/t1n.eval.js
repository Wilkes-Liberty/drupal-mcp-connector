/**
 * T1n (DEV-845). Startup, not a request: a non-loopback bind with
 * MCP_ALLOW_UNAUTHENTICATED=1 and no resource server must be fatal.
 *
 * Increment 2 (c-4): drives `startHttpsTransport` (the same function
 * `src/index.js` calls) and, on the green run, also spawns `src/index.js`
 * with TLS so the real process exits before listen.
 *
 * Mutant: restore the pre-DEV-845 fail-open inbound-mode decision.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCase } from "../harness/case.js";
import { expectEqual, expectStartupFatal, expectStartupNotListening } from "../harness/assert.js";
import { failOpenInboundAuthMode } from "../harness/build.js";
import { httpAuth, httpsStartup, mcpServer } from "../harness/connector.js";

const INDEX = fileURLToPath(new URL("../../../../src/index.js", import.meta.url));

function spawnRealIndex() {
  const dir = mkdtempSync(join(tmpdir(), "eval-t1n-"));
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048",
    "-keyout", key, "-out", cert,
    "-days", "1", "-nodes",
    "-subj", "/CN=localhost",
  ], { encoding: "utf8" });
  if (openssl.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`openssl failed: ${openssl.stderr || openssl.stdout}`);
  }
  const child = spawnSync(process.execPath, [INDEX], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MCP_TRANSPORT: "https",
      MCP_BIND_HOST: "0.0.0.0",
      MCP_ALLOW_UNAUTHENTICATED: "1",
      TLS_CERT_PATH: cert,
      TLS_KEY_PATH: key,
      MCP_PORT: "0",
      DRUPAL_BASE_URL: "http://127.0.0.1:9",
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return child;
}

defineCase({
  id: "T1n",
  title: "non-loopback bind with MCP_ALLOW_UNAUTHENTICATED=1 is fatal at startup",
  needsHarness: false,
  mutants: [
    { id: "T1n", expectedLabel: "non-loopback + allow-unauthenticated: mode" },
  ],
  async run(h) {
    const dummyServer = mcpServer.createConnectorServerFactory({
      serverInfo: { name: "eval-t1n", version: "0" },
      tools: { definitions: [], list: async () => [], call: async () => ({}) },
      resources: { definitions: [], read: async () => ({}) },
      prompts: { definitions: [], get: () => [] },
    });
    const exits = [];
    const result = await httpsStartup.startHttpsTransport({
      bindHost: "0.0.0.0",
      port: 0,
      allowHttp: true,
      allowUnauth: true,
      sharedToken: "",
      inboundCfg: { issuer: "", audience: "" },
      listenHost: "127.0.0.1",
      buildServer: dummyServer,
      toolCount: 0,
      resolveInboundAuthModeFn: h.mutant ? failOpenInboundAuthMode : httpAuth.resolveInboundAuthMode,
      exit: (code, reason) => { exits.push({ code, reason }); },
      log: () => {},
    });
    try {
      expectStartupFatal(h, "non-loopback + allow-unauthenticated", result.inboundMode);
      expectStartupNotListening(h, "non-loopback + allow-unauthenticated", result);
      expectEqual(h, "startup called exit(1)", exits[0]?.code, 1);
    } finally {
      if (result.started) await result.close?.();
    }

    if (!h.mutant) {
      const child = spawnRealIndex();
      expectEqual(h, "index.js exit code", child.status, 1);
      expectEqual(
        h,
        "index.js names the DEV-845 reason",
        /non-loopback bind with MCP_ALLOW_UNAUTHENTICATED/.test(`${child.stderr}\n${child.stdout}`),
        true,
      );
    }
  },
});
