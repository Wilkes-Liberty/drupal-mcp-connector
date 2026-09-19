# Module-owned MCP tools

Drupal modules can define business actions once and expose them through the connector's generic module registry. This feature is opt-in. A tool being installed or appearing in a remote catalog does not grant access to it.

## Responsibilities

- The module owns its typed input/output contracts, access checks, business services, transactions, idempotency and audit events.
- Drupal's MCP Tool bridge publishes enabled Tool API plugins through `tools/list` and `tools/call`.
- Sentinel enforces source readiness, credential scopes, policy and output controls.
- The connector selects approved tools, checks caller/site grants and operation policy, validates schemas, and transports calls. No module code is loaded into the Node process.

## Configure a provider

Extend an existing site's `serverTools` object. Keep its credential in the existing secret mechanism. Use a separate site entry and source credential for each isolated machine role.

```json
{
  "serverTools": {
    "url": "/mcp",
    "modules": {
      "namespace": "staging_relationships",
      "tools": {
        "record_activity": {
          "name": "tool_api__example_record_activity",
          "scope": "relationship_write",
          "operation": "write",
          "capabilities": []
        }
      }
    }
  }
}
```

This exposes `drupal_module_write_staging_relationships__record_activity` only if the source lists the approved tool and caller policy permits it. The operation in the name comes from operator configuration, never the remote annotation. This keeps write classification consistent with transport and relay actor requirements. The namespace and alias together must be unique across configured sites.

Copy `name` from the installed source's advertised catalog. Bridge versions may
use different derivative separators; the connector does not rewrite them.

`config/config.example.json` has a full example under `_server_tools.example`:
a namespace, two module-owned tools, and all seven compatibility bindings with
the aliases they map to. A test checks it against the registry's validation.

## Compatibility bindings

An existing command can retain its public name while its implementation lives
in Drupal. Add `serverTools.bindings` to map a supported compatibility operation
to an alias in the same site's `serverTools.modules.tools` object:

```json
{
  "bindings": {
    "configGet": "get_config",
    "configList": "list_config",
    "configSet": "set_config"
  }
}
```

These three aliases must have scope `mcp_config`. Get/list require operation
`read` and capability `configRead`; set requires operation `write` and capability
`configWrite`. Each alias's `name` is the exact approved source tool name, not a
connector constant. Existing config-set clients still pass `value`; the
compatibility adapter supplies that map as the module's `data` argument.

Configured bindings use fresh discovery and the same schema, caller, site and
source checks as ordinary module calls. Missing mappings, changed schemas and
refusals never trigger a legacy-tool or SSH fallback. Config reports use these
bindings too. The install verifier resolves the same local mapping but sends
its negative probe directly to the source, so a local catalog filter cannot be
mistaken for evidence of source authorization. It checks that the bound name is
in the source's `tools/list` first; a refusal of a name the source does not
advertise is `skipped`, not a pass.

Sites without `bindings` retain the previous config transport during migration.
That transport resolves the config tool's wire name from the source's
`tools/list` (`tool_api__<id>`, or `tool_api.<id>` on an older bridge) and fails
closed when the source advertises neither.
Review and configure all three bindings together before validating the new path.
The module registry itself remains opt-in.

### Codegen and governed SQL

The following compatibility bindings use the same registry. Configure them on
sites that use these commands; an existing `bindings` object activates strict
binding resolution, so an absent mapping refuses the command.

| Binding | Public command | Inbound scope | Capability | Drupal action |
|---|---|---|---|---|
| `codegenInspect` | `drupal_codegen_inspect` | `mcp_config` | `configRead` | `graphql_compose_codegen_inspect` |
| `codegenDiff` | `drupal_codegen_diff` | `mcp_config` | `configRead` | `graphql_compose_codegen_diff` |
| `codegenPreview` | `drupal_codegen_generate` | `mcp_config` | `configRead` | `graphql_compose_codegen_preview` |
| `sqlQuery` | `drupal_drush_sql_query` | `mcp_admin` | `rawSql` | `mcp_sentinel_sql_query` |

All four require operation `read`. Map each binding to a configured alias and
copy its exact wire name from the source catalog. Inbound connector scopes and
outbound Drupal credential scopes are separate: Codegen's Drupal actions require
`mcp_config_read`; SQL requires `mcp_read` plus explicit source `allow_raw_sql`.
Retain the local SQL opt-in `drushSsh.rawSql: "governed"`. A bound call needs no
SSH host, key or connection; other Drush commands still require their SSH setup.

Codegen translates `skipFields` to the module's `skip_fields`. Its response keeps
`output`, `command` and `wroteFiles: false`; `output` now contains the module's
structured result serialized as JSON, and `command` identifies the module binding.
Generation is a preview and never writes files on Drupal. SQL keeps its existing
`rows`, `row_count`, `truncated` and `profile` response fields. Invalid responses
and source refusals fail without trying a legacy command.

Unbound sites retain their existing Drush adapters during migration. This does
not remove core or third-party integrations such as taxonomy, node/media tools,
or the general Drush administration commands.

`operation` is `read`, `write` or `delete`. `capabilities` is required and lists additional connector gates: `publish`, `configRead`, `configWrite`, `graphql`, or `rawSql`. Raw SQL retains the explicit governed-SQL opt-in. These gates only tighten permissions; they do not grant Drupal access. A read-only connector refuses writes regardless of a source tool's description.

