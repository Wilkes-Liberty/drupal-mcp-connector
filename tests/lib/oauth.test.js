import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { getAccessToken, clearToken, OAuthError, OAUTH_TOKEN_TIMEOUT_MS } from "../../src/lib/oauth.js";

function tokenResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function oauthSite(name, overrides = {}) {
  return {
    _name: name,
    baseUrl: "https://api.example.com",
    oauth: {
      tokenUrl: "/oauth/token",
      clientId: "mcp-agent",
      clientSecret: "shh",
      scopes: ["mcp:read", "mcp:write"],
      grant: "client_credentials",
      ...overrides,
    },
  };
}

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

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

describe("getAccessToken", () => {
  it("fetches a token on first call and posts the client_credentials form body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      tokenResponse({ access_token: "tok-1", expires_in: 3600 })
    );
    const site = oauthSite("s1");
    const token = await getAccessToken(site);
    expect(token).toBe("tok-1");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.example.com/oauth/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(opts.body);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("mcp-agent");
    expect(params.get("client_secret")).toBe("shh");
    expect(params.get("scope")).toBe("mcp:read mcp:write");
  });

  it("caches the token within its TTL (second call does not fetch)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      tokenResponse({ access_token: "tok-cache", expires_in: 3600 })
    );
    const site = oauthSite("s2");
    expect(await getAccessToken(site)).toBe("tok-cache");
    expect(await getAccessToken(site)).toBe("tok-cache");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("re-acquires once the cached token is near expiry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-old", expires_in: 30 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-new", expires_in: 3600 }));
    const site = oauthSite("s3");
    // expires_in 30s is inside the 60s refresh window, so the next call re-fetches.
    expect(await getAccessToken(site)).toBe("tok-old");
    expect(await getAccessToken(site)).toBe("tok-new");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("uses the refresh_token grant when one was returned", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "tok-a", expires_in: 30, refresh_token: "refresh-1" })
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-b", expires_in: 3600 }));
    const site = oauthSite("s4");
    expect(await getAccessToken(site)).toBe("tok-a");
    expect(await getAccessToken(site)).toBe("tok-b");

    const secondBody = new URLSearchParams(vi.mocked(fetch).mock.calls[1][1].body);
    expect(secondBody.get("grant_type")).toBe("refresh_token");
    expect(secondBody.get("refresh_token")).toBe("refresh-1");
  });

  it("clearToken forces a re-acquire", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-1", expires_in: 3600 }))
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-2", expires_in: 3600 }));
    const site = oauthSite("s5");
    expect(await getAccessToken(site)).toBe("tok-1");
    clearToken(site);
    expect(await getAccessToken(site)).toBe("tok-2");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent requests at expiry into a single token fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      tokenResponse({ access_token: "tok-burst", expires_in: 3600 })
    );
    const site = oauthSite("s7");
    const [a, b] = await Promise.all([getAccessToken(site), getAccessToken(site)]);
    expect(a).toBe("tok-burst");
    expect(b).toBe("tok-burst");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("falls back to client_credentials when the refresh grant fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "tok-a", expires_in: 30, refresh_token: "refresh-1" })
      )
      .mockResolvedValueOnce(
        tokenResponse({ error: "invalid_grant" }, { ok: false, status: 400 })
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: "tok-fresh", expires_in: 3600 }));
    const site = oauthSite("s8");
    expect(await getAccessToken(site)).toBe("tok-a");
    // Refresh fails (400), so it retries with a fresh client_credentials grant.
    expect(await getAccessToken(site)).toBe("tok-fresh");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);

    const refreshBody = new URLSearchParams(vi.mocked(fetch).mock.calls[1][1].body);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    const fallbackBody = new URLSearchParams(vi.mocked(fetch).mock.calls[2][1].body);
    expect(fallbackBody.get("grant_type")).toBe("client_credentials");
    expect(fallbackBody.get("refresh_token")).toBeNull();
  });

  it("throws OAuthError when the token response has no access_token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      tokenResponse({ expires_in: 3600 })
    );
    const site = oauthSite("s9");
    await expect(getAccessToken(site)).rejects.toThrow(OAuthError);
    try {
      await getAccessToken(oauthSite("s9b"));
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect(String(err.message)).not.toContain("shh");
    }
  });

  it("attaches AbortSignal.timeout on the token POST", async () => {
    const fake = new AbortController().signal;
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fake);
    try {
      vi.mocked(fetch).mockResolvedValueOnce(
        tokenResponse({ access_token: "tok-timeout", expires_in: 3600 })
      );
      await getAccessToken(oauthSite("s-timeout"));
      expect(spy).toHaveBeenCalledWith(OAUTH_TOKEN_TIMEOUT_MS);
      expect(vi.mocked(fetch).mock.calls[0][1].signal).toBe(fake);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails with OAuthError when the token POST times out", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20));
    try {
      await expect(getAccessToken(oauthSite("s-hang"))).rejects.toThrow(OAuthError);
      await expect(getAccessToken(oauthSite("s-hang-2"))).rejects.toThrow(
        `OAuth token request to s-hang-2 timed out after ${OAUTH_TOKEN_TIMEOUT_MS / 1000}s.`
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("throws OAuthError on a non-2xx token response without leaking the secret", async () => {
    vi.mocked(fetch).mockResolvedValue(
      tokenResponse({ error: "invalid_client" }, { ok: false, status: 401 })
    );
    const site = oauthSite("s6");
    await expect(getAccessToken(site)).rejects.toThrow(OAuthError);
    try {
      await getAccessToken(oauthSite("s6b"));
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.status).toBe(401);
      expect(String(err.message)).not.toContain("shh");
    }
  });
});
