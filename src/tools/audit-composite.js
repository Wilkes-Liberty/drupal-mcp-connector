/**
 * Tool group: Composite site-health audit.
 *
 * `drupal_audit_site_health` runs a configurable battery of the individual audit
 * tools (content + links + config) and rolls their results into one scored
 * dashboard. Each section runs independently: a section that throws or returns a
 * gated/unavailable payload is recorded as such and does not abort the others, so
 * the dashboard is always returned. The roll-up grade reflects only the sections
 * that produced findings.
 *
 * This module composes the other tool groups' handlers rather than re-querying
 * the backend, so its behavior always matches the standalone tools.
 */

import { getSiteConfig } from "../lib/config.js";
import * as reports from "./reports.js";
import * as reportsLinks from "./reports-links.js";
import * as reportsConfig from "./reports-config.js";
import * as reportsContent from "./reports-content.js";

/**
 * The audit battery. Each section names its group, the handler to run, the args
 * to pass (derived from the composite's options), and a scorer that extracts an
 * `{ issues, high }` signal from the section's result.
 */
const SECTIONS = [
  // Content
  { key: "content_summary", group: "content", run: (o) => reports.handlers.drupal_report_content_summary({ site: o.site }), score: () => ({ issues: 0, high: 0 }) },
  { key: "stale_content", group: "content", run: (o) => reports.handlers.drupal_report_stale_content({ site: o.site, type: o.type, days: 180, limit: o.sampleSize }), score: (r) => ({ issues: (r.findings || r.nodes || []).length, high: 0 }) },
  { key: "seo_audit", group: "content", run: (o) => reports.handlers.drupal_report_seo_audit({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: sumIssueCounts(r.issues), high: 0 }) },
  { key: "accessibility", group: "content", run: (o) => reports.handlers.drupal_report_accessibility_audit({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: sumIssueCounts(r.issues), high: 0 }) },
  { key: "duplicate_content", group: "content", run: (o) => reportsContent.handlers.drupal_report_duplicate_content({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: r.duplicateGroups || 0, high: 0 }) },
  { key: "readability", group: "content", run: (o) => reportsContent.handlers.drupal_report_readability({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: (r.hardToRead || []).length, high: 0 }) },
  { key: "pii_exposure", group: "content", run: (o) => reportsContent.handlers.drupal_report_pii_exposure({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: r.flaggedNodes || 0, high: r.flaggedNodes || 0 }) },
  // Links
  { key: "broken_links", group: "links", run: (o) => reportsLinks.handlers.drupal_report_broken_links({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: r.summary?.malformed || 0, high: 0 }) },
  { key: "redirect_health", group: "links", run: (o) => reportsLinks.handlers.drupal_report_redirect_health({ site: o.site }), score: (r) => ({ issues: (r.summary?.duplicateSources || 0) + (r.summary?.chains || 0) + (r.summary?.loops || 0), high: r.summary?.loops || 0 }) },
  { key: "alias_coverage", group: "links", run: (o) => reportsLinks.handlers.drupal_report_alias_coverage({ site: o.site, type: o.type, sampleSize: o.sampleSize }), score: (r) => ({ issues: (r.totalMissingAlias || 0) + (r.aliasConflicts?.conflicting?.length || 0), high: 0 }) },
  { key: "log_404", group: "links", run: (o) => reportsLinks.handlers.drupal_report_404_log({ site: o.site }), score: (r) => ({ issues: (r.findings || []).length, high: 0 }) },
  // Config
  { key: "config_best_practices", group: "config", run: (o) => reportsConfig.handlers.drupal_audit_config_best_practices({ site: o.site }), score: (r) => ({ issues: (r.counts?.high || 0) + (r.counts?.medium || 0) + (r.counts?.low || 0), high: r.counts?.high || 0 }) },
  { key: "module_audit", group: "config", run: (o) => reportsConfig.handlers.drupal_report_module_audit({ site: o.site }), score: (r) => ({ issues: (r.summary?.devModulesEnabled || 0) + (r.summary?.securityAdvisories || 0), high: r.summary?.securityAdvisories || 0 }) },
  { key: "permission_audit", group: "config", run: (o) => reportsConfig.handlers.drupal_report_permission_audit({ site: o.site }), score: (r) => ({ issues: (r.findings || []).length, high: r.counts?.high || 0 }) },
];

const SECTION_KEYS = SECTIONS.map((s) => s.key);

/**
 * Sum the `count` values out of an seo/accessibility audit's `issues` map.
 * @param {object} issues The audit's keyed issues object.
 * @returns {number} Total issue count.
 */
function sumIssueCounts(issues) {
  if (!issues || typeof issues !== "object") return 0;
  return Object.values(issues).reduce((sum, v) => sum + (v?.count || 0), 0);
}

/**
 * Whether a section result is a gated/unavailable payload.
 * @param {object} r A section result.
 * @returns {boolean}
 */
function isGated(r) {
  return Boolean(r && (r.unavailable === true || r.gated === true));
}

/**
 * Convert aggregate high/issue counts into a letter grade.
 * @param {number} high Total high-severity findings.
 * @param {number} issues Total findings.
 * @returns {"A"|"B"|"C"|"D"|"F"} Roll-up grade.
 */
function grade(high, issues) {
  if (high === 0 && issues === 0) return "A";
  if (high === 0 && issues <= 5) return "B";
  if (high <= 2) return "C";
  if (high <= 5) return "D";
  return "F";
}

/**
 * Run a battery of audits and roll the results into a scored dashboard.
 *
 * @param {object} args - { site?, type?, sampleSize?, sections? }.
 * @returns {Promise<object>} The dashboard: per-section status + a roll-up grade.
 */
async function siteHealth({ site: siteName, type = "article", sampleSize = 50, sections }) {
  const site = getSiteConfig(siteName);
  const selected = sections && sections.length
    ? SECTIONS.filter((s) => sections.includes(s.key))
    : SECTIONS;
  const opts = { site: site._name, type, sampleSize };

  const results = [];
  let totalHigh = 0;
  let totalIssues = 0;
  for (const section of selected) {
    try {
      const result = await section.run(opts);
      if (isGated(result)) {
        results.push({ key: section.key, group: section.group, status: "unavailable", reason: result.reason || result.attempts?.join("; ") || null });
        continue;
      }
      const { issues, high } = section.score(result);
      totalHigh += high;
      totalIssues += issues;
      results.push({ key: section.key, group: section.group, status: "ok", issues, high, result });
    } catch (err) {
      results.push({ key: section.key, group: section.group, status: "error", error: err?.message || String(err) });
    }
  }

  const byStatus = (s) => results.filter((r) => r.status === s).length;
  return {
    site: site._name,
    type,
    grade: grade(totalHigh, totalIssues),
    summary: {
      sectionsRun: results.length,
      ok: byStatus("ok"),
      unavailable: byStatus("unavailable"),
      errored: byStatus("error"),
      totalHigh,
      totalIssues,
    },
    sections: results,
  };
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_audit_site_health",
    description: "Composite site-health dashboard: runs a battery of content, link, and configuration audits and rolls them into one scored report with a letter grade. Each section degrades independently — gated/errored sections are recorded, not fatal. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Primary content type for content/link sections (default: article)" },
        sampleSize: { type: "number", default: 50, description: "Per-section scan cap (kept small for a fast roll-up)" },
        sections:   { type: "array", items: { type: "string", enum: SECTION_KEYS }, description: `Subset of sections to run (default: all). Available: ${SECTION_KEYS.join(", ")}` },
      },
    },
  },
];

export const handlers = {
  drupal_audit_site_health: siteHealth,
};
