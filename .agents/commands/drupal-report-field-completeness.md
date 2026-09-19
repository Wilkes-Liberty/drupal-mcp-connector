---
description: "Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc. Reads scalar and entity-reference fields; a reference with no target is empty. Sampling-bounded — flags 'approximate' when the scan hits sampleSize. An absent field is not an empty one: JSON:API leaves out a field this account may not view. A node that omits the key is counted as `absent` and stays out of completenessPercent. A field you name that is absent from every sampled node is listed in `notVisible` and not scored (it may be denied to this account, not exist on the content type, or be misspelled). Default field guesses that are absent are dropped."
argument-hint: "<type> [site] [fields] [sampleSize]"
---

Call the MCP tool `drupal_report_field_completeness`.

Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc. Reads scalar and entity-reference fields; a reference with no target is empty. Sampling-bounded — flags 'approximate' when the scan hits sampleSize. An absent field is not an empty one: JSON:API leaves out a field this account may not view. A node that omits the key is counted as `absent` and stays out of completenessPercent. A field you name that is absent from every sampled node is listed in `notVisible` and not scored (it may be denied to this account, not exist on the content type, or be misspelled). Default field guesses that are absent are dropped.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `fields` (array (pass as JSON)): Field machine names to check. Defaults to common SEO/editorial fields.
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
