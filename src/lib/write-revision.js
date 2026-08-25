/**
 * Choose which entity body represents a write (#169).
 *
 * When relationships were sent, the canonical/default revision is the
 * published node — after a draft ERR attach it still shows the *old* refs.
 * Prefer `rel:working-copy`. If that alias is not addressable, return the
 * PATCH body (or the canonical re-read) plus `_revision.relationshipsUnverified`.
 *
 * After a write, {@link attachWrittenRevisionPair} may add `_revisions`
 * `{ live, working }` when both vids can be read honestly (#166).
 */

/**
 * Read a revision id off a canonical (or raw-ish) entity body.
 * @param {?object} entity
 * @returns {?number|string}
 */
export function entityRevisionId(entity) {
  if (!entity || typeof entity !== "object") return null;
  const fields = entity.fields && typeof entity.fields === "object"
    ? entity.fields
    : {};
  const attrs = entity.attributes && typeof entity.attributes === "object"
    ? entity.attributes
    : {};
  const raw = entity.vid
    ?? fields.drupal_internal__vid
    ?? attrs.drupal_internal__vid
    ?? entity.drupal_internal__vid;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/**
 * Attach distinct live vs working revision ids when both are known.
 * Does not invent vids.
 * @param {object} entity
 * @param {{live: ?number|string, working: ?number|string}} pair
 * @returns {object}
 */
export function attachRevisionPair(entity, { live, working }) {
  if (!entity || live === null || live === undefined || working === null || working === undefined) {
    return entity;
  }
  return { ...entity, _revisions: { live, working } };
}

/**
 * After a write, attach `_revisions` when a working copy is addressable
 * and the live vid is already known. Omits the block when either side
 * cannot be read — never invents a vid.
 *
 * @param {object} args
 * @param {object} args.backend
 * @param {string} args.entityType
 * @param {string} args.bundle
 * @param {string} args.id
 * @param {object} args.entity Write result to annotate.
 * @param {?number|string} [args.liveVid]
 * @returns {Promise<object>}
 */
export async function attachWrittenRevisionPair({
  backend, entityType, bundle, id, entity, liveVid,
}) {
  if (liveVid === null || liveVid === undefined || !entity) return entity;
  let workingVid = null;
  if (typeof backend?.getEntity === "function") {
    try {
      const wc = await backend.getEntity({
        entityType, bundle, id, resourceVersion: "rel:working-copy",
      });
      workingVid = entityRevisionId(wc);
    } catch {
      workingVid = null;
    }
  }
  if (workingVid === null) workingVid = entityRevisionId(entity);
  return attachRevisionPair(entity, { live: liveVid, working: workingVid });
}

/**
 * @param {object} args
 * @param {object} args.backend
 * @param {string} args.entityType
 * @param {string} args.bundle
 * @param {string} args.id
 * @param {boolean} args.relationshipsSent
 * @param {?object} [args.patchResult] Canonicalised PATCH response body.
 * @param {boolean} [args.preferCanonical] When no relationships were sent,
 *   re-GET the canonical resource (nodes do this for the persisted alias).
 * @returns {Promise<object>} Entity to return, with `_revision` when relevant.
 */
export async function readWrittenRevision({
  backend, entityType, bundle, id, relationshipsSent, patchResult = null, preferCanonical = false,
}) {
  if (!relationshipsSent) {
    if (preferCanonical && typeof backend.getEntity === "function") {
      const fresh = await backend.getEntity({ entityType, bundle, id }).catch(() => null);
      return fresh ?? patchResult ?? { id };
    }
    return patchResult ?? { id };
  }

  // Content-moderation working-copy aliases are a node (host) feature. Other
  // entity types keep the PATCH body and an unverified marker.
  let workingCopy = null;
  if (entityType === "node" && typeof backend.getEntity === "function") {
    try {
      workingCopy = await backend.getEntity({
        entityType, bundle, id, resourceVersion: "rel:working-copy",
      });
    } catch {
      workingCopy = null;
    }
  }
  if (workingCopy) {
    return {
      ...workingCopy,
      _revision: {
        source: "working-copy",
        note:
          "Returned from rel:working-copy — the revision that was written, not the " +
          "published default. Canonical re-reads hide a draft ERR attach (#169).",
      },
    };
  }

  let fallback = patchResult;
  if (!fallback && preferCanonical && typeof backend.getEntity === "function") {
    fallback = await backend.getEntity({ entityType, bundle, id }).catch(() => null);
  }
  return {
    ...(fallback ?? { id }),
    _revision: {
      source: patchResult ? "patch" : "canonical",
      relationshipsUnverified: true,
      note:
        "Relationships were sent on this write. The body below is not the written " +
        "revision (no addressable working copy). It is not proof an ERR field landed. " +
        "Inspect rel:working-copy with drupal_get_revision, or treat the field as unverified (#169).",
    },
  };
}
