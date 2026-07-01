---
description: "Update an existing redirect by UUID: repoint its source or target, or change its status code (e.g. 301↔302). Only the fields you pass are changed (partial update). Use this to activate/fix a redirect that isn't firing (e.g. one created with a stale source). Governed by the site security policy."
argument-hint: "[site] <id> [source] [target] [statusCode]"
allowed-tools: mcp__drupal__drupal_update_redirect
---

Call the `mcp__drupal__drupal_update_redirect` MCP tool.

Update an existing redirect by UUID: repoint its source or target, or change its status code (e.g. 301↔302). Only the fields you pass are changed (partial update). Use this to activate/fix a redirect that isn't firing (e.g. one created with a stale source). Governed by the site security policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `id` (string): Redirect entity UUID

**Optional:**
- `site` (string): omit for the default site
- `source` (string): New source/old path (leading slash optional). Omit to leave unchanged.
- `target` (string): New destination path/URI. Omit to leave unchanged.
- `statusCode` (number): New HTTP redirect status code (301/302/303/307/308). Omit to leave unchanged.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
