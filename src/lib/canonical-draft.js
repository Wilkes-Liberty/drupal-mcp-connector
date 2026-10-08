/**
 * Draft open and continuation for library items and custom blocks (#420, #422).
 *
 * paragraphs_library_item and block_content use drupal_internal__revision_id.
 * When the host inventory advertises open_draft, the first draft and a later
 * continuation both use /mcp-draft. The body is the entity only: no meta and
 * no mcp_components. If-Match is the live revision, or live:working when a
 * forward draft already exists. The published revision and its paragraph
 * pins are re-read afterwards. A continuation compares the forward pins with
 * the pre-write working copy unless the caller submitted relationships.
 *
 * When that operation is absent, a published entity with no forward revision
 * is still opened by a canonical JSON:API PATCH whose moderation_state is
 * draft or review. A real forward revision is refused before that PATCH:
 * saving the published default again creates another forward revision from
 * the live copy and drops the existing draft.
 *
 * rel:working-copy is the latest revision. When its id differs from the
 * default, a forward draft already exists. rel:latest-version is the latest
 * default revision, not that draft. A 404, or a 403 whose message is
 * Drupal's "No pending revision", on rel:working-copy means no draft. The
 * same phrase at any other status fails closed. Any other 401/403, a
 * timeout, or a missing revision id fails closed. A draft-inventory 404 or
 * 405 is absence. Any other inventory failure fails closed. After the write
 * the published revision, rel:working-copy, and the published paragraph pins
 * (including order) are re-read. Entity Reference Revisions saves a new
 * paragraph revision when an existing host saves a new revision, so the draft
 * may pin a later revision of the submitted paragraph. That later revision
 * matches. An older revision, a different paragraph, or a different order
 * does not. A completed 4xx is returned when that re-read matches the
 * pre-write state. A lost response, or a 4xx whose re-read shows a change,
 * is reported from the re-read and is not called a rollback. An unmoderated
 * entity keeps the ordinary update.
 */

import { entityRevisionId } from "./write-revision.js";
import { httpStatusOf } from "./error-status.js";
import { paragraphPinsFromEntity } from "./err-relationships.js";
import { entityLooksModerated } from "./moderation-default.js";
import { supportsSentinelDraft } from "./sentinel-draft.js";
import { OPEN_DRAFT_OPERATION } from "./component-draft.js";

/** Entity types that stay on the canonical PATCH unless open_draft is advertised. */
export const CANONICAL_DRAFT_TYPES = new Set(["paragraphs_library_item", "block_content"]);

/** @param {?string} entityType */
export function isCanonicalDraftType(entityType) {
  return CANONICAL_DRAFT_TYPES.has(entityType);
}

/** Stable code when a revision id or version alias cannot be verified. */
export const REVISION_IDENTITY_CODE = "REVISION_IDENTITY";

/** Stable code when a forward draft has no governed continuation route. */
export const DRAFT_CONTINUATION_UNSUPPORTED_CODE = "DRAFT_CONTINUATION_UNSUPPORTED";

/** Stable code when a sent write could not be confirmed from a re-read. */
export const WRITE_RESULT_UNCERTAIN_CODE = "WRITE_RESULT_UNCERTAIN";

/**
 * @param {string} entityType
 * @param {string} detail
 */
export class RevisionIdentityError extends Error {
  constructor(entityType, detail) {
    super(
      `The revision identity of this ${entityType} could not be verified (${detail}). ` +
      "No write was attempted. See connector #420."
    );
    this.name = "RevisionIdentityError";
    this.code = REVISION_IDENTITY_CODE;
  }
}

/**
 * @param {string} entityType
 * @param {number|string} liveVid
 * @param {number|string} latestVid
 */
export class UnsupportedDraftContinuationError extends Error {
  constructor(entityType, liveVid, latestVid) {
    super(
      `A forward draft of this ${entityType} exists (published revision ${liveVid}, ` +
      `latest revision ${latestVid}), and there is no governed continuation endpoint for it. ` +
      "No write was attempted. Continue or discard that draft in Drupal, then retry. See connector #420."
    );
    this.name = "UnsupportedDraftContinuationError";
    this.code = DRAFT_CONTINUATION_UNSUPPORTED_CODE;
  }
}

