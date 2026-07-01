---
description: "Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status."
argument-hint: "[site] <type> <title> [body] [summary] [status] [moderationState] [fields] [dryRun]"
allowed-tools: mcp__drupal__drupal_create_node
---

Call the `mcp__drupal__drupal_create_node` MCP tool.

Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `title` (string)

**Optional:**
- `site` (string): omit for the default site
- `body` (string): Body field HTML
- `summary` (string): Body summary / teaser
- `status` (boolean (true/false)): Published flag for NON-moderated types. true to publish immediately. Ignored if moderationState is set; on a moderated type it is dropped automatically.
- `moderationState` (string): Moderation state for content_moderation types, e.g. 'draft' or 'published'. Takes precedence over status.
- `fields` (object (pass as JSON)): Additional field values keyed by Drupal machine name
- `dryRun` (boolean (true/false)): Validate and return a preview of the write without committing.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
