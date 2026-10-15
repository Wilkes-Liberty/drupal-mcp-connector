import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { NON_LOOPBACK_UNAUTHENTICATED_REASON } from "../../src/lib/http-auth.js";
import {
  createStartupRateLimiters,
  installHttpsShutdown,
  startHttpsTransport,
} from "../../src/lib/https-startup.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

const INDEX_PATH = fileURLToPath(new URL("../../src/index.js", import.meta.url));

const PRODUCTION_STARTUP_HOOKS = Object.freeze([
  "fetchFn",
  "auditWriter",
  "handlerOverrides",
  "wrapHandler",
  "wrapRequestHandler",
  "checkAuth",
  "authenticate",
  "allowLocalOperator",
  "resolveInboundAuthModeFn",
]);

const dummyServer = createConnectorServerFactory({
  serverInfo: { name: "https-startup-test", version: "0" },
  tools: { definitions: [], list: async () => [], call: async () => ({}) },
  resources: { definitions: [], read: async () => ({}) },
  prompts: { definitions: [], get: () => [] },
});

function indexSource() {
  return readFileSync(INDEX_PATH, "utf8");
}

/**
 * The `startHttpsTransport({...})` argument list in a source string.
 *
 * @param {string} source
 * @returns {string}
 */
function startHttpsTransportCall(source) {
  const marker = "await startHttpsTransport({";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("src/index.js does not call startHttpsTransport");
  let depth = 0;
  const from = start + "await startHttpsTransport".length;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed startHttpsTransport call");
}

/**
 * Eval-hook keys passed as properties on the production `startHttpsTransport` call.
 *
 * @param {string} source
 * @returns {string[]}
 */
