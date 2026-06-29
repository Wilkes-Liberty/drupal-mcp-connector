/**
 * Tool group: Content quality & governance audits.
 *
 * Read-only, backend-neutral content audits that complement the core reports:
 * duplicate titles, editorial-workflow bottlenecks, translation coverage,
 * scheduled-content state, body readability, orphan pages (no inbound internal
 * links), accidental PII exposure, and structured-meta (SEO) coverage.
 *
 * Each handler asserts read access in-handler, samples via collectEntities, and
 * flags `approximate: true` when the scan is sampling-bounded. Audits that need a
 * field the site doesn't expose (moderation state, scheduler dates, metatag
 * fields) degrade to a `gated`/empty note rather than throwing.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";
import { collectEntities, fieldValue, daysSince } from "../lib/reports-support.js";
import { bodyHtml, extractAnchors, classifyLink, normalizePath } from "../lib/audit-support.js";

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags to plain text and collapse whitespace.
 * @param {string} html Body markup.
 * @returns {string} Plain text.
 */
function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Read a field value as a scalar, unwrapping `{value}` text objects.
 * @param {object} entity Canonical entity.
 * @param {string[]} candidates Field names to try.
 * @returns {*} The scalar value, or undefined.
 */
function scalar(entity, candidates) {
  const v = fieldValue(entity, candidates);
  return v && typeof v === "object" && "value" in v ? v.value : v;
}

// ---------------------------------------------------------------------------
// drupal_report_duplicate_content
// ---------------------------------------------------------------------------

/**
 * Find duplicate / near-duplicate titles within a content type. Titles are
 * normalized (lowercased, punctuation-stripped, whitespace-collapsed) and grouped;
 * groups with more than one member are reported.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Duplicate-title groups.
 */
async function duplicateContent({ site: siteName, type, sampleSize = 200 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );

  const groups = new Map();
  for (const n of nodes) {
    const key = String(n.title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: n.id, title: n.title, path: n.url, status: n.status ? "published" : "unpublished" });
  }
  const duplicates = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ title: g[0].title, count: g.length, nodes: g }))
    .sort((a, b) => b.count - a.count);

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    duplicateGroups: duplicates.length,
    findings: duplicates,
  };
}

// ---------------------------------------------------------------------------
// drupal_report_workflow_bottlenecks
// ---------------------------------------------------------------------------

/**
 * Find content stuck in a non-published moderation state beyond a threshold —
 * editorial bottlenecks. Reads the `moderation_state` field; when the site
 * doesn't expose it, returns a gated note rather than throwing.
 *
 * @param {object} args - { site?, type?, days?, states?, sampleSize? }.
 * @returns {Promise<object>} Stuck-content findings.
 */
async function workflowBottlenecks({ site: siteName, type, days = 30, states, sampleSize = 200 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const targetStates = (states && states.length ? states : ["draft", "needs_review", "review"]).map((s) => s.toLowerCase());

  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "asc" }] },
    sampleSize
  );

  let sawState = false;
  const findings = [];
  for (const n of nodes) {
    const state = scalar(n, ["moderation_state"]);
    if (state === undefined || state === null) continue;
    sawState = true;
    const age = daysSince(n.changed);
    if (targetStates.includes(String(state).toLowerCase()) && age !== null && age > days) {
      findings.push({ id: n.id, title: n.title, state, daysInState: age, path: n.url });
    }
  }

  if (!sawState) {
    return { contentType, gated: true, reason: "No moderation_state field exposed (content_moderation not enabled or not in the API).", scanned: nodes.length };
  }
  return {
    contentType,
    thresholdDays: days,
    states: targetStates,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    totalStuck: findings.length,
    findings: findings.sort((a, b) => b.daysInState - a.daysInState),
  };
}

// ---------------------------------------------------------------------------
// drupal_report_translation_coverage
// ---------------------------------------------------------------------------

/**
 * Report content distribution by language for a content type and flag languages
 * that lag the most-populated language — a coverage signal for multilingual
 * sites. (Exact per-node missing-translation detection requires translation
 * metadata the canonical model doesn't carry; this aggregate is the best-effort
 * stand-in.)
 *
 * @param {object} args - { site?, type?, gapThreshold?, sampleSize? }.
 * @returns {Promise<object>} Per-language counts and lagging languages.
 */
