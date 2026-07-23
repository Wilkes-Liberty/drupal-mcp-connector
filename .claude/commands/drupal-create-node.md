---
description: "Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status. Entity-reference fields (taxonomy terms, related content, media) go in `relationships`, not `fields`."
argument-hint: "<type> <title> [site] [body] [summary] [status] [moderationState] [fields] [relationships] [dryRun] [returning]"
allowed-tools: mcp__drupal__drupal_create_node
---

Call the `mcp__drupal__drupal_create_node` MCP tool.

Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status. Entity-reference fields (taxonomy terms, related content, media) go in `relationships`, not `fields`.

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
- `fields` (object (pass as JSON)): Scalar/attribute field values keyed by Drupal machine name. Do NOT put entity-reference fields here — Drupal rejects them as attributes; use `relationships`.
- `relationships` (object (pass as JSON)): Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value: { field_resource_type: { data: { type: 'taxonomy_term--resource_type', id: '<uuid>' } } }. Multi-value: { field_tags: { data: [{ type: 'taxonomy_term--tags', id: '<uuid>' }] } }.
- `dryRun` (boolean (true/false)): Validate and return a preview of the write without committing.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