/**
 * @param {string} entityType
 * @param {string} detail
 * @returns {Error}
 */
export function uncertainWriteError(entityType, detail) {
  const err = new Error(
    `The ${entityType} write result is uncertain (${detail}). ` +
    "Re-read the default revision and rel:latest-version before retrying. " +
    "Do not assume the published revision is unchanged. See connector #420."
  );
  err.name = "UncertainWriteError";
  err.code = WRITE_RESULT_UNCERTAIN_CODE;
  return err;
}

/**
 * Load the default revision before an update.
 * Canonical-draft types fail closed when that read is missing or denied.
 * Other types keep the previous contract: an explicit moderation_state skips
 * the read, and an unreadable target leaves the server-side gate in charge.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, attributes?: object}} ref
 * @returns {Promise<?object>}
 */
export async function readUpdateTarget(backend, { entityType, bundle, id, attributes }) {
  if (!isCanonicalDraftType(entityType)
    && attributes
    && Object.prototype.hasOwnProperty.call(attributes, "moderation_state")) {
    return null;
  }
  try {
    const existing = (await backend.getEntity({ entityType, bundle, id })) ?? null;
    if (isCanonicalDraftType(entityType) && !existing) {
      throw new RevisionIdentityError(entityType, "the default revision was not returned");
    }
    return existing;
  } catch (err) {
    if (err instanceof RevisionIdentityError) throw err;
    if (!isCanonicalDraftType(entityType)) return null;
    const status = httpStatusOf(err);
    const detail = status === 401 || status === 403
      ? "reading the default revision was denied"
      : "the default revision could not be read";
    throw new RevisionIdentityError(entityType, detail);
  }
}

/**
 * Decide the PATCH target for a library item or custom block.
 * An echoed default, confirmed by rel:latest-version, is not a draft.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, existing?: ?object}} ref
 * @returns {Promise<{resourceVersion: undefined, workingCopy: ?object, liveVid: number|string, workingVid: ?number|string}>}
 */
export async function resolveCanonicalDraftIdentity(backend, { entityType, bundle, id, existing }) {
  const ref = { entityType, bundle, id };
  const working = await readVersion(backend, ref, "rel:working-copy");
  if (working.kind === "denied" || working.kind === "failed" || working.kind === "unavailable") {
    throw new RevisionIdentityError(entityType, working.detail);
  }
  assertSameResource(entityType, id, working.entity, "rel:working-copy");

  let live = existing ?? null;
  let liveVid = entityRevisionId(live, entityType);
  if (liveVid === null) {
    const canonical = await readVersion(backend, ref);
    if (canonical.kind !== "ok") {
      throw new RevisionIdentityError(entityType, canonical.detail || "the default revision could not be read");
    }
    assertSameResource(entityType, id, canonical.entity, "the default revision");
    live = canonical.entity;
    liveVid = entityRevisionId(live, entityType);
  }
  const aliasVid = working.kind === "ok" ? entityRevisionId(working.entity, entityType) : null;
  if (working.kind === "ok" && (aliasVid === null || liveVid === null)) {
    throw new RevisionIdentityError(entityType, "rel:working-copy omitted a revision id");
  }

  const latest = await readVersion(backend, ref, "rel:latest-version");
  if (latest.kind !== "ok") {
    throw new RevisionIdentityError(entityType, latest.detail);
  }
  assertSameResource(entityType, id, latest.entity, "rel:latest-version");
  const latestVid = entityRevisionId(latest.entity, entityType);
  if (latestVid === null || liveVid === null) {
    throw new RevisionIdentityError(entityType, "rel:latest-version omitted a revision id");
  }
  if (String(latestVid) !== String(liveVid)) {
    throw new RevisionIdentityError(entityType, "rel:latest-version did not match the default revision");
  }
  const continuing = aliasVid !== null && String(aliasVid) !== String(liveVid);
  const openingPublished = entityLooksModerated(live) && live.status === true && !continuing;
  const governedDraft = (continuing || openingPublished)
    ? await selectGovernedDraft(backend, ref, { liveVid, workingVid: aliasVid })
    : null;
  if (!governedDraft && continuing) {
    throw new UnsupportedDraftContinuationError(entityType, liveVid, aliasVid);
  }
  return {
    resourceVersion: undefined,
    workingCopy: working.kind === "ok" ? working.entity : null,
    liveVid,
    workingVid: aliasVid,
    ...(governedDraft ? { governedDraft } : {}),
  };
}

