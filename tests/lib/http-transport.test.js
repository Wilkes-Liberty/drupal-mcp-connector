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
    expect(sessionPrincipalKey({ sub: "a", clientId: "c" })).toBe("a\0c");
    expect(sessionPrincipalKey({ sub: "a", clientId: "other" })).not.toBe(
      sessionPrincipalKey({ sub: "a", clientId: "c" }),
    );
    expect(sessionPrincipalKey({ sub: "a" })).toBe("a\0");
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

  it("detects JSON-RPC batches, notifications, and responses", () => {
    expect(isJsonRpcBatch([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toBe(true);
    expect(isJsonRpcBatch({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
  });
});
