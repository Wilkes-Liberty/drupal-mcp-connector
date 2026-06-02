import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../src/lib/drupal-fetch.js", () => ({ drupalFetch: vi.fn(), drupalGraphqlFetch: vi.fn(), drupalUploadFile: vi.fn() }));
import { drupalFetch, drupalGraphqlFetch } from "../../src/lib/drupal-fetch.js";
import { resolveBackend, _clearBackendCache } from "../../src/lib/backends/index.js";
import { JsonApiBackend } from "../../src/lib/backends/jsonapi.js";
import { GraphqlBackend } from "../../src/lib/backends/graphql.js";
import { BackendResolutionError } from "../../src/lib/backends/errors.js";

beforeEach(() => {
  _clearBackendCache();
  vi.mocked(drupalFetch).mockReset();
  vi.mocked(drupalGraphqlFetch).mockReset();
});

describe("resolveBackend", () => {
  it("uses explicit api='jsonapi' without probing", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ links: {} }); // reachability check
    const b = await resolveBackend({ _name: "s1", baseUrl: "https://x", api: "jsonapi" });
    expect(b).toBeInstanceOf(JsonApiBackend);
  });

  it("caches the resolved backend per site name", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ links: {} });
    const a = await resolveBackend({ _name: "s2", baseUrl: "https://x", api: "jsonapi" });
    const b = await resolveBackend({ _name: "s2", baseUrl: "https://x", api: "jsonapi" });
    expect(a).toBe(b);
    expect(vi.mocked(drupalFetch).mock.calls.length).toBe(1); // only resolved once
  });

  it("probes when api is unset and finds JSON:API", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ links: {} });
    const b = await resolveBackend({ _name: "s3", baseUrl: "https://x" });
    expect(b).toBeInstanceOf(JsonApiBackend);
  });

  it("throws BackendResolutionError when an explicit backend is unreachable", async () => {
    vi.mocked(drupalFetch).mockRejectedValue(new Error("404"));
    await expect(resolveBackend({ _name: "s4", baseUrl: "https://x", api: "jsonapi" }))
      .rejects.toBeInstanceOf(BackendResolutionError);
  });

  it("array api: skips an unknown first entry and uses the reachable second", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ links: {} });
    // "soap" is not a registered backend, so it is skipped in favor of jsonapi.
    const b = await resolveBackend({ _name: "s6", baseUrl: "https://x", api: ["soap", "jsonapi"] });
    expect(b).toBeInstanceOf(JsonApiBackend);
    expect(vi.mocked(drupalFetch).mock.calls.length).toBe(1);
  });

  it("throws BackendResolutionError for an unknown backend name", async () => {
    await expect(resolveBackend({ _name: "s5", baseUrl: "https://x", api: "soap" }))
      .rejects.toBeInstanceOf(BackendResolutionError);
  });

  it("resolves explicit api='graphql' when the endpoint responds", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValue({ data: { __typename: "Query" } });
    const b = await resolveBackend({ _name: "g1", baseUrl: "https://x", api: "graphql" });
    expect(b).toBeInstanceOf(GraphqlBackend);
  });

  it("priority ['graphql','jsonapi'] picks graphql when reachable", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValue({ data: { __typename: "Query" } });
    vi.mocked(drupalFetch).mockResolvedValue({ links: {} });
    const b = await resolveBackend({ _name: "g2", baseUrl: "https://x", api: ["graphql", "jsonapi"] });
    expect(b).toBeInstanceOf(GraphqlBackend);
  });
});
