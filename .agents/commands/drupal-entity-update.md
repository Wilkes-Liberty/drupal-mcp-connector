---
description: "Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets a non-saving PATCH preflight runs first (including dryRun) against the same URL the write will hit. An addressable node draft uses Sentinel's governed draft endpoint with live/working revision preconditions (#166); a stray revision with no addressable working copy still fails with revision-surgery language (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents. A dryRun that returns without a refusal is not proof the write will succeed: field access and entity validation are checked only when Sentinel's draft endpoint ran, and the result's `checks` block says which checks ran."
argument-hint: "<entityType> <bundle> <id> [site] [langcode] [attributes] [relationships] [dryRun] [returning]"
---

Call the MCP tool `drupal_entity_update`.

Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets a non-saving PATCH preflight runs first (including dryRun) against the same URL the write will hit. An addressable node draft uses Sentinel's governed draft endpoint with live/working revision preconditions (#166); a stray revision with no addressable working copy still fails with revision-surgery language (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents. A dryRun that returns without a refusal is not proof the write will succeed: field access and entity validation are checked only when Sentinel's draft endpoint ran, and the result's `checks` block says which checks ran.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)
- `id` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `langcode` (string): Target language for an unpublished working translation (nodes). Continues that translation via Sentinel.
- `attributes` (object (pass as JSON))
- `relationships` (object (pass as JSON))
- `dryRun` (boolean (true/false)): Validate, resolve ERR identifiers, run the server-side preflight when one applies, and return a preview without the real write. The result's `checks` block says what was checked; `caveat` names what was not. Only an existing node draft (or a langcode translation draft) is checked with the real payload: Sentinel's non-saving draft endpoint applies the submitted fields through field access and validates the entity (`serverPreflight: sentinel_draft`). On other moderated targets an id-mismatch core PATCH with no fields checks entity update access and core's working-copy guard only; field access and entity validation are NOT checked (`core_patch_guard`), so the real write can still fail with a field-access 403 or a 422. Unmoderated targets get no server-side check at all (`none`). A published node with no distinct working copy whose changed timestamp is later than revision_timestamp (possiblyPatchBlocked) fails dryRun the same as the real write (#273). Any refusal fails the dryRun.
- `returning` (one of: full, minimal): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
