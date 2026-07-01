---
description: "Inventory links in published body content (internal/external/images), aggregate external hosts, and flag malformed hrefs. With checkLive:true, verifies links via bounded, SSRF-guarded outbound HTTP (internal always; external only if includeExternal and host-allowlisted). No network egress unless checkLive is set."
argument-hint: "[site] [type] [sampleSize] [checkLive] [includeExternal]"
allowed-tools: mcp__drupal__drupal_report_broken_links
---

Call the `mcp__drupal__drupal_report_broken_links` MCP tool.

Inventory links in published body content (internal/external/images), aggregate external hosts, and flag malformed hrefs. With checkLive:true, verifies links via bounded, SSRF-guarded outbound HTTP (internal always; external only if includeExternal and host-allowlisted). No network egress unless checkLive is set.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan
- `checkLive` (boolean (true/false)): Perform live HTTP checks (off by default)
- `includeExternal` (boolean (true/false)): When checkLive, also check allowlisted external hosts

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
