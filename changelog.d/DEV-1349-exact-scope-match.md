---
section: Changed
---
OAuth scope checks are exact match only (DEV-1349). A token that holds `mcp_config` and not `mcp_config_read` is refused for config-read tools (`drupal_config_get`, `drupal_config_list`, `drupal_drush_config_status`, and config-read module bindings), matching mcp_sentinel. `mcp_config_read` still admits those reads; `mcp_config` still admits config writes. Grant both scopes to a developer consumer that must read and write config, and update config-read bindings from `mcp_config` to `mcp_config_read`.