/**
 * Canonical PATCH plus a before/after revision read.
 * Call only when no Sentinel draft pair was selected.
 *
 * @param {object} backend
 * @param {object} input updateEntity argument.
 * @returns {Promise<object>}
 */
export async function writeCanonicalModeratedEntity(backend, input) {
  const { entityType, bundle, id, attributes = {}, relationships } = input;
  const ref = { entityType, bundle, id };
  const preview = await readVersion(backend, ref);
  if (preview.kind === "ok" && !entityLooksModerated(preview.entity)) {
    return backend.updateEntity(input);
  }
  if (preview.kind !== "ok") {
    throw new RevisionIdentityError(entityType, preview.detail || "the default revision could not be read");
  }
  const before = await readPair(backend, ref, "before");
  if (String(before.latestVid) !== String(before.liveVid)) {
    throw new RevisionIdentityError(entityType, "rel:latest-version did not match the default revision");
  }
  const continuing = before.workingVid !== null && String(before.workingVid) !== String(before.liveVid);
  const openingDraft = entityLooksModerated(before.entity) && before.entity.status === true;
  if (openingDraft && !isForwardModerationState(attributes.moderation_state)) {
    throw new RevisionIdentityError(
      entityType,
      "a published moderated entity requires moderation_state draft or review"
    );
  }
  const governed = (continuing || openingDraft)
    ? await selectGovernedDraft(backend, ref, before)
    : null;
  if (governed) {
    return writeGovernedCanonicalDraft(backend, input, before, governed);
  }
  if (continuing) {
    throw new UnsupportedDraftContinuationError(entityType, before.liveVid, before.workingVid);
  }
  let result;
  try {
    result = await backend.updateEntity(input);
  } catch (err) {
    if (isDefinitiveClientError(err)) {
      const unchanged = await publishedStateUnchanged(backend, ref, before);
      if (unchanged === true) {
        if (err instanceof Error) {
          err.message +=
            " Re-read matched the published revision, rel:working-copy, and paragraph pins from before the request.";
        }
        throw err;
      }
    }
    throw uncertainWriteError(entityType, await lossDetail(backend, ref, err));
  }
  if (!result || result.id !== id) {
    throw uncertainWriteError(entityType, await lossDetail(
      backend, ref, new Error("the write response did not identify this entity")
    ));
  }
  const after = await readPair(backend, ref, "after");
  if (openingDraft) {
    assertPublishedPreserved(entityType, before, after, relationships);
  } else if (submittedParagraphPins(relationships)) {
    const written = after.workingVid !== null && String(after.workingVid) !== String(after.liveVid)
      ? after.working
      : after.entity;
    assertSubmittedPins(entityType, written, relationships);
  }
  return annotatedResult(result, before, after);
}

const VID_RE = /^[1-9]\d*$/;

/**
 * @param {unknown} vid
 * @returns {boolean}
 */
function validVid(vid) {
  return VID_RE.test(String(vid ?? "")) && Number.isSafeInteger(Number(vid));
}

/**
 * Library and custom-block inventory. A 404 or 405 is absence. Permission,
 * transport, and a malformed inventory fail closed. Node and media inventory
 * stays on readNodeDraftInventory.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @returns {Promise<?object>}
 */
