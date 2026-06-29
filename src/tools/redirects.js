/**
 * Tool group: URL redirects (the contrib Redirect module).
 *
 * A `redirect` entity maps an old/source path to a destination and fires an HTTP
 * redirect (301 by default) when the source path is requested. Redirects are a
 * single-bundle content entity (`redirect--redirect`) exposed over JSON:API, so
 * they go through the shared backend like the other structural content tools.
 *
 * Why a dedicated tool (vs. the generic entity tools): the Redirect module's
 * field shape is unforgiving and easy to get wrong, which produces a stored-but-
 * dead redirect:
 *   - `redirect_source` stores the source path WITHOUT a leading slash. A source
 *     saved as "/old" never matches an incoming request for "old", so the
 *     redirect silently never fires. This tool strips the leading slash so a
 *     created redirect is live (serves its 301) immediately.
 *   - `redirect_redirect` is a Drupal link field — a bare "/new" must be wrapped
 *     as the URI "internal:/new". This tool normalizes destinations so callers
 *     can pass a plain path, an `entity:node/ID`, or an absolute URL.
 *   - `status_code` defaults to 301 and can be set to 302 (or another redirect
 *     code) explicitly on create, and changed on an existing redirect via update.
 *
 * Redirect entities have no separate enabled/disabled flag — a redirect with a
 * valid source is active. "Enable an existing redirect" therefore means: correct
 * its fields so it matches and fires, which is exactly what drupal_update_redirect
 * does. Both tools are governed: writes assert create/update permission for the
 * `redirect` entity type against the per-site security policy.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertWriteAllowed } from "../lib/security.js";

const REDIRECT_TYPE = "redirect";

// Redirect status codes the Redirect module supports. 301/302 are the common
// pair called for in the ticket; the rest are the other valid HTTP redirect
// codes, accepted so the tool isn't needlessly restrictive. 301 is the default.
const ALLOWED_STATUS_CODES = [301, 302, 303, 307, 308];

// Drupal URI schemes a destination may already carry; anything else that is a
// path gets wrapped as internal:.
const URI_SCHEME_RE = /^(https?:|mailto:|tel:|internal:|entity:|route:|base:)/i;

/**
 * Normalize a source path to the Redirect module's stored form: trimmed, no
 * leading slash. Storing a leading slash is the classic "redirect saved but
 * never fires" bug, so this is the core of the fix.
 *
 * @param {string} source Raw source path, e.g. "/old-path" or "old-path".
 * @returns {string} The source path without a leading slash.
 */
function normalizeSource(source) {
  return String(source).trim().replace(/^\/+/, "");
}

/**
 * Normalize a redirect destination into a Drupal link-field URI. Absolute URLs
 * and explicit Drupal URI schemes (entity:, internal:, route:, …) pass through
 * unchanged; a bare path is wrapped as `internal:`.
 *
 * @param {string} target Destination path or URI.
 * @returns {string} A Drupal link-field URI.
 */
function normalizeTargetUri(target) {
  const t = String(target).trim();
  if (URI_SCHEME_RE.test(t)) return t;
  return t.startsWith("/") ? `internal:${t}` : `internal:/${t}`;
}

/**
 * Validate a requested status code against the supported redirect codes.
 *
 * @param {number} code The HTTP status code.
 * @returns {number} The validated code.
 * @throws {Error} If the code is not a supported redirect status code.
 */
function assertStatusCode(code) {
  if (!ALLOWED_STATUS_CODES.includes(code)) {
    throw new Error(
      `Unsupported redirect status code ${code}. Use one of: ${ALLOWED_STATUS_CODES.join(", ")} (301 is the default).`,
    );
  }
  return code;
}

/** Entity type id for redirects, exported so side-effect callers can reuse it. */
export const REDIRECT_ENTITY_TYPE = REDIRECT_TYPE;

/**
 * Build the JSON:API attribute map for a `redirect` entity from a plain
 * source/target, applying the leading-slash and link-URI normalization that
 * keeps a created redirect live. Exported so other tools (e.g. the node
 * rename-redirect side-effect in nodes.js) create redirects identically.
 *
 * @param {string} source Old path (leading slash optional; stripped).
 * @param {string} target Destination path / `entity:node/ID` / absolute URL.
 * @param {number} [statusCode] HTTP redirect code (default 301).
 * @param {string} [language] Redirect language (default 'und').
 * @returns {object} The redirect attribute map for backend.createEntity.
 * @throws {Error} If the status code is unsupported.
 */
