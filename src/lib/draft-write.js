/**
 * Sentinel's governed draft-continuation contract (d.o #3621022 / GitHub #176).
 * Core JSON:API revision selectors support reads, not PATCH requests.
 * Translation create/update uses the same surface with X-MCP-Draft-Langcode.
 */

import { entityRevisionId } from "./write-revision.js";

const LANGCODE_RE = /^[a-z][a-z0-9_-]{0,11}$/;
const MISSING_DRAFT_ENDPOINT =
  "The site does not provide Sentinel's governed draft endpoint (d.o #3621022). " +
  "Update the server-side module; the draft was not discarded and no canonical fallback was attempted.";
const MISSING_TRANSLATION_ENDPOINT =
  "The site does not provide Sentinel's governed draft-translation endpoint. " +
  "Update MCP Sentinel; no canonical langcode PATCH was attempted.";

/**
 * @param {unknown} error
 * @param {string} message
 * @returns {Error}
 */
function missingEndpointError(error, message) {
  if (/Drupal (404|405)\b/.test(String(error?.message))) {
    return new Error(message, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * @param {string} langcode
 * @returns {string}
 */
export function assertDraftLangcode(langcode) {
  const value = String(langcode || "").trim();
  if (!LANGCODE_RE.test(value)) {
    throw new Error("A valid target langcode is required (for example 'es' or 'pt-br').");
  }
  return value;
}

/**
 * @param {object} [draftRevision]
 * @returns {{live: string, working: string}}
 */
function requireWorkingPair(draftRevision) {
  const live = String(draftRevision?.liveVid ?? "");
  const working = String(draftRevision?.workingVid ?? "");
  if (!/^[1-9]\d*$/.test(live) || !/^[1-9]\d*$/.test(working) || live === working) {
    throw new Error("Draft continuation requires distinct, verified live and working node revision IDs.");
  }
  return { live, working };
}

/**
 * @param {object} backend
 * @param {string} entityType
 * @param {string} bundle
 * @param {string} id
 * @returns {string}
 */
function draftResource(backend, entityType, bundle, id) {
  if (entityType !== "node" && entityType !== "paragraph") {
    throw new Error("Governed draft translation is implemented for nodes and paragraphs.");
  }
  if (typeof backend.rawQuery !== "function" || typeof backend.resourcePath !== "function") {
    throw new Error("This backend does not support governed draft continuation.");
  }
  return `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
}

/**
 * @param {object} [draftRevision]
 * @returns {string}
 */
function requireParagraphRevisionId(draftRevision) {
  const revisionId = String(draftRevision?.revisionId ?? draftRevision?.workingVid ?? "");
  if (!/^[1-9]\d*$/.test(revisionId)) {
    throw new Error("Paragraph translation requires a verified paragraph revision ID.");
  }
  return revisionId;
}

/**
 * Validate or continue a draft, using the same payload and revision precondition.
 * No canonical fallback: an absent endpoint or refused precondition stops work.
 * @param {object} backend JSON:API backend.
 * @param {object} input Canonical update input plus draftRevision.
 * @param {boolean} preflight Validate without saving.
 * @returns {Promise<object>} Preflight metadata or the written canonical entity.
 */
export async function writeDraft(backend, input, preflight = false) {
  const { entityType, bundle, id, attributes = {}, relationships, draftRevision, langcode } = input;
  if (entityType === "paragraph") {
    return writeParagraphDraft(backend, input, preflight);
  }
  const { live, working } = requireWorkingPair(draftRevision);
  const base = draftResource(backend, entityType, bundle, id);
  const data = { type: `${entityType}--${bundle}`, id, attributes };
  if (relationships) data.relationships = relationships;
  const headers = {
    "If-Match": `"${live}:${working}"`,
    "X-MCP-Draft-Preflight": preflight ? "1" : "0",
  };
  const targetLang = langcode ? assertDraftLangcode(langcode) : null;
  if (targetLang) headers["X-MCP-Draft-Langcode"] = targetLang;
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft`,
      options: { method: "PATCH", headers, body: JSON.stringify({ data }) },
    });
  } catch (error) {
    throw missingEndpointError(error, MISSING_DRAFT_ENDPOINT);
  }
  if (preflight) {
    if (result?.meta?.draft_preflight !== true
      || String(result.meta.live) !== live || String(result.meta.working) !== working) {
      throw new Error("The site did not confirm a non-saving draft preflight. Refusing to continue.");
    }
    if (targetLang && result.meta.langcode && String(result.meta.langcode) !== targetLang) {
      throw new Error("The site did not confirm the requested translation language. Refusing to continue.");
    }
    return result;
  }
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("Draft write response did not identify the requested entity. The write outcome is uncertain; re-read before retrying.");
  }
  return backend.toCanonical(result.data);
}

