/**
 * Shared helpers for the audit tool groups — HTML link/embed extraction and
 * link classification, backend-neutral.
 *
 * Single responsibility: turn a node's rendered body HTML into structured link
 * and embed records, and classify a URL as internal/external/other relative to
 * a site's base URL. The link (`reports-links.js`) and content
 * (`reports-content.js`) audits share this one parser so link handling stays
 * consistent across the suite.
 *
 * Detection is regex-based on the stored body markup — a heuristic pass, not a
 * full DOM parse — matching the existing seo/accessibility audits in reports.js.
 */

import { fieldValue } from "./reports-support.js";

/**
 * Read a node's body HTML from a canonical entity. Mirrors the body-extraction
 * idiom in reports.js (the body field may be a `{value}` object or a scalar).
 * @param {object} entity Canonical entity.
 * @param {string[]} [candidates] Field names to try, in order.
 * @returns {string} The body HTML, or "" when absent.
 */
export function bodyHtml(entity, candidates = ["body"]) {
  const raw = fieldValue(entity, candidates);
  const value = raw && typeof raw === "object" ? raw.value : raw;
  return typeof value === "string" ? value : "";
}

/**
 * Extract all `href` values from `<a>` tags in an HTML string.
 * @param {string} html Body markup.
 * @returns {string[]} Raw href values in document order (may include dups).
 */
export function extractAnchors(html) {
  return matchAttr(html, /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi);
}

/**
 * Extract all `src` values from `<img>` tags in an HTML string.
 * @param {string} html Body markup.
 * @returns {string[]} Raw src values in document order (may include dups).
 */
export function extractImages(html) {
  return matchAttr(html, /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi);
}

/**
 * Extract entity embeds from body markup. Covers the CKEditor media/entity embed
 * shapes Drupal emits — `<drupal-media>`, `<drupal-entity>`, and any element
 * carrying `data-entity-type` + `data-entity-uuid` (entity_embed). Each embed is
 * returned as a `{ entityType, uuid }` ref so callers can probe the target.
 * @param {string} html Body markup.
 * @returns {Array<{entityType: ?string, uuid: string}>} De-duped embed refs.
 */
export function extractEmbeds(html) {
  const out = [];
  const seen = new Set();
  // Match any tag that carries a data-entity-uuid attribute; pull the optional
  // sibling data-entity-type from the same tag.
  const tagRe = /<([a-z-]+)\b([^>]*\bdata-entity-uuid\s*=\s*["'][^"']+["'][^>]*)>/gi;
  for (const m of String(html || "").matchAll(tagRe)) {
    const attrs = m[2];
    const uuid = readAttr(attrs, /\bdata-entity-uuid\s*=\s*["']([^"']+)["']/i);
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({ entityType: readAttr(attrs, /\bdata-entity-type\s*=\s*["']([^"']+)["']/i), uuid });
  }
  return out;
}

/**
 * Classify a URL relative to a site base URL.
 *
 * @param {string} url Raw href/src value.
 * @param {string} baseUrl The site's configured base URL (origin).
 * @returns {{kind: "internal"|"external"|"fragment"|"mailto"|"tel"|"other",
 *   url: string, path: ?string, host: ?string}} Classification. `path` is set
 *   for internal links (origin-relative, no query/fragment); `host` for external.
 */
export function classifyLink(url, baseUrl) {
  const raw = (url || "").trim();
  if (!raw) return { kind: "other", url: raw, path: null, host: null };
  if (raw.startsWith("#")) return { kind: "fragment", url: raw, path: null, host: null };

  const lower = raw.toLowerCase();
  if (lower.startsWith("mailto:")) return { kind: "mailto", url: raw, path: null, host: null };
  if (lower.startsWith("tel:")) return { kind: "tel", url: raw, path: null, host: null };
  if (/^(javascript|data):/i.test(lower)) return { kind: "other", url: raw, path: null, host: null };

  const baseHost = hostOf(baseUrl);

  // Root- or path-relative internal links.
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return { kind: "internal", url: raw, path: normalizePath(raw), host: baseHost };
  }

  // Protocol-relative or absolute URLs.
  let parsed;
  try {
    parsed = new URL(raw, baseUrl || undefined);
  } catch {
    return { kind: "other", url: raw, path: null, host: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "other", url: raw, path: null, host: null };
  }
  if (baseHost && parsed.host.toLowerCase() === baseHost.toLowerCase()) {
    return { kind: "internal", url: raw, path: normalizePath(parsed.pathname), host: parsed.host };
  }
  return { kind: "external", url: raw, path: null, host: parsed.host };
}

/**
 * Normalize an internal path for comparison: decode, strip query/fragment, drop
 * a trailing slash (except root), and ensure a leading slash.
 * @param {string} path A pathname or root-relative URL.
 * @returns {string} Normalized path beginning with "/".
 */
export function normalizePath(path) {
  let p = String(path || "/");
  const fragIdx = p.indexOf("#");
  if (fragIdx !== -1) p = p.slice(0, fragIdx);
  const queryIdx = p.indexOf("?");
  if (queryIdx !== -1) p = p.slice(0, queryIdx);
  try { p = decodeURI(p); } catch { /* leave as-is on malformed escapes */ }
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p || "/";
}

/**
 * Pull the host (`host:port`) out of a base URL string, tolerating a bare host.
 * @param {string} baseUrl A configured site base URL.
 * @returns {?string} The host, or null when unparseable/absent.
 */
export function hostOf(baseUrl) {
  if (!baseUrl) return null;
  try { return new URL(baseUrl).host; }
  catch {
    try { return new URL(`https://${baseUrl}`).host; }
    catch { return null; }
  }
}

/**
 * Run a global attribute-capturing regex over HTML and return capture group 1
 * for every match.
 * @param {string} html Source markup.
 * @param {RegExp} re Global regex whose first group is the attribute value.
 * @returns {string[]} Captured values in document order.
 */
function matchAttr(html, re) {
  const out = [];
  if (!html) return out;
  for (const m of String(html).matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * Read a single attribute value out of a tag's attribute string using a literal
 * capturing regex.
 * @param {string} attrs The raw attribute text inside a tag.
 * @param {RegExp} re A regex whose first group captures the attribute value.
 * @returns {?string} The value, or null when the attribute is absent.
 */
function readAttr(attrs, re) {
  const m = String(attrs || "").match(re);
  return m ? m[1] : null;
}
