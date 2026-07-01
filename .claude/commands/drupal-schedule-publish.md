---
description: "Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. Provide at least one of publishOn or unpublishOn."
argument-hint: "<type> <id> [site] [publishOn] [unpublishOn]"
allowed-tools: mcp__drupal__drupal_schedule_publish
---

Call the `mcp__drupal__drupal_schedule_publish` MCP tool.

Schedule a content node to publish and/or unpublish at a future time using the Drupal Scheduler module. Sets the publish_on and unpublish_on fields on the node. Requires the Scheduler module to be installed and enabled for the content type, with the publish_on / unpublish_on fields present on the bundle — otherwise the call fails with a clear capability error. Timestamps accept ISO 8601 (e.g. '2026-07-01T12:00:00Z') or a Unix epoch and are passed through unchanged. Provide at least one of publishOn or unpublishOn.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site (omit for default)
- `publishOn` (string): When to publish — ISO 8601 datetime or Unix epoch. Sets the Scheduler publish_on field.
- `unpublishOn` (string): When to unpublish — ISO 8601 datetime or Unix epoch. Sets the Scheduler unpublish_on field.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
