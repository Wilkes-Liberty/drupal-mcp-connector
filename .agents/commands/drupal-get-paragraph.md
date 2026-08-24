---
description: "Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph (fields include drupal_internal__revision_id) plus a `ref` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) you can use to embed it in a host entity's paragraph / ERR field. Paragraphs are referenced from a host field rather than queried standalone in production. Governed by the site security policy."
argument-hint: "<paragraphType> <id> [site]"
---

Call the MCP tool `drupal_get_paragraph`.

Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph (fields include drupal_internal__revision_id) plus a `ref` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) you can use to embed it in a host entity's paragraph / ERR field. Paragraphs are referenced from a host field rather than queried standalone in production. Governed by the site security policy.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `paragraphType` (string): Paragraph type / bundle machine name
- `id` (string): Paragraph UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
