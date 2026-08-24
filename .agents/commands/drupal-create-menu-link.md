---
description: "Create a custom menu link, enabled by default so it renders immediately. The link target is a Drupal URI such as 'internal:/about', 'entity:node/42', or an absolute 'https://…' URL — prefer 'entity:node/<id>' when linking to a node (avoids the alias-resolution 'path inaccessible' race). Set 'parent' (a parent link plugin id like 'menu_link_content:<uuid>') to nest the link, and 'enabled: false' to create it disabled. Checked against the site security config."
argument-hint: "<title> <link> <menu> [site] [weight] [parent] [enabled]"
---

Call the MCP tool `drupal_create_menu_link`.

Create a custom menu link, enabled by default so it renders immediately. The link target is a Drupal URI such as 'internal:/about', 'entity:node/42', or an absolute 'https://…' URL — prefer 'entity:node/<id>' when linking to a node (avoids the alias-resolution 'path inaccessible' race). Set 'parent' (a parent link plugin id like 'menu_link_content:<uuid>') to nest the link, and 'enabled: false' to create it disabled. Checked against the site security config.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `title` (string): Link label shown in the menu
- `link` (string): Target URI, e.g. 'entity:node/42', 'internal:/about', or 'https://example.com'
- `menu` (string): Menu machine name to place the link in, e.g. 'main' or 'footer'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `weight` (number): Ordering weight within the menu (lower sorts first)
- `parent` (string): Parent link plugin id to nest under, e.g. 'menu_link_content:<uuid>'. Omit for a top-level link.
- `enabled` (boolean (true/false)): Whether the link is enabled (renders). Defaults to true.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
