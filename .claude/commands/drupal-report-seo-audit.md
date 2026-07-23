---
description: "SEO audit for a content type: missing meta descriptions, title length issues, and thin content (under 300 words). Returns node lists for each issue category. Meta descriptions use the rendered Metatag output via GraphQL when available (reported as `metaSource`); when no description source is readable it reports the meta check as unavailable rather than a false zero."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_seo_audit
---

Call the `mcp__drupal__drupal_report_seo_audit` MCP tool.

SEO audit for a content type: missing meta descriptions, title length issues, and thin content (under 300 words). Returns node lists for each issue category. Meta descriptions use the rendered Metatag output via GraphQL when available (reported as `metaSource`); when no description source is readable it reports the meta check as unavailable rather than a false zero.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
