/**
 * Governed nested-paragraph draft (#421).
 *
 * Sentinel component drafts edit only paragraphs the host pins directly.
 * A nested child is replaced by new unpublished paragraphs. The host draft
 * then points at a new direct parent. The published host and the paragraphs
 * it already pins are not patched.
 *
 * The first host draft needs Sentinel open_draft (2.29.0). An existing
 * working copy continues through /mcp-draft. There is no mcp_components
 * payload and no direct paragraph update.
 *
 * When the host inventory advertises nested_replacement, one /mcp-draft
 * carries meta.mcp_nested_replacement and this module creates no paragraphs.
 * parentId is sent as parent. The host paragraph field is not also sent.
 * resumeParentId stays on the client sequence: those paragraphs already exist.
 */

import { readNodeDraftInventory, readTranslationInventory, isMissingTranslationEndpoint, createTranslationDraft } from "./sentinel-draft.js";
import { entityRevisionId } from "./write-revision.js";
import { embedParagraphRef, paragraphRevisionId } from "./err-relationships.js";
import { httpStatusOf } from "./error-status.js";
import { OPEN_DRAFT_OPERATION, MIN_SENTINEL_COMPONENTS_VERSION, valueMatches } from "./component-draft.js";
import { applyParagraphTextFormats } from "./field-definition.js";
import { PREFLIGHT_NONE, PREFLIGHT_SENTINEL_DRAFT, dryRunChecks } from "./dry-run-checks.js";

export const NESTED_DRAFT_PARTIAL_CODE = "NESTED_DRAFT_PARTIAL";

/** Inventory operation: one atomic nested paragraph replacement. */
export const NESTED_REPLACEMENT_OPERATION = "nested_replacement";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z][a-z0-9_]*$/;
const SKIP_RELATIONSHIPS = new Set(["uid", "revision_uid"]);
const SKIPPED_FIELDS = new Set([
  "status", "moderation_state", "langcode", "default_langcode", "created", "changed",
  "parent_id", "parent_type", "parent_field_name", "behavior_settings",
  "revision_translation_affected", "content_translation_source",
  "content_translation_outdated", "content_translation_uid", "content_translation_created",
]);

/**
 * @param {string} detail
 * @param {object[]} prepared
 * @returns {Error}
 */
export function nestedDraftPartial(detail, prepared) {
  const ids = prepared.map((row) => row.id).filter(Boolean).join(", ") || "none";
  const hasParent = prepared.some((row) => row.role === "parent" && row.id);
  const recovery = hasParent
    ? "Delete them or retry the host pin with resumeParentId."
    : "Delete them. There is no prepared parent to pin.";
  const err = new Error(
    `The nested draft did not finish (${detail}). Prepared paragraphs (${ids}) are not ` +
    `referenced by the published host. ${recovery} ` +
    "Do not edit the published child paragraphs."
  );
  err.name = "NestedDraftPartialError";
  err.code = NESTED_DRAFT_PARTIAL_CODE;
  err.prepared = prepared;
  return err;
}

/**
 * The host request was sent, or a preflight failed after creates, and the
 * follow-up read did not prove what the host now pins.
 * @param {string} detail
 * @param {object[]} prepared
 * @returns {Error}
 */
export function nestedDraftUncertain(detail, prepared) {
  const ids = prepared.map((row) => row.id).join(", ");
  const err = new Error(
    `The nested draft outcome is uncertain (${detail}). Prepared paragraphs (${ids}) may or may not be pinned. ` +
    "Re-read the published revision and rel:working-copy before retrying. " +
    "Do not edit the published child paragraphs, and do not assume the draft succeeded."
  );
  err.name = "NestedDraftPartialError";
  err.code = NESTED_DRAFT_PARTIAL_CODE;
  err.prepared = prepared;
  err.uncertain = true;
  return err;
}

/**
 * @param {object} backend
 * @param {object} input
 * @param {{dryRun?: boolean, assertParagraphCreate?: (bundle: string) => void, site?: object}} [options]
 * @returns {Promise<object>}
 */
