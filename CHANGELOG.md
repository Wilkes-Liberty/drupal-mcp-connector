# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-06-01

The connector is now **dual-protocol**: every tool runs against an abstract backend
(JSON:API or GraphQL), selectable per site, with one canonical entity shape across both.

### Added
- **Dual-protocol backend layer.** A per-site `api` selector (`"jsonapi"`, `"graphql"`,
  or a priority array; omit to auto-detect) routes every tool through `resolveBackend`.
  JSON:API and GraphQL backends are interchangeable.
- **GraphQL backend** via [GraphQL Compose](https://www.drupal.org/project/graphql_compose):
  introspection-driven, type-aware field selection (`DateTime`/`Language`/`TextSummary`
  scalar wrappers, entity-reference unions), native sort for `created`/`changed`/`title`,
  and client-side filtering over a bounded fetch (results flagged `approximate`/`truncated`).
- **Canonical entity shape** (`{ id, entityType, bundle, title, status, langcode, created,
  changed, url, fields, relationships, _backend }`) produced by both backends.
- **Backend capability model** (`read`/`write`/`delete`/`count`/`filter`/`sort`/`revisions`).
  Writes against a read-only backend raise a clear `BackendCapabilityError`.
- **Security hardening (all optional, safe defaults):** `X-MCP-Client` identity header
  (override/disable via `MCP_CLIENT_ID`), bearer-authenticated HTTPS transport
  (`MCP_AUTH_TOKEN`), bind-address restriction (`MCP_BIND_HOST`), tokens-from-env per site
  (`apiTokenEnv`), and strict per-site auth enforcement (`requireSecureAuth`).
- **GraphQL mutation gate:** parser-based detection rejects any mutation when
  `allowGraphqlMutations` is off, regardless of where it appears in the document.

### Changed
- All 66 tools and 10 reports migrated to the backend layer and canonical output.
- HTTPS transport hardened: HTTPS mandatory, plain HTTP refused off-localhost unless
  `MCP_ALLOW_HTTP=1`; loopback-only bind without TLS; security headers on every response.
- Documentation rewritten for the dual-protocol model, canonical output, capability gating,
  and the optional hardening controls.

### Removed
- Bundled `drupal-module/` reference scaffold. Server-side governance now lives in the
  companion [MCP Sentinel](https://www.drupal.org/project/mcp_sentinel) module
  (`drupal/mcp_sentinel`), which supersedes it.

### Security
- Field-level PII redaction applied to canonical entities and JSON:API resources alike.
- User tools gained explicit PII-access assertions.
- Whole tree lint-clean (`npm run lint`) with object-injection sinks rewritten to safe lookups.

[0.4.0]: https://github.com/Wilkes-Liberty/drupal-mcp-server/releases/tag/v0.4.0