function productionStartupHookKeys(source) {
  const call = startHttpsTransportCall(source);
  // `key:` syntax, shorthand (`key,` / `key}`), and any spread, which could
  // smuggle a seam in without naming it.
  const found = PRODUCTION_STARTUP_HOOKS.filter((key) =>
    new RegExp(`(^|[\\s{,])${key}\\s*[:,}]`).test(call));
  if (/(^|[\s{,])\.\.\./.test(call)) found.push("...spread");
  return found;
}

/**
 * @param {string} source
 */
function assertProductionStartupHasNoEvalHooks(source) {
  const found = productionStartupHookKeys(source);
  if (found.length) {
    throw new Error(`src/index.js passes eval hooks to startHttpsTransport: ${found.join(", ")}`);
  }
}

function baseStartup(overrides = {}) {
  return startHttpsTransport({
    bindHost: "127.0.0.1",
    port: 0,
    allowHttp: true,
    allowUnauth: false,
    sharedToken: "",
    inboundCfg: { issuer: "", audience: "" },
    buildServer: dummyServer,
    exit: (code, reason) => { throw new Error(`startup exited (${code}): ${reason}`); },
    log: () => {},
    ...overrides,
  });
}

describe("startHttpsTransport", () => {
  it.each([false, true])("refuses admission policy without an issuer even when allowUnauth=%s", async (allowUnauth) => {
    for (const allowedPrincipals of [[], [{ clientId: "pilot", sub: "user" }]]) {
      const exits = [];
      const result = await baseStartup({
        allowUnauth,
        inboundCfg: { allowedPrincipals },
        exit: (code, reason) => exits.push({ code, reason }),
      });
      try {
        expect(result.started).toBe(false);
        expect(result.server).toBeUndefined();
        expect(exits).toHaveLength(1);
        expect(exits[0].code).toBe(1);
        expect(exits[0].reason).toContain("incomplete inbound OAuth resource server");
      } finally {
        await result.close?.();
      }
    }
  });

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

  it("does not listen on loopback when issuer and audience lack introspection credentials", async () => {
    const exits = [];
    const result = await startHttpsTransport({
      bindHost: "127.0.0.1",
      port: 0,
      allowHttp: true,
      allowUnauth: false,
      sharedToken: "",
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com/mcp",
        introspectionUrl: "",
        introspectionClientId: "",
        introspectionClientSecret: "",
      },
      buildServer: dummyServer,
      exit: (code, reason) => { exits.push({ code, reason }); },
      log: () => {},
    });
    try {
      expect(result.started).toBe(false);
      expect(result.inboundMode.mode).toBe("fatal");
      expect(result.inboundMode.reason).toContain("auth.introspectionUrl");
      expect(exits).toEqual([{ code: 1, reason: result.inboundMode.reason }]);
      expect(result.server).toBeUndefined();
    } finally {
      await result.close?.();
    }
  });

  it.each([
    ["checkAuth", () => true],
    ["authenticate", null],
    ["allowLocalOperator", true],
    ["auditWriter", null],
    ["modernHandler", () => {}],
  ])("throws at construction when handlerOverrides includes %s", async (key, value) => {
    await expect(baseStartup({ handlerOverrides: { [key]: value } }))
      .rejects.toThrow(new RegExp(`handlerOverrides\\.${key} is not allowed`));
  });

  it("allows a predicate *Fn override", async () => {
    const result = await baseStartup({
      handlerOverrides: { isUnauthenticatedRouteFn: () => false },
    });
    expect(result.started).toBe(true);
    await result.close();
  });

  it("answers 500 fail-closed when onRequest rejects, without dispatch", async () => {
    let dispatched = 0;
    const result = await baseStartup({
      wrapHandler: (handler) => async (req, res, body) => {
        dispatched += 1;
        return handler(req, res, body);
      },
      wrapRequestHandler: () => async () => {
        throw new Error("onRequest boom");
      },
    });
    expect(result.started).toBe(true);
    try {
      const res = await fetch(result.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(dispatched).toBe(0);
    } finally {
      await result.close();
    }
  });

  it("answers 500 fail-closed when onRequest throws synchronously, without dispatch", async () => {
    let dispatched = 0;
    const result = await baseStartup({
      wrapHandler: (handler) => async (req, res, body) => {
        dispatched += 1;
        return handler(req, res, body);
      },
      wrapRequestHandler: () => () => {
        throw new Error("onRequest sync boom");
      },
    });
    expect(result.started).toBe(true);
    try {
      const res = await fetch(result.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(dispatched).toBe(0);
    } finally {
      await result.close();
    }
  });
  it("destroys the socket when onRequest rejects after headers were sent", async () => {
    let closed = false;
    const result = await baseStartup({
      wrapRequestHandler: () => async (req, res) => {
        res.on("close", () => { closed = true; });
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        throw new Error("late boom");
      },
    });
    expect(result.started).toBe(true);
    try {
      // The body never completes: the response must be torn down, not left
      // open until the client times out.
      await expect(fetch(result.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }).then((res) => res.text())).rejects.toThrow();
      expect(closed).toBe(true);
    } finally {
      await result.close();
    }
  });

  it("does not keep the listen-time error handler after bind", async () => {
    const result = await baseStartup();
    expect(result.started).toBe(true);
    try {
      expect(result.server.listenerCount("error")).toBe(0);
      // A bind failure still rejects the startup promise.
      await expect(baseStartup({ port: result.server.address().port }))
        .rejects.toThrow(/EADDRINUSE/);
      // A later server error surfaces (unhandled "error" throws) instead of
      // being consumed by the settled listen promise.
      const late = new Error("late server error");
      expect(() => result.server.emit("error", late)).toThrow(late);
    } finally {
      await result.close();
    }
  });

  it("refuses a cleartext listener on a non-loopback bind even with a resource server configured", async () => {
    const exits = [];
    let discovered = 0;
    const result = await baseStartup({
      bindHost: "0.0.0.0",
      allowHttp: true,
      inboundCfg: { issuer: "https://issuer.example", audience: "https://mcp.example/mcp" },
      // A complete resource-server mode: the cleartext boundary must still
      // refuse, and before any issuer discovery fetch.
      resolveInboundAuthModeFn: () => ({ mode: "resource_server" }),
      fetchFn: async () => { discovered += 1; throw new Error("must not discover"); },
      exit: (code, reason) => { exits.push({ code, reason }); },
    });
    expect(discovered).toBe(0);
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/Plain HTTP binds loopback only/);
    expect(exits).toEqual([{ code: 1, reason: result.reason }]);
    expect(result.server).toBeUndefined();
  });

  it("brackets an IPv6 loopback literal in the returned url and the listen log", async () => {
    const logged = [];
    const result = await baseStartup({ bindHost: "::1", log: (line) => { logged.push(line); } });
    expect(result.started).toBe(true);
    try {
      expect(result.url).toMatch(/^http:\/\/\[::1\]:\d+\/mcp$/);
      expect(logged.join("\n")).toMatch(/Listening on http:\/\/\[::1\]:\d+\/mcp/);
      // The url is usable as-is.
      const res = await fetch(new URL("/health", result.url));
      expect(res.status).toBe(200);
    } finally {
      await result.close();
    }
  });

  it("refuses a non-loopback listenHost so the test override cannot widen exposure", async () => {
    for (const listenHost of ["0.0.0.0", "::", "192.0.2.10"]) {
      await expect(baseStartup({ listenHost })).rejects.toThrow(/listenHost must be a loopback address/);
    }
    const ok = await baseStartup({ listenHost: "127.0.0.1" });
    expect(ok.started).toBe(true);
    await ok.close();
  });

  it("throws at construction when principalRateKeyFn is supplied but not a function", async () => {
    for (const bad of [null, "nope", 42]) {
      await expect(baseStartup({ handlerOverrides: { principalRateKeyFn: bad } }))
        .rejects.toThrow(/principalRateKeyFn must be a function/);
    }
  });

  it("throws at construction when sessionPrincipalKeyFn is supplied but not a function", async () => {
    await expect(baseStartup({ handlerOverrides: { sessionPrincipalKeyFn: null } }))
      .rejects.toThrow(/sessionPrincipalKeyFn must be a function/);
    await expect(baseStartup({ handlerOverrides: { sessionPrincipalKeyFn: "nope" } }))
      .rejects.toThrow(/sessionPrincipalKeyFn must be a function/);
  });

  it("close() closes leftover 2025 transports and stops the server", async () => {
    let rawLegacy;
    const result = await baseStartup({
      wrapHandler: (handler) => {
        if (typeof handler.close === "function") rawLegacy = handler;
        return handler;
      },
    });
    expect(result.started).toBe(true);
    const closeSpy = vi.spyOn(rawLegacy, "close");
    await result.close();
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(result.server.listening).toBe(false);
  });
});

