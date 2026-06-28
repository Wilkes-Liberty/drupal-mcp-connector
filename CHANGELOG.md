# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] - 2026-06-27

### Fixed
- The server-tool bridge client now performs the MCP Streamable-HTTP session handshake
  before calling governed config tools. It POSTs `initialize`, reads the `Mcp-Session-Id`
  response header, sends `notifications/initialized`, then issues `tools/call` carrying that
  session id — caching the session per site and re-initialising transparently on server-side
  expiry. Previously it POSTed a bare `tools/call` with no session, which Drupal's
  session-mandatory `mcp_server` rejected with `-32600` ("A valid session id is REQUIRED for
  non-initialize requests"), so `drupal_config_get` / `_list` / `_set` always failed. Responses
  are now parsed for both `application/json` and `text/event-stream` (SSE) transports, and the
  request advertises `MCP-Protocol-Version: 2025-06-18`. The existing 401 → token-refresh retry
  is preserved and layered with a single session re-init/replay.

## [1.3.0] - 2026-06-27

### Fixed
- `drupal_mcp_whoami` no longer over-reports configuration capabilities. Capabilities are
  now the intersection of the connector security preset **and** the token's effective OAuth
  scopes: `configRead` / `configWrite` require the dedicated `mcp_config` scope (config-editor
  / Developer tier), and `write` / `delete` require `mcp_write`. Previously a content-tier
  token (`mcp_read` / `mcp_write`) was reported with `configRead: true` even though the server
  denies every `config_*` tool without `mcp_config`. When a site declares no OAuth scopes,
  behaviour is unchanged (preset-only).

### Changed
- The config tools (`config_get` / `config_list` / `config_set`) now check for the
  `mcp_config` scope up front (when OAuth scopes are configured) and fail fast with a clear
  message instead of dispatching a call the governed server will deny — keeping connector
  behaviour consistent with `drupal_mcp_whoami`. Aligns with mcp_sentinel isolating the config
  tools under the dedicated `mcp_config` scope.

## [1.2.0] - 2026-06-27

### Changed
- Widened the content/developer security presets so the connector supports full content
  building and management. `content-editor` and `write-plane` now allow `paragraph`,
  `block_content`, `menu_link_content`, `redirect`, `path_alias`, and `file` in addition
  to `node`/`taxonomy_term`/`media`. `config-editor` (developer tier) additionally allows
  the site-building config entities (`node_type`, `paragraphs_type`, `block_content_type`,
  `media_type`, `field_config`, `field_storage_config`, `entity_form_display`,
  `entity_view_display`, `taxonomy_vocabulary`) for read/introspection — content-model
  changes go through the governed config bridge / `drush config:import`, not JSON:API
  entity create.
- Corrected the server-tool bridge tool names: `mcp_server_tool_bridge` exposes Tool-API
  tools as `tool_api.<id>`, so the governed config tools are
  `tool_api.mcp_sentinel_config_get` / `_list` / `_set` (previously documented as bare
  `config_get` / `_list` / `_set`, which never resolved). Updated `SERVER_TOOLS` and
  `docs/integration-contract.md` accordingly. These tools must be registered as enabled
  `mcp_tool_config` entities on the Drupal site; they are not exposed by default.

### Security
- Deny-hardened the content/developer presets: `oauth2_token`, `key`, `consumer`,
  `encryption_profile`, `mcp_tool_config`, and `mcp_policy_profile` are now in
  `deniedEntityTypes` alongside `user`, so secrets, the agent's own governance config,
  and account data stay blocked even if an allowlist is later widened. PII-bearing
  `webform_submission` and `profile` are intentionally left off the allowlists.

## [1.1.1] - 2026-06-26

### Fixed
- Docs: corrected stale tool/module counts (89→93, 20→21) and the example startup
  banner version (v1.0.0→v1.1.0) in `architecture.md`, `getting-started.md`,
  `whitepaper.md`, and `tools-reference.md` after the 1.1.0 release.

## [1.1.0] - 2026-06-26

### Security
- Bump transitive `hono` 4.12.23 → 4.12.27 (via `@modelcontextprotocol/sdk`), clearing
  5 advisories (1 high, 4 moderate): GHSA-88fw-hqm2-52qc (CORS wildcard-with-credentials),
  GHSA-wwfh-h76j-fc44 (serve-static path traversal), GHSA-j6c9-x7qj-28xf, GHSA-rv63-4mwf-qqc2,
  GHSA-wgpf-jwqj-8h8p. Lockfile-only; the SDK's `^4.11.4` range already permits the fix.
  `npm audit` clean.

### Added
- Environment-keyed governance tiers. The `config/config.example.json` template now
  models four least-privilege tiers — `prod`/`staging` (content), `dev` (developer),
  `dev-admin` (admin/break-glass) — each pinned by OAuth scopes and a security preset.
- New `config-editor` security preset (Developer tier): content-editor capabilities plus
  governed config read/write. All presets gained `allowConfigRead` / `allowConfigWrite`
  caps (mirroring the server-side governance profile), with `assertConfigReadAllowed` /
  `assertConfigWriteAllowed` gates. Caps are surfaced by `drupal_security_info`.
- Governed configuration tools: `drupal_config_get`, `drupal_config_list`,
  `drupal_config_set`. These call Drupal's authoritative server-side MCP config tools via a
  new JSON-RPC bridge (`src/lib/server-tools.js`, per-site `serverTools.url`) — not drush —
  and are gated by the new config caps as a defence-in-depth second layer.
- `drupal_mcp_whoami` — reports the agent's effective tier, preset, OAuth scopes, and
  capabilities (read/write/delete/config/publish) for a site, so permitted actions are
  visible up front. Publishing is always reported as server-gated.
- Per-site `drushSsh.allowedCommands` allowlist. When set, only those Drush subcommands
  may run on that site; the example `dev` site is pinned to `config:export` /
  `config:status`, and prod/staging carry no `drushSsh` block at all.
- CI: Slack release notification (`.github/workflows/release-notify.yml`) — posts to the
  maintainers' release channel on release tags; no-ops without the `SLACK_WEBHOOK_RELEASES` secret.
- `bin/drupal-mcp-launch.sh` — launcher script for starting the connector
  (secret-manager-friendly local launch).

### Removed
- `.playwright-mcp/` page snapshots — throwaway browser-automation captures
  that were committed by mistake; the directory is now gitignored.

### Changed
- CI: the CHANGELOG check now exempts Dependabot PRs automatically (author
  `dependabot[bot]`), so dependency bumps no longer need a changelog entry or the
  `no-changelog` label.
- CI: made the Dependabot auto-merge workflow self-contained instead of calling
  the private `Wilkes-Liberty/.github` reusable workflow. A public repo cannot use
  a private reusable workflow, so the previous version startup-failed and
  Dependabot PRs never auto-merged. Removed the dead `changelog-autoupdate.yml`
  (also a private-reusable caller that needs an org GitHub App).

### Fixed
- JSON:API filter values are now DB-portable, fixing report-tool 500s on
  PostgreSQL-backed sites. Boolean filters (e.g. `status`) serialized as
  `'true'`/`'false'` were rejected by Postgres' `smallint` columns ("invalid
  input syntax for type smallint"); they are now `1`/`0`.
  `drupal_report_stale_content` filtered the integer `changed` timestamp with an
  ISO-8601 string (same class of error); it now uses epoch seconds. MySQL coerced
  both, which masked the bug. (#71)
- `drupal_report_user_activity` now surfaces a top-level `approximate` flag when
  any of its account counts hit the backend's safety ceiling — matching
  `drupal_report_content_summary` and `drupal_report_taxonomy_usage`. Previously a
  capped count (e.g. 1000 users) was presented as exact. (#75)
- JSON:API `countEntities` now returns the **exact** total by paginating through
  `links.next`, instead of trusting `meta.count` — which Drupal core JSON:API does
  not provide. Previously every report count collapsed to the requested page size
  (e.g. `1` per non-empty content type), reported as exact. Counts beyond a safety
  ceiling (1000 records) are returned and flagged `approximate`. Fixes the
  undercount in `drupal_report_content_summary`, `drupal_report_taxonomy_usage`,
  and `drupal_report_user_activity`. (#73)

## [1.0.0] - 2026-06-15

First stable release. The tool surface, security model, and configuration
schema are now considered stable and will follow semantic versioning.

### Added
- Stable **1.0** milestone: 89 tools across 20 modules with full read +
  governed-write coverage (node/entity CRUD, revisions, moderation, scheduler,
  fields, references, bulk operations, translations, paragraphs, structure,
  search, and reports), `dryRun` preview on every write tool, the JSON:API and
  GraphQL backends, the `write-plane` security preset, and multi-client launch
  support (Claude Code, Claude Desktop, Grok Build).

### Changed
- No functional changes since 0.10.0 — this release promotes the 0.10.x feature
  set to a stable 1.0 line.

## [0.10.0] - 2026-06-15

### Added
- **`dryRun` option** on the node + generic-entity write tools (`drupal_create_node`,
  `drupal_update_node`, `drupal_delete_node`, `drupal_entity_create`,
  `drupal_entity_update`, `drupal_entity_delete`) (#42). When `true`, the tool runs
  the security checks and builds the final payload, then returns a preview
  (`{ dryRun: true, operation, entityType, bundle, id?, attributes }`) **without
  writing** — no backend call is made. Lets an agent confirm intent safely.
- **23 new tools across 11 modules** (66 → 89 tools), toward 1.0 feature coverage:
  - **Revisions** (#37): `drupal_list_revisions`, `drupal_get_revision`, `drupal_revert_revision` (governed revert; JSON:API addresses revisions by id / latest-version / working-copy — full history enumeration needs the Drush bridge).
  - **Moderation** (#38): `drupal_set_moderation_state`, `drupal_content_by_moderation_state`, `drupal_list_moderation_states` (content_moderation).
  - **Scheduler** (#39): `drupal_schedule_publish` (publish_on / unpublish_on).
  - **Fields** (#40): `drupal_describe_fields` (bundle field schema; best-effort, Drush-enhanced).
  - **References** (#41): `drupal_resolve_reference` (name/title → UUID).
  - **Bulk** (#43): `drupal_bulk_create`, `drupal_bulk_update` (per-item partial-failure reporting).
  - **Translations** (#45): `drupal_list_translations`, `drupal_create_translation`.
  - **Paragraphs** (#44): `drupal_create_paragraph`, `drupal_get_paragraph`.
  - **Structure** (#46): `drupal_list_menu_links`, `drupal_create_menu_link`, `drupal_list_blocks`, `drupal_create_block`.
  - **Search** (#47): `drupal_search` (best-effort title match; Search API/Solr-ready).
  - **Reports (extra)** (#48): `drupal_report_orphaned_references`, `drupal_report_unpublished`, `drupal_report_missing_field`.
  - All reads are policy-redacted; all writes assert the security policy. New write verbs (`bulk_`/`revert_`/`schedule_`/`set_`) added to the middleware write-gating prefixes.

## [0.9.1] - 2026-06-15

### Security
- Validate and URL-encode JSON:API path segments. The entity `id` is now checked
  with `validateUuid` and `entityType`/`bundle` with `validateMachineName` (both
  previously unused), and every segment is `encodeURIComponent`'d. This closes a
  path-traversal vector where a crafted `id` (e.g. `../../user/user/<uuid>`) could
  reach a different resource type and bypass the connector's entity-type/PII
  policy. (Drupal core permissions were always still enforced.)

### Added
- A [Threat Model](docs/threat-model.md) documenting trust boundaries, threats &
  mitigations, residual risks (drush SQL bridge; why filter-field names are not
  machine-name-validated), and the 1.0 security-pass results (`npm audit` clean,
  adversarial review).

## [0.9.0] - 2026-06-15

### Added
- Docs: an [MCP client setup guide](docs/mcp-clients.md) with copy-paste config
  **and per-platform management commands** for Claude (Code `claude mcp …` /
  Desktop), Grok (Build `grok mcp …` + API Remote MCP Tools), and OpenAI (Codex
  `codex mcp …` + ChatGPT/Responses API), plus generic stdio and remote-HTTP
  patterns and the local-vs-remote reachability/secret tradeoffs.
- Test coverage for the Streamable-HTTP transport's request routing (bearer-auth
  gate, session open/reuse, `/health`, 404) via an extracted, unit-tested
  `http-handler` module.
- Regression tests confirming **non-content-moderation Drupal sites are
  unaffected** by the moderation fallback: a plain create sends `status` and
  succeeds on the first request with no retry (the fallback only engages on the
  specific moderated-entity 403).
- Optional built-in **rate limiting** for the HTTPS transport: set
  `MCP_RATE_LIMIT` (per-IP requests per window) and `MCP_RATE_WINDOW_SEC`
  (default 60). Over-limit `/mcp` requests get `429` + `Retry-After`; the check
  runs before auth (throttling brute force) and never limits `/health`. Off by
  default. (#4)
- Reference deployment for the HTTPS transport: a `Dockerfile` (+ `.dockerignore`),
  systemd unit, launchd plist + launcher, a Caddy reverse-proxy example, and a
  [Deployment guide](docs/deployment.md) with a pre-exposure checklist.
- [Versioning & Stability policy](docs/versioning.md) defining the stable public
  surface (tool names/inputs, resource/prompt URIs, config + env vars, transports,
  presets), the deprecation process, MCP-protocol negotiation behavior, and Node
  support — the contract that 1.0 will lock.

### Changed
- Refactor: the HTTP transport's request handler is extracted from `index.js`
  into `src/lib/http-handler.js` (no behavior change), making the routing/auth
  path unit-testable and ready for additional middleware (e.g. rate limiting).

## [0.8.0] - 2026-06-15

### Added
- Docs: an OAuth2 `client_credentials` deployment guide
  (`docs/oauth-client-credentials.md`) covering scope→role mapping, JSON:API
  write enablement, config persistence across deploys, and secret handling, plus
  a reusable `examples/launch-with-secret.sh` secret-manager launcher. Linked
  from the README and getting-started.
- `drupal_create_node` and `drupal_update_node` accept a `moderationState`
  argument (e.g. `"draft"`/`"published"`) for content types under a
  content_moderation workflow. When set, `moderation_state` is sent and `status`
  is omitted (moderated entities own their published state).
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

### Fixed
- Create/update no longer fail on content_moderation bundles. The JSON:API
  backend now transparently retries a write without the `status` attribute when
  Drupal rejects it as a moderated entity's published field (HTTP 403), so the
  safe default `status:false` works on moderated types (Drupal applies the
  workflow's default state). Affects all entity create/update paths (nodes,
  entities, media), not just nodes. (#23)
- Docs: replaced a personal email with the `opensource@wilkesliberty.com` role
  address (README, `package.json`); corrected whitepaper tool counts (Drush
  ~10→15, Nodes ~12→6).

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

[1.0.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v1.0.0
[0.10.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.10.0
[0.9.1]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.9.1
[0.9.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.9.0
[0.8.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.8.0
[0.7.1]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.7.1
[0.7.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.7.0
[0.6.1]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.6.1
[0.6.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.6.0
[0.5.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.5.0
[0.4.0]: https://github.com/Wilkes-Liberty/drupal-mcp-connector/releases/tag/v0.4.0