export async function draftNestedComponents(backend, input, { dryRun = false, assertParagraphCreate, site = {} } = {}) {
  const spec = normalizeNestedInput(input);
  // Caller-supplied children and translations only. Copied parent fields are
  // the stored paragraph, not a new format choice, and are left unchanged.
  await applyCallerParagraphFormats(backend, site, spec.children);
  const inventory = await readNodeDraftInventory(backend, spec);
  if (!inventory) {
    throw new Error(
      "This host has no governed draft inventory. Nested edits require a node draft. " +
      "No write was attempted, and no paragraph was created or edited."
    );
  }
  const operations = Array.isArray(inventory.operations) ? inventory.operations : [];
  const defaultLang = typeof inventory.defaultLangcode === "string" ? inventory.defaultLangcode : "";
  if (!defaultLang) throw new Error("Sentinel did not report the default language. No write was attempted.");
  const live = String(inventory.live.vid);
  if (spec.liveRevisionId && String(spec.liveRevisionId) !== live) {
    throw new Error(
      `The host revision is stale (requested ${spec.liveRevisionId}, live revision ${live}). No write was attempted.`
    );
  }
  const working = inventory.working?.vid && String(inventory.working.vid) !== live
    ? String(inventory.working.vid)
    : "";
  if (!working && !operations.includes(OPEN_DRAFT_OPERATION)) {
    throw new Error(
      `This Sentinel host cannot open the first draft (missing ${OPEN_DRAFT_OPERATION}). ` +
      `Update MCP Sentinel to ${MIN_SENTINEL_COMPONENTS_VERSION} or later. ` +
      "No write was attempted, and no paragraph was created."
    );
  }
  if (working) assertWorkingLanguageDraft(inventory, defaultLang);

  const publishedHost = await readHost(backend, spec, "");
  const publishedVid = entityRevisionId(publishedHost);
  if (publishedVid === null || String(publishedVid) !== live) {
    throw new Error("The host revision changed while reading it. No write was attempted.");
  }
  const publishedPins = fieldList(publishedHost, spec.field);
  const publishedSlot = publishedPins.findIndex((ref) => sameId(ref?.id, spec.parentId));
  if (publishedSlot < 0) {
    throw new Error(
      "This paragraph is not a direct component of the published host. " +
      "Nested paragraphs are not edited in place. No write was attempted."
    );
  }
  if (isReusable(publishedPins[publishedSlot])) throw reusableError();
  for (const ref of publishedPins) requirePinRevision(ref, "A direct component pin");
  let draftPins = publishedPins;
  if (working) {
    const workingHost = await readHost(backend, spec, working);
    const workingVid = entityRevisionId(workingHost);
    if (workingVid === null || String(workingVid) !== working) {
      throw new Error("The working copy revision changed while reading it. No write was attempted.");
    }
    draftPins = fieldList(workingHost, spec.field);
    for (const ref of draftPins) requirePinRevision(ref, "A working-copy component pin");
    if (draftPins.length !== publishedPins.length) {
      throw new Error("The working copy's component list does not match the published host. No write was attempted.");
    }
  }
  let slot = draftPins.findIndex((ref) => sameId(ref?.id, spec.parentId));
  if (slot < 0 && spec.resumeParentId) {
    slot = draftPins.findIndex((ref) => sameId(ref?.id, spec.resumeParentId));
  }
  if (slot < 0) {
    throw new Error(
      "A forward draft already replaces this component. The published host still pins it. " +
      "No further nested draft was started. Continue that draft in Drupal, or retry the host pin with resumeParentId."
    );
  }
  if (slot !== publishedSlot) {
    throw new Error("The working copy does not keep this component in the published slot. No write was attempted.");
  }
  const parentRef = publishedPins[publishedSlot];
  const parentBundle = paragraphBundle(parentRef);
  if (!parentBundle) throw new Error("The direct component has no paragraph type. No write was attempted.");
  const parentRevision = revisionOf(parentRef);
  const parent = await readParagraph(backend, parentBundle, spec.parentId, parentRevision);
  if (!sameId(parent?.id, spec.parentId)) {
    throw new Error("The component read did not match the requested paragraph. No write was attempted.");
  }
  const childPins = fieldList(parent, spec.childField);
  if (childPins.some(isReusable)) throw reusableError();
  for (const ref of childPins) requirePinRevision(ref, ref?.id || "A nested component");
  if (spec.resumeParentId && liveParagraphIds(publishedPins, childPins).has(spec.resumeParentId.toLowerCase())) {
    throw new Error("resumeParentId is a paragraph the published host already pins. No write was attempted.");
  }
  const requiredLangs = await requiredTranslationLangs(
    backend, parentBundle, spec.parentId, defaultLang, parentRevision,
  );
  assertChildren(spec.children, childPins, requiredLangs);
  if (!spec.resumeParentId) {
    const bundles = [
      ...spec.children.filter((child) => child.op !== "keep").map((child) => child.type),
      parentBundle,
    ];
    for (const bundle of bundles) assertParagraphCreate?.(bundle);
  }

  if (!spec.resumeParentId && operations.includes(NESTED_REPLACEMENT_OPERATION)) {
    return writeAtomicNestedReplacement(backend, {
      spec, dryRun, live, working, defaultLang, publishedPins, slot, childPins,
    });
  }

  if (dryRun) {
    return {
      dryRun: true,
      operation: "update",
      entityType: spec.entityType,
      bundle: spec.bundle,
      id: spec.id,
      hostPayloadEvaluated: false,
      createsParagraphs: !spec.resumeParentId,
      opensWorkingCopy: !working,
      replacesParentId: spec.parentId,
      note: "No paragraphs were created. The host draft payload was not evaluated because the replacement paragraphs do not exist yet.",
      ...dryRunChecks({ operation: "update", preflight: PREFLIGHT_NONE }),
    };
  }

  const prepared = [];
  const childRefs = [];
  if (spec.resumeParentId) {
    const resumed = await readParagraph(backend, parentBundle, spec.resumeParentId);
    const revisionId = await assertResumeMatches(
      backend, spec, parent, childPins, resumed, requiredLangs, defaultLang,
    );
    prepared.push({ id: spec.resumeParentId, bundle: parentBundle, role: "parent", revisionId });
  } else {
    for (const child of spec.children) {
      if (child.op === "keep") {
        const existing = childPins.find((ref) => sameId(ref?.id, child.id));
        childRefs.push(pinRef(existing));
        continue;
      }
      childRefs.push(await createParagraph(backend, child, prepared, assertParagraphCreate, defaultLang));
    }
    await createParagraph(backend, {
      op: "insert",
      type: parentBundle,
      attributes: copiedAttributes(parent),
      relationships: copiedRelationships(parent, spec.childField, childRefs),
      translations: [],
    }, prepared, assertParagraphCreate, defaultLang, "parent");
    await copyParentTranslations(backend, parent, prepared.find((row) => row.role === "parent"), requiredLangs, prepared);
  }

  const draftParent = spec.resumeParentId
    ? prepared[0]
    : prepared.find((row) => row.role === "parent");
  const nextPins = draftPins.map((ref, index) => (
    index === slot ? embedParagraphRef(draftParent.bundle, draftParent.id, draftParent.revisionId) : pinRef(ref)
  ));
  if (working && sameId(draftPins[slot]?.id, draftParent.id)) {
    const confirmed = await confirmLanded(backend, spec, live, nextPins);
    if (confirmed.ok) return finished(spec, live, confirmed.workingVid, draftParent, prepared, false);
    throw recoveryError(confirmed, "the existing draft pin could not be confirmed", prepared);
  }

  const data = {
    type: `${spec.entityType}--${spec.bundle}`,
    id: spec.id,
    attributes: { moderation_state: "draft" },
    relationships: { [spec.field]: { data: nextPins } },
  };
  const request = { ...spec, data, live, working, langcode: defaultLang };
  try {
    await confirmHostPreflight(backend, request);
  } catch (err) {
    const confirmed = await confirmLanded(backend, spec, live, nextPins);
    if (confirmed.ok) return finished(spec, live, confirmed.workingVid, draftParent, prepared, !working);
    throw recoveryError(confirmed, messageOf(err), prepared);
  }
  let result;
  try {
    result = await hostDraftRequest(backend, { ...request, preflight: false });
  } catch (err) {
    const confirmed = await confirmLanded(backend, spec, live, nextPins);
    if (confirmed.ok) return finished(spec, live, confirmed.workingVid, draftParent, prepared, !working);
    throw recoveryError(confirmed, messageOf(err), prepared);
  }
  if (!result?.data || result.data.id !== spec.id) {
    const confirmed = await confirmLanded(backend, spec, live, nextPins);
    if (confirmed.ok) return finished(spec, live, confirmed.workingVid, draftParent, prepared, !working);
    throw recoveryError(confirmed, "the host draft response did not identify the node", prepared);
  }
  const landed = await confirmLanded(backend, spec, live, nextPins);
  if (!landed.ok) {
    throw recoveryError(landed, "the working copy did not pin the new component", prepared);
  }
  return finished(spec, live, landed.workingVid, draftParent, prepared, !working);
}

