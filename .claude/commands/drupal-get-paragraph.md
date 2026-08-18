---
description: "Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph (fields include drupal_internal__revision_id) plus a `ref` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) you can use to embed it in a host entity's paragraph / ERR field. Paragraphs are referenced from a host field rather than queried standalone in production. Governed by the site security policy."
argument-hint: "<paragraphType> <id> [site]"
allowed-tools: mcp__drupal__drupal_get_paragraph
---

Call the `mcp__drupal__drupal_get_paragraph` MCP tool.

Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph (fields include drupal_internal__revision_id) plus a `ref` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) you can use to embed it in a host entity's paragraph / ERR field. Paragraphs are referenced from a host field rather than queried standalone in production. Governed by the site security policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `paragraphType` (string): Paragraph type / bundle machine name
- `id` (string): Paragraph UUID

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