async function translationCoverage({ site: siteName, type, gapThreshold = 0.5, sampleSize = 500 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );

  const byLang = new Map();
  for (const n of nodes) {
    const lang = n.langcode || "und";
    byLang.set(lang, (byLang.get(lang) || 0) + 1);
  }
  const counts = [...byLang.entries()].map(([langcode, count]) => ({ langcode, count })).sort((a, b) => b.count - a.count);
  const top = counts[0]?.count ?? 0;
  const lagging = counts
    .filter((c) => top > 0 && c.count / top < gapThreshold)
    .map((c) => ({ langcode: c.langcode, count: c.count, coverage: Number((c.count / top).toFixed(2)) }));

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    languages: counts,
    laggingLanguages: lagging,
    note: "Coverage is a distribution-by-language signal; exact per-node missing translations require translation metadata not in the canonical model.",
  };
}

// ---------------------------------------------------------------------------
// drupal_report_scheduled_content
// ---------------------------------------------------------------------------

/**
 * Report content with Scheduler publish/unpublish dates set, split into pending
 * (date in the future) and overdue (date in the past but the action hasn't run).
 * Gated when the scheduler fields aren't exposed.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Pending and overdue scheduled items.
 */
async function scheduledContent({ site: siteName, type, sampleSize = 200 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );

  const now = Date.now();
  let sawField = false;
  const pending = [];
  const overdue = [];
  for (const n of nodes) {
    for (const [field, action] of [["publish_on", "publish"], ["unpublish_on", "unpublish"]]) {
      const raw = scalar(n, [field]);
      if (raw === undefined || raw === null || raw === "" || raw === 0) continue;
      sawField = true;
      const ms = toMillis(raw);
      if (ms === null) continue;
      const rec = { id: n.id, title: n.title, action, when: new Date(ms).toISOString(), path: n.url };
      if (ms > now) pending.push(rec);
      else overdue.push(rec);
    }
  }

  if (!sawField) {
    return { contentType, gated: true, reason: "No Scheduler publish_on/unpublish_on fields exposed.", scanned: nodes.length };
  }
  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    summary: { pending: pending.length, overdue: overdue.length },
    findings: { pending, overdue },
  };
}

/**
 * Coerce a scheduler date value (unix seconds, ms, or ISO string) to epoch ms.
 * @param {*} raw Field value.
 * @returns {?number} Epoch milliseconds, or null.
 */
function toMillis(raw) {
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const n = Number(raw);
  if (!Number.isNaN(n) && raw !== "") return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// drupal_report_readability
// ---------------------------------------------------------------------------

/**
 * Score body readability (Flesch Reading Ease) for a content type and flag
 * hard-to-read content plus structural issues (no H2 subheadings, multiple H1s).
 *
 * @param {object} args - { site?, type?, sampleSize?, hardThreshold? }.
 * @returns {Promise<object>} Per-node scores and aggregate.
 */
async function readability({ site: siteName, type, sampleSize = 100, hardThreshold = 30 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );

  const scored = [];
  const hard = [];
  const structural = [];
  for (const n of nodes) {
    const html = bodyHtml(n);
    if (!html) continue;
    const text = stripTags(html);
    if (text.length < 40) continue;
    const score = fleschReadingEase(text);
    scored.push({ id: n.id, title: n.title, score });
    if (score < hardThreshold) hard.push({ id: n.id, title: n.title, score });
    const issues = [];
    if (!/<h2/i.test(html)) issues.push("no H2 subheadings");
    if ((html.match(/<h1/gi) || []).length > 1) issues.push("multiple H1s");
    if (issues.length) structural.push({ id: n.id, title: n.title, issues });
  }

  const avg = scored.length ? Number((scored.reduce((s, r) => s + r.score, 0) / scored.length).toFixed(1)) : null;
  return {
    contentType,
    scanned: nodes.length,
    analyzed: scored.length,
    approximate: nodes.length >= sampleSize,
    averageScore: avg,
    hardToRead: hard.sort((a, b) => a.score - b.score),
    structuralIssues: structural,
    note: "Flesch Reading Ease: 90-100 very easy, 60-70 standard, 0-30 very difficult.",
  };
}

/**
 * Estimate the Flesch Reading Ease of a block of plain text.
 * @param {string} text Plain text.
 * @returns {number} Score, rounded to one decimal (clamped to [0, 120]).
 */
function fleschReadingEase(text) {
  const sentences = Math.max(1, (text.match(/[.!?]+/g) || []).length);
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = Math.max(1, words.length);
  const syllables = words.reduce((s, w) => s + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
  return Number(Math.max(0, Math.min(120, score)).toFixed(1));
}

/**
 * Estimate the syllable count of a word by counting vowel groups.
 * @param {string} word A single word.
 * @returns {number} Estimated syllables (at least 1).
 */
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) || [];
  let count = groups.length;
  if (w.endsWith("e") && count > 1) count--; // silent trailing e
  return Math.max(1, count);
}