/**
 * One server-side nested replacement. The connector creates nothing.
 *
 * @param {object} backend
 * @param {object} args
 * @returns {Promise<object>}
 */
async function writeAtomicNestedReplacement(backend, {
  spec, dryRun, live, working, defaultLang, publishedPins, slot, childPins,
}) {
  const data = {
    type: `${spec.entityType}--${spec.bundle}`,
    id: spec.id,
    attributes: { moderation_state: "draft" },
  };
  const request = {
    ...spec,
    data,
    meta: {
      mcp_nested_replacement: {
        field: spec.field,
        parent: spec.parentId,
        childField: spec.childField,
        children: spec.children.map(atomicChild),
      },
    },
    live,
    working,
    langcode: defaultLang,
  };
  try {
    await confirmAtomicPreflight(backend, request);
  } catch (err) {
    throw noWriteError(err);
  }
  if (dryRun) {
    return {
      dryRun: true,
      operation: "update",
      entityType: spec.entityType,
      bundle: spec.bundle,
      id: spec.id,
      hostPayloadEvaluated: true,
      createsParagraphs: false,
      opensWorkingCopy: !working,
      replacesParentId: spec.parentId,
      atomic: true,
      ...dryRunChecks({ operation: "update", preflight: PREFLIGHT_SENTINEL_DRAFT }),
    };
  }
  let result;
  try {
    result = await atomicDraftRequest(backend, { ...request, preflight: false });
  } catch (err) {
    const confirmed = await confirmAtomicLanded(backend, spec, live, working, publishedPins, slot, childPins);
    if (confirmed.ok) return atomicFinished(spec, live, confirmed, !working);
    throw atomicFailure(confirmed, messageOf(err));
  }
  if (!result?.data || result.data.id !== spec.id) {
    const confirmed = await confirmAtomicLanded(backend, spec, live, working, publishedPins, slot, childPins);
    if (confirmed.ok) return atomicFinished(spec, live, confirmed, !working);
    throw atomicFailure(confirmed, "the host draft response did not identify the node");
  }
  const landed = await confirmAtomicLanded(backend, spec, live, working, publishedPins, slot, childPins);
  if (!landed.ok) throw atomicFailure(landed, "the working copy did not show the nested replacement");
  return atomicFinished(spec, live, landed, !working);
}

/**
 * @param {object} child
 * @returns {object}
 */
function atomicChild(child) {
  if (child.op === "keep") return { op: "keep", id: child.id };
  const entry = {
    op: child.op,
    type: `paragraph--${child.type}`,
    attributes: child.attributes,
  };
  if (child.op === "replace") entry.id = child.id;
  if (child.translations?.length) entry.translations = child.translations;
  return entry;
}

/**
 * @param {object} backend
 * @param {object} request
 * @returns {Promise<object>}
 */
function atomicDraftRequest(backend, { entityType, bundle, id, data, meta, live, working, langcode, preflight }) {
  return backend.rawQuery({
    path: `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}/mcp-draft`,
    options: {
      method: "PATCH",
      headers: {
        "If-Match": working ? `"${live}:${working}"` : `"${live}"`,
        "X-MCP-Draft-Preflight": preflight ? "1" : "0",
        "X-MCP-Draft-Langcode": langcode,
      },
      body: JSON.stringify({ data, meta }),
    },
  });
}

/**
 * @param {object} backend
 * @param {object} request
 * @returns {Promise<void>}
 */
async function confirmAtomicPreflight(backend, request) {
  const checked = await atomicDraftRequest(backend, { ...request, preflight: true });
  const meta = checked?.meta;
  if (meta?.draft_preflight !== true || String(meta.live) !== request.live
    || String(meta.working ?? "") !== request.working
    || meta.operation !== NESTED_REPLACEMENT_OPERATION) {
    throw new Error("The site did not confirm a non-saving nested replacement preflight. No write was attempted.");
  }
}

/**
 * @param {object} backend
 * @param {object} spec
 * @param {string} live
 * @param {string} previousWorking
 * @param {object[]} publishedPins
 * @param {number} slot
 * @param {object[]} childPins
 * @returns {Promise<object>}
 */
async function confirmAtomicLanded(backend, spec, live, previousWorking, publishedPins, slot, childPins) {
  let published;
  let workingEntity;
  try {
    published = await backend.getEntity({ entityType: spec.entityType, bundle: spec.bundle, id: spec.id });
    workingEntity = await backend.getEntity({
      entityType: spec.entityType, bundle: spec.bundle, id: spec.id, resourceVersion: "rel:working-copy",
    });
  } catch (err) {
    return { ok: false, uncertain: true, publishedIntact: false, detail: messageOf(err) };
  }
  if (!published || !workingEntity) {
    return { ok: false, uncertain: true, publishedIntact: false, detail: "a host revision was not returned" };
  }
  const publishedVid = entityRevisionId(published);
  const publishedNow = fieldList(published, spec.field);
  const publishedIntact = publishedVid !== null && String(publishedVid) === String(live)
    && samePinList(publishedNow, publishedPins);
  if (!publishedIntact) {
    return { ok: false, uncertain: true, publishedIntact: false, detail: "the published revision changed" };
  }
  const workingPins = fieldList(workingEntity, spec.field);
  const newParentRef = workingPins[slot];
  const stillOriginal = !newParentRef || sameId(newParentRef.id, spec.parentId);
  const workingVid = entityRevisionId(workingEntity);
  const advanced = workingVid !== null && String(workingVid) !== String(live)
    && (!previousWorking || String(workingVid) !== String(previousWorking));
  if (stillOriginal) {
    return {
      ok: false, uncertain: false, publishedIntact: true,
      detail: "the published host still pins the original component",
    };
  }
  if (!advanced || workingPins.length !== publishedPins.length
    || workingPins.some((ref, index) => index !== slot && pinKey(ref) !== pinKey(publishedPins[index]))) {
    return {
      ok: false, uncertain: true, publishedIntact: true,
      detail: advanced
        ? "a new pin appeared without a verifiable component list"
        : "a new pin appeared but the working revision did not advance",
    };
  }
  const bundle = paragraphBundle(newParentRef);
  const revisionId = revisionOf(newParentRef);
  let parent;
  try {
    parent = await backend.getEntity({
      entityType: "paragraph",
      bundle,
      id: newParentRef.id,
      ...(revisionId ? { resourceVersion: `id:${revisionId}` } : {}),
    });
  } catch (err) {
    return { ok: false, uncertain: true, publishedIntact: true, detail: messageOf(err) };
  }
  if (!isUnpublishedParagraph(parent)) {
    return {
      ok: false, uncertain: true, publishedIntact: true,
      detail: "the new parent was not an unpublished paragraph",
    };
  }
  const nextChildren = fieldList(parent, spec.childField);
  const childDetail = await verifyAtomicChildren(backend, spec, childPins, nextChildren);
  if (childDetail) {
    return { ok: false, uncertain: true, publishedIntact: true, detail: childDetail };
  }
  const prepared = [{
    id: newParentRef.id, bundle, role: "parent", revisionId, atomic: true,
  }];
  spec.children.forEach((child, index) => {
    if (child.op === "keep") return;
    const pin = nextChildren[index];
    prepared.push({
      id: pin.id, bundle: paragraphBundle(pin), role: "child", revisionId: revisionOf(pin), atomic: true,
    });
  });
  return {
    ok: true,
    workingVid: String(workingVid),
    parent: { id: newParentRef.id, bundle, revisionId },
    prepared,
  };
}

