---
description: "Inventory links in published body content (internal/external/images), aggregate external hosts, and flag malformed hrefs. With checkLive:true, verifies links via bounded, SSRF-guarded outbound HTTP (internal always; external only if includeExternal and host-allowlisted). No network egress unless checkLive is set."
argument-hint: "[site] [type] [sampleSize] [checkLive] [includeExternal]"
---

Call the MCP tool `drupal_report_broken_links`.

Inventory links in published body content (internal/external/images), aggregate external hosts, and flag malformed hrefs. With checkLive:true, verifies links via bounded, SSRF-guarded outbound HTTP (internal always; external only if includeExternal and host-allowlisted). No network egress unless checkLive is set.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan
- `checkLive` (boolean (true/false)): Perform live HTTP checks (off by default)
- `includeExternal` (boolean (true/false)): When checkLive, also check allowlisted external hosts

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
