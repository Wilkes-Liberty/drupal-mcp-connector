/**
 * Tool group: Scheduler integration.
 *
 * Sets scheduled publish / unpublish dates on a content node via the Drupal
 * Scheduler module (https://www.drupal.org/project/scheduler). Scheduler stores
 * the schedule on two entity fields — `publish_on` and `unpublish_on` — which the
 * module adds to a content type when scheduling is enabled for that bundle.
 *
 * On a bundle under Content Moderation, Scheduler Content Moderation
 * Integration also needs `publish_state` / `unpublish_state`. Dates without
 * those states are accepted by Drupal and then fail at cron (#402).
 *
 * This is a thin write over the canonical backend's updateEntity: the supplied
 * timestamps are passed straight through as those attributes. Scheduler
 * accepts an ISO 8601 datetime string or a Unix epoch; we accept either form and
 * forward it unchanged (the JSON:API backend coerces datetime fields as needed).
 *
 * Capability degradation: if the Scheduler module is not installed, or the bundle
 * does not have the publish_on / unpublish_on fields, the backend write fails with
 * an "unknown field" error. We catch that and re-throw a clear, actionable message
 * (while still surfacing the underlying backend error) rather than a raw stack.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertWriteAllowed, redactCanonicalEntity } from "../lib/security.js";
import { entityLooksModerated } from "../lib/moderation-default.js";
import { fieldPresence } from "../lib/reports-support.js";

/**
 * Heuristic: does this backend error look like a missing/unknown field? Scheduler
 * fields are absent unless the module is installed and enabled for the bundle, so
 * an unknown-field error almost always means a missing Scheduler capability.
 *
 * @param {Error} err - The error thrown by the backend write.
 * @returns {boolean}
 */
export function looksLikeUnknownField(err) {
  const msg = String(err?.message || err || "");
  return /unknown|not exist|no field|invalid field|unrecognized|publish_on|unpublish_on|publish_state|unpublish_state/i.test(msg);
}

/**
 * Whether a schema or entity exposes a Scheduler attribute.
 * @param {?object} entity Canonical entity.
 * @param {?object} schema Bundle schema from getEntitySchema.
 * @param {string} field Field machine name.
 * @returns {boolean}
 */
function schedulerFieldPresent(entity, schema, field) {
  if (entity && fieldPresence(entity, field).present) return true;
  return Boolean(schema?.attributes && Object.prototype.hasOwnProperty.call(schema.attributes, field));
}

/**
 * Schedule a node to publish and/or unpublish at the given times.
 *
 * Writes the Scheduler `publish_on` / `unpublish_on` attributes through the
 * canonical updateEntity. At least one of publishOn / unpublishOn must be given.
 * Each value is forwarded unchanged (ISO 8601 string or epoch integer).
 *
 * On a moderated bundle, `publishState` / `unpublishState` are required when
 * the matching date is set and the Scheduler CM state field exists (#402).
 *
 * @param {object} args - { site?, type, id, publishOn?, unpublishOn?, publishState?, unpublishState? }.
 * @returns {Promise<object>} The redacted, updated node descriptor.
 * @throws {Error} If neither timestamp is supplied, if the policy forbids the
 *   write, if a moderated schedule is missing its target state, or — degraded —
 *   if the Scheduler fields are unknown on the bundle.
 */