/**
 * @param {object} backend
 * @param {object} spec
 * @param {object[]} originalPins
 * @param {object[]} nextPins
 * @returns {Promise<?string>}
 */
async function verifyAtomicChildren(backend, spec, originalPins, nextPins) {
  if (nextPins.length !== spec.children.length) {
    return "the new parent child list does not match the request";
  }
  for (let index = 0; index < spec.children.length; index += 1) {
    const child = spec.children[index];
    const pin = nextPins[index];
    if (child.op === "keep") {
      const original = originalPins.find((ref) => sameId(ref?.id, child.id));
      if (!sameId(pin?.id, child.id) || String(revisionOf(pin)) !== String(revisionOf(original))) {
        return `kept child ${child.id} was not pinned at its original revision`;
      }
      continue;
    }
    if (child.op === "replace" && sameId(pin?.id, child.id)) {
      return `replaced child ${child.id} was not a new paragraph`;
    }
    if (paragraphBundle(pin) !== child.type) return "a new child has the wrong paragraph type";
    let entity;
    try {
      const revisionId = revisionOf(pin);
      entity = await backend.getEntity({
        entityType: "paragraph",
        bundle: child.type,
        id: pin.id,
        ...(revisionId ? { resourceVersion: `id:${revisionId}` } : {}),
      });
    } catch (err) {
      return messageOf(err);
    }
    if (!isUnpublishedParagraph(entity)) return "a new child was not unpublished";
    const stored = entity.fields ?? entity.attributes ?? {};
    const mismatch = Object.entries(child.attributes ?? {}).find(([key, value]) => !valueMatches(value, stored[key]));
    if (mismatch) return `child field ${mismatch[0]} did not match`;
  }
  return null;
}

/**
 * @param {?object} entity
 * @returns {boolean}
 */
function isUnpublishedParagraph(entity) {
  if (!entity || typeof entity !== "object") return false;
  const state = String(entity.fields?.moderation_state ?? entity.moderation_state ?? "").toLowerCase();
  if (entity.status === true || state === "published") return false;
  return entity.status === false || state === "draft" || state === "review";
}

/**
 * @param {object[]} left
 * @param {object[]} right
 * @returns {boolean}
 */
function samePinList(left, right) {
  return left.length === right.length && left.every((ref, index) => pinKey(ref) === pinKey(right[index]));
}

/**
 * @param {unknown} err
 * @returns {Error}
 */
function noWriteError(err) {
  const message = messageOf(err);
  if (/no write was attempted/i.test(message)) return err instanceof Error ? err : new Error(message);
  return new Error(`${message} No write was attempted.`);
}

/**
 * @param {object} confirmed
 * @param {string} fallback
 * @returns {Error}
 */
function atomicFailure(confirmed, fallback) {
  const detail = confirmed.detail && confirmed.detail !== fallback
    ? `${fallback} (${confirmed.detail})`
    : (confirmed.detail || fallback);
  if (confirmed.uncertain || !confirmed.publishedIntact) return atomicUncertain(detail);
  return atomicPartial(detail);
}

/**
 * @param {string} detail
 * @returns {Error}
 */
function atomicPartial(detail) {
  const err = new Error(
    `The nested replacement did not finish (${detail}). The published host still pins the original component. ` +
    "No paragraph was prepared by the connector. Do not edit the published child paragraphs."
  );
  err.name = "NestedDraftPartialError";
  err.code = NESTED_DRAFT_PARTIAL_CODE;
  err.prepared = [];
  err.atomic = true;
  return err;
}

/**
 * @param {string} detail
 * @returns {Error}
 */
function atomicUncertain(detail) {
  const err = new Error(
    `The nested replacement outcome is uncertain (${detail}). ` +
    "Re-read the published revision and rel:working-copy before retrying. " +
    "Do not assume the published revision is unchanged. No paragraph was prepared by the connector."
  );
  err.name = "NestedDraftPartialError";
  err.code = NESTED_DRAFT_PARTIAL_CODE;
  err.prepared = [];
  err.uncertain = true;
  err.atomic = true;
  return err;
}

/**
 * @param {object} spec
 * @param {string} live
 * @param {object} confirmed
 * @param {boolean} opened
 * @returns {object}
 */
function atomicFinished(spec, live, confirmed, opened) {
  return {
    id: spec.id,
    entityType: spec.entityType,
    bundle: spec.bundle,
    publishedParentId: spec.parentId,
    draftParentId: confirmed.parent.id,
    publishedPinsUnchanged: true,
    opensWorkingCopy: opened,
    atomic: true,
    prepared: confirmed.prepared,
    _revisions: { live, working: confirmed.workingVid },
  };
}

/**
 * @param {object} input
 * @returns {object}
 */
