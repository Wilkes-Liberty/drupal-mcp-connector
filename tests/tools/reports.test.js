import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  countEntities: vi.fn(),
  listContentTypes: vi.fn(),
  capabilities: vi.fn(() => ({
    revisions: true,
    fieldAvailability: () => ["login", "status", "name", "created"],
  })),
  rawQuery: vi.fn(),
};

const graphqlFetch = vi.fn();
vi.mock("../../src/lib/drupal-fetch.js", () => ({ drupalGraphqlFetch: (...a) => graphqlFetch(...a) }));

vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({ globalRedactedFields: [], entityRules: {} })),
    assertReadAllowed: vi.fn(),
  };
});

import { handlers } from "../../src/tools/reports.js";

beforeEach(() => {
  graphqlFetch.mockReset();
  Object.values(backend).forEach((f) => typeof f.mockReset === "function" && f.mockReset());
  // Re-apply default capabilities after reset
  backend.capabilities.mockReturnValue({
    revisions: true,
    fieldAvailability: () => ["login", "status", "name", "created"],
  });
});

// ---------------------------------------------------------------------------
// Task 3: count/list group
// ---------------------------------------------------------------------------

describe("drupal_report_content_summary", () => {
  it("aggregates counts per content type and sets approximate", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "article" }]);
    backend.countEntities
      .mockResolvedValueOnce({ count: 5, approximate: false })  // published
      .mockResolvedValueOnce({ count: 2, approximate: false })  // unpublished
      .mockResolvedValueOnce({ count: 7, approximate: false }); // total
    const out = await handlers.drupal_report_content_summary({});
    expect(out.byContentType[0]).toMatchObject({ contentType: "article", total: 7, published: 5, unpublished: 2 });
    expect(out.approximate).toBe(false);
    expect(out.grandTotal).toBe(7);
  });

  it("sets approximate:true if any count is approximate", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "page" }]);
    backend.countEntities
      .mockResolvedValueOnce({ count: 3, approximate: true })
      .mockResolvedValueOnce({ count: 1, approximate: false })
      .mockResolvedValueOnce({ count: 4, approximate: false });
    const out = await handlers.drupal_report_content_summary({});
    expect(out.approximate).toBe(true);
  });

  it("marks access_denied if countEntities throws", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "secret" }]);
    backend.countEntities.mockRejectedValue(new Error("403"));
    const out = await handlers.drupal_report_content_summary({});
    expect(out.byContentType[0].total).toBe("access_denied");
  });
});

describe("drupal_report_recently_published", () => {
  it("returns canonical nodes via listEntities with status filter", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [{ id: "n1", title: "A", url: "/a", fields: {}, created: "2025-01-01", changed: "2025-01-02" }],
      page: {},
      approximate: false,
    });
    const out = await handlers.drupal_report_recently_published({ type: "article", limit: 5 });
    expect(out.nodes[0].id).toBe("n1");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "status", op: "eq", value: true }]));
  });

  it("uses approximate flag from backend response", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: {}, approximate: true });
    const out = await handlers.drupal_report_recently_published({});
    expect(out.approximate).toBe(true);
  });
});

