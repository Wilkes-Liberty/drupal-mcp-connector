---
description: "Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status."
argument-hint: "<type> <id> [site] [title] [body] [summary] [status] [moderationState] [fields] [dryRun]"
allowed-tools: mcp__drupal__drupal_update_node
---

Call the `mcp__drupal__drupal_update_node` MCP tool.

Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string): Node UUID

**Optional:**
- `site` (string): omit for the default site
- `title` (string)
- `body` (string)
- `summary` (string)
- `status` (boolean (true/false)): Published flag for NON-moderated types: true = publish, false = unpublish. Ignored if moderationState is set.
- `moderationState` (string): Moderation state transition for content_moderation types, e.g. 'draft', 'published', 'archived'. Takes precedence over status.
- `fields` (object (pass as JSON))
- `dryRun` (boolean (true/false)): Validate and return a preview of the update without committing.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