/**
 * Create a target-language translation as an unpublished forward revision.
 * If-Match is `"live"` when there is no working copy, or `"live:working"` when
 * adding the language onto an existing unpublished English draft.
 * @param {object} backend
 * @param {object} input
 * @param {boolean} [preflight]
 * @returns {Promise<object>}
 */
export async function createTranslationDraft(backend, input, preflight = false) {
  const { entityType, bundle, id, attributes = {}, relationships, draftRevision } = input;
  const langcode = assertDraftLangcode(input.langcode);
  if (entityType === "paragraph") {
    return createParagraphTranslationDraft(backend, {
      entityType, bundle, id, attributes, relationships, draftRevision, langcode,
    }, preflight);
  }
  const live = String(draftRevision?.liveVid ?? "");
  const workingRaw = draftRevision?.workingVid;
  const working = workingRaw === undefined || workingRaw === null || workingRaw === ""
    ? ""
    : String(workingRaw);
  if (entityType !== "node" || !/^[1-9]\d*$/.test(live)) {
    throw new Error("Translation create requires a verified live node revision ID.");
  }
  if (working && (!/^[1-9]\d*$/.test(working) || working === live)) {
    throw new Error("Translation create requires distinct live and working revision IDs when a working copy exists.");
  }
  const base = draftResource(backend, entityType, bundle, id);
  const safeAttributes = { ...attributes };
  delete safeAttributes.langcode;
  const data = { type: `${entityType}--${bundle}`, id, attributes: safeAttributes };
  if (relationships) data.relationships = relationships;
  const ifMatch = working ? `"${live}:${working}"` : `"${live}"`;
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft/translations`,
      options: {
        method: "POST",
        headers: {
          "If-Match": ifMatch,
          "X-MCP-Draft-Preflight": preflight ? "1" : "0",
          "X-MCP-Draft-Langcode": langcode,
        },
        body: JSON.stringify({ data }),
      },
    });
  } catch (error) {
    throw rewriteTranslationWorkingRevisionError(missingEndpointError(error, MISSING_TRANSLATION_ENDPOINT));
  }
  if (preflight) {
    if (result?.meta?.draft_preflight !== true || String(result.meta.live) !== live) {
      throw new Error("The site did not confirm a non-saving translation preflight. Refusing to continue.");
    }
    return result;
  }
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("Translation create response did not identify the requested entity. The write outcome is uncertain; re-read before retrying.");
  }
  return backend.toCanonical(result.data);
}

/**
 * Live + working revision ids for a node translation create.
 * Prefers Sentinel's mcp-translations inventory over JSON:API
 * `rel:working-copy`, which 403s on some unpublished drafts even when a
 * working revision exists (#282).
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, existing?: ?object}} ref
 * @returns {Promise<{liveVid: ?(number|string), workingVid: ?(number|string)}>}
 */
export async function resolveNodeTranslationPair(backend, { entityType, bundle, id, existing }) {
  const fromEntity = existing ? entityRevisionId(existing) : null;
  try {
    const meta = await readTranslationInventory(backend, { entityType, bundle, id });
    const liveVid = meta.live?.vid ?? fromEntity;
    const workingVid = meta.working?.vid;
    const distinct = workingVid !== undefined && workingVid !== null && workingVid !== ""
      && liveVid !== undefined && liveVid !== null
      && String(workingVid) !== String(liveVid);
    return { liveVid, workingVid: distinct ? workingVid : undefined };
  } catch {
    if (typeof backend.getEntity !== "function") {
      return { liveVid: fromEntity, workingVid: undefined };
    }
    let workingCopy = null;
    try {
      workingCopy = await backend.getEntity({
        entityType, bundle, id, resourceVersion: "rel:working-copy",
      });
    } catch {
      workingCopy = null;
    }
    const workingVid = workingCopy ? entityRevisionId(workingCopy) : null;
    const distinct = workingVid !== null && fromEntity !== null && String(workingVid) !== String(fromEntity);
    return { liveVid: fromEntity, workingVid: distinct ? workingVid : undefined };
  }
}

/**
 * Rewrite Sentinel's live-only 409 into an actionable connector error.
 * @param {unknown} error
 * @returns {Error}
 */
export function rewriteTranslationWorkingRevisionError(error) {
  if (/A working revision exists\. Reload and send both revision IDs/i.test(String(error?.message || ""))) {
    return new Error(
      "Translation create sent only the live revision, but a working draft exists. " +
      "The connector should have sent both live and working revision IDs (If-Match). " +
      "Reload with drupal_list_translations and retry. See connector #282.",
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Read live/working translation inventory from Sentinel.
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, revisionId?: string|number}} ref
 * @returns {Promise<object>}
 */
export async function readTranslationInventory(backend, { entityType, bundle, id, revisionId }) {
  const base = draftResource(backend, entityType, bundle, id);
  const headers = {};
  if (revisionId !== undefined && revisionId !== null && revisionId !== "") {
    headers["If-Match"] = `"${requireParagraphRevisionId({ revisionId })}"`;
  }
  try {
    const result = await backend.rawQuery({
      path: `${base}/mcp-translations`,
      options: Object.keys(headers).length ? { method: "GET", headers } : undefined,
    });
    if (!result?.meta?.live) {
      throw new Error("The site did not return a translation inventory.");
    }
    return result.meta;
  } catch (error) {
    throw missingEndpointError(error, MISSING_TRANSLATION_ENDPOINT);
  }
}

/**
 * Read one unpublished working translation.
 * @param {object} backend
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function readDraftTranslation(backend, input) {
  const { entityType, bundle, id, draftRevision } = input;
  const langcode = assertDraftLangcode(input.langcode);
  if (entityType === "paragraph") {
    return readParagraphDraftTranslation(backend, input);
  }
  const { live, working } = requireWorkingPair(draftRevision);
  const base = draftResource(backend, entityType, bundle, id);
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft`,
      options: {
        method: "GET",
        headers: {
          "If-Match": `"${live}:${working}"`,
          "X-MCP-Draft-Langcode": langcode,
        },
      },
    });
  } catch (error) {
    throw missingEndpointError(error, MISSING_TRANSLATION_ENDPOINT);
  }
  if (!result?.data || result.data.id !== id) {
    throw new Error("Draft translation read did not identify the requested entity.");
  }
  return backend.toCanonical(result.data);
}

