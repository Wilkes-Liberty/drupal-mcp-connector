/**
 * Tool group: Link & 404 integrity audits.
 *
 * Read-only audits of a site's link health: the 404 log (top missing URLs →
 * redirect candidates), redirect-table integrity (chains/loops/duplicates), body
 * link inventory with optional live checking, URL-alias coverage, menu-link
 * integrity, and embedded-entity references. Backend-neutral where the data
 * lives in entities (redirect / path_alias / menu_link_content / node body);
 * self-sufficient via the connector's own drush bridge where the data lives in
 * the dblog (404 log). No companion module is required.
 *
 * Each handler asserts read access in-handler, returns a `gatedReport` payload
 * (never throws) when its source is unavailable, and flags `approximate`/
 * `truncated` when sampling- or cap-bounded. Live HTTP checking is OFF unless the
 * caller passes `checkLive: true`.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";
import { collectEntities, gatedReport, fieldValue } from "../lib/reports-support.js";
import { runPrivileged } from "../lib/audit-sources.js";
import { sshDrush, parseDrush } from "./drush.js";
import {
  bodyHtml, extractAnchors, extractImages, extractEmbeds,
  classifyLink, normalizePath, hostOf,
} from "../lib/audit-support.js";
import { checkLinks } from "../lib/link-checker.js";

// ---------------------------------------------------------------------------
// Field-reading helpers (best-effort across canonical shapes)
// ---------------------------------------------------------------------------

/**
 * Read a "uri-ish" scalar from a canonical field value, tolerating the shapes
 * JSON:API and GraphQL produce: a bare string, a `{value}` text object, or a
 * link/path object (`{uri}` / `{path}` / `{alias}`).
 * @param {*} v A field value read off an entity.
 * @returns {?string} The best scalar, or null.
 */
function scalarUri(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.uri ?? v.value ?? v.path ?? v.alias ?? null;
  return String(v);
}

/**
 * Normalize a redirect/menu target URI into an internal path when it points
 * inside the site, else return null. Handles `internal:/x`, `entity:node/1`,
 * `route:...`, root-relative `/x`, and absolute same-host URLs.
 * @param {?string} uri Raw target uri.
 * @param {?string} baseHost The site host, for same-host detection.
 * @returns {?string} A normalized internal path, or null for external/unknown.
 */
