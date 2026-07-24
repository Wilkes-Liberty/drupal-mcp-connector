import { describe, it, expect, vi, beforeEach } from "vitest";

const drupalFetch = vi.fn();
const drupalGraphqlFetch = vi.fn();
const clearToken = vi.fn();

vi.mock("../../src/lib/drupal-fetch.js", () => ({
  drupalFetch: (...a) => drupalFetch(...a),
  drupalGraphqlFetch: (...a) => drupalGraphqlFetch(...a),
}));
vi.mock("../../src/lib/oauth.js", () => ({ clearToken: (...a) => clearToken(...a) }));
vi.mock("../../src/lib/backends/jsonapi.js", () => ({
  JsonApiBackend: class { constructor(site) { this.site = site; this.kind = "jsonapi"; } },
}));
vi.mock("../../src/lib/backends/graphql.js", () => ({
  GraphqlBackend: class { constructor(site) { this.site = site; this.kind = "graphql"; } },
}));

import { resolveBackend, isAuthError, _clearBackendCache } from "../../src/lib/backends/index.js";

const site = (over = {}) => ({ _name: "s", api: "jsonapi", oauth: true, baseUrl: "https://x", ...over });

beforeEach(() => {
  _clearBackendCache();
  drupalFetch.mockReset();
  drupalGraphqlFetch.mockReset();
  clearToken.mockReset();
});

describe("isAuthError", () => {
  it("recognises auth-class failures", () => {
    expect(isAuthError(new Error("Drupal 401 on GET /jsonapi: ..."))).toBe(true);
    expect(isAuthError(new Error("invalid_client"))).toBe(true);
    expect(isAuthError(new Error("invalid_grant: token expired"))).toBe(true);
    expect(isAuthError(new Error("Unauthorized"))).toBe(true);
  });
  it("does not flag reachability/other failures", () => {
    expect(isAuthError(new Error("ECONNREFUSED 127.0.0.1:8080"))).toBe(false);
    expect(isAuthError(new Error("Drupal 500 on GET /jsonapi"))).toBe(false);
    expect(isAuthError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe("resolveBackend (#119)", () => {
  it("returns the configured backend when the probe succeeds", async () => {
    drupalFetch.mockResolvedValue({ jsonapi: { version: "1.1" }, data: [] });
    const backend = await resolveBackend(site());
    expect(backend.kind).toBe("jsonapi");
  });

  it("reports an auth failure distinctly and clears the token for recovery", async () => {
    drupalFetch.mockRejectedValue(new Error("Drupal 401 on GET /jsonapi: invalid_token"));
    await expect(resolveBackend(site())).rejects.toThrow(/authentication failed/i);
    expect(clearToken).toHaveBeenCalledTimes(1);
  });

  it("does not clear the token (or claim auth) for a reachability failure", async () => {
    drupalFetch.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:8080"));
    await expect(resolveBackend(site())).rejects.toThrow(/none of the configured api backends/i);
    // The underlying error is surfaced, not hidden.
    await expect(resolveBackend(site())).rejects.toThrow(/ECONNREFUSED/);
    expect(clearToken).not.toHaveBeenCalled();
  });

  it("does not re-clear/latch: a later call re-probes and can recover", async () => {
    drupalFetch.mockRejectedValueOnce(new Error("Drupal 401 on GET /jsonapi"));
    await expect(resolveBackend(site())).rejects.toThrow(/authentication failed/i);
    // Token re-granted server-side; the next call succeeds (no failure was cached).
    drupalFetch.mockResolvedValue({ jsonapi: { version: "1.1" }, data: [] });
    const backend = await resolveBackend(site());
    expect(backend.kind).toBe("jsonapi");
  });
});
