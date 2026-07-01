---
description: "Create a custom content block of a given block type (bundle). 'info' is the administrative label; 'body' is optional rendered HTML. Checked against the site security config."
argument-hint: "[site] <type> <info> [body]"
allowed-tools: mcp__drupal__drupal_create_block
---

Call the `mcp__drupal__drupal_create_block` MCP tool.

Create a custom content block of a given block type (bundle). 'info' is the administrative label; 'body' is optional rendered HTML. Checked against the site security config.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Block type (bundle) machine name, e.g. 'basic'
- `info` (string): Administrative label / block description

**Optional:**
- `site` (string): omit for the default site
- `body` (string): Block body HTML (optional)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
