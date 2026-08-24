---
description: "List custom (content) menu links, optionally scoped to a single menu (e.g. 'main', 'footer'). Returns each link's title, target URI, menu, and weight. Note: this lists editable menu_link_content entities, not code-defined static links."
argument-hint: "[site] [menu] [limit] [offset] [sort]"
---

Call the MCP tool `drupal_list_menu_links`.

List custom (content) menu links, optionally scoped to a single menu (e.g. 'main', 'footer'). Returns each link's title, target URI, menu, and weight. Note: this lists editable menu_link_content entities, not code-defined static links.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `menu` (string): Menu machine name to filter by, e.g. 'main', 'footer', 'admin'. Omit to list links across all menus.
- `limit` (number)
- `offset` (number)
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }]. Defaults to weight asc.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
