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
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, assertPublishAllowed,
  redactCanonicalEntity,
} from "../lib/security.js";
import { collectEntities } from "../lib/reports-support.js";
import { prepareGuardedPatch, updateEntityGuarded } from "../lib/patch-preflight.js";
import { assertDraftLangcode, readTranslationInventory } from "../lib/draft-write.js";
import { inventoryRowMatching } from "../lib/translation-rows.js";

/** Cap for the client-side scan when JSON:API cannot filter the field. */
const SAMPLE_CAP = 500;

/**
 * Drupal core JSON:API cannot filter on the computed `moderation_state`
 * field. The error is a 500 whose detail is `'moderation_state' not found`
 * (#162). jsonapi_extras (or a similar alias) can make the field filterable;
 * those sites never hit this.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUnfilterableModerationState(err) {
  const msg = String(err?.message || "");
  if (!/moderation_state/i.test(msg)) return false;
  return /not found/i.test(msg) || /not filterable/i.test(msg) || /invalid filter/i.test(msg);
}

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
async function setModerationState({ site: siteName, type, id, state, langcode }) {
  if (!state) throw new Error("A moderation 'state' is required (e.g. 'draft', 'published').");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "node", type);
  const attributes = { moderation_state: state };
  assertPublishAllowed(sec, attributes);
  const backend = await resolveBackend(site);
  if (langcode) {
    const targetLang = assertDraftLangcode(langcode);
    let existing = null;
    try {
      existing = (await backend.getEntity({ entityType: "node", bundle: type, id })) ?? null;
    } catch {
      existing = null;
    }
    const patchTarget = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: type, id, existing, attributes, langcode: targetLang,
    });
    const patched = await updateEntityGuarded(backend, {
      entityType: "node", bundle: type, id, attributes, langcode: targetLang,
      ...(patchTarget.draftRevision ? { draftRevision: patchTarget.draftRevision } : {}),
    });
    return redactCanonicalEntity(patched, sec, "node");
  }
  const entity = await backend.updateEntity({ entityType: "node", bundle: type, id, attributes });
  return redactCanonicalEntity(entity, sec, "node");
}

/**
 * List nodes of a type in a given moderation state, paged + redacted.
 *
 * Stock JSON:API cannot filter on the computed `moderation_state` field
 * (#162). When the site accepts the filter (jsonapi_extras or similar) the
 * result is exact. Otherwise we scan a bounded recent set and filter
 * client-side rather than surfacing Drupal's 500 as a transient error.
 *
 * @param {object} args - { site?, type, state, limit?, offset? }.
 */