describe("drupal_report_stale_content", () => {
  it("builds a changed lt filter and returns nodes", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [{ id: "n2", title: "Old", url: "/old", status: false, changed: "2020-01-01" }],
      page: { total: 1 },
      approximate: false,
    });
    const out = await handlers.drupal_report_stale_content({ type: "page", days: 365 });
    const desc = backend.listEntities.mock.calls[0][0];
    const changedFilter = desc.filters.find((f) => f.field === "changed");
    expect(changedFilter).toBeDefined();
    expect(changedFilter.op).toBe("lt");
    expect(out.nodes[0].status).toBe("unpublished");
    expect(typeof out.nodes[0].daysSinceUpdate).toBe("number");
  });

  it("filters changed by an epoch-second integer, not an ISO string (Postgres-safe)", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await handlers.drupal_report_stale_content({ type: "article", days: 180 });
    const desc = backend.listEntities.mock.calls[0][0];
    const changedFilter = desc.filters.find((f) => f.field === "changed");
    // changed is an integer Unix timestamp; an ISO string 500s on Postgres.
    expect(typeof changedFilter.value).toBe("number");
    expect(Number.isInteger(changedFilter.value)).toBe(true);
    // Epoch SECONDS (10 digits), not milliseconds (13) — sanity bound.
    expect(String(changedFilter.value).length).toBe(10);
  });

  it("still reports the human-readable cutoff date", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    const out = await handlers.drupal_report_stale_content({ type: "article", days: 180 });
    expect(out.cutoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("drupal_report_content_by_author", () => {
  it("aggregates node counts by author uuid", async () => {
    // collectEntities paginates via listEntities; mock one page, no next
    backend.listEntities.mockResolvedValue({
      entities: [
        { id: "n1", relationships: { uid: { id: "u1" } } },
        { id: "n2", relationships: { uid: { id: "u1" } } },
        { id: "n3", relationships: { uid: { id: "u2" } } },
      ],
      page: { hasNext: false },
    });
    const out = await handlers.drupal_report_content_by_author({ type: "article" });
    expect(out.authors[0]).toMatchObject({ authorUuid: "u1", nodeCount: 2 });
    expect(out.authors[1]).toMatchObject({ authorUuid: "u2", nodeCount: 1 });
    expect(out.totalAuthors).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Task 4: scan group
// ---------------------------------------------------------------------------

describe("drupal_report_field_completeness", () => {
  it("scores field completeness across sampled nodes", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        { id: "n1", fields: { body: { value: "text" } } },
        { id: "n2", fields: { body: null } },
      ],
      page: { hasNext: false },
    });
    const out = await handlers.drupal_report_field_completeness({ type: "article", fields: ["body"] });
    const bodyRow = out.fields.find((r) => r.field === "body");
    expect(bodyRow).toBeDefined();
    expect(bodyRow.populated).toBe(1);
    expect(bodyRow.empty).toBe(1);
    expect(bodyRow.completenessPercent).toBe(50);
  });
});

describe("drupal_report_seo_audit", () => {
  it("flags nodes missing meta description and thin content", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        {
          id: "n1", title: "Short",
          fields: { body: { value: "only a few words here" }, metaDescription: null },
        },
        {
          id: "n2", title: "Good Title That Is Long Enough Here",
          fields: { body: { value: "word ".repeat(350) }, metaDescription: "good meta" },
        },
      ],
      page: { hasNext: false },
    });
    const out = await handlers.drupal_report_seo_audit({ type: "article", sampleSize: 10 });
    expect(out.issues.missingMetaDescription.count).toBe(1);
    expect(out.metaSource).toBe("jsonapi");
    expect(out.issues.thinContent.count).toBe(1);
    expect(out.scanned).toBe(2);
    expect(out.approximate).toBe(false);
  });

  it("prefers the rendered Metatag description via GraphQL when nodes have aliases", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        { id: "n1", title: "A Long Enough Title For The SEO Check", url: "/a", fields: { body: { value: "word ".repeat(400) } } },
        { id: "n2", title: "Another Sufficiently Long Node Title", url: "/b", fields: { body: { value: "word ".repeat(400) } } },
      ],
      page: { hasNext: false },
    });
    graphqlFetch.mockResolvedValue({
      data: {
        n0: { entity: { metatag: [{ __typename: "MetaTagValue", attributes: { name: "description", content: "present" } }] } },
        n1: { entity: { metatag: [] } },
      },
    });
    const out = await handlers.drupal_report_seo_audit({ type: "resource", sampleSize: 10 });
    expect(out.metaSource).toBe("graphql");
    expect(out.issues.missingMetaDescription.count).toBe(1);
    expect(out.issues.missingMetaDescription.nodes[0].id).toBe("n2");
  });

  it("reports the meta check unavailable instead of a false zero when no source is readable", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        { id: "n1", title: "Node With No Description Field At All Here", url: "/a", fields: { body: { value: "x" } } },
      ],
      page: { hasNext: false },
    });
    graphqlFetch.mockResolvedValue({ errors: [{ message: "Cannot query field metatag" }] });
    const out = await handlers.drupal_report_seo_audit({ type: "resource", sampleSize: 10 });
    expect(out.metaSource).toBe("unavailable");
    expect(out.issues.missingMetaDescription).toMatchObject({ unavailable: true, count: null });
  });
});

