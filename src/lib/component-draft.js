/**
 * Component paragraph changes carried in one governed node draft
 * (drupal-mcp-connector #416, MCP Sentinel d.o #3627742).
 *
 * The node edit form saves a draft once: each changed paragraph becomes a
 * new non-default revision and the draft points at it, while the live
 * revision keeps its pins. Sentinel's `/mcp-draft` does the same when the
 * request carries `meta.mcp_components`. This module validates the
 * components, checks that the host advertises the operations, preflights the
 * exact payload, writes it, and verifies the working copy moved each pin.
 *
 * There is no fallback. A host without the operations is refused before any
 * write; a direct paragraph PATCH would change the live page.
 */

import { readNodeDraftInventory, assertDraftLangcode } from "./sentinel-draft.js";
import { entityRevisionId } from "./write-revision.js";
import { paragraphPinsFromEntity } from "./err-relationships.js";
import { PREFLIGHT_SENTINEL_DRAFT, dryRunChecks } from "./dry-run-checks.js";

/** Inventory operation: component paragraph changes inside a draft save. */
export const DRAFT_COMPONENTS_OPERATION = "draft_components";
/** Inventory operation: open the first working copy from live (`If-Match: "live"`). */
export const OPEN_DRAFT_OPERATION = "open_draft";
/** First MCP Sentinel release with both operations. */
export const MIN_SENTINEL_COMPONENTS_VERSION = "2.29.0";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUNDLE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate component entries and normalize `type` to `paragraph--<bundle>`.
 * @param {unknown} components
 * @returns {Array<{type: string, id: string, attributes: object}>}
 */
export function normalizeComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("components must be a non-empty list of { id, type, attributes }.");
  }
  const seen = new Set();
  return components.map((component, index) => {
    const where = `components[${index}]`;
    if (!component || typeof component !== "object" || Array.isArray(component)) {
      throw new Error(`${where} must be an object with id, type and attributes.`);
    }
    if (Object.hasOwn(component, "relationships")) {
      throw new Error(`${where}: a component change cannot change references. Send attribute values only.`);
    }
    const id = String(component.id ?? "");
    if (!UUID_RE.test(id)) throw new Error(`${where}.id must be the paragraph UUID.`);
    if (seen.has(id)) throw new Error(`${where}: paragraph ${id} is listed more than once.`);
    seen.add(id);
    const rawType = String(component.type ?? "");
    const bundle = rawType.startsWith("paragraph--") ? rawType.slice("paragraph--".length) : rawType;
    if (rawType.includes("--") && !rawType.startsWith("paragraph--")) {
      throw new Error(`${where}.type must be a paragraph bundle, not ${rawType}.`);
    }
    if (!BUNDLE_RE.test(bundle)) throw new Error(`${where}.type must be a paragraph bundle such as "p_hero".`);
    const attributes = component.attributes;
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)
      || Object.keys(attributes).length === 0) {
      throw new Error(`${where}.attributes must name at least one field.`);
    }
    return { type: `paragraph--${bundle}`, id, attributes };
  });
}

/**
 * @param {string} operation
 * @returns {Error}
 */
function capabilityError(operation) {
  return new Error(
    `This Sentinel host cannot save component changes in a draft (missing ${operation}). ` +
    `Update MCP Sentinel to ${MIN_SENTINEL_COMPONENTS_VERSION} or later. ` +
    "No write was attempted, and no direct paragraph write was tried: it would change the live page.",
  );
}

/**
 * One `/mcp-draft` request carrying node attributes and components.
 * @param {object} backend
 * @param {object} spec
 * @returns {Promise<object>}
 */
function draftRequest(backend, { entityType, bundle, id, data, components, live, working, langcode, preflight }) {
  return backend.rawQuery({
    path: `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}/mcp-draft`,
    options: {
      method: "PATCH",
      headers: {
        "If-Match": working ? `"${live}:${working}"` : `"${live}"`,
        "X-MCP-Draft-Preflight": preflight ? "1" : "0",
        "X-MCP-Draft-Langcode": langcode,
      },
      body: JSON.stringify({ data, meta: { mcp_components: components } }),
    },
  });
}

