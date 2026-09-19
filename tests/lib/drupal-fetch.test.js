import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
vi.mock("node-fetch", () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) }));
import fetch from "node-fetch";
import { drupalFetch, drupalGraphqlFetch, drupalUploadFile, DRUPAL_FETCH_TIMEOUT_MS } from "../../src/lib/drupal-fetch.js";
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
    const file = join(tmpdir(), "mcp-connector-upload-budget.png");
    writeFileSync(file, "x");
    const previousRoot = process.env.MCP_UPLOAD_ROOT;
    process.env.MCP_UPLOAD_ROOT = tmpdir();
    try {
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
    } finally {
      if (previousRoot === undefined) delete process.env.MCP_UPLOAD_ROOT;
      else process.env.MCP_UPLOAD_ROOT = previousRoot;
    }
  });
});

function hangingFetch(_url, opts) {
  return new Promise((_, reject) => {
    const abort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (opts?.signal?.aborted) {
      abort();
      return;
    }
    opts?.signal?.addEventListener("abort", abort, { once: true });
  });
}

function uploadFixture() {
  const file = join(tmpdir(), "mcp-connector-upload-timeout.png");
  writeFileSync(file, "x");
  return file;
}

describe("drupalFetch northbound HTTP timeout", () => {
  it("attaches AbortSignal.timeout(30s) on JSON:API, GraphQL, and upload", async () => {
    const fake = new AbortController().signal;
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fake);
    const file = uploadFixture();
    const previousRoot = process.env.MCP_UPLOAD_ROOT;
    process.env.MCP_UPLOAD_ROOT = tmpdir();
    try {
      await drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article");
      await drupalGraphqlFetch({ _name: "t", baseUrl: "https://x" }, { query: "{ ping }" });
      await drupalUploadFile({ _name: "t", baseUrl: "https://x" }, "media", "image", "field_media_image", file);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledWith(DRUPAL_FETCH_TIMEOUT_MS);
      expect(vi.mocked(fetch).mock.calls.map(([, opts]) => opts.signal)).toEqual([fake, fake, fake]);
    } finally {
      spy.mockRestore();
      if (previousRoot === undefined) delete process.env.MCP_UPLOAD_ROOT;
      else process.env.MCP_UPLOAD_ROOT = previousRoot;
    }
  });

  it("surfaces a timeout when the default signal aborts JSON:API, GraphQL, and upload", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20));
    const file = uploadFixture();
    const previousRoot = process.env.MCP_UPLOAD_ROOT;
    process.env.MCP_UPLOAD_ROOT = tmpdir();
    try {
      await expect(drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article"))
        .rejects.toThrow(`Drupal request timed out after ${DRUPAL_FETCH_TIMEOUT_MS / 1000}s`);
      await expect(drupalGraphqlFetch({ _name: "t", baseUrl: "https://x" }, { query: "{ ping }" }))
        .rejects.toThrow(/timed out after 30s/);
      await expect(drupalUploadFile({ _name: "t", baseUrl: "https://x" }, "media", "image", "field_media_image", file))
        .rejects.toThrow(/timed out after 30s/);
    } finally {
      spy.mockRestore();
      if (previousRoot === undefined) delete process.env.MCP_UPLOAD_ROOT;
      else process.env.MCP_UPLOAD_ROOT = previousRoot;
    }
  });

  it("honors a caller signal on drupalFetch without remapping the abort", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    await expect(drupalFetch(
      { _name: "t", baseUrl: "https://x" },
      "/jsonapi/node/article",
      { signal: AbortSignal.timeout(20) }
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("drupalUploadFile failure message (#343)", () => {
  const site = { _name: "t", baseUrl: "https://x" };
  let previousRoot;
  let file;

  beforeEach(() => {
    previousRoot = process.env.MCP_UPLOAD_ROOT;
    process.env.MCP_UPLOAD_ROOT = tmpdir();
    file = join(tmpdir(), "mcp-connector-upload-error.png");
    writeFileSync(file, "x");
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.MCP_UPLOAD_ROOT;
    else process.env.MCP_UPLOAD_ROOT = previousRoot;
  });

  async function failWith(status, body, contentType) {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType ?? null : null) },
      text: async () => body,
    });
    try {
      await drupalUploadFile(site, "media", "image", "field_media_image", file);
    } catch (err) {
      return err.message;
    }
    throw new Error("expected the upload to fail");
  }

  it("surfaces errors[].detail from a JSON:API error document and nothing else", async () => {
    const message = await failWith(422, JSON.stringify({
      jsonapi: { version: "1.0" },
      errors: [
        {
          title: "Unprocessable Entity", status: "422",
          detail: "Unprocessable Entity: file validation failed.\nOnly files with the following extensions are allowed: <em class=\"placeholder\">png jpg</em>.",
          source: { file: "/var/www/html/web/core/modules/jsonapi/src/Controller/FileUpload.php", line: 170 },
          meta: { trace: "#0 /var/www/html/web/core/lib/Drupal/Core/File/FileSystem.php(310): secret()" },
        },
        { title: "Forbidden" },
      ],
    }), "application/vnd.api+json");
    expect(message).toBe(
      "File upload failed 422: Unprocessable Entity: file validation failed. " +
      "Only files with the following extensions are allowed: png jpg.; Forbidden"
    );
    expect(message).not.toContain("/var/www");
    expect(message).not.toContain("trace");
  });

  it("redacts a server path and a stream-wrapper URI inside a detail", async () => {
    const message = await failWith(500, JSON.stringify({
      errors: [{ detail: "file_put_contents(/var/www/html/web/sites/default/files/tmp/a.png): failed. Could not move private://hr/2026/jane-doe-resume.pdf" }],
    }), "application/vnd.api+json");
    expect(message).toContain("File upload failed 500:");
    expect(message).toContain("[path]");
    expect(message).toContain("private://[path]");
    expect(message).not.toContain("/var/www");
    expect(message).not.toContain("jane-doe");
  });

  it("never passes an HTML body through, by content type", async () => {
    const html = "<!DOCTYPE html><html><head><title>Error | Example</title></head><body><h1>The website encountered an unexpected error.</h1>" +
      "<pre>PDOException in /var/www/html/web/core/lib/Database.php line 12</pre></body></html>";
    const message = await failWith(500, html, "text/html; charset=UTF-8");
    expect(message).toBe("File upload failed 500: the server returned an HTML page, not shown (title: Error | Example)");
    expect(message).not.toContain("PDOException");
    expect(message).not.toContain("<");
  });

  it("detects an HTML body without a content type", async () => {
    const message = await failWith(413, "\n  <html>\r\n<head><title>413 Request Entity Too Large</title></head><body><center>nginx</center></body></html>");
    expect(message).toBe("File upload failed 413: the server returned an HTML page, not shown (title: 413 Request Entity Too Large)");
  });

  it("reports an HTML body with no title without quoting it", async () => {
    const message = await failWith(502, "<html><body><p>Bad gateway at /srv/app/proxy.conf</p></body></html>");
    expect(message).toBe("File upload failed 502: the server returned an HTML page, not shown");
  });

  it("bounds an oversized detail", async () => {
    const message = await failWith(422, JSON.stringify({ errors: [{ detail: "x".repeat(20000) }] }), "application/vnd.api+json");
    expect(message.length).toBeLessThan(600);
    expect(message).toMatch(/… \[truncated\]$/);
  });

  it("bounds an oversized plain-text body and strips markup and control characters", async () => {
    const message = await failWith(500, `Upload <b>rejected</b>\u0000\u001b[31m: ${"y".repeat(50000)}`, "text/plain");
    expect(message.startsWith("File upload failed 500: Upload rejected")).toBe(true);
    expect(message).not.toMatch(/[\u0000-\u001f<>]/);
    expect(message.length).toBeLessThan(600);
  });

  it("keeps the status when the body is empty", async () => {
    expect(await failWith(503, "")).toBe("File upload failed 503 (empty response body)");
    expect(await failWith(503, "  \n ")).toBe("File upload failed 503 (empty response body)");
  });

  it("does not echo a JSON body that is not an error document", async () => {
    const message = await failWith(500, JSON.stringify({ debug: { dsn: "pgsql://user:pw@db/app" } }), "application/json");
    expect(message).toBe("File upload failed 500: the server returned JSON with no error detail, not shown");
  });

  it("reads the message member of a plain Drupal JSON error", async () => {
    const message = await failWith(403, JSON.stringify({ message: "The 'create media' permission is required." }), "application/json");
    expect(message).toBe("File upload failed 403: The 'create media' permission is required.");
  });

  it("still fails with the status when the body cannot be read", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500, text: async () => { throw new Error("socket hang up"); } });
    await expect(drupalUploadFile(site, "media", "image", "field_media_image", file))
      .rejects.toThrow("File upload failed 500 (response body could not be read)");
  });
});
