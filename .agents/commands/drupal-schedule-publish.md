---
description: "Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. On a bundle under Content Moderation, also set publishState / unpublishState (written as publish_state / unpublish_state) — dates alone never go live. Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. Moderated bundles additionally need Scheduler Content Moderation Integration; when those state fields exist, the matching state is required whenever a date is set. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. Provide at least one of publishOn or unpublishOn."
argument-hint: "<type> <id> [site] [publishOn] [unpublishOn] [publishState] [unpublishState]"
---

Call the MCP tool `drupal_schedule_publish`.

Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. On a bundle under Content Moderation, also set publishState / unpublishState (written as publish_state / unpublish_state) — dates alone never go live. Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. Moderated bundles additionally need Scheduler Content Moderation Integration; when those state fields exist, the matching state is required whenever a date is set. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. Provide at least one of publishOn or unpublishOn.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `publishOn` (string): When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field.
- `unpublishOn` (string): When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field.
- `publishState` (string): Moderation state to enter at publishOn (e.g. 'published'). Required on moderated bundles when publishOn is set.
- `unpublishState` (string): Moderation state to enter at unpublishOn (e.g. 'draft'). Required on moderated bundles when unpublishOn is set.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
