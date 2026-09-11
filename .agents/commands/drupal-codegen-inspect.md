---
description: "List node and paragraph bundles and extra fields from graphql_compose_codegen (`drush graphql-compose-codegen:inspect`). Requires the module and drushSsh. Missing command fails loud. If allowedCommands is set, include graphql-compose-codegen:inspect. Does not write files."
argument-hint: "[site] [bundles] [skipFields]"
---

Call the MCP tool `drupal_codegen_inspect`.

List node and paragraph bundles and extra fields from graphql_compose_codegen (`drush graphql-compose-codegen:inspect`). Requires the module and drushSsh. Missing command fails loud. If allowedCommands is set, include graphql-compose-codegen:inspect. Does not write files.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `bundles` (array (pass as JSON)): Node/paragraph bundle ids. Omit for every bundle graphql_compose exposes.
- `skipFields` (array (pass as JSON)): Extra field machine names to exclude from the scaffold.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