async function readCanonicalDraftInventory(backend, ref) {
  if (!isCanonicalDraftType(ref.entityType) || !supportsSentinelDraft(backend)) return null;
  if (typeof backend.rawQuery !== "function" || typeof backend.resourcePath !== "function") {
    throw new RevisionIdentityError(ref.entityType, "the backend cannot read the draft inventory");
  }
  let result;
  try {
    result = await backend.rawQuery({
      path: `${backend.resourcePath(ref.entityType, ref.bundle)}/${encodeURIComponent(ref.id)}/mcp-translations`,
      options: { method: "GET" },
    });
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 404 || status === 405) return null;
    const detail = status === 401 || status === 403
      ? "reading the draft inventory was denied"
      : "the draft inventory could not be read";
    throw new RevisionIdentityError(ref.entityType, detail);
  }
  const inventory = result?.meta;
  if (!inventory || typeof inventory !== "object" || !validVid(inventory.live?.vid)
    || (inventory.working && !validVid(inventory.working.vid))) {
    throw new RevisionIdentityError(ref.entityType, "the draft inventory omitted a revision id");
  }
  return inventory;
}

/**
 * Select /mcp-draft only when this host advertises open_draft and the
 * inventory vids agree with the JSON:API default and working copy.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @param {{liveVid: number|string, workingVid: ?number|string}} identity
 * @returns {Promise<?{live: string, working: string, langcode: string}>}
 */
async function selectGovernedDraft(backend, ref, identity) {
  const inventory = await readCanonicalDraftInventory(backend, ref);
  if (!inventory) return null;
  const operations = Array.isArray(inventory.operations) ? inventory.operations : [];
  if (!operations.includes(OPEN_DRAFT_OPERATION)) return null;
  if (String(inventory.live.vid) !== String(identity.liveVid)) {
    throw new RevisionIdentityError(
      ref.entityType,
      "the draft inventory live revision did not match the default revision"
    );
  }
  const continuing = identity.workingVid !== null
    && identity.workingVid !== undefined
    && String(identity.workingVid) !== String(identity.liveVid);
  if (continuing) {
    if (inventory.working?.vid === undefined || inventory.working?.vid === null
      || String(inventory.working.vid) !== String(identity.workingVid)) {
      throw new RevisionIdentityError(
        ref.entityType,
        "the draft inventory working revision did not match rel:working-copy"
      );
    }
  } else if (inventory.working?.vid && String(inventory.working.vid) !== String(identity.liveVid)) {
    throw new RevisionIdentityError(
      ref.entityType,
      "the draft inventory reported a working revision rel:working-copy did not"
    );
  }
  const langcode = typeof inventory.defaultLangcode === "string" ? inventory.defaultLangcode : "";
  if (!langcode || /[\r\n]/.test(langcode)) {
    throw new RevisionIdentityError(ref.entityType, "the draft inventory omitted the default language");
  }
  if (continuing) {
    const row = (inventory.working?.translations ?? []).find((entry) => entry?.langcode === langcode);
    const state = typeof row?.moderation_state === "string" ? row.moderation_state : "";
    if (!row || row.status === true || state === "published") {
      throw new RevisionIdentityError(ref.entityType, "the working language is not an unpublished draft");
    }
  }
  return {
    live: String(identity.liveVid),
    working: continuing ? String(identity.workingVid) : "",
    langcode,
  };
}

/**
 * One /mcp-draft for a library item or custom block. No meta.
 *
 * @param {object} backend
 * @param {object} spec
 * @returns {Promise<object>}
 */
function governedCanonicalDraftRequest(backend, {
  entityType, bundle, id, attributes, relationships, live, working, langcode, preflight,
}) {
  const data = { type: `${entityType}--${bundle}`, id, attributes: attributes ?? {} };
  if (relationships && typeof relationships === "object" && Object.keys(relationships).length) {
    data.relationships = relationships;
  }
  return backend.rawQuery({
    path: `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}/mcp-draft`,
    options: {
      method: "PATCH",
      headers: {
        "If-Match": working ? `"${live}:${working}"` : `"${live}"`,
        "X-MCP-Draft-Preflight": preflight ? "1" : "0",
        "X-MCP-Draft-Langcode": langcode,
      },
      body: JSON.stringify({ data }),
    },
  });
}

/**
 * Non-saving /mcp-draft check for a library item or custom block.
 * The saving request reads the inventory again and does not reuse this result.
 *
 * @param {object} backend
 * @param {object} input
 * @returns {Promise<void>}
 */
