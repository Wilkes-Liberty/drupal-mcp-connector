---
description: "List custom content blocks (block_content entities), optionally scoped to a single block type (bundle). Returns each block's admin label (info) and body. Does not list code/plugin-defined blocks."
argument-hint: "[site] [type] [limit] [offset] [sort]"
allowed-tools: mcp__drupal__drupal_list_blocks
---

Call the `mcp__drupal__drupal_list_blocks` MCP tool.

List custom content blocks (block_content entities), optionally scoped to a single block type (bundle). Returns each block's admin label (info) and body. Does not list code/plugin-defined blocks.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Block type (bundle) machine name to filter by, e.g. 'basic'. Omit to list all custom blocks.
- `limit` (number)
- `offset` (number)
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }]. Defaults to info asc.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
