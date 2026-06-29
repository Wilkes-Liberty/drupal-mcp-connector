import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: { listEntities: vi.fn() },
  site: null,
}));
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => h.backend) }));
vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: vi.fn(() => h.site) }));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({ allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {} })) };
});

import { handlers, definitions } from "../../src/tools/reports-content.js";

const { backend } = h;
function node(over = {}) {
  return { id: "n", title: "T", status: true, langcode: "en", changed: null, url: "/t", fields: {}, relationships: {}, ...over };
}
function page(entities) {
  return { entities, page: { hasNext: false }, approximate: false };
}
/** A timestamp N days in the past (epoch seconds) — for scheduler fields. */
function daysAgo(n) {
  return Math.floor((Date.now() - n * 86400000) / 1000);
}
/** An ISO timestamp N days in the past — matches the canonical `changed` shape. */
function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

beforeEach(() => {
  h.site = { _name: "d", baseUrl: "https://example.com" };
  backend.listEntities.mockReset();
});

describe("reports-content", () => {
  it("definition names match handler keys", () => {
    expect(definitions.map((d) => d.name).sort()).toEqual(Object.keys(handlers).sort());
  });

  describe("drupal_report_duplicate_content", () => {
    it("groups normalized duplicate titles", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ id: "1", title: "Hello World" }),
        node({ id: "2", title: "hello, world!" }),
        node({ id: "3", title: "Unique" }),
      ]));
      const res = await handlers.drupal_report_duplicate_content({ type: "page" });
      expect(res.duplicateGroups).toBe(1);
      expect(res.findings[0].count).toBe(2);
    });
  });

  describe("drupal_report_workflow_bottlenecks", () => {
    it("flags content stuck past the threshold", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ id: "1", changed: isoDaysAgo(60), fields: { moderation_state: { value: "draft" } } }),
        node({ id: "2", changed: isoDaysAgo(5), fields: { moderation_state: { value: "draft" } } }),
        node({ id: "3", changed: isoDaysAgo(90), fields: { moderation_state: { value: "published" } } }),
      ]));
      const res = await handlers.drupal_report_workflow_bottlenecks({ type: "page", days: 30 });
      expect(res.totalStuck).toBe(1);
      expect(res.findings[0].id).toBe("1");
    });
    it("gates when moderation_state is absent", async () => {
      backend.listEntities.mockResolvedValue(page([node({ id: "1" })]));
      const res = await handlers.drupal_report_workflow_bottlenecks({ type: "page" });
      expect(res.gated).toBe(true);
    });
  });

  describe("drupal_report_translation_coverage", () => {
    it("flags lagging languages", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ langcode: "en" }), node({ langcode: "en" }), node({ langcode: "en" }), node({ langcode: "en" }),
        node({ langcode: "es" }),
      ]));
      const res = await handlers.drupal_report_translation_coverage({ type: "page" });
      expect(res.languages[0]).toEqual({ langcode: "en", count: 4 });
      expect(res.laggingLanguages[0].langcode).toBe("es");
    });
  });

  describe("drupal_report_scheduled_content", () => {
    it("splits pending and overdue", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ id: "1", fields: { publish_on: { value: daysAgo(-3) } } }), // future
        node({ id: "2", fields: { unpublish_on: { value: daysAgo(3) } } }), // past
      ]));
      const res = await handlers.drupal_report_scheduled_content({ type: "page" });
      expect(res.summary).toEqual({ pending: 1, overdue: 1 });
    });
    it("gates when scheduler fields are absent", async () => {
      backend.listEntities.mockResolvedValue(page([node({ id: "1" })]));
      const res = await handlers.drupal_report_scheduled_content({ type: "page" });
      expect(res.gated).toBe(true);
    });
  });

  describe("drupal_report_readability", () => {
    it("scores body text and flags structural issues", async () => {
      const body = "<p>" + "The cat sat on the mat. ".repeat(8) + "</p>";
      backend.listEntities.mockResolvedValue(page([node({ fields: { body: { value: body } } })]));
      const res = await handlers.drupal_report_readability({ type: "page" });
      expect(res.analyzed).toBe(1);
      expect(typeof res.averageScore).toBe("number");
      expect(res.structuralIssues[0].issues).toContain("no H2 subheadings");
    });
  });

  describe("drupal_report_orphan_pages", () => {
    it("flags pages never linked from the sample", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ id: "1", url: "/a", fields: { body: { value: '<a href="/b">to b</a>' } } }),
        node({ id: "2", url: "/b", fields: { body: { value: "no links" } } }),
        node({ id: "3", url: "/c", fields: { body: { value: "island" } } }),
      ]));
      const res = await handlers.drupal_report_orphan_pages({ type: "page" });
      const paths = res.findings.map((f) => f.path).sort();
      expect(paths).toEqual(["/a", "/c"]);
    });
  });

  describe("drupal_report_pii_exposure", () => {
    it("detects and masks PII", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ fields: { body: { value: "Contact jane@example.com or 555-123-4567, SSN 123-45-6789." } } }),
      ]));
      const res = await handlers.drupal_report_pii_exposure({ type: "page" });
      expect(res.totals.email).toBe(1);
      expect(res.totals.ssn).toBe(1);
      expect(res.findings[0].hits.email.samples[0]).toMatch(/\*\*\*@example\.com/);
      expect(res.findings[0].hits.email.samples[0]).not.toContain("jane@");
    });
  });

  describe("drupal_report_seo_meta_coverage", () => {
    it("reports per-field coverage and nodes missing all meta", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ id: "1", fields: { field_meta_tags: { value: "<meta>" } } }),
        node({ id: "2", fields: {} }),
      ]));
      const res = await handlers.drupal_report_seo_meta_coverage({ type: "page" });
      expect(res.fields.field_meta_tags.populated).toBe(1);
      expect(res.nodesMissingAllMeta).toBe(1);
    });
  });
});