/**
 * Continue an unpublished paragraph translation on a pinned revision.
 * @param {object} backend
 * @param {object} input
 * @param {boolean} [preflight]
 * @returns {Promise<object>}
 */
async function writeParagraphDraft(backend, input, preflight = false) {
  const { entityType, bundle, id, attributes = {}, relationships, draftRevision } = input;
  const langcode = assertDraftLangcode(input.langcode);
  const revisionId = requireParagraphRevisionId(draftRevision);
  const draftState = input.draftState;
  if (typeof draftState !== "string" || !/^[a-f0-9]{64}$/.test(draftState)) {
    throw new Error("Paragraph translation update requires draftState from the previous draft read. Re-read the draft; do not retry old copy with a refreshed token.");
  }
  const base = draftResource(backend, entityType, bundle, id);
  const data = { type: `${entityType}--${bundle}`, id, attributes };
  if (relationships) data.relationships = relationships;
  const headers = {
    "If-Match": `"${revisionId}"`,
    "X-MCP-Draft-Preflight": preflight ? "1" : "0",
    "X-MCP-Draft-Langcode": langcode,
    "X-MCP-Draft-State": draftState,
  };
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft`,
      options: { method: "PATCH", headers, body: JSON.stringify({ data }) },
    });
  } catch (error) {
    throw missingEndpointError(error, MISSING_DRAFT_ENDPOINT);
  }
  if (preflight) {
    if (result?.meta?.draft_preflight !== true
      || String(result.meta.live) !== revisionId
      || (result.meta.langcode && String(result.meta.langcode) !== langcode)) {
      throw new Error("The site did not confirm a non-saving paragraph translation preflight. Refusing to continue.");
    }
    return result;
  }
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("Paragraph translation write did not identify the requested entity. The write outcome is uncertain; re-read before retrying.");
  }
  return { ...backend.toCanonical(result.data), draftState: result.meta?.draft_state };
}

/**
 * Create an unpublished paragraph translation on a pinned revision.
 * @param {object} backend
 * @param {object} input
 * @param {boolean} [preflight]
 * @returns {Promise<object>}
 */
async function createParagraphTranslationDraft(backend, input, preflight = false) {
  const { entityType, bundle, id, attributes = {}, relationships, draftRevision, langcode } = input;
  const revisionId = requireParagraphRevisionId(draftRevision);
  const base = draftResource(backend, entityType, bundle, id);
  const safeAttributes = { ...attributes };
  delete safeAttributes.langcode;
  const data = { type: `${entityType}--${bundle}`, id, attributes: safeAttributes };
  if (relationships) data.relationships = relationships;
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft/translations`,
      options: {
        method: "POST",
        headers: {
          "If-Match": `"${revisionId}"`,
          "X-MCP-Draft-Preflight": preflight ? "1" : "0",
          "X-MCP-Draft-Langcode": langcode,
        },
        body: JSON.stringify({ data }),
      },
    });
  } catch (error) {
    throw missingEndpointError(error, MISSING_TRANSLATION_ENDPOINT);
  }
  if (preflight) {
    if (result?.meta?.draft_preflight !== true || String(result.meta.live) !== revisionId) {
      throw new Error("The site did not confirm a non-saving paragraph translation preflight. Refusing to continue.");
    }
    return result;
  }
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("Paragraph translation create did not identify the requested entity. The write outcome is uncertain; re-read before retrying.");
  }
  return { ...backend.toCanonical(result.data), draftState: result.meta?.draft_state };
}

/**
 * Read one unpublished paragraph translation of a pinned revision.
 * @param {object} backend
 * @param {object} input
 * @returns {Promise<object>}
 */
async function readParagraphDraftTranslation(backend, input) {
  const { entityType, bundle, id, draftRevision } = input;
  const langcode = assertDraftLangcode(input.langcode);
  const revisionId = requireParagraphRevisionId(draftRevision);
  const base = draftResource(backend, entityType, bundle, id);
  let result;
  try {
    result = await backend.rawQuery({
      path: `${base}/mcp-draft`,
      options: {
        method: "GET",
        headers: {
          "If-Match": `"${revisionId}"`,
          "X-MCP-Draft-Langcode": langcode,
        },
      },
    });
  } catch (error) {
    throw missingEndpointError(error, MISSING_TRANSLATION_ENDPOINT);
  }
  if (!result?.data || result.data.id !== id) {
    throw new Error("Paragraph draft translation read did not identify the requested entity.");
  }
  return { ...backend.toCanonical(result.data), draftState: result.meta?.draft_state };
}
