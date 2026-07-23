---
description: "Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status. Entity-reference fields go in `relationships`, not `fields`."
argument-hint: "<type> <id> [site] [title] [body] [summary] [status] [moderationState] [fields] [relationships] [dryRun]"
allowed-tools: mcp__drupal__drupal_update_node
---

Call the `mcp__drupal__drupal_update_node` MCP tool.

Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status. Entity-reference fields go in `relationships`, not `fields`.

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
- `fields` (object (pass as JSON)): Scalar/attribute field values keyed by machine name. Entity-reference fields go in `relationships`, not here.
- `relationships` (object (pass as JSON)): Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value uses { data: { type, id } }; multi-value uses { data: [{ type, id }, …] }.
- `dryRun` (boolean (true/false)): Validate and return a preview of the update without committing.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