/**
 * Whether a stored field value carries every submitted part.
 *
 * Submitted objects are compared key by key, so read-only extras such as
 * `processed` or `resolvable_uri` do not count. An empty submitted `options`
 * matches any stored empty options. A single submitted item matches a
 * single-value field read back as an object.
 * @param {unknown} submitted
 * @param {unknown} actual
 * @returns {boolean}
 */
export function valueMatches(submitted, actual) {
  if (submitted === null || typeof submitted !== "object") {
    if (actual !== null && typeof actual === "object" && !Array.isArray(actual) && "value" in actual) {
      return valueMatches(submitted, actual.value);
    }
    return submitted === actual;
  }
  if (Array.isArray(submitted)) {
    const list = Array.isArray(actual) ? actual : actual === null || actual === undefined ? [] : [actual];
    return list.length === submitted.length && submitted.every((item, i) => valueMatches(item, list.at(i)));
  }
  if (actual === null || typeof actual !== "object") return false;
  const stored = new Map(Object.entries(actual));
  return Object.entries(submitted).every(([key, part]) => {
    const isEmpty = (v) => v === null || v === undefined
      || (Array.isArray(v) && v.length === 0)
      || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    if (key === "options" && isEmpty(part)) return isEmpty(stored.get(key));
    return valueMatches(part, stored.get(key));
  });
}

/**
 * Pins keyed by paragraph UUID.
 * @param {?object} entity
 * @returns {Map<string, string>}
 */
function pinMap(entity) {
  const pins = new Map();
  for (const pin of paragraphPinsFromEntity(entity)) {
    if (pin.revisionId !== null && pin.revisionId !== undefined) pins.set(pin.id, String(pin.revisionId));
  }
  return pins;
}

/**
 * Save node attributes and component paragraph changes as one unpublished
 * draft revision, opening the working copy from live when none exists.
 *
 * @param {object} backend JSON:API backend with Sentinel draft routes.
 * @param {object} input
 * @param {string} input.entityType Always "node" today.
 * @param {string} input.bundle
 * @param {string} input.id Node UUID.
 * @param {object} input.attributes Node attributes, including moderation_state.
 * @param {object} [input.relationships]
 * @param {Array} input.components Entries for {@link normalizeComponents}.
 * @param {string} [input.langcode] Must be the default language when given.
 * @param {{dryRun?: boolean}} [options]
 * @returns {Promise<object>} Preview on dryRun; otherwise the written entity
 *   plus `components` (live and working pins per paragraph).
 */