export async function preflightGovernedCanonicalDraft(backend, input) {
  const governed = input.governedDraft;
  const checked = await governedCanonicalDraftRequest(backend, {
    entityType: input.entityType,
    bundle: input.bundle,
    id: input.id,
    attributes: input.attributes,
    relationships: input.relationships,
    live: governed.live,
    working: governed.working,
    langcode: governed.langcode,
    preflight: true,
  });
  const meta = checked?.meta;
  const working = governed.working || "";
  if (meta?.draft_preflight !== true || String(meta.live) !== String(governed.live)
    || String(meta.working ?? "") !== working
    || (!working && meta.operation !== OPEN_DRAFT_OPERATION)) {
    throw new Error("The site did not confirm a non-saving draft preflight. No write was attempted.");
  }
}

/**
 * Saving /mcp-draft after a fresh inventory read.
 *
 * @param {object} backend
 * @param {object} input
 * @param {object} before
 * @param {{live: string, working: string, langcode: string}} governed
 * @returns {Promise<object>}
 */
async function writeGovernedCanonicalDraft(backend, input, before, governed) {
  const { entityType, bundle, id, attributes = {}, relationships } = input;
  const ref = { entityType, bundle, id };
  const continuing = governed.working !== "";
  let result;
  try {
    result = await governedCanonicalDraftRequest(backend, {
      entityType, bundle, id, attributes, relationships,
      live: governed.live,
      working: governed.working,
      langcode: governed.langcode,
      preflight: false,
    });
  } catch (err) {
    if (isDefinitiveClientError(err)) {
      const unchanged = await publishedStateUnchanged(backend, ref, before);
      if (unchanged === true) {
        if (err instanceof Error) {
          err.message +=
            " Re-read matched the published revision, rel:working-copy, and paragraph pins from before the request.";
        }
        throw err;
      }
    }
    throw uncertainWriteError(entityType, await lossDetail(backend, ref, err));
  }
  const writtenId = result?.data?.id ?? result?.id;
  if (!result || writtenId !== id) {
    throw uncertainWriteError(entityType, await lossDetail(
      backend, ref, new Error("the write response did not identify this entity")
    ));
  }
  const after = await readPair(backend, ref, "after");
  if (entityLooksModerated(before.entity) && before.entity.status === true) {
    assertPublishedPreserved(entityType, before, after, relationships);
  } else if (submittedParagraphPins(relationships)) {
    const written = after.workingVid !== null && String(after.workingVid) !== String(after.liveVid)
      ? after.working
      : after.entity;
    assertSubmittedPins(entityType, written, relationships);
  }
  if (continuing && String(after.workingVid) === String(before.workingVid)) {
    throw uncertainWriteError(entityType, "the working revision did not advance");
  }
  return annotatedResult(result, before, after);
}

/**
 * Drupal's working-copy alias reports a missing draft as 403
 * "No pending revision", not as 404. That phrase is absence only on 403.
 * Any other 401/403 is a denied read. The phrase on 5xx or a timeout is a
 * failed read.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @param {string} [resourceVersion]
 * @returns {Promise<{kind: string, entity?: object, detail: string}>}
 */
async function readVersion(backend, ref, resourceVersion) {
  const label = resourceVersion || "the default revision";
  if (typeof backend?.getEntity !== "function") {
    return { kind: "unavailable", detail: "the backend cannot read revisions" };
  }
  try {
    const entity = await backend.getEntity({
      entityType: ref.entityType,
      bundle: ref.bundle,
      id: ref.id,
      ...(resourceVersion ? { resourceVersion } : {}),
    });
    if (!entity) return { kind: "absent", detail: `${label} was not found` };
    return { kind: "ok", entity, detail: "" };
  } catch (err) {
    const status = httpStatusOf(err);
    const message = String(err?.message || err || "");
    const missingDraft = resourceVersion === "rel:working-copy"
      && status === 403
      && /no pending revision/i.test(message);
    if (status === 404 || missingDraft) {
      return { kind: "absent", detail: `${label} was not found` };
    }
    if (status === 401 || status === 403) {
      return { kind: "denied", detail: `${label} was denied` };
    }
    return { kind: "failed", detail: `${label} could not be read` };
  }
}

/**
 * @param {string} entityType
 * @param {string} id
 * @param {?object} entity
 * @param {string} label
 */