describe("installHttpsShutdown", () => {
  it("closes the transport then exits 0 on SIGTERM and ignores a second signal", async () => {
    const listeners = {};
    const closed = [];
    const exits = [];
    installHttpsShutdown(
      { close: async () => { closed.push(true); } },
      {
        on: (signal, fn) => { listeners[signal] = fn; },
        off: (signal, fn) => {
          if (listeners[signal] === fn) delete listeners[signal];
        },
        exit: (code) => { exits.push(code); },
      },
    );
    expect(Object.keys(listeners).sort()).toEqual(["SIGINT", "SIGTERM"]);
    const shutdown = listeners.SIGTERM;
    await shutdown();
    expect(closed).toEqual([true]);
    expect(exits).toEqual([0]);
    expect(listeners).toEqual({});
    await shutdown();
    expect(closed).toEqual([true]);
    expect(exits).toEqual([0]);
  });

  it("exits 1 when close() rejects", async () => {
    const listeners = {};
    const exits = [];
    installHttpsShutdown(
      { close: async () => { throw new Error("close failed"); } },
      {
        on: (signal, fn) => { listeners[signal] = fn; },
        off: () => {},
        exit: (code) => { exits.push(code); },
      },
    );
    await listeners.SIGINT();
    expect(exits).toEqual([1]);
  });
});

