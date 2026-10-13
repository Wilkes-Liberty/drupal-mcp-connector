import { describe, expect, it } from "vitest";
import { LOCAL_OPERATOR } from "../../src/lib/principal.js";
import {
  MCP_PROTOCOL_VERSION_CURRENT,
  MCP_PROTOCOL_VERSIONS,
  acceptIncludes,
  isJsonRpcBatch,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isSupportedProtocolVersion,
  mcpAcceptOk,
  normalizeOrigin,
  originAllowed,
  parseOriginList,
  hostAllowed,
  normalizeHost,
  parseHostHeader,
  parseHostList,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  sessionPrincipalKey,
} from "../../src/lib/http-transport.js";

describe("http-transport helpers", () => {
  it("lists the current protocol and rejects unsupported revisions", () => {
    expect(MCP_PROTOCOL_VERSION_CURRENT).toBe("2026-07-28");
    expect(MCP_PROTOCOL_VERSIONS).toContain("2026-07-28");
    expect(MCP_PROTOCOL_VERSIONS).toContain("2025-11-25");
    expect(isSupportedProtocolVersion("2026-07-28")).toBe(true);
    expect(isSupportedProtocolVersion(" 2025-11-25 ")).toBe(true);
    expect(isSupportedProtocolVersion("2099-01-01")).toBe(false);
    expect(isSupportedProtocolVersion("")).toBe(false);
  });

  it("normalizes Origins and builds the allowlist from config plus the resource", () => {
    expect(normalizeOrigin("https://App.Example.com/path")).toBe("https://app.example.com");
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(parseOriginList("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(resolveAllowedOrigins({
      allowedOrigins: ["https://cursor.example/app", "ftp://nope"],
      resource: "https://mcp.example.com/mcp",
    })).toEqual(["https://cursor.example", "https://mcp.example.com"]);
  });

  it("allows a missing Origin and denies a disallowed or malformed one", () => {
    const allow = ["https://app.example.com"];
    expect(originAllowed(undefined, allow)).toBe(true);
    expect(originAllowed("", allow)).toBe(true);
    expect(originAllowed("https://app.example.com", allow)).toBe(true);
    expect(originAllowed("https://evil.example", allow)).toBe(false);
    expect(originAllowed("null", allow)).toBe(false);
    expect(originAllowed("null", ["null"])).toBe(true);
    expect(originAllowed(":::bad", allow)).toBe(false);
  });

  it("binds sessions to sub+clientId and never to an empty identity", () => {
    expect(sessionPrincipalKey(LOCAL_OPERATOR)).toBe("local-operator");
    expect(sessionPrincipalKey({ sub: "a", clientId: "c" })).toBe('["a","c"]');
    // Structural encoding: a NUL inside a claim cannot alias another principal.
    expect(sessionPrincipalKey({ sub: "a\0b", clientId: "c" }))
      .not.toBe(sessionPrincipalKey({ sub: "a", clientId: "b\0c" }));
    expect(sessionPrincipalKey({ sub: "a", clientId: "other" })).not.toBe(
      sessionPrincipalKey({ sub: "a", clientId: "c" }),
    );
    expect(sessionPrincipalKey({ sub: "a" })).toBe('["a",""]');
    expect(sessionPrincipalKey({})).toBeNull();
    expect(sessionPrincipalKey(null)).toBeNull();
  });

  it("accepts JSON and SSE Accept headers and rejects unrelated types", () => {
    expect(mcpAcceptOk("POST", undefined)).toBe(true);
    expect(mcpAcceptOk("POST", "application/json, text/event-stream")).toBe(true);
    expect(mcpAcceptOk("POST", "application/json")).toBe(true);
    expect(mcpAcceptOk("POST", "text/html")).toBe(false);
    expect(mcpAcceptOk("GET", "text/event-stream")).toBe(true);
    expect(mcpAcceptOk("GET", "application/json")).toBe(false);
    expect(acceptIncludes("application/json; q=0.9, */*", "text/event-stream")).toBe(true);
  });

  it("honors q=0, media ranges, and exact-over-wildcard precedence", () => {
    // q=0 explicitly forbids a type even when listed.
    expect(acceptIncludes("application/json;q=0", "application/json")).toBe(false);
    expect(mcpAcceptOk("POST", "application/json;q=0")).toBe(false);
    expect(mcpAcceptOk("POST", "application/json;q=0, text/event-stream")).toBe(true);
    // A subtype wildcard is a valid range.
    expect(acceptIncludes("application/*", "application/json")).toBe(true);
    expect(mcpAcceptOk("GET", "text/*")).toBe(true);
    // The most specific match decides: exact q=0 beats a wildcard that allows it.
    expect(acceptIncludes("*/*, application/json;q=0", "application/json")).toBe(false);
    expect(acceptIncludes("application/*;q=0, application/json", "application/json")).toBe(true);
    // A present but empty header lists nothing the endpoint can answer with.
    expect(mcpAcceptOk("POST", "")).toBe(false);
    expect(mcpAcceptOk("GET", "   ")).toBe(false);
    expect(mcpAcceptOk("POST", undefined)).toBe(true);
  });

  it("builds the Host allowlist from config, resource, and loopback binds (DEV-861)", () => {
    expect(normalizeHost("MCP.Example.com:8443")).toBe("mcp.example.com:8443");
    expect(normalizeHost("https://not-a-host")).toBeNull();
    expect(normalizeHost("example.com:80")).toBe("example.com:80");
    expect(normalizeHost("[::1]:3443")).toBe("[::1]:3443");
    expect(parseHostHeader("example.com:80")).toEqual({ hostname: "example.com", port: "80" });
    expect(parseHostHeader("[::1]:80")).toEqual({ hostname: "::1", port: "80" });
    expect(parseHostList("mcp.example.com, 127.0.0.1")).toEqual(["mcp.example.com", "127.0.0.1"]);
    expect(resolveAllowedHosts({
      allowedHosts: ["app.example.com:8443"],
      resource: "https://mcp.example.com/mcp",
      loopbackBind: true,
    })).toEqual(["app.example.com:8443", "mcp.example.com", "localhost", "127.0.0.1", "::1"]);
    expect(resolveAllowedHosts({
      allowedHosts: ["[2001:db8::1]:8443", "app.example.com:80"],
    })).toEqual(["[2001:db8::1]:8443", "app.example.com:80"]);
  });

  it("refuses a missing or disallowed Host and accepts an allowlisted one (DEV-861)", () => {
    const allow = ["mcp.example.com", "127.0.0.1"];
    expect(hostAllowed(undefined, allow)).toBe(false);
    expect(hostAllowed("", allow)).toBe(false);
    expect(hostAllowed("evil.example", allow)).toBe(false);
    expect(hostAllowed("mcp.example.com", allow)).toBe(true);
    expect(hostAllowed("mcp.example.com:3443", allow)).toBe(true);
    expect(hostAllowed("127.0.0.1:9", allow)).toBe(true);
    expect(hostAllowed("mcp.example.com", ["mcp.example.com:8443"])).toBe(false);
    expect(hostAllowed("mcp.example.com:8443", ["mcp.example.com:8443"])).toBe(true);
    expect(hostAllowed("example.com:80", ["example.com:80"])).toBe(true);
    expect(hostAllowed("example.com", ["example.com:80"])).toBe(false);
    expect(hostAllowed("example.com:8080", ["example.com:80"])).toBe(false);
    expect(hostAllowed("::1", ["::1"])).toBe(true);
    expect(hostAllowed("[::1]:3443", ["::1"])).toBe(true);
    expect(hostAllowed("[::1]:3443", ["[::1]:3443"])).toBe(true);
    expect(hostAllowed("[2001:db8::1]:8443", ["[2001:db8::1]:8443"])).toBe(true);
    expect(hostAllowed("[2001:db8::1:8443]", ["[2001:db8::1]:8443"])).toBe(false);
  });

  it("rejects Host values that carry URL syntax instead of host[:port] (DEV-861)", () => {
    // `URL` would absorb userinfo, query, fragment, and backslashes and hand
    // back the allowlisted hostname; the raw grammar check refuses them first.
    for (const bad of [
      "evil.example@mcp.example.com",
      "user:pw@mcp.example.com:443",
      "mcp.example.com?x=1",
      "mcp.example.com#frag",
      "mcp.example.com\\x",
      "mcp.example.com:",
      "mcp.example.com:443:1",
      "mcp.example.com:8o80",
      "[::1",
      "::1]:3443",
    ]) {
      expect(parseHostHeader(bad), bad).toBeNull();
      expect(hostAllowed(bad, ["mcp.example.com", "::1"]), bad).toBe(false);
    }
    // Explicit default ports are kept, not dropped by URL normalization.
    expect(parseHostHeader("mcp.example.com:80")).toEqual({ hostname: "mcp.example.com", port: "80" });
    expect(parseHostHeader("mcp.example.com:443")).toEqual({ hostname: "mcp.example.com", port: "443" });
    expect(parseHostHeader("MCP.Example.COM.")).toEqual({ hostname: "mcp.example.com", port: "" });
    // IPv6 zone ids are not valid in a Host header and are refused.
    expect(parseHostHeader("[fe80::1%25eth0]:3443")).toBeNull();
  });

  it("detects JSON-RPC batches, notifications, and responses", () => {
    expect(isJsonRpcBatch([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toBe(true);
    expect(isJsonRpcBatch({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
  });
});