function normalizeNestedInput(input) {
  const entityType = input?.entityType;
  if (entityType !== "node") {
    throw new Error("Nested draft edits are supported on nodes. No write was attempted.");
  }
  const bundle = String(input.bundle ?? "");
  const id = String(input.id ?? "");
  const field = String(input.field ?? "");
  const parentId = String(input.parentId ?? "");
  const childField = String(input.childField ?? "");
  if (!NAME_RE.test(bundle) || !NAME_RE.test(field) || !NAME_RE.test(childField)) {
    throw new Error("bundle, field, and childField must be Drupal machine names.");
  }
  if (!UUID_RE.test(id) || !UUID_RE.test(parentId)) {
    throw new Error("The host id and parentId must be UUIDs.");
  }
  const resumeParentId = input.resumeParentId ? String(input.resumeParentId) : "";
  if (resumeParentId && (!UUID_RE.test(resumeParentId) || resumeParentId === parentId)) {
    throw new Error("resumeParentId must be the prepared parent UUID, not the published component.");
  }
  const children = Array.isArray(input.children) ? input.children : null;
  if (!children) throw new Error("children must be the full new child list.");
  return {
    entityType, bundle, id, field, parentId, childField, resumeParentId,
    liveRevisionId: input.liveRevisionId,
    children: children.map(normalizeChild),
  };
}

/**
 * @param {object} child
 * @param {number} index
 * @returns {object}
 */
function normalizeChild(child, index) {
  const where = `children[${index}]`;
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error(`${where} must be an object.`);
  }
  if (Object.hasOwn(child, "relationships") && child.op !== undefined) {
    throw new Error(`${where}: a nested edit cannot change references inside the child. Create a new child instead.`);
  }
  const op = child.op;
  if (op !== "keep" && op !== "replace" && op !== "insert") {
    throw new Error(`${where}.op must be keep, replace, or insert. Omit a child to remove it from the draft.`);
  }
  if ((op === "keep" || op === "replace") && !UUID_RE.test(String(child.id ?? ""))) {
    throw new Error(`${where}.id must be the existing child UUID.`);
  }
  if (op === "keep") return { op, id: String(child.id) };
  const bundle = paragraphType(child.type, where);
  const attributes = child.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new Error(`${where}.attributes must be the field values for the new paragraph.`);
  }
  const translations = Array.isArray(child.translations) ? child.translations.map((row, translationIndex) => {
    if (!row || typeof row.langcode !== "string" || !row.attributes || typeof row.attributes !== "object") {
      throw new Error(`${where}.translations[${translationIndex}] must have langcode and attributes.`);
    }
    return { langcode: row.langcode, attributes: row.attributes };
  }) : [];
  return { op, id: child.id ? String(child.id) : "", type: bundle, attributes, translations };
}

/**
 * @param {object[]} children
 * @param {object[]} childPins
 * @param {Set<string>} requiredLangs
 */
function assertChildren(children, childPins, requiredLangs) {
  const known = new Set(childPins.map((ref) => ref?.id?.toLowerCase()).filter(Boolean));
  const seen = new Set();
  for (const child of children) {
    if (child.op === "insert") {
      assertLangs(child, requiredLangs);
      continue;
    }
    const key = child.id.toLowerCase();
    if (!known.has(key)) {
      throw new Error(
        `${child.id} is not a child of this component. No write was attempted.`
      );
    }
    if (seen.has(key)) throw new Error(`${child.id} is listed more than once.`);
    seen.add(key);
    if (child.op === "replace") assertLangs(child, requiredLangs);
  }
}

/**
 * @param {object} backend
 * @param {object} site
 * @param {object[]} children
 * @returns {Promise<void>}
 */
async function applyCallerParagraphFormats(backend, site, children) {
  for (const child of children) {
    if (child.op === "keep") continue;
    await applyParagraphTextFormats(backend, site, child.type, child.attributes);
    for (const translation of child.translations ?? []) {
      await applyParagraphTextFormats(backend, site, child.type, translation.attributes);
    }
  }
}

function assertLangs(child, requiredLangs) {
  const supplied = new Set(child.translations.map((row) => row.langcode));
  for (const lang of requiredLangs) {
    if (!supplied.has(lang)) {
      throw new Error(
        `This component has a ${lang} translation that was not included. No write was attempted.`
      );
    }
  }
}

/**
 * @param {object} backend
 * @param {object} child
 * @param {object[]} prepared
 * @param {(bundle: string) => void} [assertParagraphCreate]
 * @param {string} defaultLang
 * @param {"child"|"parent"} [role]
 * @returns {Promise<object>}
 */
async function createParagraph(backend, child, prepared, assertParagraphCreate, defaultLang, role = "child") {
  try {
    assertParagraphCreate?.(child.type);
  } catch (err) {
    if (prepared.length) throw nestedDraftPartial(messageOf(err), prepared);
    throw err;
  }
  let created;
  try {
    created = await backend.createEntity({
      entityType: "paragraph",
      bundle: child.type,
      langcode: defaultLang,
      attributes: child.attributes,
      ...(child.relationships ? { relationships: child.relationships } : {}),
    });
  } catch (err) {
    const orphan = err?.entity;
    if (orphan?.id) {
      prepared.push({
        id: orphan.id, bundle: child.type, role, revisionId: paragraphRevisionId(orphan),
      });
    }
    if (prepared.length) throw nestedDraftPartial(messageOf(err), prepared);
    throw err;
  }
  const servedLang = created?.langcode ?? created?.fields?.langcode ?? "";
  if (servedLang !== defaultLang) {
    prepared.push({
      id: created?.id, bundle: child.type, role, revisionId: paragraphRevisionId(created),
    });
    const reported = servedLang || "an unreported language";
    throw nestedDraftPartial(
      `paragraph ${created?.id} was created in "${reported}", not ${defaultLang}`,
      prepared,
    );
  }
  const revisionId = paragraphRevisionId(created);
  if (revisionId === null) {
    prepared.push({ id: created?.id, bundle: child.type, role, revisionId: null });
    throw nestedDraftPartial(`paragraph ${created?.id} has no revision id`, prepared);
  }
  const row = { id: created.id, bundle: child.type, role, revisionId };
  prepared.push(row);
  for (const translation of child.translations ?? []) {
    if (translation.langcode === defaultLang) continue;
    try {
      await createTranslationDraft(backend, {
        entityType: "paragraph",
        bundle: child.type,
        id: created.id,
        langcode: translation.langcode,
        attributes: translation.attributes,
        draftRevision: { revisionId },
      });
    } catch (err) {
      throw nestedDraftPartial(messageOf(err), prepared);
    }
  }
  return embedParagraphRef(child.type, created.id, revisionId);
}

