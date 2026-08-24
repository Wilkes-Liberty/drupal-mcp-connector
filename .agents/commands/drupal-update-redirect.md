---
description: "Update an existing redirect by UUID: repoint its source or target, or change its status code (e.g. 301↔302). Only the fields you pass are changed (partial update). Use this to activate/fix a redirect that isn't firing (e.g. one created with a stale source). Governed by the site security policy."
argument-hint: "<id> [site] [source] [target] [statusCode]"
---

Call the MCP tool `drupal_update_redirect`.

Update an existing redirect by UUID: repoint its source or target, or change its status code (e.g. 301↔302). Only the fields you pass are changed (partial update). Use this to activate/fix a redirect that isn't firing (e.g. one created with a stale source). Governed by the site security policy.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `id` (string): Redirect entity UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `source` (string): New source/old path (leading slash optional). Omit to leave unchanged.
- `target` (string): New destination path/URI. Omit to leave unchanged.
- `statusCode` (number): New HTTP redirect status code (301/302/303/307/308). Omit to leave unchanged.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
