import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
vi.mock("node-fetch", () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) }));
import fetch from "node-fetch";
import { drupalFetch, drupalGraphqlFetch, drupalUploadFile } from "../../src/lib/drupal-fetch.js";
import { CLIENT_VERSION } from "../../src/lib/config.js";
import { clearToken } from "../../src/lib/oauth.js";
import {
  HEADER_DECLARED_CEILING,
  HEADER_DECLARED_DESTINATION,
  REASON_READ,
  buildDataFlowContext,
  resetDataFlowBudgets,
  runWithDataFlow,
} from "../../src/lib/data-flow.js";

const ok = () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
const oauthSite = (name) => ({
  _name: name,
  baseUrl: "https://x",
  oauth: { tokenUrl: "/oauth/token", clientId: "c", clientSecret: "s", grant: "client_credentials", scopes: ["mcp:read"] },
});

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(async () => ok());
  delete process.env.MCP_CLIENT_ID;
  resetDataFlowBudgets();
});

describe("drupalFetch identity header", () => {
  it("sends X-MCP-Client + User-Agent on requests", async () => {
    await drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article");
    const opts = vi.mocked(fetch).mock.calls[0][1];
    const expected = `drupal-mcp-connector/${CLIENT_VERSION}`;
    expect(opts.headers["X-MCP-Client"]).toBe(expected);
    expect(opts.headers["User-Agent"]).toBe(expected);
  });
});

describe("drupalFetch oauth integration", () => {
  it("sends a Bearer token sourced from the token manager", async () => {
    const site = oauthSite("of1");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-x", expires_in: 3600 }) })
      .mockResolvedValueOnce(ok());
    await drupalFetch(site, "/jsonapi/node/article");
    // call 0 is the token endpoint, call 1 is the JSON:API request
    const apiOpts = vi.mocked(fetch).mock.calls[1][1];
    expect(apiOpts.headers.Authorization).toBe("Bearer tok-x");
    clearToken(site);
  });

  it("on a 401 clears the token, re-acquires, and retries exactly once", async () => {
    const site = oauthSite("of2");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-old", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-new", expires_in: 3600 }) })
      .mockResolvedValueOnce(ok());
    const result = await drupalFetch(site, "/jsonapi/node/article");
    expect(result).toEqual({ data: [] });
    // token, failed-request, re-token, retried-request = 4 fetches
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    const retryOpts = vi.mocked(fetch).mock.calls[3][1];
    expect(retryOpts.headers.Authorization).toBe("Bearer tok-new");
    clearToken(site);
  });

  it("does not retry a 401 for a static apiToken site", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, text: async () => "nope" });
    await expect(drupalFetch({ _name: "st1", baseUrl: "https://x", apiToken: "static" }, "/jsonapi/node/article"))
      .rejects.toThrow(/401/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(fetch).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer static");
  });
});

describe("drupalFetch northbound data-flow (#179)", () => {
  const flow = () => buildDataFlowContext({
    identity: { sub: "alice", clientId: "content-agent" },
    target: { name: "production", baseUrl: "https://x", source: "grant" },
    site: { security: { declaredCeiling: "internal" } },
    limits: { requests: 2, requestWindowSec: 60, pages: 1, pageWindowSec: 60, results: 2, bytes: 4096 },
    now: () => 1_000,
    correlationId: "corr-fetch",
  });

  it("attaches declared ceiling and destination on JSON:API and GraphQL", async () => {
    await runWithDataFlow(flow(), () => drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article/abcd"));
    const jsonapi = vi.mocked(fetch).mock.calls[0][1].headers;
    expect(jsonapi[HEADER_DECLARED_CEILING]).toBe("internal");
    expect(jsonapi[HEADER_DECLARED_DESTINATION]).toBe("content-agent:production");

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async () => ok());
    await runWithDataFlow(flow(), () => drupalGraphqlFetch({ _name: "t", baseUrl: "https://x" }, { query: "{ ping }" }));
    const gql = vi.mocked(fetch).mock.calls[0][1].headers;
    expect(gql[HEADER_DECLARED_CEILING]).toBe("internal");
    expect(gql[HEADER_DECLARED_DESTINATION]).toBe("content-agent:production");
  });

  it("does not let a collection page evade the page budget", async () => {
    const ctx = flow();
    await runWithDataFlow(ctx, () =>
      drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article?page[limit]=2"));
    await expect(runWithDataFlow(ctx, () =>
      drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article?page[offset]=2"))).rejects.toMatchObject({
      reason: "page_budget_exceeded",
      correlationId: "corr-fetch",
    });
  });

  it("rewrites a source budget denial to a stable reason and drops the payload", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        errors: [{ code: REASON_READ, detail: "restricted-body leaked" }],
      }),
    });
    try {
      await runWithDataFlow(flow(), () =>
        drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article"));
      throw new Error("expected source budget denial");
    } catch (err) {
      expect(err.reason).toBe(REASON_READ);
      expect(err.correlationId).toBe("corr-fetch");
      expect(err.message).toBe("read_budget_exceeded (correlation corr-fetch)");
      expect(err.message).not.toContain("restricted-body");
    }
  });

  it("rewrites an upload-path source denial without leaking the body", async () => {
    const dir = join(process.cwd(), ".tmp-upload-budget");
    const file = join(dir, "ok.png");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "x");
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        errors: [{ code: REASON_READ, detail: "restricted-body leaked" }],
      }),
    });
    await expect(runWithDataFlow(flow(), () =>
      drupalUploadFile({ _name: "t", baseUrl: "https://x" }, "media", "image", "field_media_image", file))).rejects.toMatchObject({
      reason: REASON_READ,
    });
  });
});
