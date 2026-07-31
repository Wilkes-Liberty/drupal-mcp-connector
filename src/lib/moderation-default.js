/**
 * Safe draft default for updates of published, moderated entities (#131).
 *
 * When a PATCH targets a *published* entity under content_moderation and the
 * caller did not pass an explicit `moderation_state`, the write can land on the
 * live default revision if a server-side publish gate mis-classifies it as "no
 * transition". Defaulting to `moderation_state: draft` forces a forward
 * (reviewable) revision instead.
 *
 * Callers that genuinely want a same-state save on a published node must opt in
 * by passing `moderation_state` (or the tool-level `moderationState`) explicitly.
 *
 * Detection is best-effort from the existing entity payload: the entity is
 * treated as moderated when a `moderation_state` field is present on it, and as
 * published when `status === true`. If the entity cannot be read, attributes
 * are left unchanged (fail open for non-moderated bundles; server-side gate
 * remains authoritative).
 */

/** Default moderation state applied when none was supplied for a published moderated entity. */
export const SAFE_DRAFT_STATE = "draft";

/**
 * Whether a canonical entity exposes a content_moderation state field.
 * @param {?object} entity Canonical entity (or null).
 * @returns {boolean}
 */
export function entityLooksModerated(entity) {
  if (!entity) return false;
  if (entity.fields && Object.prototype.hasOwnProperty.call(entity.fields, "moderation_state")) {
    return true;
  }
  // Tolerate a top-level promotion if a backend ever surfaces it that way.
  return Object.prototype.hasOwnProperty.call(entity, "moderation_state");
}

/**
 * Whether a canonical entity is currently published.
 * @param {?object} entity Canonical entity (or null).
 * @returns {boolean}
 */
export function isPublishedEntity(entity) {
  return entity?.status === true;
}

/**
 * Whether the write attributes already carry an explicit moderation state.
 * @param {?object} attributes Attribute map about to be sent.
 * @returns {boolean}
 */
export function hasExplicitModerationState(attributes) {
  return Boolean(attributes && Object.prototype.hasOwnProperty.call(attributes, "moderation_state"));
}

/**
 * Decide whether a draft default should be injected for this update.
 * Pure helper — no I/O.
 *
 * @param {{attributes?: object, entity?: ?object}} input
 * @returns {boolean}
 */
export function shouldDefaultPublishedUpdateToDraft({ attributes, entity }) {
  if (hasExplicitModerationState(attributes)) return false;
  if (!isPublishedEntity(entity)) return false;
  if (!entityLooksModerated(entity)) return false;
  return true;
}

/**
 * Apply the safe draft default when updating a published moderated entity.
 * Returns a new attributes object when a default is applied; otherwise returns
 * the original attributes reference unchanged.
 *
 * @param {object} args
 * @param {object} args.backend Backend with `getEntity`.
 * @param {string} args.entityType
 * @param {string} args.bundle
 * @param {string} args.id Entity UUID.
 * @param {object} [args.attributes={}] Attribute map for the write.
 * @param {?object} [args.existingEntity] Pre-fetched entity; when omitted a get is issued.
 * @returns {Promise<object>} Attributes to send (possibly with moderation_state: draft).
 */
export async function applySafeDraftDefault({
  backend,
  entityType,
  bundle,
  id,
  attributes = {},
  existingEntity,
}) {
  if (hasExplicitModerationState(attributes)) return attributes;

  let entity = existingEntity;
  if (entity === undefined) {
    try {
      entity = await backend.getEntity({ entityType, bundle, id });
    } catch {
      // Fail open: without a readable target we cannot sniff moderation.
      return attributes;
    }
  }
  if (!shouldDefaultPublishedUpdateToDraft({ attributes, entity })) {
    return attributes;
  }
  return { ...attributes, moderation_state: SAFE_DRAFT_STATE };
}
