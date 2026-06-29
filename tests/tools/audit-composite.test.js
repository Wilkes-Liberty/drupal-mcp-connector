import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  site: { _name: "d", baseUrl: "https://example.com" },
  reports: {},
  links: {},
  config: {},
  content: {},
}));

vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: vi.fn(() => h.site) }));
vi.mock("../../src/tools/reports.js", () => ({ handlers: h.reports }));
vi.mock("../../src/tools/reports-links.js", () => ({ handlers: h.links }));
vi.mock("../../src/tools/reports-config.js", () => ({ handlers: h.config }));
vi.mock("../../src/tools/reports-content.js", () => ({ handlers: h.content }));

import { handlers, definitions } from "../../src/tools/audit-composite.js";

/** A handler that resolves a fixed value. */
const ok = (v) => vi.fn(async () => v);

beforeEach(() => {
  // Default every composed handler to a benign result.
  h.reports.drupal_report_content_summary = ok({ grandTotal: 10 });
  h.reports.drupal_report_stale_content = ok({ findings: [] });
  h.reports.drupal_report_seo_audit = ok({ issues: {} });
  h.reports.drupal_report_accessibility_audit = ok({ issues: {} });
  h.content.drupal_report_duplicate_content = ok({ duplicateGroups: 0 });
  h.content.drupal_report_readability = ok({ hardToRead: [] });
  h.content.drupal_report_pii_exposure = ok({ flaggedNodes: 0 });
  h.links.drupal_report_broken_links = ok({ summary: { malformed: 0 } });
  h.links.drupal_report_redirect_health = ok({ summary: { duplicateSources: 0, chains: 0, loops: 0 } });
  h.links.drupal_report_alias_coverage = ok({ totalMissingAlias: 0, aliasConflicts: { conflicting: [] } });
  h.links.drupal_report_404_log = ok({ findings: [] });
  h.config.drupal_audit_config_best_practices = ok({ counts: { high: 0, medium: 0, low: 0 } });
  h.config.drupal_report_module_audit = ok({ summary: { devModulesEnabled: 0, securityAdvisories: 0 } });
  h.config.drupal_report_permission_audit = ok({ findings: [], counts: { high: 0 } });
});

describe("audit-composite", () => {
  it("definition names match handler keys", () => {
    expect(definitions.map((d) => d.name)).toEqual(Object.keys(handlers));
  });

  it("grades a clean site A and runs every section", async () => {
    const res = await handlers.drupal_audit_site_health({});
    expect(res.grade).toBe("A");
    expect(res.summary.errored).toBe(0);
    expect(res.summary.unavailable).toBe(0);
    expect(res.summary.sectionsRun).toBe(res.sections.length);
  });

  it("aggregates high-severity findings into a worse grade", async () => {
    h.content.drupal_report_pii_exposure = ok({ flaggedNodes: 4 });
    h.config.drupal_audit_config_best_practices = ok({ counts: { high: 3, medium: 1, low: 0 } });
    const res = await handlers.drupal_audit_site_health({ sections: ["pii_exposure", "config_best_practices"] });
    expect(res.summary.totalHigh).toBe(7);
    expect(res.grade).toBe("F");
  });

  it("records unavailable and errored sections without aborting", async () => {
    h.links.drupal_report_404_log = ok({ unavailable: true, reason: "no source" });
    h.config.drupal_report_module_audit = vi.fn(async () => { throw new Error("boom"); });
    const res = await handlers.drupal_audit_site_health({ sections: ["log_404", "module_audit", "content_summary"] });
    const byKey = Object.fromEntries(res.sections.map((s) => [s.key, s]));
    expect(byKey.log_404.status).toBe("unavailable");
    expect(byKey.module_audit.status).toBe("error");
    expect(byKey.content_summary.status).toBe("ok");
  });

  it("honors the sections allowlist", async () => {
    const res = await handlers.drupal_audit_site_health({ sections: ["content_summary"] });
    expect(res.sections).toHaveLength(1);
    expect(res.sections[0].key).toBe("content_summary");
  });
});