/**
 * @param {object} backend
 * @param {object} spec
 * @returns {Promise<object>}
 */
function hostDraftRequest(backend, { entityType, bundle, id, data, live, working, langcode, preflight }) {
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
 * @param {object} backend
 * @param {object} request
 * @returns {Promise<void>}
 */
async function confirmHostPreflight(backend, request) {
  const checked = await hostDraftRequest(backend, { ...request, preflight: true });
  const meta = checked?.meta;
  if (meta?.draft_preflight !== true || String(meta.live) !== request.live
    || String(meta.working ?? "") !== request.working
    || (!request.working && meta.operation !== OPEN_DRAFT_OPERATION)) {
    throw new Error("The site did not confirm a non-saving host draft preflight.");
  }
}

/**
 * @param {object} backend
 * @param {object} spec
 * @param {string} live
 * @param {object[]} expectedWorkingPins
 * @returns {Promise<?string>} Working revision id when the draft pin landed.
 */
async function confirmLanded(backend, spec, live, expectedWorkingPins) {
  let published;
  let workingEntity;
  try {
    published = await backend.getEntity({ entityType: spec.entityType, bundle: spec.bundle, id: spec.id });
    workingEntity = await backend.getEntity({
      entityType: spec.entityType, bundle: spec.bundle, id: spec.id, resourceVersion: "rel:working-copy",
    });
  } catch (err) {
    return { ok: false, uncertain: true, detail: messageOf(err) };
  }
  if (!published || !workingEntity) {
    return { ok: false, uncertain: true, detail: "a host revision was not returned" };
  }
  const publishedVid = entityRevisionId(published);
  if (publishedVid === null || String(publishedVid) !== String(live)) {
    return { ok: false, uncertain: false, detail: "the published revision changed" };
  }
  const publishedIds = fieldList(published, spec.field).map((ref) => ref?.id?.toLowerCase());
  if (!publishedIds.includes(spec.parentId.toLowerCase())) {
    return { ok: false, uncertain: false, detail: "the published host no longer pins the original component" };
  }
  const workingVid = entityRevisionId(workingEntity);
  if (workingVid === null || String(workingVid) === String(live)) {
    return { ok: false, uncertain: false, detail: "no forward revision was found" };
  }
  const workingKeys = fieldList(workingEntity, spec.field).map(pinKey);
  const expectedKeys = expectedWorkingPins.map(pinKey);
  if (workingKeys.length !== expectedKeys.length || workingKeys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, uncertain: false, detail: "the working copy did not pin the prepared revision" };
  }
  return { ok: true, workingVid: String(workingVid) };
}

/**
 * @param {{ok: boolean, uncertain?: boolean, detail?: string}} confirmed
 * @param {string} fallback
 * @param {object[]} prepared
 * @returns {Error}
 */
function recoveryError(confirmed, fallback, prepared) {
  if (confirmed.uncertain
    || confirmed.detail === "the published revision changed"
    || confirmed.detail === "the published host no longer pins the original component") {
    const why = confirmed.uncertain ? `re-read failed: ${confirmed.detail}` : confirmed.detail;
    return nestedDraftUncertain(`${fallback}; ${why}`, prepared);
  }
  const reason = confirmed.detail && confirmed.detail !== fallback
    ? `${fallback} (${confirmed.detail})`
    : fallback;
  return nestedDraftPartial(reason, prepared);
}

/**
 * Copy the published component's non-default translations onto the new parent.
 * The new paragraph is not the one the published host pins.
 * @param {object} backend
 * @param {object} source Published parent paragraph.
 * @param {object} created Prepared parent row.
 * @param {Set<string>} langs
 * @param {object[]} prepared
 * @returns {Promise<void>}
 */
async function copyParentTranslations(backend, source, created, langs, prepared) {
  for (const lang of langs) {
    let translated;
    try {
      translated = await backend.getEntity({
        entityType: "paragraph",
        bundle: created.bundle,
        id: source.id,
        langcode: lang,
        resourceVersion: `id:${paragraphRevisionId(source)}`,
      });
    } catch (err) {
      throw nestedDraftPartial(`the ${lang} translation could not be copied (${messageOf(err)})`, prepared);
    }
    if (!translated) {
      throw nestedDraftPartial(`the ${lang} translation of the component could not be read`, prepared);
    }
    try {
      await createTranslationDraft(backend, {
        entityType: "paragraph",
        bundle: created.bundle,
        id: created.id,
        langcode: lang,
        attributes: copiedAttributes(translated),
        draftRevision: { revisionId: created.revisionId },
      });
    } catch (err) {
      throw nestedDraftPartial(messageOf(err), prepared);
    }
  }
}

/**
 * @param {object} spec
 * @param {string} live
 * @param {string} workingVid
 * @param {object} draftParent
 * @param {object[]} prepared
 * @param {boolean} opened
 * @returns {object}
 */
function finished(spec, live, workingVid, draftParent, prepared, opened) {
  return {
    id: spec.id,
    entityType: spec.entityType,
    bundle: spec.bundle,
    publishedParentId: spec.parentId,
    draftParentId: draftParent.id,
    publishedPinsUnchanged: true,
    opensWorkingCopy: opened,
    prepared,
    _revisions: { live, working: workingVid },
  };
}

/**
 * @param {object} inventory
 * @param {string} defaultLang
 */
function assertWorkingLanguageDraft(inventory, defaultLang) {
  const row = (inventory.working.translations ?? []).find((item) => item?.langcode === defaultLang);
  const state = typeof row?.moderation_state === "string" ? row.moderation_state : "";
  if (!row || row.status === true || state === "published") {
    throw new Error(
      `The default language (${defaultLang}) is still published on the working copy, so it cannot be continued. ` +
      "No write was attempted."
    );
  }
}

/**
 * @param {object} backend
 * @param {object} spec
 * @param {string} working
 * @returns {Promise<object>}
 */
async function readHost(backend, spec, working) {
  try {
    const entity = await backend.getEntity({
      entityType: spec.entityType,
      bundle: spec.bundle,
      id: spec.id,
      ...(working ? { resourceVersion: `id:${working}` } : {}),
    });
    if (!entity) throw new Error("The host revision was not returned.");
    return entity;
  } catch (err) {
    if (httpStatusOf(err) === 401 || httpStatusOf(err) === 403) {
      throw new Error("Reading the host was denied. No write was attempted.");
    }
    throw err;
  }
}

