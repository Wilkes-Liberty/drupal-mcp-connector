---
description: "Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status. When the target is published and moderated and you omit moderationState, the connector defaults the write to moderation_state 'draft' (forward revision) so live default revisions are not mutated by accident. Entity-reference fields go in `relationships`, not `fields`. Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved (an unresolved identifier persists as an empty field). On moderated targets an id-mismatch PATCH preflight runs first — including on dryRun — against the same URL the write will hit. An addressable working copy is PATCHed via ?resourceVersion=rel:working-copy (#166); dryRun uses that same target. workingCopy:null from drupal_list_revisions is not proof the node is writable (possiblyPatchBlocked / #201). Preflight here does not un-orphan paragraphs already created; probe the host before creating dependents."
argument-hint: "<type> <id> [site] [title] [body] [summary] [format] [status] [moderationState] [fields] [relationships] [dryRun] [returning]"
---

Call the MCP tool `drupal_update_node`.

Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status. When the target is published and moderated and you omit moderationState, the connector defaults the write to moderation_state 'draft' (forward revision) so live default revisions are not mutated by accident. Entity-reference fields go in `relationships`, not `fields`. Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved (an unresolved identifier persists as an empty field). On moderated targets an id-mismatch PATCH preflight runs first — including on dryRun — against the same URL the write will hit. An addressable working copy is PATCHed via ?resourceVersion=rel:working-copy (#166); dryRun uses that same target. workingCopy:null from drupal_list_revisions is not proof the node is writable (possiblyPatchBlocked / #201). Preflight here does not un-orphan paragraphs already created; probe the host before creating dependents.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `title` (string)
- `body` (string)
- `summary` (string): Body summary/teaser — writes body.summary on core text_with_summary only. Refused when the sampled body field has no summary property (text_long / text_formatted) or the schema cannot be determined. Prefer the site's dedicated deck/summary field via `fields`.
- `format` (string): Text format machine name for the body, e.g. 'basic_html'. When the body field's allowed_formats lists exactly one format, that is the default. A caller format outside that list is refused before write. When allowed_formats cannot be resolved, defaults to the site config's `defaultTextFormat`, then 'full_html'.
- `status` (boolean (true/false)): Published flag for NON-moderated types: true = publish, false = unpublish. Ignored if moderationState is set.
- `moderationState` (string): Moderation state transition for content_moderation types, e.g. 'draft', 'published', 'archived'. Takes precedence over status. Required to keep or re-publish a live node — omitting it on a published moderated node defaults the write to 'draft'.
- `fields` (object (pass as JSON)): Scalar/attribute field values keyed by machine name. Formatted text: a string or { value, format?, summary? }. format must be in the field's allowed_formats; a single allowed format is used when omitted. Entity-reference fields go in `relationships`, not here.
- `relationships` (object (pass as JSON)): Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value uses { data: { type, id } }; multi-value uses { data: [{ type, id }, …] }. Paragraph / ERR items must carry meta.target_revision_id — the connector injects it when missing, and fails the write if it cannot.
- `dryRun` (boolean (true/false)): Validate, resolve ERR identifiers, and (on moderated targets) run the core PATCH-guard probe against Drupal, then return a preview without the real write. The probe uses a non-matching data.id so Drupal does not save, and hits the same URL as the real write (canonical, or ?resourceVersion=rel:working-copy when a draft is addressable). A working-copy 400 fails the dryRun.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
