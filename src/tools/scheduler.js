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
 * does not have the publish_on / unpublish_on fields, JSON:API rejects the write
 * because the attribute does not exist. We catch that and re-throw a clear,
 * actionable message (while still surfacing the underlying backend error).
 *
 * The connector does not decide who may schedule which transition. Drupal's
 * validation (SchedulerModerationTransitionAccess) and the site's MCP Sentinel
 * policy are the gate; their refusals are surfaced verbatim. The only local
 * refusal is a date with no matching state on a bundle that exposes the state
 * field, because Drupal accepts that write and the schedule then never runs.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertWriteAllowed, redactCanonicalEntity } from "../lib/security.js";
import { entityLooksModerated } from "../lib/moderation-default.js";
import { fieldPresence } from "../lib/reports-support.js";
import { httpStatusOf } from "../lib/error-status.js";

/**
 * Does this backend error say a Scheduler attribute does not exist on the
 * bundle? Only the "unknown attribute" phrasing counts. A field name alone is
 * not enough: Drupal's 422 validation detail starts with the property path
 * (`publish_state: You do not have access to transition …`), and that is a
 * refusal by the site, not a missing capability (#402).
 *
 * @param {Error} err - The error thrown by the backend write.
 * @returns {boolean}
 */
export function looksLikeUnknownField(err) {
  const msg = String(err?.message || err || "");
  return /\b(?:attribute|field|property)\b[^.]*?\b(?:does not exist|doesn't exist|is unknown|is not recognized)/i.test(msg)
    || /\b(?:unknown|unrecognized|invalid) (?:field|attribute|property)\b|\bno such (?:field|attribute)\b/i.test(msg);
}

/**
 * Wrap a site refusal so the reason is the first thing the caller reads. The
 * original message (with Drupal's or Sentinel's reason) is kept verbatim and
 * the HTTP status is carried over.
 *
 * @param {Error} err - The error thrown by the backend write.
 * @param {string} type - Bundle machine name.
 * @returns {Error}
 */
function siteRefusal(err, type) {
  const status = httpStatusOf(err);
  const reason = err?.message || String(err);
  const out = new Error(
    `The site refused the schedule on '${type}'${status ? ` (HTTP ${status})` : ""}. ` +
    `Drupal validation or the site's MCP Sentinel policy decides scheduled transitions; the connector does not. Reason: ${reason}`,
  );
  if (status) out.status = status;
  out.cause = err;
  return out;
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
 * `publishState` / `unpublishState` are written as `publish_state` /
 * `unpublish_state`. When the bundle exposes the matching state field, a date
 * without its state is refused locally (#402); every other decision is Drupal's.
 *
 * @param {object} args - { site?, type, id, publishOn?, unpublishOn?, publishState?, unpublishState? }.
 * @returns {Promise<object>} The redacted, updated node descriptor, with
 *   `warnings` when a moderated bundle has no state field to pair a date with.
 * @throws {Error} If neither timestamp is supplied, if connector policy forbids
 *   the write, if a date is missing its state on a bundle with the state field,
 *   if the site refuses the write (reason kept verbatim), or — degraded — if the
 *   Scheduler fields are unknown on the bundle.
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
    try {
      existing = await backend.getEntity({ entityType: "node", bundle: type, id }) ?? null;
    } catch {
      existing = null;
    }
  }
  let schema = null;
  if (existing && typeof backend.getEntitySchema === "function") {
    try {
      schema = await backend.getEntitySchema("node", type);
    } catch {
      schema = null;
    }
  }

  // A state field on the bundle means Scheduler Content Moderation Integration
  // is active there. Drupal accepts a date with no state, and the schedule then
  // fails at every cron run, so that one case is refused here (#402).
  const pairs = [
    ["publishOn", publishOn, "publishState", publishState, "publish_state", "published"],
    ["unpublishOn", unpublishOn, "unpublishState", unpublishState, "unpublish_state", "archived"],
  ];
  const warnings = [];
  for (const [dateArg, date, stateArg, state, stateField, example] of pairs) {
    if (date === undefined || state !== undefined) continue;
    if (schedulerFieldPresent(existing, schema, stateField)) {
      throw new Error(
        `'${type}' is a moderated bundle with Scheduler Content Moderation Integration: pass ${stateArg} ` +
        `(the moderation state to enter at ${dateArg}, e.g. '${example}'). A schedule without a state never runs: ` +
        "Drupal accepts it, then cron logs 'Publishing failed' on every run.",
      );
    }
    if (entityLooksModerated(existing)) {
      warnings.push(
        `'${type}' is moderated but exposes no ${stateField} field. Scheduler cannot change a moderated node ` +
        `without the Scheduler Content Moderation Integration module and a ${stateArg}, so this ${dateArg} may never take effect.`,
      );
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
        `Could not set Scheduler dates on '${type}': a Scheduler field is not available on this bundle. ` +
        "publish_on / unpublish_on need the Drupal Scheduler module enabled for this content type; " +
        "publish_state / unpublish_state also need Scheduler Content Moderation Integration. " +
        `Backend error: ${err?.message || err}`,
      );
    }
    const status = httpStatusOf(err);
    if (status !== null && status >= 400 && status < 500) throw siteRefusal(err, type);
    throw err;
  }
  const out = updated ? redactCanonicalEntity(updated, sec, "node") : updated;
  return out && warnings.length ? { ...out, warnings } : out;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_schedule_publish",
    description:
      "Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. " +
      "Sets the publish_on and unpublish_on fields on the node. Provide at least one of publishOn or unpublishOn. " +
      "Moderated bundles (Content Moderation) also need a target state: pass publishState / unpublishState " +
      "(moderation state machine names, e.g. 'published', 'archived'), written as publish_state / unpublish_state. " +
      "These fields exist only when the Scheduler Content Moderation Integration module is enabled. When the bundle " +
      "exposes a state field and its date is set without the state, the call fails, because Drupal would accept a " +
      "schedule that never runs. When a moderated bundle has no state field, the dates are written and the result " +
      "carries a warning. Whether this account may schedule a given transition is decided by the site (Drupal " +
      "validation and MCP Sentinel policy), not the connector; a refusal returns the site's reason verbatim. " +
      "Without the Scheduler module on the content type, the call fails with a capability error. " +
      "Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:           { type: "string", description: "Named site (omit for default)" },
        type:           { type: "string", description: "Content type machine name, e.g. 'article'" },
        id:             { type: "string", description: "Node UUID" },
        publishOn:      { type: ["string", "number"], description: "When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field." },
        unpublishOn:    { type: ["string", "number"], description: "When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field." },
        publishState:   { type: "string", description: "Moderation state machine name to enter at publishOn (e.g. 'published'). Written as publish_state. Required when publishOn is set and the bundle has a publish_state field." },
        unpublishState: { type: "string", description: "Moderation state machine name to enter at unpublishOn (e.g. 'archived'). Written as unpublish_state. Required when unpublishOn is set and the bundle has an unpublish_state field." },
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
