# Module-owned workflow prompts

A per-tool command runs one call. A workflow prompt carries the order of
calls, the stop conditions, and what to ask the person. Modules that publish
tools have sequences worth packaging that way. The connector discovers,
filters, and relays those workflows. It does not hardcode a module's steps.

This note is the #333 record. It answers the decisions that issue listed, then
describes the loader. v1 loaded built-ins plus local `serverTools.modules.workflows`.
The connector now also fetches Drupal `prompts/list` / `prompts/get` from
`serverTools.url` (contrib `mcp_server` `McpPromptConfig` entities) and merges
them into that loader.

## Decisions

### 1. Source of truth

**Both, with local config able to disable but not widen.**

The long-term source is the module that owns the tools, published as Drupal
`McpPromptConfig` (or equivalent) and listed through the server-tool
transport's `prompts/list` / `prompts/get`. The connector then relays, the
same way it relays module tools.

The loader therefore takes definitions from:

1. A built-in provider (the five connector-authored workflows, now in the
   same format so there is one code path).
2. Site config next to `serverTools.modules`:
   `serverTools.modules.workflows`. A workflow listed there is enabled. Omit
   it to disable. A workflow may only name aliases that already exist under
   `serverTools.modules.tools` on that site. Config cannot invent a tool.
3. Drupal `prompts/list` + `prompts/get` on `serverTools.url`, for ids that
   local config already named. Remote instruction text is the source of truth
   when the catalog returns that id; a local body remains the fallback when
   the catalog omits it or the fetch fails. A remote prompt that is not named
   locally is ignored.

A remote catalog cannot add tools the local policy did not approve, and
local config cannot enable a remote workflow whose named tools are not
already visible. That is "disable but not widen." Drupal `{{name}}` tokens
are rewritten to `{arg:name}` so the existing renderer applies. `{tool:alias}`
placeholders in the remote text are the tool list.

### 2. Trust

A relayed prompt is instruction text from the source. v1 treats it like a
remote tool description:

- **Explicit local enablement.** Module workflows exist only when named in
  `serverTools.modules.workflows`.
- **Size bounds.** Description ≤ 1024 characters. Instructions ≤ 8192.
  Excess is truncated, not relayed in full.
- **No impersonation markup.** Leading Markdown headings and `system:` lines
  are stripped. Remaining whitespace is preserved enough for numbered steps.
- **Visibility.** A module workflow is listed only when every tool it names
  is visible to this caller (same scope, site grant, and source checks as
  the tools). Built-in workflows stay gated by inbound scope (`mcp_read` /
  `mcp_write`) as they are today, because they name core connector tools
  rather than module aliases.

### 3. Tool references

Workflows name tools by **local alias**, not wire name, so a namespace or
bridge-separator change does not rewrite the steps.

Placeholder syntax in instructions:

- `{tool:<alias>}` — rewritten at render time to the public tool name
  (`drupal_module_<operation>_<namespace>__<alias>`).
- `{arg:<name>}` — rewritten from the prompt arguments. Unknown args become
  an empty string. Values are length-capped and flattened to one line.

A `{tool:alias}` that is not in the workflow's `tools` list, or an alias that
is not in the site's approved `tools` object, **disables the whole
workflow**. Missing tool, missing alias, and unapproved alias are the same
fail-closed outcome: the prompt is absent.

Built-in workflows may list public `drupal_*` names in `tools` and use
`{tool:drupal_report_content_summary}` as an identity substitution.

### 4. Naming

Module workflows are `drupal-<namespace>-<workflow>`, with underscores in
either part turned into hyphens. Example:
`example_site` + `review_and_log` → `drupal-example-site-review-and-log`.

Collision rules, first match wins, the other is dropped:

1. Built-in workflow names.
2. Per-tool prompt names (`drupal-<tool>` / `drupal-module-…`).
3. Another module workflow already loaded.

A dropped name is not listed and `prompts/get` returns the same "not
visible" as an unauthorized prompt. The connector does not rename.

### 5. Writes

`readOnly` is required. `true` needs `mcp_read`. `false` needs `mcp_write`
(and is hidden from a read-only principal, like `drupal-create-article`).

A write workflow's instructions must tell the model to confirm with the
person before any write, and must not tell it to retry. The renderer
appends a fixed line: `Module writes are not retried.` It does not append
that line on read-only workflows.

### 6. Static stubs

`npm run install:commands -- --modules` also writes workflow stubs
(`drupal-<namespace>-<workflow>.md`) for workflows the local config enables
whose named tools the source returned. Collision with a built-in command
file or with a module-tool stub is refused. A plain `install:commands` does
not write or delete workflow stubs.

### 7. Built-in workflows

The five connector-authored workflows (`drupal-content-audit`,
`drupal-create-article`, `drupal-seo-fix`, `drupal-user-cleanup`,
`drupal-full-audit`) use this definition format and the same loader. Their
public names and steps stay the same.

## v1 definition

```json
{
  "id": "review_and_log",
  "description": "Review recent activities and log a follow-up after confirmation.",
  "readOnly": false,
  "tools": ["list_activities", "record_activity"],
  "arguments": [
    { "name": "site", "description": "Target site", "required": false }
  ],
  "instructions": "1. Call {tool:list_activities} for recent rows.\n2. Summarize.\n3. Ask before calling {tool:record_activity}. Do not retry a write."
}
```

`id` is a machine name: lowercase letters, digits, underscores, up to 48
characters, starting with a letter. `tools` is a non-empty list of aliases.
`instructions` is required.

## Out of scope here

- Shipping `McpPromptConfig` YAML from individual Drupal modules (they own
  that config; the connector only relays what `/mcp` already advertises).
- Per-tool commands for module tools (separate issue).
- Changing tool authorization.
- Retrying a module write.
