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
          "name": "tool_api.example_record_activity",
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

Static slash-command generation continues to describe built-in tools. Runtime module tools are discovered over MCP; they are not silently installed as local command files. The private Drupal bridge retains its supported MCP 2025-06-18 transport; module support does not upgrade that wire protocol.

## Migration status

The generic registry does not by itself migrate existing built-in module commands. The remaining migration covers code generation, Scheduler, Redirect, Paragraphs, Sentinel configuration/SQL, and module-specific report sources. Compatibility routing and Drupal-side adapters must be validated before retiring existing implementations. Sentinel's entity draft/revision transport and generic relationship correctness remain security infrastructure.
