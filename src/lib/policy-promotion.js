/**
 * W&L-operated dual-control promotion ledger (#253).
 *
 * The edge never mints a Sentinel HMAC seal. A promotion is an already-sealed
 * portable document plus two distinct operator ids. Eligibility is the gate
 * before the tenant agent may receive the artifact. Caller-supplied documents
 * are never read here.
 */

export const POLICY_DIGEST = /^[0-9a-f]{64}$/i;

export const SEAL_PREFIX = "hmac-sha256:";

function tableHasKeys(table) {
  return Object.keys(table).some((key) => {
    const id = key.trim();
    return id && !id.startsWith("_");
  });
}

function uniqueApprovals(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const id = String(value).trim();
    if (!id || id.startsWith("_") || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function portableDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bag = new Map(Object.entries(raw));
  const digest = typeof bag.get("digest") === "string"
    ? bag.get("digest").trim().toLowerCase()
    : "";
  const seal = typeof bag.get("seal") === "string" ? bag.get("seal").trim() : "";
  if (!POLICY_DIGEST.test(digest)) return null;
  if (!seal.startsWith(SEAL_PREFIX) || seal.length <= SEAL_PREFIX.length) return null;
  bag.set("digest", digest);
  bag.set("seal", seal);
  return Object.freeze(Object.fromEntries(bag));
}

/**
 * Normalize `auth.promotions` (digest → sealed document + approvals).
 * Comment keys and malformed rows are dropped. Duplicate operator ids in
 * `approvals` count once. A row is eligible only with two distinct operators
 * and a document whose claimed digest matches the map key.
 *
 * @param {object|null} promotions
 * @returns {object|null}
 */
export function normalizePromotions(promotions) {
  if (!promotions || typeof promotions !== "object" || Array.isArray(promotions)) {
    return null;
  }
  const entries = [];
  for (const [rawKey, value] of Object.entries(promotions)) {
    const key = rawKey.trim().toLowerCase();
    if (!key || key.startsWith("_") || !POLICY_DIGEST.test(key)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const bag = new Map(Object.entries(value));
    const document = portableDocument(bag.get("document"));
    if (!document || document.digest !== key) continue;
    const approvals = uniqueApprovals(bag.get("approvals"));
    entries.push([key, Object.freeze({
      digest: key,
      document,
      approvals: Object.freeze(approvals),
      eligible: approvals.length >= 2,
    })]);
  }
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Whether a promotions table is in force (fail-closed even when every row
 * is ineligible). Comment-only objects are not in force.
 *
 * @param {object|null} promotions
 * @returns {boolean}
 */
export function promotionsRequired(promotions) {
  if (!promotions || typeof promotions !== "object" || Array.isArray(promotions)) {
    return false;
  }
  return tableHasKeys(promotions);
}

/**
 * Eligible sealed documents ready to fan down.
 *
 * @param {object|null} promotions
 * @returns {Array<{digest: string, document: object, approvals: string[]}>}
 */
export function eligiblePromotions(promotions) {
  const table = normalizePromotions(promotions);
  if (!table) return [];
  return Object.values(table).filter((row) => row.eligible);
}

/**
 * Look up one digest in the ledger.
 *
 * @param {object} params
 * @param {string|null} [params.digest]
 * @param {object|null} [params.promotions]
 * @returns {{document: object|null, eligible: boolean, reason: "not_entitled"|null}}
 */
export function resolveEligiblePromotion({ digest = null, promotions = null } = {}) {
  const required = promotionsRequired(promotions);
  const table = normalizePromotions(promotions);
  if (!table) {
    return {
      document: null,
      eligible: false,
      reason: required ? "not_entitled" : null,
    };
  }
  const key = typeof digest === "string" ? digest.trim().toLowerCase() : "";
  const record = key ? new Map(Object.entries(table)).get(key) : null;
  if (!record || !record.eligible) {
    return { document: null, eligible: false, reason: "not_entitled" };
  }
  return { document: record.document, eligible: true, reason: null };
}