describe("drupal_report_accessibility_audit", () => {
  it("flags images without alt and non-descriptive link text", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        {
          id: "n1", title: "T1",
          fields: { body: { value: '<img src="x.png"><a href="#">click here</a>' } },
        },
        {
          id: "n2", title: "T2",
          fields: { body: { value: '<img src="x.png" alt="desc"><a href="#">good link text</a>' } },
        },
      ],
      page: { hasNext: false },
    });
    const out = await handlers.drupal_report_accessibility_audit({ type: "article" });
    expect(out.issues.imagesWithoutAlt.count).toBe(1);
    expect(out.issues.nonDescriptiveLinkText.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 5: degrade/gate group
// ---------------------------------------------------------------------------

describe("drupal_report_taxonomy_usage", () => {
  it("aggregates per-term node counts", async () => {
    // collectEntities call for terms
    backend.listEntities.mockResolvedValue({
      entities: [
        { id: "t1", fields: { name: "Alpha" } },
        { id: "t2", fields: { name: "Beta" } },
      ],
      page: { hasNext: false },
    });
    backend.countEntities
      .mockResolvedValueOnce({ count: 10, approximate: false })
      .mockResolvedValueOnce({ count: 0, approximate: false });
    const out = await handlers.drupal_report_taxonomy_usage({ vocabulary: "tags" });
    expect(out.terms[0].id).toBe("t1");
    expect(out.terms[0].nodeCount).toBe(10);
    expect(out.unusedTerms).toBe(1);
    expect(out.approximate).toBe(false);
  });

  it("passes approximate:true through when backend is approximate", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [{ id: "t1", fields: { name: "Tag" } }],
      page: { hasNext: false },
    });
    backend.countEntities.mockResolvedValue({ count: 5, approximate: true });
    const out = await handlers.drupal_report_taxonomy_usage({ vocabulary: "tags" });
    expect(out.approximate).toBe(true);
  });
});

describe("drupal_report_revision_hotspots", () => {
  it("returns {unavailable} when capabilities().revisions is false", async () => {
    backend.capabilities.mockReturnValue({ revisions: false, read: true });
    const out = await handlers.drupal_report_revision_hotspots({});
    expect(out.unavailable).toBe(true);
    expect(out.report).toBe("revision_hotspots");
  });

  it("fetches revisions when capabilities().revisions is true", async () => {
    backend.capabilities.mockReturnValue({ revisions: true });
    backend.listEntities.mockResolvedValue({
      entities: [{ id: "n1", title: "T", changed: "2025-01-01", url: "/t" }],
      page: {},
    });
    backend.rawQuery.mockResolvedValue({ meta: { count: 5 } });
    const out = await handlers.drupal_report_revision_hotspots({ type: "article" });
    expect(out.nodes).toBeDefined();
    expect(out.nodes[0].id).toBe("n1");
  });
});

describe("drupal_report_user_activity", () => {
  it("returns {unavailable} when fieldAvailability lacks login", async () => {
    backend.capabilities.mockReturnValue({
      revisions: true,
      fieldAvailability: () => ["name", "status"], // no "login"
    });
    const out = await handlers.drupal_report_user_activity({});
    expect(out.unavailable).toBe(true);
    expect(out.report).toBe("user_activity");
  });

  it("returns user summary when fieldAvailability includes login and status", async () => {
    backend.capabilities.mockReturnValue({
      revisions: true,
      fieldAvailability: () => ["login", "status", "name"],
    });
    backend.countEntities
      .mockResolvedValueOnce({ count: 10, approximate: false }) // active
      .mockResolvedValueOnce({ count: 2, approximate: false })  // blocked
      .mockResolvedValueOnce({ count: 1, approximate: false }); // neverLoggedIn
    backend.listEntities.mockResolvedValue({
      entities: [],
      page: {},
    });
    const out = await handlers.drupal_report_user_activity({ inactiveDays: 90 });
    expect(out.summary.activeAccounts).toBe(10);
    expect(out.summary.blockedAccounts).toBe(2);
    expect(out.summary.neverLoggedIn).toBe(1);
  });

  it("skips the gate when fieldAvailability is null (JSON:API path)", async () => {
    backend.capabilities.mockReturnValue({
      revisions: true,
      fieldAvailability: null,
    });
    backend.countEntities
      .mockResolvedValueOnce({ count: 5, approximate: false })
      .mockResolvedValueOnce({ count: 0, approximate: false })
      .mockResolvedValueOnce({ count: 0, approximate: false });
    backend.listEntities.mockResolvedValue({ entities: [], page: {} });
    const out = await handlers.drupal_report_user_activity({});
    expect(out.unavailable).toBeUndefined();
    expect(out.summary.activeAccounts).toBe(5);
    expect(out.approximate).toBe(false);
  });

  it("surfaces approximate:true when any of the counts hit the ceiling", async () => {
    backend.capabilities.mockReturnValue({ revisions: true, fieldAvailability: null });
    backend.countEntities
      .mockResolvedValueOnce({ count: 1000, approximate: true })  // active capped
      .mockResolvedValueOnce({ count: 2, approximate: false })
      .mockResolvedValueOnce({ count: 1, approximate: false });
    backend.listEntities.mockResolvedValue({ entities: [], page: {} });
    const out = await handlers.drupal_report_user_activity({});
    expect(out.approximate).toBe(true);
    expect(out.summary.activeAccounts).toBe(1000);
  });
});
