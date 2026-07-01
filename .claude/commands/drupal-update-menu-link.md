---
description: "Update a custom menu link by UUID (rename, re-weight, re-target, re-parent, enable/disable). Only the fields you pass change. The link's enabled state is preserved across edits — an unrelated change will not disable a live link — unless you pass 'enabled' explicitly. Checked against the site security config."
argument-hint: "<id> [site] [title] [link] [menu] [weight] [parent] [enabled]"
allowed-tools: mcp__drupal__drupal_update_menu_link
---

Call the `mcp__drupal__drupal_update_menu_link` MCP tool.

Update a custom menu link by UUID (rename, re-weight, re-target, re-parent, enable/disable). Only the fields you pass change. The link's enabled state is preserved across edits — an unrelated change will not disable a live link — unless you pass 'enabled' explicitly. Checked against the site security config.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `id` (string): Menu link UUID

**Optional:**
- `site` (string): omit for the default site
- `title` (string): New link label. Omit to leave unchanged.
- `link` (string): New target URI (e.g. 'entity:node/42'). Omit to leave unchanged.
- `menu` (string): Move the link to this menu. Omit to leave unchanged.
- `weight` (number): New ordering weight. Omit to leave unchanged.
- `parent` (string): New parent link plugin id (e.g. 'menu_link_content:<uuid>'), or '' for top level. Omit to leave unchanged.
- `enabled` (boolean (true/false)): Enable/disable the link. Omit to preserve the current state.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
