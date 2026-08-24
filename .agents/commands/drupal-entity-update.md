---
description: "Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets an id-mismatch PATCH preflight runs first (including dryRun) so a core working-copy guard failure is reported before the real write and no revision is saved by the probe (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents."
argument-hint: "<entityType> <bundle> <id> [site] [attributes] [relationships] [dryRun] [returning]"
---

Call the MCP tool `drupal_entity_update`.

Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets an id-mismatch PATCH preflight runs first (including dryRun) so a core working-copy guard failure is reported before the real write and no revision is saved by the probe (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)
- `id` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `attributes` (object (pass as JSON))
- `relationships` (object (pass as JSON))
- `dryRun` (boolean (true/false)): Validate, resolve ERR identifiers, and (on moderated targets) run the core PATCH-guard probe against Drupal, then return a preview without the real write. The probe uses a non-matching data.id so Drupal does not save. A working-copy 400 fails the dryRun.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