// ---------------------------------------------------------------------------
// drupal_report_orphan_pages
// ---------------------------------------------------------------------------

/**
 * Find published pages with no inbound internal links from other sampled pages —
 * "content islands". Best-effort over the sampled set: a node is orphaned if its
 * path is never targeted by another node's body link.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Orphan pages.
 */
async function orphanPages({ site: siteName, type, sampleSize = 200 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const baseUrl = site.baseUrl;
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );

  // Collect every internal link target across the sample.
  const targeted = new Set();
  for (const n of nodes) {
    for (const href of extractAnchors(bodyHtml(n))) {
      const c = classifyLink(href, baseUrl);
      if (c.kind === "internal" && c.path) targeted.add(c.path);
    }
  }
  const orphans = nodes
    .filter((n) => typeof n.url === "string" && !targeted.has(normalizePath(n.url)))
    .map((n) => ({ id: n.id, title: n.title, path: n.url }));

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    totalOrphans: orphans.length,
    findings: orphans,
    note: "Best-effort over the sampled set — inbound links from outside the sample are not counted.",
  };
}

// ---------------------------------------------------------------------------
// drupal_report_pii_exposure
// ---------------------------------------------------------------------------

const PII_PATTERNS = new Map([
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["phone", /\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g],
]);

/**
 * Scan published body content for accidentally exposed PII (emails, US SSNs,
 * phone numbers). Matched values are masked in the output so the report itself
 * doesn't leak the data.
 *
 * @param {object} args - { site?, type?, sampleSize?, kinds? }.
 * @returns {Promise<object>} PII findings, masked.
 */
async function piiExposure({ site: siteName, type, sampleSize = 100, kinds }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const active = (kinds && kinds.length ? kinds : [...PII_PATTERNS.keys()]).filter((k) => PII_PATTERNS.has(k));
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );

  const totals = new Map(active.map((k) => [k, 0]));
  const findings = [];
  for (const n of nodes) {
    const text = stripTags(bodyHtml(n));
    if (!text) continue;
    const hits = new Map();
    for (const kind of active) {
      const matches = text.match(PII_PATTERNS.get(kind)) || [];
      if (matches.length) {
        totals.set(kind, totals.get(kind) + matches.length);
        hits.set(kind, { count: matches.length, samples: [...new Set(matches)].slice(0, 3).map((m) => maskPii(kind, m)) });
      }
    }
    if (hits.size) findings.push({ id: n.id, title: n.title, path: n.url, hits: Object.fromEntries(hits) });
  }

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    totals: Object.fromEntries(totals),
    flaggedNodes: findings.length,
    findings,
    note: "Matched values are masked. Review flagged nodes for content that should not be public.",
  };
}

/**
 * Mask a PII value so it can be reported without re-exposing it.
 * @param {string} kind PII kind.
 * @param {string} value The matched value.
 * @returns {string} A masked representation.
 */
