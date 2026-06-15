/**
 * Tool group: content_moderation workflow.
 *
 * Thin, governed operations over the canonical backend for sites using Drupal's
 * content_moderation (editorial) workflow:
 *   - set a node's moderation_state (the governed write; draft -> needs_review -> published -> archived)
 *   - list content filtered by moderation_state (e.g. "what's awaiting review")
 *   - list the moderation states observed on a bundle's content
 *
 * Capability note: the authoritative set of states and the *valid transitions*
 * from a given state live in workflow config and are not exposed over JSON:API.
 * drupal_list_moderation_states therefore degrades to the DISTINCT states
 * observed on existing content (authoritative:false); a full transition map
 * requires the Drush bridge.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, redactCanonicalEntity } from "../lib/security.js";

/** Read a node's moderation_state from a canonical entity, tolerating shapes. */
function moderationStateOf(entity) {
  const v = entity?.fields?.moderation_state;
  if (Array.isArray(v)) return v[0]?.value ?? v[0] ?? null;
  if (v && typeof v === "object") return v.value ?? null;
  return v ?? null;
}

/**
 * Transition a node to a moderation state (governed write).
 * @param {object} args - { site?, type, id, state }.
 * @returns {Promise<object>} The updated, redacted node.
 * @throws {SecurityError} If writing node/type is not permitted.
 */
async function setModerationState({ site: siteName, type, id, state }) {
  if (!state) throw new Error("A moderation 'state' is required (e.g. 'draft', 'published').");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "node", type);
  const backend = await resolveBackend(site);
  const entity = await backend.updateEntity({ entityType: "node", bundle: type, id, attributes: { moderation_state: state } });
  return redactCanonicalEntity(entity, sec, "node");
}

/**
 * List nodes of a type in a given moderation state, paged + redacted.
 * @param {object} args - { site?, type, state, limit?, offset? }.
 */
async function contentByModerationState({ site: siteName, type, state, limit = 20, offset = 0 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({
    entityType: "node", bundle: type,
    filters: [{ field: "moderation_state", op: "eq", value: state }],
    sort: [{ field: "changed", dir: "desc" }],
    page: { limit, offset },
  });
  const nodes = res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
  return { type, state, total: res.page?.total ?? nodes.length, approximate: res.approximate ?? false, offset, nextOffset: offset + nodes.length, nodes };
}

/**
 * List the moderation states observed on a bundle's content (best-effort).
 * @param {object} args - { site?, type, sample? }.
 */
async function listModerationStates({ site: siteName, type, sample = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({ entityType: "node", bundle: type, page: { limit: sample } });
  const states = [...new Set(res.entities.map(moderationStateOf).filter(Boolean))].sort();
  return {
    type,
    states,
    authoritative: false,
    note: "Derived from observed content (sampled). The authoritative state set and valid transitions live in workflow config and require the Drush bridge.",
  };
}

export const definitions = [
  {
    name: "drupal_set_moderation_state",
    description: "Transition a content node to a moderation state (content_moderation), e.g. 'draft', 'needs_review', 'published', 'archived'. Governed write.",
    inputSchema: {
      type: "object", required: ["type", "id", "state"],
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Content type machine name" },
        id:    { type: "string", description: "Node UUID" },
        state: { type: "string", description: "Target moderation state machine name" },
      },
    },
  },
  {
    name: "drupal_content_by_moderation_state",
    description: "List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review').",
    inputSchema: {
      type: "object", required: ["type", "state"],
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Content type machine name" },
        state:  { type: "string", description: "Moderation state machine name" },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
      },
    },
  },
  {
    name: "drupal_list_moderation_states",
    description: "List the moderation states observed on a content type's content (best-effort; authoritative transitions require the Drush bridge).",
    inputSchema: {
      type: "object", required: ["type"],
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Content type machine name" },
        sample: { type: "number", default: 50, description: "How many recent items to sample" },
      },
    },
  },
];

export const handlers = {
  drupal_set_moderation_state:       setModerationState,
  drupal_content_by_moderation_state: contentByModerationState,
  drupal_list_moderation_states:     listModerationStates,
};