Non-loopback HTTPS deployments must also permit the intended inbound OAuth scope through their existing resource-server configuration. Do not broaden a CRM credential into a generic content-editor credential merely to satisfy a transport's default scope.

## Call contract

Each discovered tool has an object schema with two properties:

- `catalogRevision`: the constant supplied by discovery. Refresh discovery when it changes.
- `arguments`: the module's own typed input schema. Routing comes from the configured tool identity, not from fields inside this object.

Calls fetch the catalog again and validate both the current contract and its revision. An unavailable, disabled, changed or unauthorized tool fails closed. There is no fallback to an entity write, SSH command or arbitrary URL.

Results preserve structured module data under `result` and report the resolved `_target`. Successful results with an output schema are validated before disclosure. Tool failures remain failures, including the Tool API bridge's `success: false` result. The initial registry supports JSON/text results only; binary attachments and resource blocks are refused.

## Bounds and failure handling

Catalogs are limited to 16 pages, 256 tools and 256 KiB total. Schemas are limited to 64 KiB each; arguments and results to 256 KiB. External schema loading and asynchronous validators are not supported. JSON Schema 2020-12 is supported with format validation and no type coercion. Local schema references retain their own root when embedded in the connector envelope.

There is no cross-request catalog cache. Discovery is deterministic and filtered by caller scope and target grant; every invocation checks again. HTTP sessions are bounded and separated by source endpoint, source credentials and requesting principal. Individual bounded transport requests time out after 15 seconds.

Module writes are not automatically retried. After an uncertain result, use the module's idempotency or reconciliation operation. A read-only or idempotency annotation is a hint, not authorization or proof that replay is safe.

## Developer acceptance

Register a normal Tool API plugin and an enabled MCP bridge config in Drupal. Use task-shaped actions and shared Drupal services, not shell-command strings. Module installation and tool enablement belong in reviewed configuration. Document required scopes and additional capability gates for the operator's connector policy.

Tests must cover direct invocation as well as discovery: wrong scope/site, denied records and fields, stale revisions, duplicate requests, removed plugins, malformed inputs and audit failures. The connector's fixture tests use two unrelated tool providers to prove that adding a module does not require a new JavaScript handler.

Runtime module tools are discovered over MCP. The private Drupal bridge retains its supported MCP 2025-06-18 transport; module support does not upgrade that wire protocol.

## Prompts and slash commands

Each module tool that discovery returns for a request also has an MCP prompt,
`drupal-module-<operation>-<namespace>--<alias>`. The prompt list is built from
the same discovery as `tools/list`, so a caller sees a prompt only for a tool it
can call. Nothing is cached between requests. The prompt lists the module's own
parameters, tells the model to place them inside `arguments`, and tells it to
copy `catalogRevision` from the tool's current input schema. No prompt or stub
contains a revision value, because the value changes with the module's schema.

Committed slash-command generation (`.agents/commands/`) describes built-in
tools only. Module tools are never installed as local command files by default.
An operator can ask for them:

```bash
# from the directory that holds config/config.json
npm run install:commands -- --modules
```

This discovers the tools the local config approves, using the configured
sources and credentials, and writes one stub per tool named
`drupal-<namespace>-<alias>.md` (for example
`/drupal-staging-relationships-record-activity`). For Codex the tools are added
to the `drupal-mcp` skill catalog instead.

- A stub name that matches a built-in command, or that two module tools share,
  is refused and reported. Pick a different namespace or alias. Names come from
  the configured namespace and alias, not from parsing the tool name.
- Descriptions a source supplies are flattened to one line and cut at 1024
  characters before they reach a prompt or a stub.
- If tools are configured and no source returns any, the run fails and writes
  nothing. If only some are returned, the missing names are printed and stubs
  from earlier runs are kept, since the source may only be unreachable.
- A complete `--modules` run removes stubs for tools that are no longer
  configured. A plain `install:commands` leaves module stubs alone. The Codex
  catalog is rebuilt on every run, so it lists module tools only after a
  `--modules` run.
- A stub is a convenience, not a grant. The call still passes every connector
  and source check, and a stub for a tool the caller cannot see fails closed.
- Stubs are written for the local operator's view of the catalog. Re-run after
  changing `serverTools.modules`.

## Migration status

The generic registry does not by itself migrate existing commands. Specialized
actions from modules maintained by this project move into their owning modules:
CRM, GraphQL Compose Codegen, and MCP Sentinel. Compatibility routing and
Drupal-side adapters must be validated before retiring old implementations.

Core and third-party integrations remain in the connector, including taxonomy,
Scheduler, Redirect, Paragraphs and Metatag reports. Their availability does not
depend on upstream accepting Tool API plugins. Sentinel's entity draft/revision
transport and generic relationship correctness remain security infrastructure.

### Nullable input schemas

Providers may express nullable types with `oneOf` and sibling constraints such as
`maxLength`. The registry accepts this JSON Schema form without coercing values
or dropping unknown properties. Type, length, enum and required-field validation
remain active. Unknown schema keywords and unresolved external references still
make an action unavailable.