export async function writeComponentDraft(backend, input, { dryRun = false } = {}) {
  const { entityType, bundle, id, attributes = {}, relationships } = input;
  const components = normalizeComponents(input.components);
  if (Object.hasOwn(attributes, "path")) {
    throw new Error("Aliases are not revisioned. Change the alias in a separate update; no write was attempted.");
  }
  const inventory = await readNodeDraftInventory(backend, { entityType, bundle, id });
  if (!inventory) throw capabilityError(DRAFT_COMPONENTS_OPERATION);
  const operations = Array.isArray(inventory.operations) ? inventory.operations : [];
  if (!operations.includes(DRAFT_COMPONENTS_OPERATION)) throw capabilityError(DRAFT_COMPONENTS_OPERATION);

  const defaultLang = typeof inventory.defaultLangcode === "string" ? inventory.defaultLangcode : undefined;
  if (!defaultLang) throw new Error("Sentinel did not report the default language. No write was attempted.");
  if (input.langcode !== undefined && input.langcode !== null && input.langcode !== ""
    && assertDraftLangcode(input.langcode) !== defaultLang) {
    throw new Error(`Component changes apply to the default language (${defaultLang}) only. No write was attempted.`);
  }

  const live = String(inventory.live.vid);
  const working = inventory.working?.vid && String(inventory.working.vid) !== live
    ? String(inventory.working.vid)
    : "";
  if (!working && !operations.includes(OPEN_DRAFT_OPERATION)) throw capabilityError(OPEN_DRAFT_OPERATION);
  if (working) {
    const row = (inventory.working.translations ?? []).find((r) => r?.langcode === defaultLang);
    const state = typeof row?.moderation_state === "string" ? row.moderation_state : "";
    if (!row || row.status === true || state === "published") {
      throw new Error(
        `The default language (${defaultLang}) is still published on the working copy, so it cannot be continued. ` +
        "Publish or discard the other language's draft first. No write was attempted.",
      );
    }
  }

  const data = { type: `${entityType}--${bundle}`, id, attributes };
  if (relationships && Object.keys(relationships).length) data.relationships = relationships;
  const request = { entityType, bundle, id, data, components, live, working, langcode: defaultLang };

  const checked = await draftRequest(backend, { ...request, preflight: true });
  const meta = checked?.meta;
  if (meta?.draft_preflight !== true || String(meta.live) !== live || String(meta.working ?? "") !== working
    || (!working && meta.operation !== OPEN_DRAFT_OPERATION)) {
    throw new Error("The site did not confirm a non-saving draft preflight for these components. No write was attempted.");
  }
  if (dryRun) {
    return {
      dryRun: true, operation: "update", entityType, bundle, id, attributes,
      relationships: data.relationships ?? {}, components,
      opensWorkingCopy: !working,
      ...dryRunChecks({ operation: "update", preflight: PREFLIGHT_SENTINEL_DRAFT }),
    };
  }

  const result = await draftRequest(backend, { ...request, preflight: false });
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("The draft write response did not identify the node. The outcome is uncertain; re-read before retrying.");
  }
  const entity = backend.toCanonical(result.data);
  const workingVid = entityRevisionId(entity) ?? entityRevisionId(result.data);
  if (workingVid === null) {
    throw new Error("The draft write response carried no revision ID. Re-read the working copy before retrying.");
  }
  const [liveEntity, workingEntity] = await Promise.all([
    backend.getEntity({ entityType, bundle, id }),
    backend.getEntity({ entityType, bundle, id, resourceVersion: `id:${workingVid}` }),
  ]);
  const livePins = pinMap(liveEntity);
  const workingPins = pinMap(workingEntity);
  // Every paragraph on the host gets a new revision when the host does, so a
  // moved pin alone proves nothing. Read each component at its working pin and
  // compare the submitted values.
  const report = [];
  for (const { id: uuid, type, attributes: submitted } of components) {
    const livePin = livePins.get(uuid) ?? null;
    const workingPin = workingPins.get(uuid) ?? null;
    if (!workingPin || workingPin === livePin) {
      throw new Error(
        `The draft was saved as revision ${workingVid}, but it still pins the live revision of component ${uuid}. ` +
        "Re-read the working copy before retrying.",
      );
    }
    const paragraph = await backend.getEntity({
      entityType: "paragraph", bundle: type.slice("paragraph--".length), id: uuid, resourceVersion: `id:${workingPin}`,
    });
    if (!paragraph) {
      throw new Error(
        `The draft was saved as revision ${workingVid}, but component ${uuid} could not read back at revision ${workingPin}. ` +
        "Check the working copy before retrying.",
      );
    }
    const values = new Map(Object.entries({ ...(paragraph.attributes ?? {}), ...(paragraph.fields ?? {}) }));
    const mismatched = Object.entries(submitted)
      .filter(([name, value]) => !valueMatches(value, values.get(name)))
      .map(([name]) => name);
    if (mismatched.length) {
      throw new Error(
        `The draft was saved as revision ${workingVid}, but component ${uuid} does not hold the submitted ` +
        `${mismatched.join(", ")} at revision ${workingPin}. Check the working copy before retrying.`,
      );
    }
    report.push({ id: uuid, type, livePin, workingPin, verified: Object.keys(submitted) });
  }
  return {
    ...entity,
    _revisions: { live, working: workingVid },
    preflight: PREFLIGHT_SENTINEL_DRAFT,
    components: report,
  };
}
