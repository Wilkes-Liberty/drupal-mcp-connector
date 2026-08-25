---
description: "Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status. Entity-reference fields (taxonomy terms, related content, media) go in `relationships`, not `fields`."
argument-hint: "<type> <title> [site] [body] [summary] [format] [status] [moderationState] [fields] [relationships] [dryRun] [returning]"
---

Call the MCP tool `drupal_create_node`.

Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status. Entity-reference fields (taxonomy terms, related content, media) go in `relationships`, not `fields`.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `title` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `body` (string): Body field HTML
- `summary` (string): Body summary/teaser — writes the `summary` property of the body field (core `text_with_summary`). Many headless sites instead use a dedicated summary/deck field for teasers and meta descriptions; on those, set that field in `fields` — a value written here will be stored but may never be rendered.
- `format` (string): Text format machine name for the body, e.g. 'basic_html'. When the body field's allowed_formats lists exactly one format, that is the default. A caller format outside that list is refused before write. When allowed_formats cannot be resolved, defaults to the site config's `defaultTextFormat`, then 'full_html'.
- `status` (boolean (true/false)): Published flag for NON-moderated types. true to publish immediately. Ignored if moderationState is set; on a moderated type it is dropped automatically.
- `moderationState` (string): Moderation state for content_moderation types, e.g. 'draft' or 'published'. Takes precedence over status.
- `fields` (object (pass as JSON)): Scalar/attribute field values keyed by Drupal machine name. Formatted text: a string or { value, format?, summary? }. format must be in the field's allowed_formats; a single allowed format is used when omitted. Do NOT put entity-reference fields here — Drupal rejects them as attributes; use `relationships`.
- `relationships` (object (pass as JSON)): Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value: { field_resource_type: { data: { type: 'taxonomy_term--resource_type', id: '<uuid>' } } }. Multi-value: { field_tags: { data: [{ type: 'taxonomy_term--tags', id: '<uuid>' }] } }.
- `dryRun` (boolean (true/false)): Validate and return a preview of the write without committing.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