async function contentByModerationState({ site: siteName, type, state, limit = 20, offset = 0, langcode }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const sort = [{ field: "changed", dir: "desc" }];
  const targetLang = langcode ? assertDraftLangcode(langcode) : null;
  if (targetLang) {
    if (typeof backend.rawQuery !== "function" || typeof backend.resourcePath !== "function") {
      return {
        type, state, langcode: targetLang, unavailable: true,
        reason: "A langcode filter requires Sentinel's translation inventory.",
      };
    }
    const scanned = await collectEntities(
      backend,
      { entityType: "node", bundle: type, sort },
      SAMPLE_CAP,
    );
    const matches = [];
    for (const entity of scanned) {
      try {
        const inventory = await readTranslationInventory(backend, {
          entityType: "node", bundle: type, id: entity.id,
        });
        const row = inventoryRowMatching(inventory, { langcode: targetLang, state });
        if (row) {
          matches.push({
            ...entity,
            langcode: targetLang,
            fields: { ...entity.fields, moderation_state: row.moderation_state },
          });
        }
      } catch (error) {
        if (/does not provide Sentinel's governed draft-translation endpoint/.test(String(error?.message))) {
          return {
            type, state, langcode: targetLang, unavailable: true,
            reason: "A langcode filter requires Sentinel's translation inventory.",
          };
        }
        throw error;
      }
    }
    const page = matches.slice(offset, offset + limit);
    return {
      type, state, langcode: targetLang, source: "inventory",
      approximate: scanned.length >= SAMPLE_CAP,
      scanned: scanned.length,
      total: matches.length,
      offset, nextOffset: offset + page.length,
      nodes: page.map((e) => redactCanonicalEntity(e, sec, "node")),
    };
  }
  const canFilter = typeof backend.capabilities === "function"
    ? Boolean(backend.capabilities()?.filter)
    : true;

  if (canFilter) {
    try {
      const res = await backend.listEntities({
        entityType: "node", bundle: type,
        filters: [{ field: "moderation_state", op: "eq", value: state }],
        sort,
        page: { limit, offset },
      });
      const nodes = res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
      return {
        type, state, source: "filter",
        total: res.page?.total ?? nodes.length,
        approximate: res.approximate ?? false,
        offset, nextOffset: offset + nodes.length, nodes,
      };
    } catch (err) {
      if (!isUnfilterableModerationState(err)) throw err;
    }
  }

  const scanned = await collectEntities(
    backend,
    { entityType: "node", bundle: type, sort },
    SAMPLE_CAP,
  );
  const wanted = String(state).toLowerCase();
  const matches = [];
  let sawState = false;
  for (const entity of scanned) {
    const got = moderationStateOf(entity);
    if (got === null || got === undefined) continue;
    sawState = true;
    if (String(got).toLowerCase() === wanted) matches.push(entity);
  }
  if (!sawState && scanned.length > 0) {
    return {
      type, state, unavailable: true, source: "sampled", scanned: scanned.length,
      reason:
        "moderation_state is not filterable over JSON:API on this site (it is a " +
        "computed field) and no sampled entity exposed the field. Enable " +
        "content_moderation on the bundle, or expose a filterable alias " +
        "(jsonapi_extras).",
    };
  }
  const page = matches.slice(offset, offset + limit);
  return {
    type, state, source: "sampled",
    approximate: scanned.length >= SAMPLE_CAP,
    scanned: scanned.length,
    total: matches.length,
    offset, nextOffset: offset + page.length,
    nodes: page.map((e) => redactCanonicalEntity(e, sec, "node")),
    note:
      "Stock JSON:API cannot filter on moderation_state (computed field). " +
      "Results are a client-side sample of recent nodes, not a complete list. " +
      "A filterable alias (jsonapi_extras) makes this exact.",
  };
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
    description: "Transition a content node to a moderation state (content_moderation), e.g. 'draft', 'needs_review', 'published', 'archived'. Governed write. Pass langcode to change one translation via Sentinel; omit it for the default-language / shared-state write. If moderation_state is not translatable, a langcode write is refused.",
    inputSchema: {
      type: "object", required: ["type", "id", "state"],
      properties: {
        site:     { type: "string" },
        type:     { type: "string", description: "Content type machine name" },
        id:       { type: "string", description: "Node UUID" },
        state:    { type: "string", description: "Target moderation state machine name" },
        langcode: { type: "string", description: "Target translation (e.g. 'es'). Omit for the default language. Requires Sentinel." },
      },
    },
  },
  {
    name: "drupal_content_by_moderation_state",
    description: "List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review'). Pass langcode to match that translation via Sentinel inventory (the editorial work queue). Omit langcode for default-language JSON:API / sampled behavior. Stock JSON:API cannot filter the computed moderation_state field; when the site rejects that filter the tool samples recent nodes client-side and marks the result approximate, instead of returning Drupal's 500.",
    inputSchema: {
      type: "object", required: ["type", "state"],
      properties: {
        site:     { type: "string" },
        type:     { type: "string", description: "Content type machine name" },
        state:    { type: "string", description: "Moderation state machine name" },
        langcode: { type: "string", description: "Match this translation (e.g. 'es'). Requires Sentinel. Omit for default-language listing." },
        limit:    { type: "number", default: 20 },
        offset:   { type: "number", default: 0 },
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
