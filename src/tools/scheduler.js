/**
 * Tool group: Scheduler integration.
 *
 * Sets scheduled publish / unpublish dates on a content node via the Drupal
 * Scheduler module (https://www.drupal.org/project/scheduler). Scheduler stores
 * the schedule on two entity fields — `publish_on` and `unpublish_on` — which the
 * module adds to a content type when scheduling is enabled for that bundle.
 *
 * This is a thin write over the canonical backend's updateEntity: the supplied
 * timestamps are passed straight through as those two attributes. Scheduler
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

/**
 * Heuristic: does this backend error look like a missing/unknown field? Scheduler
 * fields are absent unless the module is installed and enabled for the bundle, so
 * an unknown-field error almost always means a missing Scheduler capability.
 *
 * @param {Error} err - The error thrown by the backend write.
 * @returns {boolean}
 */
function looksLikeUnknownField(err) {
  const msg = String(err?.message || err || "");
  return /unknown|not exist|no field|invalid field|unrecognized|publish_on|unpublish_on/i.test(msg);
}

/**
 * Schedule a node to publish and/or unpublish at the given times.
 *
 * Writes the Scheduler `publish_on` / `unpublish_on` attributes through the
 * canonical updateEntity. At least one of publishOn / unpublishOn must be given.
 * Each value is forwarded unchanged (ISO 8601 string or epoch integer).
 *
 * @param {object} args - { site?, type, id, publishOn?, unpublishOn? }.
 * @returns {Promise<object>} The redacted, updated node descriptor.
 * @throws {Error} If neither timestamp is supplied, if the policy forbids the
 *   write, or — degraded — if the Scheduler fields are unknown on the bundle.
 */
async function schedulePublish({ site: siteName, type, id, publishOn, unpublishOn }) {
  if (publishOn === undefined && unpublishOn === undefined) {
    throw new Error("Provide at least one of publishOn or unpublishOn to schedule the node.");
  }
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "node", type);
  const backend = await resolveBackend(site);

  const attributes = {};
  if (publishOn !== undefined) attributes.publish_on = publishOn;
  if (unpublishOn !== undefined) attributes.unpublish_on = unpublishOn;

  let updated;
  try {
    updated = await backend.updateEntity({ entityType: "node", bundle: type, id, attributes });
  } catch (err) {
    if (looksLikeUnknownField(err)) {
      throw new Error(
        `Could not set Scheduler dates on '${type}': the publish_on / unpublish_on fields are not available. ` +
        "This tool requires the Drupal Scheduler module to be installed and enabled for this content type. " +
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
      "Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / " +
      "unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. " +
      "Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. " +
      "Provide at least one of publishOn or unpublishOn.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:        { type: "string", description: "Named site (omit for default)" },
        type:        { type: "string", description: "Content type machine name, e.g. 'article'" },
        id:          { type: "string", description: "Node UUID" },
        publishOn:   { type: ["string", "number"], description: "When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field." },
        unpublishOn: { type: ["string", "number"], description: "When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field." },
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
