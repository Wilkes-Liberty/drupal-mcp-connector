# drupal-mcp-connector

> A secure, multi-site Model Context Protocol (MCP) connector for Drupal — dual-protocol JSON:API and GraphQL access, governed content tools, audit reports, and an SSH Drush bridge.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![Drupal](https://img.shields.io/badge/drupal-10%20%7C%2011-blue)](https://drupal.org)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-purple)](https://modelcontextprotocol.io)

Built by **Jeremy Michael Cerda** (opensource@wilkesliberty.com). Maintained by [Wilkes & Liberty, LLC](https://github.com/Wilkes-Liberty).

**If the client only shows `drupal_list_sites` and `drupal_governance_status`**, the secret env vars named in `config.json` are unset. Upgrade to **2.7.4** (or at least 2.6.1), or stay on 2.6.0 and launch via `bin/drupal-mcp-launch.sh` with a `config/secrets.map` (`ENV_VAR=keychain-item`). Then restart the MCP server. See [#199](https://github.com/Wilkes-Liberty/drupal-mcp-connector/issues/199).

---

## What It Does

`drupal-mcp-connector` connects any [Model Context Protocol](https://modelcontextprotocol.io) client to one or more Drupal sites. It exposes Drupal content and configuration as a set of MCP **tools**, **resources**, and **prompts**, so an MCP client can read, audit, and (where permitted) write content through structured, governed operations instead of the admin UI:

```
"Find all articles missing a meta description and list them."
"Show me every user account that hasn't logged in for 90 days."
"Create 10 draft product nodes from this structured data."
"Run an SEO and accessibility audit on the article content type."
"What content types exist on the site and which are barely used?"
```

The connector speaks **two Drupal backends interchangeably** — Drupal core's **JSON:API** and **GraphQL** (via [GraphQL Compose](https://www.drupal.org/project/graphql_compose)) — selectable per site. It normalizes both into one canonical entity shape, so the same tools work whether a site exposes JSON:API, GraphQL, or both. An optional SSH **Drush bridge** adds administrative operations the HTTP APIs can't reach.

---

## Dual-Protocol Backends

Each site declares which backend(s) it exposes via the `api` key:

```json
"sites": {
  "main":         { "baseUrl": "https://example.com", "api": "jsonapi" },
  "graphql_only": { "baseUrl": "https://api.example.com", "api": "graphql" },
  "either":       { "baseUrl": "https://example.com", "api": ["graphql", "jsonapi"] }
}
```

- **`api` accepts** `"jsonapi"`, `"graphql"`, or a priority array like `["graphql","jsonapi"]`. Omit it to **auto-detect** (the connector probes both once and caches the result).
- **One canonical shape.** Both backends return entities as
  `{ id, entityType, bundle, title, status, langcode, created, changed, url, fields, relationships, _backend }`, so tool output is identical regardless of protocol.
  Every site-addressing response also includes `_target: { name, baseUrl, source }` so a defaulted call cannot be mistaken for another environment.
- **Capability-aware.** Each backend advertises what it supports (read, write, delete, server-side filter/sort, revisions). GraphQL via GraphQL Compose is **read-only** (no mutations) and has no server-side field filter, so filters are applied client-side over a bounded fetch and flagged `approximate`/`truncated`. Write tools against a read-only backend return a clear capability error rather than failing silently.
- **Writes go through JSON:API.** Use a JSON:API-enabled site as the write plane; keep GraphQL as a read plane where that suits your architecture.
- **`defaultTextFormat` sets the body text format** used by the `body` convenience
  parameter on node writes, e.g. `{ "baseUrl": "…", "defaultTextFormat": "basic_html" }`.
  Individual calls can override it with `format`. Field API `allowed_formats` wins
  when it can be resolved: a single allowed format is the default, and a format
  outside the list is refused. Without a resolved list, the connector falls
  back to `full_html`, which many governed sites deliberately do not define — and which
  is the most permissive core format, so setting this per site is the safer posture. A
  text format is Drupal's HTML-filtering boundary, so it is worth choosing deliberately
  rather than inheriting.

See **[docs/architecture.md](docs/architecture.md)** for the backend abstraction and **[docs/graphql-local-setup.md](docs/graphql-local-setup.md)** for the GraphQL specifics.

---

## Features

### 119 Tools Across 26 Modules

| Module | Tools |
|--------|-------|
| **Nodes** | CRUD for any content type with arbitrary field support |
| **Taxonomy** | Vocabulary listing + full term CRUD |
| **Users** | List, get, create, update, block/unblock, role management (PII-gated) |
| **Media** | List types, CRUD, file upload, orphaned-media detection |
| **GraphQL** | Execute a query, schema introspection (mutation-gated) |
| **Entities** | Generic CRUD for *any* Drupal entity type (paragraphs, commerce, webforms, …) |
| **Site** | Site info, content-type discovery, configured-site listing |
| **Reports** | Content summary, stale content, field completeness, SEO/accessibility audits, taxonomy usage, user activity, revision hotspots (10 read-only reports) |
| **Drush** | Cache rebuild, cron, config sync, module management, DB updates via SSH |
| **Revisions** | List/get entity revisions; governed revert to a prior revision |
| **Moderation** | Set moderation state; list content by state; observed-state discovery (content_moderation) |
| **Scheduler** | Set publish-on / unpublish-on dates (Scheduler module) |
| **Fields** | Describe a bundle's fields (type/required/cardinality, best-effort) |
| **References** | Resolve a human name/title to an entity UUID for relationship fields |
| **Bulk** | Bulk create/update with per-item partial-failure reporting |
| **Translations** | List + create entity translations |
| **Paragraphs** | Create/update/get Paragraph components for embedding in host fields |
| **Structure** | Menu links (list/create/update, incl. `parent` + `enabled`) + custom blocks (list/create) |
| **Redirects** | Create active URL redirects (301/302) + update/repoint existing redirects (Redirect module) |
| **Search** | Best-effort content search (title match; Search API/Solr-ready) |
| **Reports (extra)** | Orphaned references, unpublished content, missing-field audits |
| **Reports — Links & 404** | 404-log → redirect candidates, redirect-table health (chains/loops/duplicates), body-link inventory with opt-in live checking, URL-alias coverage, menu-link integrity, embedded-entity scan |
| **Reports — Config & Health** | Config drift, best-practice/security config linter, module audit (dev/debug + security updates), permission audit, Drupal status report, text-format safety, cache posture |
| **Reports — Content Quality** | Duplicate content, workflow bottlenecks, translation coverage, scheduled content, readability (Flesch), orphan pages, PII exposure (masked), structured-meta SEO coverage |
| **Audit (composite)** | `drupal_audit_site_health` — scored content/links/config dashboard with a roll-up grade |
| **Config & Governance** | Governed config get/list/set via the server-tool bridge; `drupal_mcp_whoami` tier/capability report |

**Preview writes with `dryRun`.** The node and entity create/update/delete tools accept an optional `dryRun: true` flag that validates the request and returns a preview of exactly what would be written — without committing anything to Drupal.

### MCP Resources
Browsable, always-fresh context the client can read without calling a tool:
- **`drupal://sites`** — configured site profiles (no credentials)
- **`drupal://{site}/content-types`** — content types with field schemas
- **`drupal://{site}/security-policy`** — the active security configuration

### MCP Prompts
Prompts are exposed as slash-commands in **any** MCP client (Claude, Gemini, Codex,
and other MCP-aware agents). Two kinds ship with the connector:

**Workflow templates** — multi-step guided flows:
- `drupal-content-audit` — walk through a full site content audit
- `drupal-full-audit` — run the composite content/links/config audit and turn the scored dashboard into a prioritized action plan
- `drupal-create-article` — guided article creation with all fields
- `drupal-seo-fix` — find and fix SEO gaps
- `drupal-user-cleanup` — identify and handle inactive accounts

**One prompt per tool** — every `drupal_*` tool is also exposed as a
`drupal-<tool>` prompt (e.g. `drupal-create-node`, `drupal-list-nodes`,
`drupal-report-seo-audit`), derived automatically from the tool set so it never
drifts. Each prompt takes the tool's parameters as arguments and drives a single,
governed call to that tool. These are protocol-native, so they work everywhere the
prompts capability is supported — the client renders them per its own convention
(e.g. Claude Code shows `/mcp__drupal__drupal-create-node`).

#### Filesystem slash commands (`/drupal-*`)
MCP prompts (above) are the protocol-native slash surface. For the literal bare
`/drupal-<tool>` form, the connector ships generated stubs under
**`.agents/commands/`** — a harness-agnostic tree, not a vendor rule directory.
Clients that scan `.agents/commands/` (including Grok Build when this repo is
the project) pick them up automatically.

Clients that only scan a vendor home path (Claude Code `~/.claude/commands`,
Grok `~/.grok/commands`) install from that tree into the **operator home**, so
no consuming project has to commit `.claude/` or `.grok/`:

```bash
npm run generate:commands    # refresh .agents/commands/ (from a clone)
npm run install:commands     # copies into ~/.claude/commands and ~/.grok/commands
# npm run install:commands -- --clients claude
# npm run install:commands -- --home /path/to/fake-home   # tests / CI
```

From an npm install, the same files ship at
`node_modules/drupal-mcp-connector/.agents/commands/`. Do not copy them into an
application repo's `.claude/` or `.grok/` directory.

### Security Model

Defense-in-depth presets, enforced connector-side and complemented by Drupal-side
governance (MCP Sentinel). **Default when `security` is omitted:**
`production-strict` (read-only, sensitive types denied). Local development must
set `"preset": "development"` explicitly.

```json
"security": { "preset": "auditor" }
```

| Preset | What it does |
|--------|-------------|
| `development` | Everything allowed, including GraphQL — local development only |
| `content-editor` | Create/edit content + structural entities; no deletes; no publishing; secrets/governance/account types denied |
| `config-editor` | content-editor + site-building config read + governed config write (developer tier) |
| `auditor` | Read-only; secrets/governance/account types denied; user PII redacted when user is allowed |
| `production-strict` | Read-only; same sensitive denylist as auditor; broad PII field redaction (**default**) |
| `write-plane` | Create/update content set for agents; no deletes; no GraphQL; publish off by default |

Additional connector-side gates (2.1+ / 2.2+):

- **Entity allowlists** apply to specialized tools (`drupal_*_node`, media, taxonomy), not only `drupal_entity_*`.
- **Publish gate:** `status: true` and `moderation_state: "published"` require `allowPublish`. Media create defaults **unpublished**. Published moderated node updates without a moderation state default to **draft** (forward revision).
- **Uploads** only from `MCP_UPLOAD_ROOT` (or the process cwd); sensitive paths (`.env*`, `.ssh`, connector `config.json`) are refused.
- **HTTPS:** non-loopback binds require an inbound OAuth resource server (`auth.issuer` + `auth.audience`), not `MCP_AUTH_TOKEN`. `MCP_AUTH_TOKEN` remains valid on loopback. `MCP_ALLOW_UNAUTHENTICATED=1` is only for a trusted proxy. Non-loopback TLS defaults to 120 req/min rate limiting. Inbound JWT scopes (and optional `auth.grants`) filter which tools, resources, prompts, and sites a principal can discover or invoke.
- **GraphQL is off by default.** `drupal_graphql` / introspect require `security.allowGraphql` (true only on the `development` preset). Raw GraphQL results still bypass entity allowlists and field redaction — prefer JSON:API entity tools when connector policy must hold. Mutations also need `allowGraphqlMutations`.
- **Northbound data-flow budgets (2.8+):** row, byte, page, request, and chained-action counters keyed by inbound principal + authoritative target (same finite defaults as MCP Sentinel), so pagination, retries, batching, or a new chain id cannot reset them. Governed reads carry the declared-ceiling / declared-destination wire contract; tune with `security.declaredCeiling` and `security.readBudgets`.

Full detail: **[docs/security.md](docs/security.md)** and **[docs/security-hardening.md](docs/security-hardening.md)**.

---

## Requirements

- **Node.js** 20+
- **Drupal** 10 or 11 (JSON:API ships in core)
- For the **GraphQL backend**: [GraphQL Compose](https://www.drupal.org/project/graphql_compose)
- For **token auth** (recommended): [Simple OAuth](https://www.drupal.org/project/simple_oauth)
- For the **Drush bridge**: SSH key access to the Drupal server

---

## Quick Start

### From npm (recommended for operators)

```bash
npm install -g drupal-mcp-connector
# or: npx -y drupal-mcp-connector
```

Point your MCP client at the installed binary (path from `which drupal-mcp-connector`
or `node_modules/.bin/drupal-mcp-connector`). For multi-site or non-env config,
clone the repo (or copy `config/config.example.json` beside a small launcher) and
pass a config path — see **[docs/getting-started.md](docs/getting-started.md)**.

### From a git clone (development)

```bash
git clone https://github.com/Wilkes-Liberty/drupal-mcp-connector
cd drupal-mcp-connector
npm install
cp config/config.example.json config/config.json
# Edit config/config.json — baseUrl, api backend, auth, security preset
node src/index.js
```

### Register with an MCP client

Most desktop and CLI MCP clients launch the connector over **stdio**:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "drupal-mcp-connector",
      "env": {
        "DRUPAL_BASE_URL": "https://mysite.com",
        "DRUPAL_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

Or with an absolute path to `src/index.js` / the installed package. For multi-client
or remote use, run the HTTPS transport and register the endpoint instead — see
**[docs/getting-started.md](docs/getting-started.md)** and
**[docs/mcp-clients.md](docs/mcp-clients.md)**.

The same entry point serves current MCP 2026-07-28 clients and 2025-era clients.
Current HTTP requests are stateless and never receive `Mcp-Session-Id`; legacy
HTTP clients retain their existing session. Set `MCP_LEGACY_TRANSPORT=reject`
to end the compatibility window deliberately. The `/mcp` URL does not change.

---

## Companion Drupal Module — MCP Sentinel

The connector works out of the box against Drupal core's JSON:API and a GraphQL Compose schema. For server-side governance, pair it with the **[MCP Sentinel](https://www.drupal.org/project/mcp_sentinel)** module (`drupal/mcp_sentinel`), which enforces policy *inside* Drupal — independent of any connector configuration:

- Role-bound policy profiles (operation gates, entity allow/deny, field redaction)
- Tamper-evident audit log of every governed MCP operation, attributed to the acting account
- Content locks that prevent edits to content a human is actively editing
- OAuth scope enforcement (`mcp_read` / `mcp_write` / `mcp_config`) per tool
- HMAC-signed webhooks on MCP-driven entity changes

```bash
composer require drupal/mcp_sentinel drupal/mcp_server drupal/simple_oauth
drush en mcp_sentinel mcp_sentinel_server mcp_server_tool_bridge -y
drush mcp-sentinel:setup
```

Governance keys off the authenticated account's role and OAuth scopes — not request headers. The connector sends an `X-MCP-Client` identity header purely as a log label. See the [MCP Sentinel project page](https://www.drupal.org/project/mcp_sentinel) for the full contract.

### Raw SQL is governed, or it is off

The Drush bridge runs over SSH, which is *below* everything above: a `drush`
subprocess does not make a request Drupal can govern, and most Drush commands
never load Drupal's module system at all. `drupal_drush_sql_query` used to
exploit that without meaning to — it called `drush sql:query`, so no policy
profile, no denied entity type, no field redaction and no audit entry applied
to anything it read.

It now calls `drush mcp-sentinel:sql-query` (mcp_sentinel ≥ 1.14), which runs
with Drupal fully bootstrapped and enforces the same profile that governs
JSON:API. **Two opt-ins, both off by default**, are required:

```jsonc
// this connector, per site
"drushSsh": {
  "rawSql": "governed",                          // no other value enables it
  "allowedCommands": ["mcp-sentinel:sql-query"]  // only if you pin this list
}
```

…plus `allow_raw_sql` on the policy profile in Drupal. Expect a much narrower
tool than before: one `SELECT`, entity tables only, no expressions, and no
`SELECT *` on a table carrying a redacted column. Every attempt — permitted or
refused — lands in the audit chain with its statement text.

The rest of the bridge (`sql:cli`, `sql:dump`, `php:eval` and anything else you
reach over SSH) is **outside Drupal governance by construction**. Treat SSH as
an operator channel: keep the agent's credentials off it, and pin
`allowedCommands` per site.

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Full setup: DDEV/Lando, Simple OAuth, multi-site, transports |
| [MCP Clients](docs/mcp-clients.md) | Wire the connector into Claude (Code/Desktop), Grok (Build/API), and OpenAI (Codex/ChatGPT) — copy-paste config per client |
| [OAuth client_credentials](docs/oauth-client-credentials.md) | Production OAuth deploy: scope→role mapping, JSON:API writes, config persistence, secret handling, troubleshooting |
| [Architecture](docs/architecture.md) | Backend abstraction, canonical model, and how to extend it |
| [GraphQL Setup](docs/graphql-local-setup.md) | GraphQL Compose backend + local TLS notes |
| [Tools Reference](docs/tools-reference.md) | Full reference for all 119 tools |
| [Security Guide](docs/security.md) | Presets, entity access control, field redaction |
| [Security Hardening](docs/security-hardening.md) | Optional transport, identity, and secrets controls |
| [Verification](docs/verification.md) | Prove a secure install: static + live checks, negative probes, evidence artefact, managed residuals |
| [Threat Model](docs/threat-model.md) | Trust boundaries, threats & mitigations, residual risks, and the security-pass results |
| [Deployment](docs/deployment.md) | Run the HTTPS transport in production: Docker, systemd, launchd, reverse proxy, pre-exposure checklist |
| [Integration Contract](docs/integration-contract.md) | The connector ↔ Drupal-governance contract (identity, OAuth scopes, compatibility) |
| [Versioning & Stability](docs/versioning.md) | Semver policy: the stable surface, deprecation process, MCP protocol + Node support |
| [Whitepaper](docs/whitepaper.md) | Vision, personas, and use cases |

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md). Please do not open a public issue.

## License

[MIT](LICENSE) © 2026 Jeremy Michael Cerda and [Wilkes & Liberty, LLC](https://github.com/Wilkes-Liberty)
