# drupal-mcp-connector

> A secure, multi-site Model Context Protocol (MCP) connector for Drupal — dual-protocol JSON:API and GraphQL access, governed content tools, audit reports, and an SSH Drush bridge.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![Drupal](https://img.shields.io/badge/drupal-10%20%7C%2011-blue)](https://drupal.org)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-purple)](https://modelcontextprotocol.io)

Built by **Jeremy Michael Cerda** (opensource@wilkesliberty.com). Maintained by [Wilkes & Liberty, LLC](https://github.com/Wilkes-Liberty).

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
- **Capability-aware.** Each backend advertises what it supports (read, write, delete, server-side filter/sort, revisions). GraphQL via GraphQL Compose is **read-only** (no mutations) and has no server-side field filter, so filters are applied client-side over a bounded fetch and flagged `approximate`/`truncated`. Write tools against a read-only backend return a clear capability error rather than failing silently.
- **Writes go through JSON:API.** Use a JSON:API-enabled site as the write plane; keep GraphQL as a read plane where that suits your architecture.

See **[docs/architecture.md](docs/architecture.md)** for the backend abstraction and **[docs/graphql-local-setup.md](docs/graphql-local-setup.md)** for the GraphQL specifics.

---

## Features

### 93 Tools Across 21 Modules

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
| **Paragraphs** | Create/get Paragraph components for embedding in host fields |
| **Structure** | Menu links + custom blocks (list/create) |
| **Redirects** | Create active URL redirects (301/302) + update/repoint existing redirects (Redirect module) |
| **Search** | Best-effort content search (title match; Search API/Solr-ready) |
| **Reports (extra)** | Orphaned references, unpublished content, missing-field audits |
| **Config & Governance** | Governed config get/list/set via the server-tool bridge; `drupal_mcp_whoami` tier/capability report |

**Preview writes with `dryRun`.** The node and entity create/update/delete tools accept an optional `dryRun: true` flag that validates the request and returns a preview of exactly what would be written — without committing anything to Drupal.

### MCP Resources
Browsable, always-fresh context the client can read without calling a tool:
- **`drupal://sites`** — configured site profiles (no credentials)
- **`drupal://{site}/content-types`** — content types with field schemas
- **`drupal://{site}/security-policy`** — the active security configuration

### MCP Prompts
Workflow templates usable as slash-commands from any MCP client:
- `drupal-content-audit` — walk through a full site content audit
- `drupal-create-article` — guided article creation with all fields
- `drupal-seo-fix` — find and fix SEO gaps
- `drupal-user-cleanup` — identify and handle inactive accounts

### Security Model
Defense-in-depth with four one-line presets, enforced connector-side and complemented by Drupal-side governance:

```json
"security": { "preset": "auditor" }
```

| Preset | What it does |
|--------|-------------|
| `development` | Everything allowed — local development only |
| `content-editor` | Create/edit nodes, media, terms; no deletes; no user access |
| `auditor` | Read-only, all entity types, PII fields redacted |
| `production-strict` | Read-only, no user entities, broad PII redaction |

Presets layer with entity allow/deny lists, per-bundle operation rules, and field-level redaction. Optional transport hardening (bearer-authenticated HTTPS, bind-address restriction, secrets-from-env) is covered in **[docs/security-hardening.md](docs/security-hardening.md)**.

---

## Requirements

- **Node.js** 20+
- **Drupal** 10 or 11 (JSON:API ships in core)
- For the **GraphQL backend**: [GraphQL Compose](https://www.drupal.org/project/graphql_compose)
- For **token auth** (recommended): [Simple OAuth](https://www.drupal.org/project/simple_oauth)
- For the **Drush bridge**: SSH key access to the Drupal server

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Wilkes-Liberty/drupal-mcp-connector
cd drupal-mcp-connector
npm install

# 2. Configure
cp config/config.example.json config/config.json
# Edit config/config.json — add your site's baseUrl, api backend, and auth

# 3. Run (stdio transport)
node src/index.js
```

### Register with an MCP client

Most desktop and CLI MCP clients launch the connector over **stdio**. Add an entry to your client's MCP server configuration:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-mcp-connector/src/index.js"],
      "env": {
        "DRUPAL_BASE_URL": "https://mysite.com",
        "DRUPAL_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

For multi-client or remote use, run the HTTPS transport and register the endpoint instead — see **[docs/getting-started.md](docs/getting-started.md)**.

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

---

## Documentation

| Doc | Description |
|-----|-------------|
| [Getting Started](docs/getting-started.md) | Full setup: DDEV/Lando, Simple OAuth, multi-site, transports |
| [MCP Clients](docs/mcp-clients.md) | Wire the connector into Claude (Code/Desktop), Grok (Build/API), and OpenAI (Codex/ChatGPT) — copy-paste config per client |
| [OAuth client_credentials](docs/oauth-client-credentials.md) | Production OAuth deploy: scope→role mapping, JSON:API writes, config persistence, secret handling, troubleshooting |
| [Architecture](docs/architecture.md) | Backend abstraction, canonical model, and how to extend it |
| [GraphQL Setup](docs/graphql-local-setup.md) | GraphQL Compose backend + local TLS notes |
| [Tools Reference](docs/tools-reference.md) | Full reference for all 93 tools |
| [Security Guide](docs/security.md) | Presets, entity access control, field redaction |
| [Security Hardening](docs/security-hardening.md) | Optional transport, identity, and secrets controls |
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
