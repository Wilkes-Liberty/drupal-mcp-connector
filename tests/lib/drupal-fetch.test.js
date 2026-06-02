import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("node-fetch", () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) }));
import fetch from "node-fetch";
import { drupalFetch } from "../../src/lib/drupal-fetch.js";
import { CLIENT_VERSION } from "../../src/lib/config.js";

beforeEach(() => { vi.mocked(fetch).mockClear(); delete process.env.MCP_CLIENT_ID; });

describe("drupalFetch identity header", () => {
  it("sends X-MCP-Client + User-Agent on requests", async () => {
    await drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article");
    const opts = vi.mocked(fetch).mock.calls[0][1];
    const expected = `drupal-mcp-server/${CLIENT_VERSION}`;
    expect(opts.headers["X-MCP-Client"]).toBe(expected);
    expect(opts.headers["User-Agent"]).toBe(expected);
  });
});