export function buildRedirectAttributes(source, target, statusCode = 301, language = "und") {
  assertStatusCode(statusCode);
  return {
    redirect_source: { path: normalizeSource(source), query: null },
    redirect_redirect: { uri: normalizeTargetUri(target) },
    status_code: statusCode,
    language,
  };
}

/**
 * Create an active URL redirect.
 *
 * @param {object} args - { site?, source, target, statusCode?, language? }.
 *   `source` is the old path (a leading slash is fine; it is stripped to the
 *   stored form). `target` is the destination — a path ("/new"), an
 *   `entity:node/ID`, or an absolute URL. `statusCode` defaults to 301; pass 302
 *   for a temporary redirect. `language` defaults to 'und' (all languages).
 * @returns {Promise<object>} The created redirect descriptor from the backend.
 * @throws {Error} If source/target are missing or the status code is unsupported.
 * @throws {SecurityError} If creating redirects is not permitted.
 */
async function createRedirect({ site: siteName, source, target, statusCode = 301, language = "und" }) {
  if (!source) throw new Error("A redirect 'source' path is required (e.g. '/old-path').");
  if (!target) throw new Error("A redirect 'target' is required (a path, 'entity:node/ID', or an absolute URL).");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", REDIRECT_TYPE, REDIRECT_TYPE);
  const backend = await resolveBackend(site);
  return backend.createEntity({
    entityType: REDIRECT_TYPE, bundle: REDIRECT_TYPE,
    attributes: buildRedirectAttributes(source, target, statusCode, language),
  });
}

/**
 * Update an existing redirect: repoint its source/target or change its status
 * code. Only the provided fields are sent (a partial JSON:API PATCH), so an
 * update that changes just the status code leaves source/target untouched.
 *
 * @param {object} args - { site?, id, source?, target?, statusCode? }.
 * @returns {Promise<object>} The updated redirect descriptor from the backend.
 * @throws {Error} If id is missing or the status code is unsupported.
 * @throws {SecurityError} If updating redirects is not permitted.
 */
async function updateRedirect({ site: siteName, id, source, target, statusCode }) {
  if (!id) throw new Error("A redirect 'id' (UUID) is required to update an existing redirect.");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", REDIRECT_TYPE, REDIRECT_TYPE);
  const backend = await resolveBackend(site);
  const attributes = {};
  if (source !== undefined) attributes.redirect_source = { path: normalizeSource(source), query: null };
  if (target !== undefined) attributes.redirect_redirect = { uri: normalizeTargetUri(target) };
  if (statusCode !== undefined) attributes.status_code = assertStatusCode(statusCode);
  return backend.updateEntity({ entityType: REDIRECT_TYPE, bundle: REDIRECT_TYPE, id, attributes });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_create_redirect",
    description:
      "Create an active URL redirect (contrib Redirect module). The redirect serves its 301 (or chosen code) immediately: 'source' is the old path (a leading slash is fine — it is normalized to the module's stored, slash-less form so the redirect actually matches and fires), and 'target' is the destination as a path ('/new'), an 'entity:node/ID', or an absolute URL. status_code defaults to 301; pass 302 for a temporary redirect. Governed by the site security policy (needs redirect write / 'administer redirects').",
    inputSchema: {
      type: "object", required: ["source", "target"],
      properties: {
        site:       { type: "string", description: "Named site (omit for default)" },
        source:     { type: "string", description: "Source/old path to redirect from, e.g. '/old-slug'. Leading slash optional." },
        target:     { type: "string", description: "Destination: a path ('/new-slug'), 'entity:node/42', or an absolute 'https://…' URL." },
        statusCode: { type: "number", default: 301, description: "HTTP redirect status code. 301 (permanent, default) or 302 (temporary); 303/307/308 also accepted." },
        language:   { type: "string", default: "und", description: "Langcode the redirect applies to. Defaults to 'und' (all languages)." },
      },
    },
  },
  {
    name: "drupal_update_redirect",
    description:
      "Update an existing redirect by UUID: repoint its source or target, or change its status code (e.g. 301↔302). Only the fields you pass are changed (partial update). Use this to activate/fix a redirect that isn't firing (e.g. one created with a stale source). Governed by the site security policy.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        site:       { type: "string" },
        id:         { type: "string", description: "Redirect entity UUID" },
        source:     { type: "string", description: "New source/old path (leading slash optional). Omit to leave unchanged." },
        target:     { type: "string", description: "New destination path/URI. Omit to leave unchanged." },
        statusCode: { type: "number", description: "New HTTP redirect status code (301/302/303/307/308). Omit to leave unchanged." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_create_redirect: createRedirect,
  drupal_update_redirect: updateRedirect,
};
