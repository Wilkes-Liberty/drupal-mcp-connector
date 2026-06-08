# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CI: a `Changelog` workflow blocks any pull request that doesn't update
  `CHANGELOG.md`. Trivial PRs that genuinely need no entry can carry the
  `no-changelog` label to bypass the check.
- CI: a `dependabot.yml` enabling weekly version updates for npm (dev
  dependencies grouped) and GitHub Actions.
- CI: a `changelog-autoupdate` workflow (org reusable) that writes a CHANGELOG
  entry on Dependabot PRs and pushes it via a GitHub App token, so the required
  `CHANGELOG updated` check passes without manual edits. No-ops until the
  `CHANGELOG_APP_*` Dependabot secrets are configured.
- CI: Dependabot patch/minor PRs now auto-merge once checks pass (majors still
  reviewed), via the org reusable workflow.

### Changed
- CI: bumped `actions/checkout` and `actions/setup-node` to `v6` (Node 24
  runtime) ahead of GitHub's June 2026 deprecation of Node 20 actions.
- CI: added a `concurrency` group so superseded in-progress runs are cancelled,
  matching the sibling repos' CI hygiene.
- Dependency: bumped `graphql` 16.14.0 → 16.14.1 (patch).
- Dev dependencies: bumped `eslint` `^9`→`^10`, `eslint-plugin-security` `^3`→`^4`,
  `eslint-plugin-n` `^17`→`^18`, and `globals` `^15`→`^17` (Dependabot
  dev-dependencies group). Lint and the full test suite pass on the new majors.

## [0.7.1] - 2026-06-08

### Fixed
- The connector now reports its real version — sourced from `package.json` at
  runtime — in the MCP handshake, the `X-MCP-Client` identity header, and the
  startup logs. A hardcoded version literal had drifted and under-reported it
  (0.7.0 still announced itself as `0.6.0`).

### Documentation
- Corrected Node version references (18 → 20) in the README and getting-started
  guide to match `engines.node >=20.0.0`, and updated the example startup banner
  to the current version.
- Rewrote CONTRIBUTING.md: prerequisites, full dev-script list, a tests section,
  accurate PR/CI gates, and the PR-then-tag release flow for protected `master`.

### Changed
- Restored the column-aligned `package.json` `scripts` formatting that
  `npm version` re-flattened while cutting 0.7.0.

## [0.7.0] - 2026-06-08

### Added
- CI: lint/syntax/unit tests now run across a Node `20, 22` matrix so the
  advertised `engines.node >=20` floor is actually exercised.
- CI: `release.yml` publishes to npm on a `v*` tag via **trusted publishing**
  (GitHub Actions OIDC — no token/secret), gated on a tag↔`package.json` version
  match. Provenance is attached automatically. One-time trusted-publisher setup
  on npmjs.com (see CONTRIBUTING.md → Releasing).
- Branch protection on `master`: merges require a pull request with passing CI
  (lint, unit tests on Node 20/22, Drupal integration, CodeQL) and resolved
  review conversations; force-pushes and branch deletion are blocked.

### Fixed
- CI now runs on the `master` default branch. The workflow had been configured
  for a nonexistent `main` branch, so lint/syntax/unit and integration never
  executed on pushes or PRs.

### Removed
- **BREAKING:** dropped support for Node 18 (`engines.node` is now `>=20.0.0`).
  Node 18 reached end-of-life in April 2025, and the vitest 4 dev toolchain
  requires Node >=20.

### Changed
- Dev dependency: bumped `vitest` `^2.1.0` → `^4.1.8`, resolving three Dependabot
  alerts in the test toolchain (vitest UI file read/execute — critical; vite path
  traversal and esbuild dev-server exposure — moderate). All are devDependencies
  and do not ship to consumers.

## [0.6.1] - 2026-06-04

First release published to npm.

### Fixed
- HTTPS transport: import `randomUUID` from `node:crypto` for session IDs instead of
  relying on the bare `crypto` global, which is not available unflagged on Node 18
  (the minimum supported version).

### Changed
- Comprehensive inline-documentation pass (JSDoc on all exported functions/classes,
  canonical descriptor/entity typedefs) and a Node coding-standards audit across `src/`.

## [0.6.0] - 2026-06-03

### Changed
- Renamed the package to `drupal-mcp-connector` — clearer that it is the MCP↔Drupal connector, and avoids confusion with the Drupal `mcp_server` module. The outbound identity header is now `X-MCP-Client: drupal-mcp-connector/<version>`.
- Prepared for npm publication (`bin`, `files`, `keywords`).

## [0.5.0] - 2026-06-03

### Added
- **OAuth2 write-plane authentication.** Per-site `oauth` block enabling the
  `client_credentials` grant against Drupal `simple_oauth`: token acquisition,
  in-memory per-site caching with silent re-acquire (60s expiry skew), refresh-token
  grant with fallback to `client_credentials`, concurrent-acquire de-duplication, and
  a one-shot token clear + retry on `401`. The client secret is sourced from an
  environment variable (`oauth.clientSecretEnv`) and is never stored in config or
  surfaced in errors.
- **`write-plane` security preset** mirroring the recommended server-side governance
  profile: writes enabled, no deletes, no GraphQL mutations, entity access limited to
  `node`/`taxonomy_term`/`media`, `user` entities denied, `pass`/`mail` redacted.

### Changed
- The three fetch helpers resolve auth via an async path so OAuth sites attach a
  freshly-managed Bearer token; static token / Basic-auth sites are unchanged.
- `requireSecureAuth` now accepts a valid `oauth` block as satisfying the Bearer
  requirement.

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

[0.7.1]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.7.1
[0.7.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.7.0
[0.6.1]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.6.1
[0.6.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.6.0
[0.5.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.5.0
[0.4.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.4.0