function assertSameResource(entityType, id, entity, label, when = "before") {
  if (entity?.id && entity.id !== id) {
    const detail = `${label} returned ${entity.id} instead of ${id}`;
    if (when === "after") throw uncertainWriteError(entityType, detail);
    throw new RevisionIdentityError(entityType, detail);
  }
}

/**
 * Read the default revision and rel:latest-version.
 * A forward revision is returned to the caller; this function does not refuse it.
 * `when` is "before" (no request sent yet) or "after" (the response must not
 * claim the write was skipped).
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @param {"before"|"after"} when
 * @returns {Promise<{entity: object, latest: object, working: ?object, liveVid: number|string, latestVid: number|string, workingVid: ?number|string, pins: object[]}>}
 */
async function readPair(backend, ref, when) {
  const fail = (detail) => {
    if (when === "after") throw uncertainWriteError(ref.entityType, detail);
    throw new RevisionIdentityError(ref.entityType, detail);
  };
  const live = await readVersion(backend, ref);
  if (live.kind !== "ok") fail(live.detail);
  assertSameResource(ref.entityType, ref.id, live.entity, "the default revision", when);
  const latest = await readVersion(backend, ref, "rel:latest-version");
  if (latest.kind !== "ok") fail(latest.detail);
  assertSameResource(ref.entityType, ref.id, latest.entity, "rel:latest-version", when);
  const working = await readVersion(backend, ref, "rel:working-copy");
  if (working.kind === "denied" || working.kind === "failed" || working.kind === "unavailable") {
    fail(working.detail);
  }
  if (working.kind === "ok") {
    assertSameResource(ref.entityType, ref.id, working.entity, "rel:working-copy", when);
  }
  const liveVid = entityRevisionId(live.entity, ref.entityType);
  const latestVid = entityRevisionId(latest.entity, ref.entityType);
  const workingVid = working.kind === "ok" ? entityRevisionId(working.entity, ref.entityType) : null;
  if (liveVid === null || latestVid === null || (working.kind === "ok" && workingVid === null)) {
    fail(when === "after"
      ? "a revision id was missing after the write"
      : "a revision id was missing immediately before the write");
  }
  return {
    entity: live.entity,
    latest: latest.entity,
    working: working.kind === "ok" ? working.entity : null,
    liveVid,
    latestVid,
    workingVid,
    pins: normalizedPins(live.entity),
  };
}

/**
 * @param {string} entityType
 * @param {{liveVid: number|string, pins: object[]}} before
 * @param {{entity: object, working: ?object, liveVid: number|string, latestVid: number|string, workingVid: ?number|string, pins: object[]}} after
 * @param {?object} relationships
 */
function assertPublishedPreserved(entityType, before, after, relationships) {
  const problems = [];
  if (String(after.liveVid) !== String(before.liveVid)) {
    problems.push(`published revision was ${before.liveVid} before the write and is ${after.liveVid} after`);
  }
  if (String(after.latestVid) !== String(after.liveVid)) {
    problems.push(`rel:latest-version was ${after.latestVid} after the write and the default revision was ${after.liveVid}`);
  }
  if (pinKey(after.pins) !== pinKey(before.pins)) {
    problems.push("published paragraph pins changed");
  }
  const continuing = before.workingVid !== null && String(before.workingVid) !== String(before.liveVid);
  if (after.workingVid === null || String(after.workingVid) === String(before.liveVid)) {
    problems.push("no forward revision was verified");
  } else if (continuing && String(after.workingVid) === String(before.workingVid)) {
    problems.push("the working revision did not advance");
  }
  const submitted = submittedParagraphPins(relationships);
  const forwardPins = normalizedPins(after.working);
  const baseline = continuing ? normalizedPins(before.working) : before.pins;
  if (submitted) {
    const landed = forwardPins.filter((pin) => submitted.fields.has(pin.field));
    if (!submittedPinsLanded(submitted.pins, landed)) {
      problems.push("the forward revision does not pin the submitted paragraphs");
    }
  } else if (pinKey(forwardPins) !== pinKey(baseline)) {
    problems.push("the forward revision changed paragraph pins that were not submitted");
  }
  if (problems.length) {
    throw uncertainWriteError(entityType, problems.join("; "));
  }
}

