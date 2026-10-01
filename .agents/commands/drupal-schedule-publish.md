---
description: "Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. Provide at least one of publishOn or unpublishOn. Moderated bundles (Content Moderation) also need a target state: pass publishState / unpublishState (moderation state machine names, e.g. 'published', 'archived'), written as publish_state / unpublish_state. These fields exist only when the Scheduler Content Moderation Integration module is enabled. When the bundle exposes a state field and its date is set without the state, the call fails, because Drupal would accept a schedule that never runs. When a moderated bundle has no state field, the dates are written and the result carries a warning. Whether this account may schedule a given transition is decided by the site (Drupal validation and MCP Sentinel policy), not the connector; a refusal returns the site's reason verbatim. Without the Scheduler module on the content type, the call fails with a capability error. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged."
argument-hint: "<type> <id> [site] [publishOn] [unpublishOn] [publishState] [unpublishState]"
---

Call the MCP tool `drupal_schedule_publish`.

Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. Provide at least one of publishOn or unpublishOn. Moderated bundles (Content Moderation) also need a target state: pass publishState / unpublishState (moderation state machine names, e.g. 'published', 'archived'), written as publish_state / unpublish_state. These fields exist only when the Scheduler Content Moderation Integration module is enabled. When the bundle exposes a state field and its date is set without the state, the call fails, because Drupal would accept a schedule that never runs. When a moderated bundle has no state field, the dates are written and the result carries a warning. Whether this account may schedule a given transition is decided by the site (Drupal validation and MCP Sentinel policy), not the connector; a refusal returns the site's reason verbatim. Without the Scheduler module on the content type, the call fails with a capability error. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `publishOn` (string): When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field.
- `unpublishOn` (string): When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field.
- `publishState` (string): Moderation state machine name to enter at publishOn (e.g. 'published'). Written as publish_state. Required when publishOn is set and the bundle has a publish_state field.
- `unpublishState` (string): Moderation state machine name to enter at unpublishOn (e.g. 'archived'). Written as unpublish_state. Required when unpublishOn is set and the bundle has an unpublish_state field.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