function internalTarget(uri, baseHost) {
  if (!uri) return null;
  if (uri.startsWith("internal:")) return normalizePath(uri.slice("internal:".length));
  if (uri.startsWith("entity:")) return `/${uri.slice("entity:".length).replace(/^\/+/, "")}`;
  if (uri.startsWith("/") && !uri.startsWith("//")) return normalizePath(uri);
  if (/^https?:\/\//i.test(uri)) {
    try {
      const u = new URL(uri);
      if (baseHost && u.host.toLowerCase() === baseHost.toLowerCase()) return normalizePath(u.pathname);
    } catch { /* fall through */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// drupal_report_404_log
// ---------------------------------------------------------------------------

/**
 * Aggregate Drupal "page not found" events into the top missing URLs, ranked by
 * hit count — the classic 404 audit and a redirect-candidate list.
 * Self-sufficient via the connector's drush bridge (`drush watchdog:show`
 * filtered to the "page not found" type); gated when drush isn't configured.
 *
 * @param {object} args - { site?, limit? }.
 * @returns {Promise<object>} Ranked missing paths, or a gated payload.
 */
async function log404({ site: siteName, limit = 25 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", null);
  const max = Math.min(Number(limit) || 25, 200);

  const res = await runPrivileged(site, {
    drush: async () => {
      // dblog records 404s under the "page not found" type; the message/location
      // carries the requested path. Filter client-side and aggregate.
      const out = await sshDrush(site, [
        "watchdog:show", "--format=json", "--type=page not found", `--count=${max * 4}`,
      ]);
      return parseDrush(out);
    },
  });

  if (!res.source) {
    return gatedReport("report_404_log", "drush", res.attempts.join("; "));
  }

  const counts = new Map();
  for (const row of normalizeLogRows(res.data)) {
    const path = pick404Path(row);
    if (!path) continue;
    counts.set(path, (counts.get(path) || 0) + (Number(row.count) || 1));
  }
  const ranked = [...counts.entries()]
    .map(([path, hits]) => ({ path, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max);

  return {
    site: site._name,
    source: res.source,
    distinctPaths: counts.size,
    note: "Top missing URLs are candidates for new redirects (drupal_create_redirect).",
    findings: ranked,
  };
}

/**
 * Coerce a server-tool / drush log result into an array of row objects.
 * @param {*} data Result payload.
 * @returns {object[]} Rows (possibly empty).
 */
function normalizeLogRows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.entries)) return data.entries;
  if (Array.isArray(data.findings)) return data.findings;
  if (typeof data === "object") return Object.values(data).filter((v) => v && typeof v === "object");
  return [];
}

/**
 * Extract the requested path from a 404 log row, trying the common field names
 * dblog/Sentinel expose (path/location/message/url).
 * @param {object} row A normalized log row.
 * @returns {?string} The path, or null.
 */
function pick404Path(row) {
  const raw = row.path ?? row.location ?? row.url ?? row.message ?? null;
  if (!raw || typeof raw !== "string") return null;
  // dblog "page not found" messages are sometimes the bare path already.
  const candidate = raw.trim();
  if (candidate.startsWith("/")) return normalizePath(candidate);
  if (/^https?:\/\//i.test(candidate)) {
    try { return normalizePath(new URL(candidate).pathname); } catch { return null; }
  }
  return normalizePath(`/${candidate}`);
}

// ---------------------------------------------------------------------------
// drupal_report_redirect_health
// ---------------------------------------------------------------------------

/**
 * Audit the Redirect module's table for structural problems: duplicate sources,
 * self-redirects, and redirect chains/loops (a redirect whose target is itself
 * another redirect's source). Derived entirely from the redirect entity list, so
 * it is deterministic; gated when the `redirect` resource isn't exposed.
 *
 * @param {object} args - { site?, limit? }.
 * @returns {Promise<object>} Structural findings, or a gated payload.
 */
async function redirectHealth({ site: siteName, limit = 1000 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "redirect", null);
  const backend = await resolveBackend(site);
  const baseHost = hostOf(site.baseUrl);

  let entities;
  try {
    entities = await collectEntities(backend, { entityType: "redirect", bundle: "redirect" }, limit);
  } catch (err) {
    return gatedReport("report_redirect_health", backend.capabilities?.()?.name || "backend",
      `redirect entity not listable: ${err?.message || err}`);
  }

  const redirects = entities.map((e) => {
    const src = fieldValue(e, ["redirect_source"]);
    const sourcePath = normalizePath(scalarUri(src) ?? (src && typeof src === "object" ? src.path : "") ?? "");
    const targetUri = scalarUri(fieldValue(e, ["redirect_redirect"]));
    return {
      id: e.id,
      source: sourcePath,
      targetUri,
      targetPath: internalTarget(targetUri, baseHost),
      statusCode: fieldValue(e, ["status_code"]) ?? null,
    };
  });

  // Duplicate sources: the same source path defined by more than one redirect.
  const bySource = new Map();
  for (const r of redirects) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
  }
  const duplicateSources = [...bySource.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([source, list]) => ({ source, count: list.length, ids: list.map((r) => r.id) }));

  // Self-redirects: source === internal target.
  const selfRedirects = redirects
    .filter((r) => r.targetPath && r.targetPath === r.source)
    .map((r) => ({ id: r.id, source: r.source }));

  // Chains/loops: target path is itself another redirect's source. Follow each
  // chain to a max depth to classify as a chain (multi-hop) or a loop (cycle).
  const sourceSet = new Set(redirects.map((r) => r.source));
  const chains = [];
  const loops = [];
  for (const r of redirects) {
    if (!r.targetPath || !sourceSet.has(r.targetPath) || r.targetPath === r.source) continue;
    const path = [r.source];
    let cur = r.targetPath;
    let looped = false;
    for (let hop = 0; hop < 10 && cur; hop++) {
      if (path.includes(cur)) { looped = true; path.push(cur); break; }
      path.push(cur);
      const next = bySource.get(cur)?.[0];
      if (!next || !next.targetPath) break;
      cur = next.targetPath;
    }
    if (looped) loops.push({ id: r.id, chain: path });
    else if (path.length > 2) chains.push({ id: r.id, chain: path });
  }

  return {
    site: site._name,
    totalRedirects: redirects.length,
    approximate: redirects.length >= limit,
    summary: {
      duplicateSources: duplicateSources.length,
      selfRedirects: selfRedirects.length,
      chains: chains.length,
      loops: loops.length,
    },
    findings: { duplicateSources, selfRedirects, chains, loops },
  };
}

// ---------------------------------------------------------------------------
// drupal_report_broken_links
// ---------------------------------------------------------------------------

/**
 * Inventory the links in published body content and, when `checkLive` is set,
 * verify them with bounded outbound HTTP. Without `checkLive` (the default), no
 * network egress happens: the report lists internal/external links and images,
 * aggregates external hosts, and flags obviously malformed hrefs.
 *
 * @param {object} args - { site?, type?, sampleSize?, checkLive?, includeExternal? }.
 * @returns {Promise<object>} Link inventory plus optional live results.
 */
async function brokenLinks({ site: siteName, type, sampleSize = 100, checkLive = false, includeExternal = false }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const baseUrl = site.baseUrl;
  const baseHost = hostOf(baseUrl);

  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );

  let internal = 0, external = 0, fragments = 0, malformed = 0;
  const externalHosts = new Map();
  const liveTargets = new Set();
  const malformedLinks = [];

  for (const n of entities) {
    const html = bodyHtml(n);
    if (!html) continue;
    for (const href of [...extractAnchors(html), ...extractImages(html)]) {
      const c = classifyLink(href, baseUrl);
      if (c.kind === "internal") {
        internal++;
        if (c.path) liveTargets.add(`${baseUrl.replace(/\/+$/, "")}${c.path}`);
      } else if (c.kind === "external") {
        external++;
        externalHosts.set(c.host, (externalHosts.get(c.host) || 0) + 1);
        if (includeExternal) liveTargets.add(c.url);
      } else if (c.kind === "fragment") {
        fragments++;
      } else if (c.kind === "other") {
        malformed++;
        if (malformedLinks.length < 50) malformedLinks.push({ id: n.id, title: n.title, href });
      }
    }
  }

  const result = {
    contentType,
    scanned: entities.length,
    approximate: entities.length >= sampleSize,
    summary: { internal, external, fragments, malformed },
    externalHosts: [...externalHosts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count),
    malformedLinks,
    liveChecked: false,
  };

  if (!checkLive) {
    result.note = "Inventory only — pass checkLive:true to verify links with bounded outbound HTTP.";
    return result;
  }

  const live = await checkLinks([...liveTargets], {
    internalHost: baseHost,
    allowedHosts: site.audit?.linkCheckAllowedHosts ?? [],
    maxConcurrency: site.audit?.linkCheckConcurrency,
    timeoutMs: site.audit?.linkCheckTimeoutMs,
    maxLinks: site.audit?.linkCheckMaxLinks,
  });
  result.liveChecked = true;
  result.live = {
    checked: live.checked,
    truncated: live.truncated,
    broken: live.results.filter((r) => !r.ok && !r.skipped),
    skipped: live.results.filter((r) => r.skipped).length,
  };
  return result;
}

// ---------------------------------------------------------------------------
// drupal_report_alias_coverage
// ---------------------------------------------------------------------------

/**
 * URL-alias coverage for a content type: nodes with no alias (their canonical
 * URL is still `/node/N`), plus duplicate/conflicting aliases drawn from the
 * `path_alias` entity when it is exposed. The missing-alias check needs only the
 * node list; the duplicate check degrades gracefully when `path_alias` isn't
 * listable.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Alias-coverage findings.
 */
async function aliasCoverage({ site: siteName, type, sampleSize = 200 }) {
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
  const missingAlias = nodes
    .filter((n) => typeof n.url === "string" && /^\/node\/\d+$/.test(normalizePath(n.url)))
    .map((n) => ({ id: n.id, title: n.title, path: n.url, status: n.status ? "published" : "unpublished" }));

  // Duplicate/conflicting aliases (best-effort; gated softly if unavailable).
  let aliasIssues = { available: false };
  try {
    const aliases = await collectEntities(backend, { entityType: "path_alias", bundle: "path_alias" }, 2000);
    const byAlias = new Map();
    for (const a of aliases) {
      const alias = normalizePath(scalarUri(fieldValue(a, ["alias"])) ?? "");
      const target = normalizePath(scalarUri(fieldValue(a, ["path"])) ?? "");
      if (!byAlias.has(alias)) byAlias.set(alias, new Set());
      byAlias.get(alias).add(target);
    }
    const conflicting = [...byAlias.entries()]
      .filter(([, targets]) => targets.size > 1)
      .map(([alias, targets]) => ({ alias, targets: [...targets] }));
    aliasIssues = { available: true, totalAliases: aliases.length, conflicting };
  } catch (err) {
    aliasIssues = { available: false, reason: `path_alias not listable: ${err?.message || err}` };
  }

  return {
    contentType,
    scanned: nodes.length,
    approximate: nodes.length >= sampleSize,
    totalMissingAlias: missingAlias.length,
    missingAlias,
    aliasConflicts: aliasIssues,
  };
}

// ---------------------------------------------------------------------------
// drupal_report_menu_integrity
// ---------------------------------------------------------------------------

/**
 * Audit custom menu links (`menu_link_content`): disabled links, links with no
 * usable target (empty / `route:<nojs>` placeholders), and external links. Deep
 * target-existence resolution is noted as gated on a future server-tool, since
 * menu targets address entities by internal id which JSON:API can't probe by
 * UUID.
 *
 * @param {object} args - { site?, limit? }.
 * @returns {Promise<object>} Menu-link findings, or a gated payload.
 */
async function menuIntegrity({ site: siteName, limit = 1000 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "menu_link_content", null);
  const backend = await resolveBackend(site);
  const baseHost = hostOf(site.baseUrl);

  let links;
  try {
    links = await collectEntities(backend, { entityType: "menu_link_content", bundle: "menu_link_content" }, limit);
  } catch (err) {
    return gatedReport("report_menu_integrity", "backend", `menu_link_content not listable: ${err?.message || err}`);
  }

  const disabled = [];
  const placeholderTargets = [];
  const externalLinks = [];
  for (const l of links) {
    const title = fieldValue(l, ["title"]) ?? l.title ?? "(untitled)";
    const enabledRaw = fieldValue(l, ["enabled"]);
    const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
    const uri = scalarUri(fieldValue(l, ["link"]));
    const menu = fieldValue(l, ["menu_name"]) ?? null;

    if (!enabled) disabled.push({ id: l.id, title, menu });
    if (!uri || /^route:<nojs>|^route:<none>|^internal:#?$/.test(uri)) {
      placeholderTargets.push({ id: l.id, title, uri: uri ?? null, menu });
      continue;
    }
    if (/^https?:\/\//i.test(uri)) {
      const internal = internalTarget(uri, baseHost);
      if (!internal) externalLinks.push({ id: l.id, title, uri, menu });
    }
  }

  return {
    site: site._name,
    totalLinks: links.length,
    approximate: links.length >= limit,
    summary: { disabled: disabled.length, placeholderTargets: placeholderTargets.length, externalLinks: externalLinks.length },
    findings: { disabled, placeholderTargets, externalLinks },
    note: "Structural issues are reported here. Deep target-existence checks (unpublished/deleted entity targets) are not resolved — menu targets address entities by internal id, which JSON:API can't probe by UUID.",
  };
}

// ---------------------------------------------------------------------------
// drupal_report_broken_embeds
// ---------------------------------------------------------------------------

/**
 * Scan published body content for embedded entities (CKEditor media/entity
 * embeds) and report their usage, flagging embeds with a missing/malformed
 * `data-entity-uuid`. Full target-existence verification is best-effort: a
 * target is probed only when both its entity type and bundle are derivable;
 * otherwise it is reported as unverified.
 *
 * @param {object} args - { site?, type?, sampleSize? }.
 * @returns {Promise<object>} Embed inventory and any malformed embeds.
 */
async function brokenEmbeds({ site: siteName, type, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";

  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, filters: [{ field: "status", op: "eq", value: true }] },
    sampleSize
  );

  let totalEmbeds = 0;
  const byType = new Map();
  const malformed = [];
  const usage = [];
  for (const n of entities) {
    const html = bodyHtml(n);
    if (!html) continue;
    const embeds = extractEmbeds(html);
    if (!embeds.length) continue;
    usage.push({ id: n.id, title: n.title, embeds: embeds.length });
    for (const e of embeds) {
      totalEmbeds++;
      const t = e.entityType || "(unknown)";
      byType.set(t, (byType.get(t) || 0) + 1);
      if (!e.uuid || !/^[0-9a-f-]{36}$/i.test(e.uuid)) {
        malformed.push({ id: n.id, title: n.title, embed: e });
      }
    }
  }

  return {
    contentType,
    scanned: entities.length,
    approximate: entities.length >= sampleSize,
    totalEmbeds,
    byType: [...byType.entries()].map(([entityType, count]) => ({ entityType, count })),
    malformed,
    usage,
    note: "Malformed-UUID embeds are flagged here. Full embed target-existence verification is not performed (JSON:API can't probe a media UUID without its bundle).",
  };
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_report_404_log",
    description: "Aggregate Drupal 'page not found' (404) log events into the top missing URLs ranked by hit count — the redirect-candidate list. Self-sufficient via the connector's drush watchdog bridge; returns an 'unavailable' payload when drush isn't configured for the site.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        limit: { type: "number", default: 25, description: "Max distinct missing paths to return (max 200)" },
      },
    },
  },
  {
    name: "drupal_report_redirect_health",
    description: "Audit the Redirect module table for structural problems: duplicate sources, self-redirects, and redirect chains/loops. Deterministic from the redirect entity list; gated when the 'redirect' resource isn't exposed.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        limit: { type: "number", default: 1000, description: "Max redirects to scan" },
      },
    },
  },
  {
    name: "drupal_report_broken_links",
    description: "Inventory links in published body content (internal/external/images), aggregate external hosts, and flag malformed hrefs. With checkLive:true, verifies links via bounded, SSRF-guarded outbound HTTP (internal always; external only if includeExternal and host-allowlisted). No network egress unless checkLive is set.",
    inputSchema: {
      type: "object",
      properties: {
        site:            { type: "string" },
        type:            { type: "string", description: "Content type (default: article)" },
        sampleSize:      { type: "number", default: 100, description: "Max nodes to scan" },
        checkLive:       { type: "boolean", default: false, description: "Perform live HTTP checks (off by default)" },
        includeExternal: { type: "boolean", default: false, description: "When checkLive, also check allowlisted external hosts" },
      },
    },
  },
  {
    name: "drupal_report_alias_coverage",
    description: "URL-alias coverage for a content type: nodes whose canonical URL is still /node/N (no alias / pathauto gap), plus conflicting aliases (one alias mapped to multiple system paths) when the path_alias entity is exposed.",
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
    name: "drupal_report_menu_integrity",
    description: "Audit custom menu links (menu_link_content): disabled links, links with no usable target (route:<nojs>/empty placeholders), and external links. Structural; deep target-existence checks are not performed (JSON:API can't probe a target by internal id).",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        limit: { type: "number", default: 1000, description: "Max menu links to scan" },
      },
    },
  },
  {
    name: "drupal_report_broken_embeds",
    description: "Scan published body content for embedded entities (media/entity embeds) and report usage by type, flagging embeds with a missing/malformed data-entity-uuid. Full target-existence verification is gated on a future server-tool.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type (default: article)" },
        sampleSize: { type: "number", default: 100, description: "Max nodes to scan" },
      },
    },
  },
];

export const handlers = {
  drupal_report_404_log:          log404,
  drupal_report_redirect_health:  redirectHealth,
  drupal_report_broken_links:     brokenLinks,
  drupal_report_alias_coverage:   aliasCoverage,
  drupal_report_menu_integrity:   menuIntegrity,
  drupal_report_broken_embeds:    brokenEmbeds,
};