/**
 * @param {object} backend
 * @param {string} bundle
 * @param {string} id
 * @param {?number|string} [revisionId]
 * @returns {Promise<object>}
 */
async function readParagraph(backend, bundle, id, revisionId, langcode) {
  try {
    const entity = await backend.getEntity({
      entityType: "paragraph",
      bundle,
      id,
      ...(revisionId ? { resourceVersion: `id:${revisionId}` } : {}),
      ...(langcode ? { langcode } : {}),
    });
    if (!entity) throw new Error(`Paragraph ${id} was not returned.`);
    return entity;
  } catch (err) {
    if (httpStatusOf(err) === 401 || httpStatusOf(err) === 403) {
      throw new Error("Reading a nested component was denied. No write was attempted.");
    }
    throw err;
  }
}

/**
 * @param {object} backend
 * @param {string} bundle
 * @param {string} id
 * @param {string} defaultLang
 * @param {number|string|null} revisionId Pinned paragraph revision, not a later canonical revision.
 * @returns {Promise<Set<string>>}
 */
async function requiredTranslationLangs(backend, bundle, id, defaultLang, revisionId) {
  try {
    const inventory = await readTranslationInventory(backend, {
      entityType: "paragraph", bundle, id, revisionId,
    });
    const langs = new Set();
    for (const row of inventory?.live?.translations ?? []) {
      if (row?.langcode && row.langcode !== defaultLang) langs.add(row.langcode);
    }
    return langs;
  } catch (err) {
    if (isMissingTranslationEndpoint(err)) return new Set();
    throw err;
  }
}

/**
 * @param {?object} entity
 * @returns {object}
 */
function copiedAttributes(entity) {
  const fields = entity?.fields && typeof entity.fields === "object" ? entity.fields : {};
  const attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("drupal_internal__") || SKIPPED_FIELDS.has(key)) continue;
    attributes[key] = value;
  }
  return attributes;
}

/**
 * Copy every content relationship except the child field being replaced.
 * Authorship relationships are left for the create policy to stamp.
 * @param {?object} entity
 * @param {string} childField
 * @param {object[]} childData
 * @returns {object}
 */
function copiedRelationships(entity, childField, childData) {
  const rels = entity?.relationships && typeof entity.relationships === "object" ? entity.relationships : {};
  const out = {};
  for (const [key, value] of Object.entries(rels)) {
    if (key === childField || SKIP_RELATIONSHIPS.has(key)) continue;
    const payload = relationshipPayload(value);
    if (payload) out[key] = payload;
  }
  out[childField] = { data: childData };
  return out;
}

/**
 * The resumed paragraph must be the one this request would have created:
 * same copied fields, same other references, and the requested child pins.
 * @param {object} backend
 * @param {object} spec
 * @param {object} parent
 * @param {object[]} childPins
 * @param {object} resumed
 * @param {Set<string>} requiredLangs
 * @param {string} defaultLang
 * @returns {Promise<number|string>}
 */
async function assertResumeMatches(backend, spec, parent, childPins, resumed, requiredLangs, defaultLang) {
  const revisionId = paragraphRevisionId(resumed);
  if (revisionId === null || !sameId(resumed?.id, spec.resumeParentId)) {
    throw new Error("resumeParentId has no verified revision. No host draft was written.");
  }
  if (!sameAttributes(copiedAttributes(parent), copiedAttributes(resumed))
    || !sameRelationships(parent, resumed, spec.childField)) {
    throw new Error(
      "resumeParentId does not match the published component's fields and references. No host draft was written."
    );
  }
  const pins = fieldList(resumed, spec.childField);
  if (pins.length !== spec.children.length) {
    throw new Error("resumeParentId does not match the requested child list. No host draft was written.");
  }
  const publishedChildIds = new Set(childPins.map((ref) => ref?.id?.toLowerCase()).filter(Boolean));
  for (let index = 0; index < spec.children.length; index += 1) {
    const child = spec.children[index];
    const pin = pins[index];
    requirePinRevision(pin, "A resumed child pin");
    if (child.op === "keep") {
      const live = childPins.find((ref) => sameId(ref?.id, child.id));
      if (!sameId(pin?.id, child.id) || String(revisionOf(pin)) !== String(revisionOf(live))) {
        throw new Error("resumeParentId does not keep the requested child revision. No host draft was written.");
      }
      continue;
    }
    if (publishedChildIds.has(String(pin?.id ?? "").toLowerCase()) || sameId(pin?.id, child.id)) {
      throw new Error("resumeParentId still pins a published child. No host draft was written.");
    }
    const created = await readParagraph(backend, child.type, pin.id, revisionOf(pin));
    if (!sameId(created?.id, pin.id)
      || created?.bundle !== child.type
      || String(paragraphRevisionId(created)) !== String(revisionOf(pin))
      || !sameAttributes(child.attributes, copiedAttributes(created))) {
      throw new Error("resumeParentId does not match the requested child fields. No host draft was written.");
    }
    for (const translation of child.translations) {
      if (translation.langcode === defaultLang) continue;
      const translated = await readParagraph(backend, child.type, pin.id, revisionOf(pin), translation.langcode);
      const served = translated?.langcode ?? translated?.fields?.langcode ?? "";
      if (served !== translation.langcode || !sameAttributes(translation.attributes, copiedAttributes(translated))) {
        throw new Error(
          `resumeParentId is missing the ${translation.langcode} child translation. No host draft was written.`
        );
      }
    }
  }
  for (const lang of requiredLangs) {
    const source = await readParagraph(backend, parent.bundle, parent.id, paragraphRevisionId(parent), lang);
    const copy = await readParagraph(backend, resumed.bundle || parent.bundle, resumed.id, revisionId, lang);
    const sourceLang = source?.langcode ?? source?.fields?.langcode ?? "";
    const copyLang = copy?.langcode ?? copy?.fields?.langcode ?? "";
    if (sourceLang !== lang || copyLang !== lang || !sameAttributes(copiedAttributes(source), copiedAttributes(copy))) {
      throw new Error(`resumeParentId is missing the ${lang} translation. No host draft was written.`);
    }
  }
  return revisionId;
}

/**
 * @param {object} expected
 * @param {object} actual
 * @returns {boolean}
 */
