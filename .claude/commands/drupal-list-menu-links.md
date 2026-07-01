---
description: "List custom (content) menu links, optionally scoped to a single menu (e.g. 'main', 'footer'). Returns each link's title, target URI, menu, and weight. Note: this lists editable menu_link_content entities, not code-defined static links."
argument-hint: "[site] [menu] [limit] [offset] [sort]"
allowed-tools: mcp__drupal__drupal_list_menu_links
---

Call the `mcp__drupal__drupal_list_menu_links` MCP tool.

List custom (content) menu links, optionally scoped to a single menu (e.g. 'main', 'footer'). Returns each link's title, target URI, menu, and weight. Note: this lists editable menu_link_content entities, not code-defined static links.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site (omit for default)
- `menu` (string): Menu machine name to filter by, e.g. 'main', 'footer', 'admin'. Omit to list links across all menus.
- `limit` (number)
- `offset` (number)
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }]. Defaults to weight asc.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
