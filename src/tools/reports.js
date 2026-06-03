/**
 * Tool group: Audit & reporting.
 *
 * Read-only content/user/SEO/accessibility audits, backend-agnostic (JSON:API
 * or GraphQL). Reports consult backend capabilities and adapt: some mark
 * results `approximate` when exact counts aren't available, and some gate
 * (return a `gatedReport` { unavailable } payload) on backends that lack
 * counts, filters, or revisions. Each handler asserts read access in-handler.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";
import { collectEntities, gatedReport, fieldValue, daysSince } from "../lib/reports-support.js";

// ---------------------------------------------------------------------------
// Report implementations
// ---------------------------------------------------------------------------

/**
 * High-level content summary: node counts by type and status.
 * Per-type counts that the policy blocks are reported as "access_denied"
 * rather than aborting the whole report.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<{site: string, approximate: boolean, grandTotal: number,
 *   byContentType: object[]}>} Inventory sorted by total descending.
 * @throws {SecurityError} If reading nodes is not permitted at all.
 */
async function contentSummary({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", null);
  const backend = await resolveBackend(site);
  const types = await backend.listContentTypes();
  let approximate = false;
  const summary = [];
  for (const ct of types) {
    const type = ct.id;
    try {
      const [pub, unpub, total] = await Promise.all([
        backend.countEntities({ entityType: "node", bundle: type, filters: [{ field: "status", op: "eq", value: true }] }),
        backend.countEntities({ entityType: "node", bundle: type, filters: [{ field: "status", op: "eq", value: false }] }),
        backend.countEntities({ entityType: "node", bundle: type }),
      ]);
      approximate = approximate || pub.approximate || unpub.approximate || total.approximate;
      summary.push({ contentType: type, total: total.count, published: pub.count, unpublished: unpub.count });
    } catch {
      summary.push({ contentType: type, total: "access_denied", published: null, unpublished: null });
    }
  }
  const grandTotal = summary.reduce((s, r) => s + (typeof r.total === "number" ? r.total : 0), 0);
  return {
    site: site._name,
    approximate,
    grandTotal,
    byContentType: summary.sort((a, b) => (b.total || 0) - (a.total || 0)),
  };
}

/**
 * Stale content: nodes not updated within the last N days.
 *
 * @param {object} args - { site?, type?, days?, status?, limit? }. The cutoff
 *   is computed as now minus `days`, then applied as a `changed < cutoff` filter.
 * @returns {Promise<object>} Threshold metadata and the matching node list.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function staleContent({ site: siteName, type, days = 180, status, limit = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const filters = [{ field: "changed", op: "lt", value: cutoff }];
  if (status !== undefined) filters.push({ field: "status", op: "eq", value: status });
  const res = await backend.listEntities({
    entityType: "node", bundle: contentType,
    filters,
    sort: [{ field: "changed", dir: "asc" }],
    page: { limit },
  });
  return {
    contentType,
    stalenessThresholdDays: days,
    cutoffDate: cutoff.slice(0, 10),
    approximate: res.approximate ?? false,
    totalStale: res.page?.total ?? res.entities.length,
    nodes: res.entities.map((n) => ({
      id: n.id,
      title: n.title,
      status: n.status ? "published" : "unpublished",
      changed: n.changed,
      path: n.url,
      daysSinceUpdate: daysSince(n.changed),
    })),
  };
}

/**
 * Content by author: how many nodes each user has created, for one type.
 * Aggregation is by author UUID (resolve names with drupal_get_user).
 *
 * @param {object} args - { site?, type?, limit? }. limit caps nodes scanned.
 * @returns {Promise<object>} Authors sorted by node count descending.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function contentByAuthor({ site: siteName, type, limit = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, include: ["uid"] },
    limit
  );
  const counts = new Map();
  for (const n of entities) {
    const uid = n.relationships?.uid?.id;
    if (!uid) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([authorUuid, nodeCount]) => ({ authorUuid, nodeCount }));
  return {
    contentType,
    scanned: entities.length,
    totalAuthors: rows.length,
    authors: rows,
    note: "Use drupal_get_user to resolve author UUIDs to names.",
  };
}

/**
 * Recently published content of a given type, newest first.
 *
 * @param {object} args - { site?, type?, limit? }.
 * @returns {Promise<object>} The most recently created published nodes.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function recentlyPublished({ site: siteName, type, limit = 20 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({
    entityType: "node", bundle: type || "article",
    filters: [{ field: "status", op: "eq", value: true }],
    sort: [{ field: "created", dir: "desc" }],
    page: { limit },
  });
  return {
    contentType: type || "article",
    approximate: res.approximate ?? false,
    nodes: res.entities.map((n) => ({
      id: n.id,
      title: n.title,
      created: n.created,
      changed: n.changed,
      path: n.url,
    })),
  };
}

/**
 * Field completeness: what % of sampled nodes have optional fields populated.
 * A field absent on every sampled node is treated as "not on this content
 * type" and dropped from the results rather than counted as empty.
 *
 * @param {object} args - { site?, type, fields?, sampleSize? }. `type` is
 *   required; `fields` defaults to common SEO/editorial field names.
 * @returns {Promise<object>} Per-field populated/empty counts and percentages.
 * @throws {Error} If no content type is supplied.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function fieldCompleteness({ site: siteName, type, fields, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  if (!type) throw new Error("fieldCompleteness requires a content type.");
  const backend = await resolveBackend(site);
  const fieldsToCheck = (fields && fields.length)
    ? fields
    : ["body", "summary", "metaDescription", "field_meta_description", "image", "field_image", "tags", "field_tags"];
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: type, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );
  const results = fieldsToCheck.map((field) => {
    let populated = 0, empty = 0, missing = 0;
    for (const e of entities) {
      const v = fieldValue(e, [field]);
      if (v === undefined) {
        missing++;
      } else if (v === null || v === "" || (typeof v === "object" && !v?.value && !(Array.isArray(v) && v.length))) {
        empty++;
      } else {
        populated++;
      }
    }
    const checked = populated + empty;
    return {
      field,
      populated,
      empty,
      notOnContentType: (missing === entities.length && entities.length > 0) ? true : undefined,
      completenessPercent: checked > 0 ? Math.round((populated / checked) * 100) : null,
    };
  }).filter((r) => !r.notOnContentType);
  return {
    contentType: type,
    sampleSize: entities.length,
    approximate: false,
    fields: results.sort((a, b) => (a.completenessPercent ?? 0) - (b.completenessPercent ?? 0)),
  };
}

/**
 * Taxonomy usage: how many nodes reference each term in a vocabulary.
 * Per-term counts that error out are reported as null nodeCount.
 *
 * @param {object} args - { site?, vocabulary, contentType?, referenceField?, limit? }.
 *   `referenceField` defaults to `field_{vocabulary}`; `contentType` to "article".
 * @returns {Promise<object>} Terms sorted by usage, plus an unused-term count.
 * @throws {Error} If no vocabulary is supplied.
 * @throws {SecurityError} If reading the vocabulary is not permitted.
 */
async function taxonomyUsage({ site: siteName, vocabulary, contentType, referenceField, limit = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "taxonomy_term", vocabulary);
  if (!vocabulary) throw new Error("taxonomyUsage requires a vocabulary machine name.");
  const backend = await resolveBackend(site);
  const terms = await collectEntities(
    backend,
    { entityType: "taxonomy_term", bundle: vocabulary, sort: [{ field: "name", dir: "asc" }] },
    limit
  );
  const field = referenceField || `field_${vocabulary}`;
  const ctype = contentType || "article";
  let approximate = false;
  const results = await Promise.all(terms.map(async (term) => {
    try {
      const c = await backend.countEntities({
        entityType: "node", bundle: ctype,
        filters: [{ field: `${field}.id`, op: "eq", value: term.id }],
      });
      approximate = approximate || c.approximate;
      return { id: term.id, name: fieldValue(term, ["name"]) ?? null, nodeCount: c.count };
    } catch {
      return { id: term.id, name: fieldValue(term, ["name"]) ?? null, nodeCount: null };
    }
  }));
  return {
    vocabulary,
    contentType: ctype,
    referenceField: field,
    approximate,
    totalTerms: terms.length,
    unusedTerms: results.filter((r) => r.nodeCount === 0).length,
    terms: results.sort((a, b) => (b.nodeCount ?? -1) - (a.nodeCount ?? -1)),
  };
}

/**
 * Revision hotspots: nodes with the most revisions (heavy edit activity).
 *
 * @param {object} args - { site?, type?, limit? }.
 * @returns {Promise<object>} Nodes sorted by revision count, or a gatedReport
 *   { unavailable } payload when the backend exposes no revisions.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function revisionHotspots({ site: siteName, type, limit = 20 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  if (!backend.capabilities().revisions) {
    return gatedReport(
      "revision_hotspots",
      "graphql",
      "This backend does not expose entity revisions. Use a JSON:API site."
    );
  }
  const contentType = type || "article";
  const recent = await backend.listEntities({
    entityType: "node", bundle: contentType,
    sort: [{ field: "changed", dir: "desc" }],
    page: { limit },
  });
  const nodes = await Promise.all(recent.entities.map(async (node) => {
    try {
      const rev = await backend.rawQuery({
        path: `/jsonapi/node/${contentType}/${node.id}/revisions?page[limit]=1`,
      });
      return {
        id: node.id,
        title: node.title,
        changed: node.changed,
        revisionCount: rev.meta?.count ?? rev.data?.length ?? null,
        path: node.url,
      };
    } catch {
      return { id: node.id, title: node.title, changed: node.changed, revisionCount: null };
    }
  }));
  return {
    contentType,
    note: "Revision counts require Drupal 9.3+ with JSON:API revisions.",
    nodes: nodes.sort((a, b) => (b.revisionCount ?? 0) - (a.revisionCount ?? 0)),
  };
}

/**
 * User activity report: active vs blocked counts, never-logged-in users, and
 * accounts inactive beyond a threshold. Login is a Unix timestamp in seconds,
 * so the cutoff is computed in seconds and rendered back to ISO for output.
 *
 * @param {object} args - { site?, inactiveDays?, limit? }.
 * @returns {Promise<object>} Summary counts plus the inactive-user list, or a
 *   gatedReport { unavailable } payload when login/status aren't exposed.
 * @throws {SecurityError} If reading users is not permitted.
 */
async function userActivity({ site: siteName, inactiveDays = 90, limit = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "user", "user");
  const backend = await resolveBackend(site);
  const available = backend.capabilities().fieldAvailability;
  const fields = typeof available === "function" ? (await available("user", "user")) : null;
  if (fields && (!fields.includes("login") || !fields.includes("status"))) {
    return gatedReport(
      "user_activity",
      "graphql",
      "This backend's user type does not expose login/status. Use a JSON:API site."
    );
  }
  const cutoffTs = Math.floor((Date.now() - inactiveDays * 86400000) / 1000);
  const [active, blocked, neverLoggedIn] = await Promise.all([
    backend.countEntities({ entityType: "user", bundle: "user", filters: [{ field: "status", op: "eq", value: true }] }),
    backend.countEntities({ entityType: "user", bundle: "user", filters: [{ field: "status", op: "eq", value: false }] }),
    backend.countEntities({ entityType: "user", bundle: "user", filters: [{ field: "status", op: "eq", value: true }, { field: "login", op: "eq", value: 0 }] }),
  ]);
  let inactiveUsers = [];
  try {
    const res = await backend.listEntities({
      entityType: "user", bundle: "user",
      filters: [
        { field: "status", op: "eq", value: true },
        { field: "login", op: "lt", value: cutoffTs },
      ],
      sort: [{ field: "login", dir: "asc" }],
      page: { limit },
    });
    inactiveUsers = res.entities.map((u) => ({
      id: u.id,
      name: fieldValue(u, ["name"]),
      lastLogin: fieldValue(u, ["login"])
        ? new Date(fieldValue(u, ["login"]) * 1000).toISOString()
        : "never",
      created: u.created,
    }));
  } catch {
    inactiveUsers = [];
  }
  return {
    summary: {
      activeAccounts: active.count,
      blockedAccounts: blocked.count,
      neverLoggedIn: neverLoggedIn.count,
      inactiveThresholdDays: inactiveDays,
      inactiveCount: inactiveUsers.length,
    },
    inactiveUsers,
  };
}

/**
 * SEO audit: meta-description coverage, title length bounds, and thin content.
 * Word count is computed from body HTML with tags stripped. Title thresholds
 * (>60 too long, <20 too short) and the 300-word thin-content floor are SEO
 * heuristics, not hard Drupal limits.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Issue lists keyed by category, with counts.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function seoAudit({ site: siteName, type, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const issueKeys = ["missingMetaDescription", "titleTooLong", "titleTooShort", "thinContent"];
  const issues = new Map(issueKeys.map((k) => [k, []]));
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );
  for (const n of entities) {
    const title = n.title ?? "";
    const bodyField = fieldValue(n, ["body"]);
    const body = (bodyField && typeof bodyField === "object" ? bodyField.value : bodyField) ?? "";
    const meta = fieldValue(n, ["metaDescription", "field_meta_description", "metatag"]) ?? null;
    const wordCount = String(body).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    if (!meta) issues.get("missingMetaDescription").push({ id: n.id, title });
    if (title.length > 60) issues.get("titleTooLong").push({ id: n.id, title, length: title.length });
    if (title.length < 20) issues.get("titleTooShort").push({ id: n.id, title, length: title.length });
    if (wordCount < 300 && wordCount > 0) issues.get("thinContent").push({ id: n.id, title, wordCount });
  }
  return {
    contentType,
    scanned: entities.length,
    approximate: false,
    issues: Object.fromEntries(issueKeys.map((k) => {
      const list = issues.get(k);
      return [k, { count: list.length, nodes: list }];
    })),
  };
}

/**
 * Accessibility audit of body HTML: images missing alt text, inline H1s,
 * non-descriptive link text, and tables without a caption. Detection is
 * regex-based on the rendered body markup, so it is a heuristic pass, not a
 * full DOM-aware a11y checker.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Issue lists keyed by category, with counts.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function accessibilityAudit({ site: siteName, type, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const issueKeys = ["imagesWithoutAlt", "inlineH1", "nonDescriptiveLinkText", "tablesWithoutCaption"];
  const issues = new Map(issueKeys.map((k) => [k, []]));
  const badLinkText = />\s*(click here|read more|learn more|here|more|link)\s*</i;
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );
  for (const n of entities) {
    const bodyField = fieldValue(n, ["body"]);
    const body = (bodyField && typeof bodyField === "object" ? bodyField.value : bodyField) ?? "";
    const title = n.title;
    if (!body) continue;
    if (/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/i.test(body)) issues.get("imagesWithoutAlt").push({ id: n.id, title });
    if (/<h1/i.test(body)) issues.get("inlineH1").push({ id: n.id, title });
    if (badLinkText.test(body)) issues.get("nonDescriptiveLinkText").push({ id: n.id, title });
    if (/<table/i.test(body) && !/<caption/i.test(body)) issues.get("tablesWithoutCaption").push({ id: n.id, title });
  }
  return {
    contentType,
    scanned: entities.length,
    approximate: false,
    issues: Object.fromEntries(issueKeys.map((k) => {
      const list = issues.get(k);
      return [k, { count: list.length, nodes: list }];
    })),
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_report_content_summary",
    description: "High-level content inventory: total node counts by type and status (published/unpublished). Good first step for any site audit.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_report_stale_content",
    description: "Find content that hasn't been updated in N days. Returns a sorted list with titles, status, and days-since-update.",
    inputSchema: {
      type: "object",
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Content type (default: article)" },
        days:   { type: "number", default: 180, description: "Stale threshold in days" },
        status: { type: "boolean", description: "Filter by publish status" },
        limit:  { type: "number", default: 50 },
      },
    },
  },
  {
    name: "drupal_report_content_by_author",
    description: "Count nodes per author for a given content type. Returns author UUIDs and counts sorted by most prolific.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Content type (default: article)" },
        limit: { type: "number", default: 100, description: "Max nodes to scan" },
      },
    },
  },
  {
    name: "drupal_report_recently_published",
    description: "List the most recently published content of a given type.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Content type (default: article)" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "drupal_report_field_completeness",
    description: "Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc.",
    inputSchema: {
      type: "object", required: ["type"],
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type machine name" },
        fields:     { type: "array", items: { type: "string" }, description: "Field machine names to check. Defaults to common SEO/editorial fields." },
        sampleSize: { type: "number", default: 100, description: "Max nodes to scan" },
      },
    },
  },
  {
    name: "drupal_report_taxonomy_usage",
    description: "Count how many nodes use each term in a vocabulary. Identifies over-used, under-used, and orphaned terms.",
    inputSchema: {
      type: "object", required: ["vocabulary"],
      properties: {
        site:           { type: "string" },
        vocabulary:     { type: "string", description: "Vocabulary machine name, e.g. 'tags', 'category'" },
        contentType:    { type: "string", description: "Content type to count references from (default: article)" },
        referenceField: { type: "string", description: "Field referencing the vocabulary (default: field_{vocabulary})" },
        limit:          { type: "number", default: 100 },
      },
    },
  },
  {
    name: "drupal_report_revision_hotspots",
    description: "Find nodes with the most revision activity — useful for spotting churn or content that needs editorial process review. Requires Drupal 9.3+ JSON:API revisions.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Content type (default: article)" },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "drupal_report_user_activity",
    description: "User activity summary: active vs blocked accounts, never-logged-in users, and users inactive beyond a threshold. Useful for security audits and account hygiene.",
    inputSchema: {
      type: "object",
      properties: {
        site:         { type: "string" },
        inactiveDays: { type: "number", default: 90, description: "Days without login to flag as inactive" },
        limit:        { type: "number", default: 50 },
      },
    },
  },
  {
    name: "drupal_report_seo_audit",
    description: "SEO audit for a content type: missing meta descriptions, title length issues, and thin content (under 300 words). Returns node lists for each issue category.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 100 },
      },
    },
  },
  {
    name: "drupal_report_accessibility_audit",
    description: "Accessibility audit for body content: images without alt text, inline H1 tags, non-descriptive link text ('click here', 'read more'), and tables without captions.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 100 },
      },
    },
  },
];

export const handlers = {
  drupal_report_content_summary:     contentSummary,
  drupal_report_stale_content:       staleContent,
  drupal_report_content_by_author:   contentByAuthor,
  drupal_report_recently_published:  recentlyPublished,
  drupal_report_field_completeness:  fieldCompleteness,
  drupal_report_taxonomy_usage:      taxonomyUsage,
  drupal_report_revision_hotspots:   revisionHotspots,
  drupal_report_user_activity:       userActivity,
  drupal_report_seo_audit:           seoAudit,
  drupal_report_accessibility_audit: accessibilityAudit,
};
