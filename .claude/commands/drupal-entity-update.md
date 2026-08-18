---
description: "Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets a no-op PATCH preflight runs first (including dryRun) so a core working-copy guard failure is reported before the real write (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents."
argument-hint: "<entityType> <bundle> <id> [site] [attributes] [relationships] [dryRun] [returning]"
allowed-tools: mcp__drupal__drupal_entity_update
---

Call the `mcp__drupal__drupal_entity_update` MCP tool.

Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets a no-op PATCH preflight runs first (including dryRun) so a core working-copy guard failure is reported before the real write (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site
- `attributes` (object (pass as JSON))
- `relationships` (object (pass as JSON))
- `dryRun` (boolean (true/false)): Validate, resolve ERR identifiers, and (on moderated targets) run the core PATCH-guard probe against Drupal, then return a preview without the real write. A 400 on that probe fails the dryRun.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