function maskPii(kind, value) {
  if (kind === "email") {
    const [user, domain] = value.split("@");
    return `${user.slice(0, 1)}***@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  return `***${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// drupal_report_seo_meta_coverage
// ---------------------------------------------------------------------------

/** Default fields that indicate structured meta coverage. */
const DEFAULT_META_FIELDS = ["field_meta_tags", "field_metatag", "metatag", "field_meta_description"];

/**
 * Report structured-meta (SEO) coverage for a content type: how many sampled
 * nodes populate each meta field (metatag module, meta description, etc.).
 * Complements drupal_report_seo_audit's heuristic checks with explicit
 * per-field coverage.
 *
 * @param {object} args - { site?, type?, fields?, sampleSize? }.
 * @returns {Promise<object>} Per-field coverage and nodes missing all meta.
 */
async function seoMetaCoverage({ site: siteName, type, fields, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const metaFields = fields && fields.length ? fields : DEFAULT_META_FIELDS;
  const nodes = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );

  const coverage = new Map(metaFields.map((f) => [f, { populated: 0, present: false }]));
  const missingAll = [];
  for (const n of nodes) {
    let any = false;
    for (const f of metaFields) {
      const stat = coverage.get(f);
      const v = fieldValue(n, [f]);
      if (v !== undefined) stat.present = true;
      if (!isEmpty(v)) { stat.populated++; any = true; }
    }
    if (!any) missingAll.push({ id: n.id, title: n.title, path: n.url });
  }

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    fields: Object.fromEntries(metaFields.map((f) => {
      const stat = coverage.get(f);
      return [f, {
        present: stat.present,
        populated: stat.populated,
        coverage: nodes.length ? Number((stat.populated / nodes.length).toFixed(2)) : 0,
      }];
    })),
    nodesMissingAllMeta: missingAll.length,
    findings: missingAll,
  };
}

/**
 * Whether a field value counts as empty (scalar, {value} object, array, ref).
 * @param {*} v Field value.
 * @returns {boolean}
 */
function isEmpty(v) {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    if ("value" in v) return v.value === undefined || v.value === null || v.value === "";
    if ("id" in v) return !v.id;
    return Object.keys(v).length === 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_report_duplicate_content",
    description: "Find duplicate / near-duplicate titles within a content type (normalized title grouping). Surfaces accidental re-publishing and content cannibalization.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 200, description: "Max nodes to scan" },
      },
    },
  },
  {
    name: "drupal_report_workflow_bottlenecks",
    description: "Find content stuck in a non-published moderation state (draft/needs_review) beyond N days — editorial bottlenecks. Reads moderation_state; gated when content_moderation isn't exposed.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        days:       { type: "number", default: 30, description: "Days-in-state threshold" },
        states:     { type: "array", items: { type: "string" }, description: "Moderation states to treat as bottlenecks" },
        sampleSize: { type: "number", default: 200 },
      },
    },
  },
  {
    name: "drupal_report_translation_coverage",
    description: "Report content distribution by language for a content type and flag languages lagging the most-populated language — a multilingual coverage signal.",
    inputSchema: {
      type: "object",
      properties: {
        site:         { type: "string" },
        type:         { type: "string", description: "Content type (default: article)" },
        gapThreshold: { type: "number", default: 0.5, description: "Flag languages below this fraction of the top language" },
        sampleSize:   { type: "number", default: 500 },
      },
    },
  },
  {
    name: "drupal_report_scheduled_content",
    description: "Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Gated when scheduler fields aren't exposed.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 200 },
      },
    },
  },
  {
    name: "drupal_report_readability",
    description: "Score body readability (Flesch Reading Ease) for a content type and flag hard-to-read content and structural issues (no H2 subheadings, multiple H1s).",
    inputSchema: {
      type: "object",
      properties: {
        site:          { type: "string" },
        type:          { type: "string", description: "Content type (default: article)" },
        sampleSize:    { type: "number", default: 100 },
        hardThreshold: { type: "number", default: 30, description: "Flag content scoring below this" },
      },
    },
  },
  {
    name: "drupal_report_orphan_pages",
    description: "Find published pages with no inbound internal links from other sampled pages — content islands. Best-effort over the sampled set.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 200 },
      },
    },
  },
  {
    name: "drupal_report_pii_exposure",
    description: "Scan published body content for accidentally exposed PII (emails, US SSNs, phone numbers). Matched values are masked in the output so the report itself doesn't leak data.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 100 },
        kinds:      { type: "array", items: { type: "string", enum: ["email", "ssn", "phone"] }, description: "PII kinds to scan (default: all)" },
      },
    },
  },
  {
    name: "drupal_report_seo_meta_coverage",
    description: "Report structured-meta (SEO) coverage for a content type: how many sampled nodes populate each meta field (metatag, meta description). Complements drupal_report_seo_audit with explicit per-field coverage.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        fields:     { type: "array", items: { type: "string" }, description: "Meta field machine names to check" },
        sampleSize: { type: "number", default: 100 },
      },
    },
  },
];

export const handlers = {
  drupal_report_duplicate_content:     duplicateContent,
  drupal_report_workflow_bottlenecks:  workflowBottlenecks,
  drupal_report_translation_coverage:  translationCoverage,
  drupal_report_scheduled_content:     scheduledContent,
  drupal_report_readability:           readability,
  drupal_report_orphan_pages:          orphanPages,
  drupal_report_pii_exposure:          piiExposure,
  drupal_report_seo_meta_coverage:     seoMetaCoverage,
};