describe("src/index.js production startup call", () => {
  it("passes none of fetchFn, auditWriter, handlerOverrides, wrapHandler or wrapRequestHandler", () => {
    assertProductionStartupHasNoEvalHooks(indexSource());
  });

  it.each([
    ["checkAuth: () => true", "checkAuth"],
    ["authenticate: null", "authenticate"],
    ["allowLocalOperator: true", "allowLocalOperator"],
    ["resolveInboundAuthModeFn: () => ({ mode: \"unauthenticated\" })", "resolveInboundAuthModeFn"],
    ["authenticate", "authenticate"],
    ["allowLocalOperator", "allowLocalOperator"],
    ["...evalHooks", "...spread"],
  ])("fails when a mutant startHttpsTransport call injects %s", (injected, expected) => {
    const anchor = "legacyMode: process.env.MCP_LEGACY_TRANSPORT || \"serve\",";
    const mutated = indexSource().replace(anchor, `${anchor}\n    ${injected},`);
    expect(mutated).not.toBe(indexSource());
    expect(productionStartupHookKeys(mutated)).toContain(expected);
    expect(() => assertProductionStartupHasNoEvalHooks(mutated)).toThrow(/passes eval hooks/);
  });

  it("fails when a mutant startHttpsTransport call passes fetchFn", () => {
    const anchor = "legacyMode: process.env.MCP_LEGACY_TRANSPORT || \"serve\",";
    const mutant = indexSource().replace(anchor, `${anchor}\n    fetchFn: fetch,`);
    expect(mutant).not.toBe(indexSource());
    expect(() => assertProductionStartupHasNoEvalHooks(mutant)).toThrow(/fetchFn/);
  });

  it("logs createStartupRateLimiters values instead of recomputing MCP_RATE_LIMIT", () => {
    const callBlock = indexSource().slice(
      indexSource().indexOf("} else if (transport === \"https\""),
      indexSource().indexOf("await startHttpsTransport"),
    );
    expect(callBlock).toMatch(/limits\.addressLimit/);
    expect(callBlock).toMatch(/limits\.principalLimit/);
    expect(callBlock).toMatch(/limits\.windowSec/);
    expect(callBlock).not.toMatch(/MCP_RATE_LIMIT/);
  });

  it("registers graceful HTTPS shutdown and documents the http transport alias", () => {
    const source = indexSource();
    expect(source).toMatch(/installHttpsShutdown\(started\)/);
    expect(source).toMatch(/"http" \(https alias\)/);
    expect(startHttpsTransportCall(source)).not.toMatch(/toolCount/);
    expect(readFileSync(new URL("../../src/lib/https-startup.js", import.meta.url), "utf8"))
      .not.toMatch(/toolCount/);
    expect(source).toMatch(/Alias of `https`/);
  });
});

describe("createStartupRateLimiters", () => {
  it("defaults both gates off on loopback without TLS", () => {
    const limits = createStartupRateLimiters({ hasTls: false, loopbackBind: true, env: {} });
    expect(limits.rateLimiter).toBeNull();
    expect(limits.principalLimiter).toBeNull();
    expect(limits.addressLimit).toBe(0);
  });

  it("exposes the applied limits and window on a TLS non-loopback listener, as two separate limiters", () => {
    const limits = createStartupRateLimiters({ hasTls: true, loopbackBind: false, env: {} });
    expect(limits.addressLimit).toBe(120);
    expect(limits.principalLimit).toBe(120);
    expect(limits.windowSec).toBe(60);
    expect(typeof limits.rateLimiter.check).toBe("function");
    expect(typeof limits.rateLimiter.reserve).toBe("function");
    expect(limits.principalLimiter).not.toBe(limits.rateLimiter);
  });
});