async function schedulePublish({
  site: siteName, type, id, publishOn, unpublishOn, publishState, unpublishState,
}) {
  if (publishOn === undefined && unpublishOn === undefined) {
    throw new Error("Provide at least one of publishOn or unpublishOn to schedule the node.");
  }
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "node", type);
  const backend = await resolveBackend(site);

  let existing = null;
  if (typeof backend.getEntity === "function") {
    existing = await backend.getEntity({ entityType: "node", bundle: type, id }).catch(() => null);
  }
  let schema = null;
  if (existing && typeof backend.getEntitySchema === "function") {
    schema = await backend.getEntitySchema("node", type).catch(() => null);
  }

  const moderated = entityLooksModerated(existing);
  if (moderated) {
    if (publishOn !== undefined) {
      const hasStateField = schedulerFieldPresent(existing, schema, "publish_state");
      if (!hasStateField) {
        throw new Error(
          `Could not schedule publish on moderated '${type}': the publish_state field is not available. ` +
          "Moderated bundles need the Scheduler Content Moderation Integration module, and a publishState " +
          "(e.g. 'published') whenever publishOn is set. Without that state, cron logs 'Publishing failed' " +
          "and the node never goes live. See connector #402."
        );
      }
      if (publishState === undefined) {
        throw new Error(
          "Moderated content requires publishState (the workflow state to enter at publishOn, e.g. 'published'). " +
          "Scheduler dates without a target state are accepted by Drupal and then fail at cron. See connector #402."
        );
      }
    }
    if (unpublishOn !== undefined) {
      const hasStateField = schedulerFieldPresent(existing, schema, "unpublish_state");
      if (!hasStateField) {
        throw new Error(
          `Could not schedule unpublish on moderated '${type}': the unpublish_state field is not available. ` +
          "Moderated bundles need the Scheduler Content Moderation Integration module, and an unpublishState " +
          "(e.g. 'draft') whenever unpublishOn is set. See connector #402."
        );
      }
      if (unpublishState === undefined) {
        throw new Error(
          "Moderated content requires unpublishState (the workflow state to enter at unpublishOn, e.g. 'draft'). " +
          "Scheduler dates without a target state are accepted by Drupal and then fail at cron. See connector #402."
        );
      }
    }
  }

  const attributes = {};
  if (publishOn !== undefined) attributes.publish_on = publishOn;
  if (unpublishOn !== undefined) attributes.unpublish_on = unpublishOn;
  if (publishState !== undefined) attributes.publish_state = publishState;
  if (unpublishState !== undefined) attributes.unpublish_state = unpublishState;

  let updated;
  try {
    updated = await backend.updateEntity({ entityType: "node", bundle: type, id, attributes });
  } catch (err) {
    if (looksLikeUnknownField(err)) {
      throw new Error(
        `Could not set Scheduler dates on '${type}': the publish_on / unpublish_on fields are not available. ` +
        "This tool requires the Drupal Scheduler module to be installed and enabled for this content type. " +
        "Moderated bundles also need Scheduler Content Moderation Integration (publish_state / unpublish_state). " +
        `Backend error: ${err?.message || err}`,
      );
    }
    throw err;
  }
  return updated ? redactCanonicalEntity(updated, sec, "node") : updated;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_schedule_publish",
    description:
      "Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. " +
      "Sets the publish_on and unpublish_on fields on the node. " +
      "On a bundle under Content Moderation, also set publishState / unpublishState " +
      "(written as publish_state / unpublish_state) — dates alone never go live. " +
      "Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / " +
      "unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. " +
      "Moderated bundles additionally need Scheduler Content Moderation Integration; when those state fields " +
      "exist, the matching state is required whenever a date is set. " +
      "Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. " +
      "Provide at least one of publishOn or unpublishOn.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:           { type: "string", description: "Named site (omit for default)" },
        type:           { type: "string", description: "Content type machine name, e.g. 'article'" },
        id:             { type: "string", description: "Node UUID" },
        publishOn:      { type: ["string", "number"], description: "When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field." },
        unpublishOn:    { type: ["string", "number"], description: "When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field." },
        publishState:   { type: "string", description: "Moderation state to enter at publishOn (e.g. 'published'). Required on moderated bundles when publishOn is set." },
        unpublishState: { type: "string", description: "Moderation state to enter at unpublishOn (e.g. 'draft'). Required on moderated bundles when unpublishOn is set." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_schedule_publish: schedulePublish,
};