function sameAttributes(expected, actual) {
  const left = Object.keys(expected).sort();
  const right = Object.keys(actual).sort();
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) return false;
  return left.every((key) => JSON.stringify(expected[key]) === JSON.stringify(actual[key]));
}

/**
 * @param {?object} left
 * @param {?object} right
 * @param {string} childField
 * @returns {boolean}
 */
function sameRelationships(left, right, childField) {
  const a = contentRelationshipKeys(left, childField);
  const b = contentRelationshipKeys(right, childField);
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  if (keys.length !== other.length || keys.some((key, index) => key !== other[index])) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * @param {?object} entity
 * @param {string} childField
 * @returns {object}
 */
function contentRelationshipKeys(entity, childField) {
  const rels = entity?.relationships && typeof entity.relationships === "object" ? entity.relationships : {};
  const out = {};
  for (const [key, value] of Object.entries(rels)) {
    if (key === childField || SKIP_RELATIONSHIPS.has(key)) continue;
    out[key] = linkageKey(value);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function linkageKey(value) {
  return asList(value).map((ref) => {
    const type = typeof ref?.type === "string" && ref.type
      ? ref.type
      : (ref?.entityType && ref?.bundle ? `${ref.entityType}--${ref.bundle}` : "");
    const alt = typeof ref?.meta?.alt === "string" ? ref.meta.alt : "";
    return `${type}:${String(ref?.id ?? "").toLowerCase()}:${revisionOf(ref) ?? ""}:${alt}`;
  }).join("|");
}

/**
 * @param {unknown} value
 * @returns {?object}
 */
function relationshipPayload(value) {
  const wrapped = value && typeof value === "object" && Object.hasOwn(value, "data") ? value.data : value;
  if (Array.isArray(wrapped)) return { data: wrapped.map(toLinkage).filter(Boolean) };
  if (wrapped && typeof wrapped === "object") {
    const one = toLinkage(wrapped);
    return one ? { data: one } : null;
  }
  if (wrapped === null) return { data: null };
  return null;
}

/**
 * @param {?object} ref
 * @returns {?object}
 */
function toLinkage(ref) {
  if (!ref || typeof ref !== "object") return null;
  const type = typeof ref.type === "string" && ref.type.includes("--")
    ? ref.type
    : (ref.entityType && ref.bundle ? `${ref.entityType}--${ref.bundle}` : "");
  if (!type || !ref.id) return null;
  const out = { type, id: ref.id };
  const meta = {};
  const revisionId = ref.meta?.target_revision_id;
  if (revisionId !== undefined && revisionId !== null && revisionId !== "" && Number.isFinite(Number(revisionId))) {
    meta.target_revision_id = Number(revisionId);
  }
  if (typeof ref.meta?.alt === "string") meta.alt = ref.meta.alt;
  if (typeof ref.meta?.title === "string") meta.title = ref.meta.title;
  if (Object.keys(meta).length > 0) out.meta = meta;
  return out;
}

/**
 * @param {?object} entity
 * @param {string} field
 * @returns {object[]}
 */
function fieldList(entity, field) {
  const rels = entity?.relationships;
  if (!rels || typeof rels !== "object" || !Object.hasOwn(rels, field)) return [];
  return asList(rels[field]);
}

/**
 * @param {unknown} value
 * @returns {object[]}
 */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Object.hasOwn(value, "data")) {
    if (value.data === null || value.data === undefined) return [];
    return Array.isArray(value.data) ? value.data : [value.data];
  }
  if (value && typeof value === "object") return [value];
  return [];
}

/**
 * @param {?object} ref
 * @returns {string}
 */
function paragraphBundle(ref) {
  const type = typeof ref?.type === "string" ? ref.type : "";
  if (type.startsWith("paragraph--")) return type.slice("paragraph--".length);
  if (ref?.entityType === "paragraph" && typeof ref.bundle === "string") return ref.bundle;
  return "";
}

/**
 * @param {string} type
 * @param {string} where
 * @returns {string}
 */
function paragraphType(type, where) {
  const raw = String(type ?? "");
  const bundle = raw.startsWith("paragraph--") ? raw.slice("paragraph--".length) : raw;
  if (!NAME_RE.test(bundle) || (raw.includes("--") && !raw.startsWith("paragraph--"))) {
    throw new Error(`${where}.type must be a paragraph bundle.`);
  }
  return bundle;
}

/**
 * @param {?object} ref
 * @returns {boolean}
 */
function isReusable(ref) {
  if (ref?.entityType === "paragraphs_library_item") return true;
  const type = typeof ref?.type === "string" ? ref.type : "";
  return type.startsWith("paragraphs_library_item") || paragraphBundle(ref) === "from_library";
}

/**
 * @returns {Error}
 */
function reusableError() {
  return new Error(
    "This component is a reusable library item. Update it with drupal_entity_update. " +
    "No nested draft was started, and the shared paragraph was not edited."
  );
}

/**
 * @param {?object} ref
 * @returns {?number|string}
 */
function revisionOf(ref) {
  const revisionId = ref?.meta?.target_revision_id;
  return revisionId === undefined || revisionId === null || revisionId === "" ? null : revisionId;
}

/**
 * @param {?object} ref
 * @returns {object}
 */
function pinRef(ref) {
  const bundle = paragraphBundle(ref);
  return embedParagraphRef(bundle, ref.id, revisionOf(ref));
}

/**
 * UUID plus the pinned paragraph revision. The same UUID at another revision
 * is not the prepared draft.
 * @param {?object} ref
 * @returns {string}
 */
function pinKey(ref) {
  return `${String(ref?.id ?? "").toLowerCase()}#${String(revisionOf(ref) ?? "")}`;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {?string} left
 * @param {?string} right
 * @returns {boolean}
 */
function sameId(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

/**
 * @param {?object} ref
 * @param {string} label
 * @returns {number|string}
 */
function requirePinRevision(ref, label) {
  const revisionId = revisionOf(ref);
  const numeric = Number(revisionId);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} has no paragraph revision id. No write was attempted.`);
  }
  return revisionId;
}

/**
 * @param {object[]} hostPins
 * @param {object[]} childPins
 * @returns {Set<string>}
 */
function liveParagraphIds(hostPins, childPins) {
  return new Set(
    [...hostPins, ...childPins].map((ref) => ref?.id?.toLowerCase()).filter(Boolean),
  );
}