/**
 * @param {string} entityType
 * @param {object} latest
 * @param {?object} relationships
 */
function assertSubmittedPins(entityType, latest, relationships) {
  const submitted = submittedParagraphPins(relationships);
  if (!submitted) return;
  const landed = normalizedPins(latest).filter((pin) => submitted.fields.has(pin.field));
  if (!submittedPinsLanded(submitted.pins, landed)) {
    throw uncertainWriteError(entityType, "the written revision does not pin the submitted paragraphs");
  }
}

/**
 * @param {object} result
 * @param {{liveVid: number|string}} before
 * @param {{working: ?object, liveVid: number|string, workingVid: ?number|string}} after
 * @returns {object}
 */
function annotatedResult(result, before, after) {
  if (after.workingVid === null || String(after.workingVid) === String(after.liveVid)) return result;
  return {
    ...after.working,
    _revisions: { live: before.liveVid, working: after.workingVid },
    _revision: {
      source: "working-copy",
      note:
        "Returned from rel:working-copy. The published default revision and its " +
        "paragraph pins were re-read and matched the revision from before the write.",
    },
  };
}

/**
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @param {unknown} err
 * @returns {Promise<string>}
 */
async function lossDetail(backend, ref, err) {
  const reason = err instanceof Error ? err.message : String(err);
  try {
    const live = await readVersion(backend, ref);
    const working = await readVersion(backend, ref, "rel:working-copy");
    const liveVid = live.kind === "ok" ? entityRevisionId(live.entity, ref.entityType) : null;
    const workingVid = working.kind === "ok" ? entityRevisionId(working.entity, ref.entityType) : null;
    const workingLabel = workingVid ?? (working.kind === "absent" ? "none" : "unreadable");
    const forward = liveVid !== null && workingVid !== null && String(workingVid) !== String(liveVid)
      ? " A forward revision is present; do not send another canonical update."
      : "";
    return `${reason}. Re-read: published revision ${liveVid ?? "unreadable"}, working revision ${workingLabel}.${forward}`;
  } catch (readErr) {
    const follow = readErr instanceof Error ? readErr.message : String(readErr);
    return `${reason}. A follow-up re-read failed (${follow}).`;
  }
}

/**
 * @param {?string} state
 * @returns {boolean}
 */
function isForwardModerationState(state) {
  return state === "draft" || state === "review";
}

/**
 * A completed 4xx names a rejected request. 408 and 429 do not: the write
 * may still have been accepted. 5xx and transport errors stay uncertain.
 * @param {unknown} err
 * @returns {boolean}
 */
function isDefinitiveClientError(err) {
  const status = httpStatusOf(err);
  if (status === null || status < 400 || status >= 500) return false;
  return status !== 408 && status !== 429;
}

/**
 * Whether the published revision, its pins, and the absence of a new
 * forward draft still match the pre-write read. Null means the re-read
 * itself failed, which is not proof that nothing changed.
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @param {{liveVid: number|string, pins: object[]}} before
 * @returns {Promise<?boolean>}
 */
async function publishedStateUnchanged(backend, ref, before) {
  try {
    const after = await readPair(backend, ref, "after");
    if (String(after.liveVid) !== String(before.liveVid)) return false;
    if (String(after.latestVid) !== String(after.liveVid)) return false;
    if (pinKey(after.pins) !== pinKey(before.pins)) return false;
    const continuing = before.workingVid !== null && String(before.workingVid) !== String(before.liveVid);
    if (continuing) {
      return after.workingVid !== null && String(after.workingVid) === String(before.workingVid);
    }
    if (after.workingVid !== null && String(after.workingVid) !== String(before.liveVid)) return false;
    return true;
  } catch {
    return null;
  }
}

/**
 * @param {?object} entity
 * @returns {Array<{field: string, id: string, revisionId: ?string}>}
 */
function normalizedPins(entity) {
  return paragraphPinsFromEntity(entity).map((pin) => ({
    field: pin.field,
    id: pin.id,
    revisionId: pin.revisionId === null || pin.revisionId === undefined || pin.revisionId === ""
      ? null
      : String(pin.revisionId),
  }));
}

