import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    authHeadersAsync: vi.fn(async (site) => {
      if (site.failAuth) throw new Error("auth failed");
      return { Authorization: "Bearer tok" };
    }),
    clientHeaders: () => ({ "User-Agent": "test-client" }),
  };
});

import {
  clearTextFormatContextCache,
  ensureTextFormatContext,
  fetchTextFormatContext,
  installTextFormatContextFetcher,
  textFormatDefinitionFromContext,
} from "../../src/lib/text-format-context.js";

const site = { _name: "s", baseUrl: "https://example.test", apiToken: "tok" };

beforeEach(() => {
  clearTextFormatContextCache();
  installTextFormatContextFetcher(async () => null);
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ensureTextFormatContext", () => {
  it("remembers a failed fetch and does not refetch until that miss expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ content_types: {} });
    installTextFormatContextFetcher(fetcher);
    await ensureTextFormatContext(site);
    await ensureTextFormatContext(site);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(textFormatDefinitionFromContext(site, "node", "page", "body")).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    await ensureTextFormatContext(site);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reuses a successful document past the failure window", async () => {
    vi.useFakeTimers();
    const document = {
      content_types: {
        solution: {
          fields: { field_summary: { type: "text_long", allowed_formats: ["plain_text"] } },
        },
      },
    };
    const fetcher = vi.fn(async () => document);
    installTextFormatContextFetcher(fetcher);
    await ensureTextFormatContext(site);
    await vi.advanceTimersByTimeAsync(30_000);
    await ensureTextFormatContext(site);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(textFormatDefinitionFromContext(site, "node", "solution", "field_summary")?.allowedFormats)
      .toEqual(["plain_text"]);
  });

  it("shares one in-flight fetch across concurrent callers", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      await gate;
      return { content_types: {} };
    });
    installTextFormatContextFetcher(fetcher);
    const pending = Promise.all([
      ensureTextFormatContext(site),
      ensureTextFormatContext(site),
      ensureTextFormatContext(site),
    ]);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not treat a null document as a schema", async () => {
    installTextFormatContextFetcher(async () => null);
    await ensureTextFormatContext(site);
    expect(textFormatDefinitionFromContext(site, "node", "solution", "field_summary")).toBeNull();
  });
});

describe("fetchTextFormatContext", () => {
  it("returns null when authentication fails and does not request context", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchTextFormatContext({ ...site, failAuth: true })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(fetchTextFormatContext(site)).resolves.toBeNull();
  });

  it.each([
    ["a non-OK response", { ok: false, status: 503, json: async () => ({}) }],
    ["a body with no content_types", { ok: true, status: 200, json: async () => ({ site: "x" }) }],
    ["an array body", { ok: true, status: 200, json: async () => [] }],
    ["malformed JSON", {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }],
  ])("returns null for %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(fetchTextFormatContext(site)).resolves.toBeNull();
  });
});
