---
description: "Accessibility audit for body content: images without alt text, inline H1 tags, non-descriptive link text ('click here', 'read more'), and tables without captions."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_accessibility_audit
---

Call the `mcp__drupal__drupal_report_accessibility_audit` MCP tool.

Accessibility audit for body content: images without alt text, inline H1 tags, non-descriptive link text ('click here', 'read more'), and tables without captions.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