/**
 * @param {?object} relationships
 * @returns {?{fields: Set<string>, pins: object[]}}
 */
function submittedParagraphPins(relationships) {
  if (!relationships || typeof relationships !== "object" || Array.isArray(relationships)) return null;
  const pins = [];
  const fields = new Set();
  for (const [field, rel] of Object.entries(relationships)) {
    if (!rel || typeof rel !== "object" || !Object.prototype.hasOwnProperty.call(rel, "data")) continue;
    const data = rel.data;
    const list = data === null || data === undefined ? [] : Array.isArray(data) ? data : [data];
    let fieldHasParagraph = false;
    for (const ref of list) {
      if (!ref?.id) continue;
      const type = typeof ref.type === "string" ? ref.type : "";
      if (ref.entityType !== "paragraph" && !type.startsWith("paragraph--")) continue;
      fieldHasParagraph = true;
      const revisionId = ref.meta?.target_revision_id;
      pins.push({
        field,
        id: ref.id,
        revisionId: revisionId === null || revisionId === undefined || revisionId === ""
          ? null
          : String(revisionId),
      });
    }
    if (fieldHasParagraph || data === null || (Array.isArray(data) && data.length === 0)) {
      fields.add(field);
    }
  }
  if (!fields.size) return null;
  return { fields, pins };
}

/**
 * @param {object[]} pins
 * @returns {string}
 */
function pinKey(pins) {
  const groups = new Map();
  for (const pin of pins) {
    const row = `${pin.id}\0${pin.revisionId ?? ""}`;
    if (!groups.has(pin.field)) groups.set(pin.field, []);
    groups.get(pin.field).push(row);
  }
  return [...groups.keys()].sort().map((field) => {
    const rows = groups.get(field) ?? [];
    return `${field}\0${rows.join("\n")}`;
  }).join("\n\n");
}

/**
 * Group pins by field, preserving submission and re-read order inside a field.
 * @param {object[]} pins
 * @returns {Map<string, object[]>}
 */
function pinsByField(pins) {
  const groups = new Map();
  for (const pin of pins) {
    if (!groups.has(pin.field)) groups.set(pin.field, []);
    groups.get(pin.field).push(pin);
  }
  return groups;
}

/**
 * Entity Reference Revisions creates a new paragraph revision when an existing
 * host saves a new revision, then points the host at that revision. The
 * submitted id is the earlier one. A missing revision on either side matches
 * only another missing revision.
 * @param {?string} submittedId
 * @param {?string} landedId
 * @returns {boolean}
 */
function sameRevisionOrNewer(submittedId, landedId) {
  const submittedMissing = submittedId === null || submittedId === undefined || submittedId === "";
  const landedMissing = landedId === null || landedId === undefined || landedId === "";
  if (submittedMissing || landedMissing) return submittedMissing && landedMissing;
  const submitted = Number(submittedId);
  const landed = Number(landedId);
  if (!Number.isSafeInteger(submitted) || !Number.isSafeInteger(landed)) {
    return String(submittedId) === String(landedId);
  }
  return landed >= submitted;
}

/**
 * Whether the re-read pins the submitted paragraphs, in order. A later
 * revision of the same paragraph counts. An older revision does not.
 * @param {object[]} submittedPins
 * @param {object[]} landedPins
 * @returns {boolean}
 */
function submittedPinsLanded(submittedPins, landedPins) {
  const submitted = pinsByField(submittedPins);
  const landed = pinsByField(landedPins);
  const submittedFields = [...submitted.keys()].sort();
  const landedFields = [...landed.keys()].sort();
  if (submittedFields.length !== landedFields.length
    || submittedFields.some((field, index) => field !== landedFields[index])) {
    return false;
  }
  return submittedFields.every((field) => {
    const left = submitted.get(field) ?? [];
    const right = landed.get(field) ?? [];
    if (left.length !== right.length) return false;
    return left.every((pin, index) => {
      const got = right[index];
      return got.id === pin.id && sameRevisionOrNewer(pin.revisionId, got.revisionId);
    });
  });
}
