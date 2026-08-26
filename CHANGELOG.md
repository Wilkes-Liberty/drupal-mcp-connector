# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Provider-neutral adapter contracts and a Drupal conformance kit (#181).**
  Versioned evaluator, relay, approval, evidence-sink, and system-of-record
  contracts live at `src/lib/contracts/` (contract 1.0). Typed decisions
  (`deny` / `allow` / `allow_with_obligations` / `require_approval`), stable
  reason codes, obligations, and execution receipts are verified at that
  seam. Final target-side denial stays authoritative: an upstream allow
  cannot widen local policy. Model and agent vendors are outside the
  contract. The Drupal adapter is the only system-of-record implementation;
  JSON:API and GraphQL remain transport adapters. The offline conformance
  kit covers allowed and denied actions, hostile input, tenant escape,
  required-evidence write failure, replay, and post-condition discrepancy.
  See [docs/adapter-contracts.md](docs/adapter-contracts.md).

## [2.8.0] - 2026-08-25

### Fixed
- **Iterative updates PATCH an existing working copy (#166).**
  `drupal_update_node`, `drupal_entity_update`, and `drupal_bulk_update`
  resolve `rel:working-copy` before the write. When that alias is
  addressable, both the dryRun probe and the real PATCH use
  `?resourceVersion=rel:working-copy` instead of the canonical URL, so a
  second edit lands on the same forward revision. dryRun can no longer
  succeed when that write would 400. An addressable draft is edited in
  place — the connector does not discard it or tell the caller to publish
  first. The stray-revision case (alias does not resolve, core still
  blocks) still refuses with revision-surgery language (#201). A stale or
  concurrent working-copy 400 is refused without retrying the canonical
  URL. Successful writes include `_revisions: { live, working }` when both
  vids can be read.
- **`summary` is refused when body has no summary property (#163).**
  `drupal_create_node` and `drupal_update_node` introspect the sampled body
  field before writing `summary`. A `text_long` / `text_formatted` body (or
  an undetermined schema) fails closed with an actionable message to set the
  site's deck field via `fields`. Core `text_with_summary` still accepts
  `summary` and returns `_warnings` with `summary_parameter_deprecated`.
  dryRun uses the same check.
- **Node writes honor field `allowed_formats` (#168).** Create/update (including
  `dryRun`) resolve Field API `allowed_formats` from JSON:API `field_config`
  and, when that is unavailable, Drush `config:get`. A single allowed format
  is the default when the caller omits `format`. A caller format outside the
  list is refused before mutation. The historical `defaultTextFormat` /
  `full_html` fallback applies only while the list cannot be resolved — never
  when `full_html` is excluded by field config.

### Added
- **Northbound data-flow budgets bind to principal and target (#179).** Every
  governed tool call that resolves a site now carries request-scoped principal
  and authoritative-target context. Row, byte, page, request, and chained-action
  counters use the same finite defaults as mcp_sentinel (500 results / 8 MiB /
  600 req/60s / 120 pages/60s) and are keyed by inbound principal + target —
  not by MCP session — so pagination, retries, batching, and a new chain id
  cannot reset them. JSON:API, GraphQL, and the server-tool bridge send the
  source wire contract (`X-MCP-Declared-Ceiling`, narrow-only;
  `X-MCP-Declared-Destination` from the entitlement pair). Denials name a
  stable reason plus a correlation id and do not echo restricted payload.
  Optional `security.declaredCeiling` and `security.readBudgets` override the
  defaults. Stdio / local-operator traffic still sends the declared headers;
  connector-side counters enforce when an inbound OAuth principal is present.

### Changed
- **Slash-command stubs moved to `.agents/commands/` (#218).** Generated
  `/drupal-*` files are harness-agnostic (protocol tool names, no
  `mcp__drupal__*` `allowed-tools`). `.claude/` is no longer tracked or
  published. `npm run install:commands` copies stubs into operator home
  directories (`~/.claude/commands` with the Claude Code adapter,
  `~/.grok/commands` as-is) so the bare `/drupal-*` form still works
  without a vendor folder in this repo or in a consuming project. The npm
  `files` list now ships `.agents/commands/` instead of `.claude/commands/`.

## [2.7.4] - 2026-08-18

### Fixed
- **`drupal_content_by_moderation_state` no longer 500s on stock JSON:API
  (#162).** `moderation_state` is a computed field and is not filterable
  over core JSON:API. The tool still tries the server-side filter (so a
  jsonapi_extras alias keeps working), and when Drupal rejects it the
  connector samples recent nodes and filters client-side. The payload
  reports `source: "sampled"` and `approximate` instead of a raw Drupal
  500. If the field is not exposed at all, the result is a gated
  `unavailable` payload.
- **Every tool response names the resolved site (#167).** Omitting `site`
  still defaults to `defaultSite`, but the payload now carries
  `_target: { name, baseUrl, source }` — the same block `drupal_mcp_whoami`
  already returned as `target`. `source` is `hint` when the caller named a
  site, `default` when the configured default was used, or `grant` when a
  principal had exactly one entitled site. A list_nodes-shaped success with
  only `_backend` is no longer claimable as production. Writes (including
  GraphQL mutations and generic `drupal_entity_*` writes) refuse a silent
  default when more than one site is configured; a write on the wrong site
  is not recoverable. Single-site configs are unchanged. Array-shaped
  results are wrapped as `{ items, _target }` so the field survives
  `JSON.stringify`.

## [2.7.3] - 2026-08-18

### Fixed
- **Launcher and startup name a secret-table / config mismatch (#211).**
  The shipped Keychain table matches `config/config.example.json`. A
  `config.json` that uses different `clientSecretEnv` names without a
  `config/secrets.map` left the table and the config each valid and
  jointly inert. Per-item Keychain misses stay silent (break-glass).
  When the table matches **no** named secret, `bin/drupal-mcp-launch.sh`
  and `src/lib/load-secrets.js` now print one stderr line that names
  the unmapped variables and says `secrets.map` is absent (or that the
  map does not name them). Fail-closed start when every named secret is
  unset is unchanged.

## [2.7.2] - 2026-08-18

### Fixed
- **Orphan-reference report no longer treats 403 / policy denial as a missing
  target (#205).** `drupal_report_orphaned_references` used to count any
  non-OK probe as an orphan. On a site whose policy denies `user`, every
  `uid` / `revision_uid` became a false finding — 64 "orphans" across 32
  healthy nodes in the report that produced this issue. Only a 404 (or an
  unaddressable ref) is an orphan. Denied targets are a third state:
  `unverifiable` plus `reason: "target entity type denied by policy"`.
  Author base fields are skipped when the policy denies `user`, so the
  auditor presets stop manufacturing corruption.
- **PATCH-blocked message names a pending draft when one is visible
  (#201 follow-up).** The preflight added in 2.7.1 always said the blocking
  row was invisible and needed revision surgery. That is right for a stray
  revision with no content_moderation working copy, and wrong for an
  ordinary open draft — the common case, and the dangerous advice. The
  preflight now loads `rel:working-copy`: if it resolves, the error is
  "This node has a pending draft (vid N). Publish or discard it before a
  canonical PATCH." Surgery is mentioned only when the working copy does
  not resolve and the guard still fires.
- **`drupal_governance_status` no longer reports `ok: true` without a
  check (#208).** When the client did not set `requireGovernance`, the
  diagnostic skipped the readiness probe and returned
  `{ required: false, ok: true, checkedAt: null }` while the same site
  503'd every governed request with `designated_consumer_disabled`. It
  now always probes `GET /drupal-mcp/readiness`, sets `checked: true` and
  `checkedAt`, and surfaces the server's reason verbatim. `ok: true` only
  after that check. Unresolved site configs report `checked: false` and
  omit `checkedAt`.

## [2.7.1] - 2026-08-18

### Fixed
- **Paragraph ERR attach sends `meta.target_revision_id` (#192).** JSON:API
  only persists an Entity Reference Revisions item when the resource
  identifier carries the current revision id. The connector used to send
  `{ type, id }` and document that Drupal would fill in the vid — Drupal
  does not, and the field is saved empty. Host writes
  (`drupal_update_node`, `drupal_entity_update`, bulk update) now resolve
  each paragraph identifier (preferring a vid from the create response)
  and fail the whole write if any ref cannot be resolved. Create/update/get
  paragraph tools return `relationshipData` / `ref` with that meta key, and
  paragraph reads surface `drupal_internal__revision_id`. An empty array is
  still an explicit clear.
- **Write responses no longer treat the canonical re-read as proof a
  relationship landed (#169).** When relationships were sent, the returned
  body is the `rel:working-copy` revision when addressable, otherwise the
  PATCH body plus `_revision.relationshipsUnverified`.
- **PATCH preflight for the core working-copy guard (#201).**
  `drupal_list_revisions` reports `possiblyPatchBlocked` when the default
  revision's `changed` is later than its `revision_timestamp`, and never
  treats `workingCopy: null` as an all-clear. `drupal_update_node` /
  `drupal_entity_update` (and their `dryRun`) probe the same canonical
  URL before the real write. The probe PATCH uses a non-matching `data.id`
  so core's working-copy guard still runs and `$entity->save()` does not
  (an empty-body 2xx would have written a revision). A core working-copy
  400 is rewritten to say the stored entity is not the latest revision,
  the JSON:API aliases cannot show the blocking row, and clearing it is
  revision surgery outside JSON:API (Drush / the entity API). Preflight
  on the host write does not un-orphan paragraphs already created — probe
  the host (`possiblyPatchBlocked`, then `dryRun`) *before*
  `drupal_create_paragraph`.

## [2.7.0] - 2026-08-17

### Security
- **Discovery and invocation follow the inbound principal (#178).** On
  HTTPS resource-server requests the validated JWT — not caller `site`,
  `environment`, `tenant`, `target`, or `scope` arguments — decides which
  tools, resources, prompts, and sites are visible or callable. Empty
  inbound scopes are no grants. `auth.grants` maps a client id to site
  names; a present map is fail-closed for unknown clients. GraphQL and
  raw SQL stay hidden unless an entitled site's preset actually allows
  them. Stdio and loopback without a resource-server identity keep the
  existing local-operator surface. `drupal_list_sites` now also returns
  `targets` with the authoritative name and base URL.
- **Network-facing HTTPS is an OAuth protected resource (#177).** `/mcp`
  validates inbound JWTs against a configured issuer (RFC 8414 / OIDC
  discovery + JWKS): issuer, audience/resource, expiry and required scopes.
  RFC 9728 metadata is served at `/.well-known/oauth-protected-resource`.
  A revocation file (`jti` / `sub`) is re-read when it changes, so a revoke
  does not require a restart. Optional RFC 7662 introspection is fail-closed
  when configured. Discovery requires the metadata `issuer` to match the
  configured identifier (RFC 8414 §3.3), uses the RFC 8414 well-known path
  for issuers that have a path component, and refuses HTTP issuers,
  `jwks_uri`s, and introspection URLs. Trailing slashes on the issuer
  identifier do not break JWT verification. RFC 9728 `authorization_servers`
  advertises the issuer string returned by discovery. A thrown authenticator, a corrupt revocation file, or a
  failed introspection returns `401` instead of hanging the request.
  Caller-supplied identity headers never become the principal. The inbound
  access token is never forwarded to Drupal. `MCP_AUTH_TOKEN` remains valid
  only on loopback; a network-facing bind that still relies on the shared
  secret refuses to start.

### Changed
- **Versioning policy states the post-1.0 guarantees it actually operates under
  (#195).** `docs/versioning.md` still opened with a pre-1.0 section explaining
  that minor releases might break the stable surface because the project was on
  `0.x`, and pointed at a closed tracking issue. The package has been past 1.0
  for some time, so the document told operators the compatibility guarantees
  were not yet in force when they were. The stable-surface list, deprecation
  policy and runtime support were already correct and are unchanged.

### Fixed
- **Whitepaper no longer calls the companion governance module pre-1.0/alpha
  (#195).** `docs/whitepaper.md` described `drupal/mcp_sentinel` as alpha and
  requiring Drupal `^10.3 || ^11`. It is a shipping module at 2.9.0 with a floor
  of `^10.6 || ^11.3` on PHP 8.3 or newer — the stale constraint would have sent
  a reader to install it on a combination it does not support.

## [2.6.1] - 2026-08-17

### Fixed
- **A process no longer starts when every secret named by the active config
  is unset (#199).** After 2.6.0, a client that spawned `node src/index.js`
  (skipping the launcher) or whose `config.json` still used older
  `clientSecretEnv` names could start with zero resolved sites and advertise
  only `drupal_list_sites` and `drupal_governance_status`. The diagnostic
  then told the operator to provide an oauth block that was already there.
  2.6.1 loads `config/secrets.map` (or the shipped example table) inside
  `node`; names the unset variable; classifies
  `drupal_governance_status` failures; and **refuses to start** when every
  named secret is missing. On 2.6.0 the same recovery is: launch via
  `bin/drupal-mcp-launch.sh` with a `config/secrets.map`
  (`ENV_VAR=keychain-item`), then restart the MCP client.

## [2.6.0] - 2026-08-15

### Added
- **Secure-install verifier (`npm run verify`, #180).** Produces evidence that
  an installation carries the secure, tenant-neutral defaults the governed
  product claims, instead of asserting it in a README. The static half needs no
  network or credentials and runs in CI: transport, principal authentication,
  scope grant, source governance, role separation, entitlement, target
  resolution and tenant neutrality. The live half (`--live --site <name>`)
  proves the same claims against a running target and adds three **negative
  probes** — a mass read, a configuration change and a live-content edit — that
  pass only when the target refuses them (a mass read that is *bounded* rather
  than refused also passes; a cap is the control working). The config probe
  goes through the connector's own bridge client, so it exercises the real MCP
  session and governed tool contract, and is skipped for a principal that
  legitimately holds `mcp_config`. A thrown bridge error is classified before
  it is scored: a tool refusal, a server-defined JSON-RPC error or a 401/403
  is a decision and passes; a missing bridge, a session failure, a network
  error or a malformed-call error never reached policy and is skipped. The
  content probe takes an explicit `--content-target` and counts only a 403/401
  as a refusal — a 404 means the publish gate was never reached, not that it
  held. `--json` prints an evidence document
  (connector version, redacted config digest, per-check outcome, the source's
  own refusal codes) for a release record. A check that cannot run reports
  `skipped` and fails the run, while a check that does not *apply* to this
  shape of install (no OAuth, no tool bridge, an in-tier principal) reports
  `n/a` and does not — a verifier a secure install can never pass is one people
  stop running. Nothing secret ever reaches the output. See
  `docs/verification.md`.
- **Prompt injection and operator trust documented as managed residuals**
  (`docs/threat-model.md`, `docs/verification.md`) and emitted with every
  evidence document — the stack bounds the blast radius, it does not solve
  them (#180).

### Changed
- **The shipped example configuration is tenant-neutral and secure by default**
  (#180). Every hostname is documentation-reserved (RFC 2606/6761); the four
  tiers are named as roles (production, staging, development, break-glass) and
  each carries **its own OAuth client id and its own secret env var** — the
  previous example shared one consumer and one development secret across tiers.
  Staging and development now declare `requireGovernance`, and the permissive
  `development` preset is confined to a loopback target. `bin/drupal-mcp-launch.sh`
  reads its env-var → Keychain-item mapping from a table (overridable per
  machine via `config/secrets.map`) instead of hardcoding one estate's items.
  CI verifies the shipped example on every run.

### Security
- **The empty-scope bypass is closed for governed setups (#180).** An OAuth site
  that named no scopes previously satisfied *every* scope gate, including
  `mcp_config`: an empty list was read as "unconstrained". It is now read as an
  unnamed grant and satisfies nothing, so a governed site must name the scopes
  its token actually carries. A site with no OAuth block (a plain
  `apiTokenEnv`/anonymous install) is unaffected and stays preset-only.

## [2.5.0] - 2026-08-14

### Fixed
- **An unrequested published-state change is no longer silent (#171).**
  `status` stays strictly opt-in on updates — the connector never adds it to a
  PATCH — but a server-side gate can still flip it (an unmoderated-entity
  publish backstop, or a write landing as an unpublished forward revision).
  `drupal_entity_update`, `drupal_update_node`, and `drupal_update_media` now
  compare the written state against a pre-write read and, when the caller sent
  neither `status` nor an explicit moderation state, report a flip via a
  `_statusChanged` marker (`from`/`to` plus a verification note) instead of
  returning a clean success. The marker survives `returning: "minimal"`.
  Regression tests pin that relationships-only and field-only updates send
  neither `status` nor `moderation_state` across the entity, media, node, and
  bulk update tools.
- **Media tools route reference-shaped `fields` to relationships (#171).**
  `drupal_update_media` and `drupal_create_media` forwarded entity-reference
  values under `fields` as JSON:API attributes, which Drupal rejects with a 422
  ("relationship fields were provided as attributes"). Values in linkage shape
  (`{ data: { type, id } }`, an array of those, or `{ data: null }` to clear)
  are now sent as relationships, matching what `drupal_entity_update` accepts;
  composite attribute values (`{ value, format }` and friends) are untouched.
  The linkage-shape helpers live in `src/lib/canonical.js` for reuse.

## [2.4.1] - 2026-08-14

### Fixed
- **One unresolvable site no longer kills tool discovery (#187).** 2.4.0's
  discovery gate resolved every configured site eagerly, so a deliberately
  credential-less site — the inert break-glass tier keeps its Keychain item
  absent by design — threw `requireSecureAuth` during `tools/list` and took
  the whole tool surface down. Discovery now skips sites whose resolution
  throws; execution against such a site still surfaces its own descriptive
  error at call time, exactly as in 2.3.0.

## [2.4.0] - 2026-08-14

### Added

- **Source governance is now enforceable on every governed product path
  (#176).** A site with `requireGovernance: true` requires the Drupal
  source's governance contract to verify before any tool call runs against
  it: the connector probes `GET /drupal-mcp/readiness` as its own principal
  (mcp_sentinel ≥ 2.4.0), caches a passing verdict for 60 seconds, and
  re-proves it after that. A failed, stale, or unreachable verification
  denies tool discovery and execution with the source's own stable reason —
  it never falls back to a plain JSON:API or GraphQL path, on any backend or
  bridge. The new `drupal_governance_status` tool stays callable while
  governance is failing and reports which required condition failed, without
  credentials. Ungoverned sites are untouched.

### Changed

- The security middleware and tools/call dispatch moved from the entry point
  into `src/lib/dispatch.js` (side-effect-free, testable per backend); the
  entry point now only boots transports. Tool discovery accepts a per-request
  `list` hook so governance can gate what is discoverable.

## [2.3.0] - 2026-08-13

### Added

- **MCP 2026-07-28 transport support (#172).** HTTP and stdio now serve the
  current request-scoped protocol through the stable 2.0.0 server, Node, and
  client packages. Modern HTTP requests use a fresh server instance, expose
  `server/discover`, carry client metadata/capabilities in the request envelope,
  and do not create `Mcp-Session-Id` state.

### Changed

- **One `/mcp` URL now has explicit dual-era routing.** Auth and rate limiting
  run before a POST body is read once and bounded; the SDK classifier then sends
  that parsed body to exactly one arm. Current requests use the strict modern
  handler. 2025-era clients keep the existing sessionful handler by default and
  can be disabled with `MCP_LEGACY_TRANSPORT=reject`. stdio uses the same server
  factory and preserves both eras.
- **MCP SDK packages are migrated to stable v2.** Runtime dependencies are now
  `@modelcontextprotocol/server` and `@modelcontextprotocol/node` 2.0.0; the
  matching client package supplies integration evidence. Node.js 20+ remains
  the runtime floor.

### Security

- Unexpected request conversion, era classification, and handler failures no
  longer expose internal error messages. Before response headers they return a
  generic 500; after headers they terminate the response without a second write.
  Protocol/header/body disagreements continue to return the SDK's typed 400
  errors, and the outbound private-Drupal bridge remains pinned to its
  sessionful 2025-06-18 contract.

## [2.2.2] - 2026-08-12

### Security
- Bump `hono` to 4.13.1, `ip-address` to 10.5.0, and `fast-uri` to 3.1.5,
  closing eight npm advisories (GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh,
  GHSA-22jq-vg5j-6vgg, GHSA-7p8r-x3mc-p8w7, GHSA-8j4g-w8fx-2239,
  GHSA-f23p-vx2j-j53r, GHSA-79qm-7rj5-m7r9, GHSA-54fx-42gc-7vw4). Lockfile-only
  bumps within existing ranges; `npm audit` reports 0 vulnerabilities (#173).

### Changed

- **CI: the attribution check is now the shared workflow.**
  `.github/workflows/attribution.yml` becomes a thin caller pinned to
  `Wilkes-Liberty/shared-ci@v1`, and the vendored `.github/scripts/` copies are
  removed. One implementation for every repository makes copy drift structurally
  impossible instead of merely detectable.
- **CI: the changelog gate is required-by-default again.** The brief conversion
  to the org's opt-in model is reverted: this package's CHANGELOG ships as a
  published artifact, so an entry is the default and trivial PRs opt out with
  the `no-changelog` label. The conversion's hardening is kept — fixed-string
  match, checkout skipped on bypassed PRs, Dependabot exempt.

## [2.2.1] - 2026-08-02

### Fixed
- **The body text format is no longer hardcoded to `full_html`.** Node writes
  that used the `body` convenience parameter always sent `format: "full_html"`,
  so the connector could not write a body at all on a site whose text formats
  omit it — and on sites that do define it, content was silently written into
  the most permissive core format. Writes now resolve the format explicitly: a
  new per-call `format` argument, then the site config's `defaultTextFormat`,
  then `full_html` as the unchanged last-resort fallback. A text format is
  Drupal's HTML-filtering boundary, so it should be a decision rather than an
  assumption.
- **A body-only update no longer blanks an existing body summary.** The body
  descriptor set `summary: ""` whenever no summary was supplied, so updating
  just the body erased the summary as a side effect. The property is now sent
  only when the caller supplies it; passing `summary: ""` still clears it
  deliberately.

### Changed
- **`summary` documents what it actually targets.** The parameter writes the
  `summary` property of the core `text_with_summary` body field. Headless sites
  commonly use a dedicated summary/deck field for teasers and meta descriptions
  instead; on those, the value written here is stored but may never be rendered.
  Both node tools now say so, and point at `fields` for the dedicated field.

### Added
- **`@claude` GitHub Action (inline).** Maintainers can tag `@claude` on an
  issue or PR and Claude acts on the repo and opens a PR. Only
  owner/member/collaborator authors trigger it; bot actors are excluded; the
  job runs on `ubuntu-latest`, stops at opening a PR, and adds no AI
  attribution. Inert until the Claude GitHub App is installed and the
  `CLAUDE_CODE_OAUTH_TOKEN` org secret is made visible to this repo.
- **CI: No AI attribution gate.** Pull requests fail when commits, the
  PR title, or the PR body credit AI with authorship (shared Wilkes & Liberty
  drop-in). Covers server-side paths that local hooks cannot see.

### Changed
- **CI: the attribution gate reads its scripts from the base commit.** A
  pull request can no longer supply the code that decides whether it passes.

### Fixed
- **CI: the `@claude` workflow can fetch its OIDC token.** The action exchanges
  a GitHub OIDC token for its app credentials in every auth mode; without
  `id-token: write` the first activation run failed before reaching Claude.
- **CI: the attribution gate no longer fails on clean commits.** The stripper
  compared each commit message against a copy that had gained a trailing newline,
  so every commit looked modified and the run ended with `strip count > 0 but tip
  unchanged`.


## [2.2.0] - 2026-07-30

### Security
- **Default security preset is `production-strict` (#140).** Omitting `security`
  or passing `{}` no longer opens the site under the `development` preset.
  Local and integration work must set `"preset": "development"` (or another
  explicit preset) deliberately. Migration: add
  `"security": { "preset": "development" }` to any site config that relied on
  the old open default.
- **GraphQL tools fail closed (#142).** `drupal_graphql` and
  `drupal_graphql_introspect` require `security.allowGraphql` (true only on the
  `development` preset). Mutations still need `allowGraphqlMutations` as well.
  When GraphQL is opted in, results remain raw (no entity allowlist/redaction
  on that path); prefer JSON:API entity tools for policy-bound reads.
- **Dependency advisories cleared (#128).** Bump
  `@modelcontextprotocol/sdk` to `^1.30.0` and pin overrides for
  `@hono/node-server` `^2.0.5` and `postcss` `^8.5.18` so `npm audit` reports
  zero vulnerabilities.

### Documentation
- README, security guide, threat model, architecture, tools reference, and
  SECURITY.md updated for the secure default, GraphQL gate, and residual-risk
  table.

## [2.1.1] - 2026-07-31

### Documentation
- **npm package page / README.** Security model table lists all six presets and
  the 2.1 connector-side gates (entity policy on specialized tools, publish/draft
  defaults, upload roots, fail-closed HTTPS). Quick start leads with `npm install`
  for package consumers; clone path remains for development.
- Normalize `package.json` `repository.url` to the form npm expects
  (`git+https://…`).

## [2.1.0] - 2026-07-31

### Security
- **Specialized tools honor entity allowlists/denylists (#138).**
  `drupal_*_node`, media, and taxonomy tools now call the same
  `assertReadAllowed` / `assertWriteAllowed` / `assertDeleteAllowed` gates as
  `drupal_entity_*`, so a denied type (e.g. `media`) cannot be reached by
  switching tool names.
- **Upload path allowlist and path segment hardening (#137).** File uploads
  must resolve under `MCP_UPLOAD_ROOT` (or the connector cwd by default);
  entity/bundle/field path segments are machine-name validated and encoded;
  Content-Disposition filenames are sanitized. Sensitive paths (`.env*`,
  `.ssh`, connector `config.json`) are refused even under an allowed root.
- **Media no longer publishes by default (#139).** `drupal_create_media` and
  upload-and-create default to `status: false` and honor `assertPublishAllowed`.
  `moderation_state: published` and `drupal_set_moderation_state` to published
  are treated as publish-bearing.
- **HTTPS fails closed without auth when non-loopback (#141).** Binding beyond
  loopback requires `MCP_AUTH_TOKEN` unless `MCP_ALLOW_UNAUTHENTICATED=1`.
  Non-loopback HTTPS defaults to 120 req/min rate limiting when
  `MCP_RATE_LIMIT` is unset.
- **Link-checker does not follow redirects (#143).** Live checks use
  `redirect: "manual"` to avoid SSRF via 302 to private/metadata targets.
- **auditor / production-strict apply SENSITIVE_DENY** (partial #140). Secrets,
  governance, and account entity types stay denied on those presets. Default
  when `security` is omitted remains `development` (tracked in #140).

### Fixed
- **Published moderated updates default to a draft forward revision (#131).**
  `drupal_update_node`, `drupal_bulk_update`, and `drupal_entity_update` now
  sniff the target entity: when it is published under content_moderation and
  the caller omitted `moderation_state` / `moderationState`, the write is sent
  as `moderation_state: draft` instead of omitting the field. That keeps bulk
  relationship-wiring and field edits as reviewable forward revisions rather
  than live default-revision mutations if a server-side publish gate
  mis-classifies the write. Callers that want a same-state save must pass an
  explicit moderation state.

### Added
- **Provider-agnostic agent instructions.** Root `AGENTS.md` is the only
  committed agent rule file (any coding agent). No vendor-specific
  `.grok/` / `CLAUDE.md` / parallel rule trees. Generated slash stubs under
  `.claude/commands/` remain client ergonomics for MCP operators, not project
  development rules.

### Documentation
- Security, hardening, deployment, tools-reference, threat-model, and
  architecture docs updated for the 2.1 controls (fail-closed HTTPS, upload
  roots, publish/draft defaults, GraphQL policy caveat).

## [2.0.0] - 2026-07-29

### Fixed
- **Re-pushing a release tag no longer fails the publish job.** The workflow
  now skips publishing a version already on the registry. Moving or recreating
  a tag is a normal recovery operation, and npm's E403 "cannot publish over the
  previously published version" reads as a broken release when the registry is
  in exactly the state you wanted.

### Changed
- **BREAKING: `drupal_drush_sql_query` no longer runs ungoverned SQL, and is off
  by default.** It called `drush sql:query`, which executes below Drupal's
  entity API — so a site's `mcp_sentinel` policy profile, its denied entity
  types, its redacted fields and its audit log had no effect on anything this
  tool read. A statement could return exactly the data the same site refused
  over JSON:API, and nothing recorded that it had. That is not fixable on the
  Drupal side: Drush caps `sql:query`'s bootstrap below the level at which
  module command files are discovered, so no module hook can run on its path.
  Nor is it fixable here — this process holds the SSH key, so a client-side
  check is a promise made by the thing being constrained.

  The tool now calls `drush mcp-sentinel:sql-query` (mcp_sentinel ≥ 1.14),
  where Drupal is fully bootstrapped and the policy profile decides. Two
  independent opt-ins are required, both off by default: `drushSsh.rawSql:
  "governed"` on the site here, and `allow_raw_sql` on the policy profile
  there. There is no ungoverned mode — keeping one behind a flag would have
  left the bypass a config key away and still invisible when used.

  **To migrate:** set both flags, add `mcp-sentinel:sql-query` to
  `allowedCommands` if the site pins that list, and expect a narrower tool —
  the server accepts a single `SELECT` over entity tables only (no `SHOW` /
  `DESCRIBE` / `EXPLAIN`, no expressions, no `SELECT *` on a table carrying a
  redacted column). Schema introspection moves to the site-context and
  entity-schema tools. Sites that do not run mcp_sentinel lose this tool; raw
  database access belongs to the operator's own shell, not to an agent.

### Fixed
- **Docs: redirect entities are publishable.** The `redirects.js` header claimed
  redirect entities have no enabled/disabled flag. That has been stale since the
  redirect module's dev-1.x made the entity publishable (`enabled` is the published
  key). Corrected the doc and added a verify-after-create caveat for sites on older
  `mcp_sentinel` releases (≤ 1.9), where agent-created redirects can arrive silently
  disabled until the publish gate exempts redirects.

## [1.8.1] - 2026-07-23

### Security
- Resolved npm audit high/low advisories via a compatible lockfile bump:
  `brace-expansion` DoS (GHSA-3jxr-9vmj-r5cp), `fast-uri` host confusion
  (GHSA-v2hh-gcrm-f6hx, GHSA-4c8g-83qw-93j6), and `body-parser` DoS
  (GHSA-v422-hmwv-36x6). Two residual moderate `@hono/node-server` advisories
  (Windows-only path traversal, GHSA-frvp-7c67-39w9) are tracked in #128, blocked
  on an `@modelcontextprotocol/sdk` release accepting hono 2.x.

## [1.8.0] - 2026-07-23

### Added
- **`returning: "minimal"` on write tools (#113).** `drupal_entity_create/update` and
  `drupal_create_node/update_node` returned the complete re-read entity on every write —
  several thousand tokens for a node with a body (included twice, `value` + `processed`),
  most of it unrelated to the change, which made bulk content work exhaust an agent's
  context window. A new `returning` parameter (`"full"` default, preserving today's
  contract; `"minimal"` opt-in) returns just identity + state (id, type, bundle, title,
  status, changed, url), recommended for bulk writes. (`drupal_bulk_create/update` already
  return only per-item id + status.)
- **`security.allowPublish` policy knob (#114).** A local, fail-fast publish gate,
  symmetric with `allowDestructive`: defaults `false` in every preset except
  `development`, and an operator opts in per site. `assertPublishAllowed` rejects a
  write carrying `status: true` before the round-trip when publishing is not permitted.
  `drupal_mcp_whoami` now **derives** `capabilities.publish` from it (`allowPublish &&
  write`) instead of returning a hardcoded `false`. The remote Drupal's permissions
  (and any server-side governance) remain the real authority — this is defence in depth.
- **Launcher: auditor secret sourcing.** `bin/drupal-mcp-launch.sh` now optionally
  sources the read-only **config-auditor** Keychain secrets (`drupal-mcp-auditor-secret`
  → `MCP_AGENT_AUDITOR_SECRET`, `drupal-mcp-auditor-secret-stg` →
  `MCP_AGENT_AUDITOR_SECRET_STG`) for the `prod-audit` and `staging-audit` connector
  sites. Both exports are guarded — silent no-ops until the auditor consumers are
  provisioned — matching the existing per-environment secret-sourcing pattern.
- **Launcher: content-auditor and break-glass admin secret sourcing.**
  `bin/drupal-mcp-launch.sh` now also sources the read-only **content-auditor**
  secrets (`drupal-mcp-content-auditor-secret` → `MCP_AGENT_CONTENT_AUDITOR_SECRET`,
  `drupal-mcp-content-auditor-secret-stg` → `MCP_AGENT_CONTENT_AUDITOR_SECRET_STG`) and
  the on-demand **break-glass admin** secret (`drupal-mcp-admin-secret` →
  `MCP_AGENT_ADMIN_SECRET`). All are guarded no-ops until the matching Keychain items
  exist; the admin item is deliberately absent by default so the `prod-admin` site stays
  inert until you opt in for a session and remove it afterward.

### Changed
- **`drupal-content-audit` prompt is now content-type-agnostic (#122).** The prompt
  hardcoded `article` for its SEO and accessibility steps, so on a site without that
  type — or one whose model was consolidated — those steps scanned zero nodes and the
  audit reported no findings, indistinguishable from a genuinely clean scan. It now
  derives the types to audit from `drupal_report_content_summary`'s `byContentType`
  inventory, iterates the per-type checks across every type that has nodes, records
  zero-node types as empty rather than clean, prefers `drupal_report_seo_meta_coverage`
  (which reads the site's actual meta field) for the SEO step, and states which types
  were scanned so an empty or unexpected model can't be mistaken for a passing audit.

### Fixed
- **`drupal_describe_fields` entity-type parameter name mismatch (#116).** The tool took
  the entity type as `type` while its siblings (`get_entity_schema`, `entity_create`,
  `entity_update`, `resolve_reference`) take `entityType`; passing the sibling name
  slipped through as `undefined` and surfaced a misleading "Entity type 'undefined' is
  not in the allowedEntityTypes list" access error. It now accepts `entityType` as an
  alias for `type`, and errors clearly (naming both accepted parameters) when neither is
  given instead of reporting a phantom access-control failure.
- **Backend resolution misdiagnosed auth failures as unreachable (#119).** The probe
  swallowed every error and reported "none of the configured api backends are usable —
  check the api setting and that the endpoint is reachable," sending operators to chase
  network/DNS when the real problem was an expired/invalid OAuth token. Resolution now
  captures each protocol's underlying error, classifies auth failures (401,
  invalid_client/grant, unauthorized) distinctly, includes the underlying detail in
  every message, and on an auth failure clears the cached token so the next call
  re-attempts the client-credentials grant instead of latching "unusable."
- **`drupal_create_node` / `drupal_update_node` couldn't set entity-reference fields (#115).**
  Everything in `fields` was sent as JSON:API attributes, so any create/update that set a
  reference field (taxonomy, related content, media) failed with a 422 — the node tools
  could only produce untagged, unclassified content. Both tools now take a `relationships`
  parameter (JSON:API shape, same as `drupal_entity_create`) that is passed through to the
  backend, and `fields`/`relationships` are documented so reference fields land in the right
  place.
- **Publish state silently dropped on writes (#111).** A write carrying `status: true`
  at a tier that cannot publish was silently discarded (200, entity unchanged, no
  diagnostic). Two causes, both fixed: the new `assertPublishAllowed` gate now rejects
  such a write up front with a clear error, and the JSON:API moderated-status retry no
  longer matches a generic `field (status)` **permission** denial — that is a real
  refusal and now surfaces, instead of being retried away as a moderation quirk. Only
  the unambiguous "published field of moderated entities" error still triggers the
  status-drop retry.
- **`dryRun` echoed input instead of validating (#112).** `dryRun` returned the request
  parameters without applying tier policy, so it previewed writes that could not happen.
  It now runs the same write **and publish** checks as the real call, so a dry run fails
  exactly where the write would.
- **`whoami` hardcoded `capabilities.publish: false` (#114).** A site-specific claim in
  a site-agnostic tool, neither derived nor enforced. Now derived from `allowPublish`
  (see Added).
- **Bulk writes bypassed the publish gate.** `drupal_bulk_create`/`drupal_bulk_update` now
  apply `assertPublishAllowed` per item (a publish-bearing item fails on its own, without
  aborting the batch), so the new `allowPublish` policy can't be sidestepped in bulk.
- **SEO audit: false "0 missing meta descriptions" on Metatag sites (#120).**
  `drupal_report_seo_audit` counted the JSON:API `metatag` field as a present
  description, but that field is an unresolved placeholder over JSON:API, so every
  node looked covered and the audit reported zero gaps while pages shipped without a
  description. The meta check now resolves the **rendered** description from GraphQL
  Compose's normalized `metatag` field (`route(path:)`, no introspection required —
  reflecting defaults *and* per-node overrides), falls back to a plain
  `field_meta_description`/`metaDescription` field on non-Metatag sites, and when
  neither is readable reports the check as `unavailable` rather than a false zero. The
  result now carries a `metaSource` of `graphql` | `jsonapi` | `unavailable`.
- **Docs: stale counts corrected.** The getting-started first-run banner and the
  architecture/whitepaper figures still read `v1.3.0 / 93 tools / 21 modules / 4 prompts`;
  updated to the current build — **119 tools across 26 modules, 3 resources, 124 prompts**
  — so onboarding output matches what a new user actually sees.

### Changed
- **Docs: per-client cross-link.** `getting-started.md` §6 now points to `mcp-clients.md`
  for copy-paste config per client (Claude Code/Desktop, Grok Build, OpenAI Codex, Cursor).

## [1.7.0] - 2026-07-01

### Added
- **A slash command for every tool.** All 119 `drupal_*` tools are now exposed as
  `drupal-<tool>` MCP prompts (e.g. `drupal-create-node`), generated dynamically from
  the tool definitions at startup and merged with the 5 existing workflow prompts.
  Being protocol-native prompts, they surface as slash commands in **any** MCP client
  (Claude, Gemini, Codex, …); each takes the tool's parameters as arguments and drives
  a single governed call to that tool, with destructive tools flagged to confirm first.
- **Claude Code command files** — `npm run generate:commands` writes one
  `.claude/commands/drupal-<tool>.md` per tool, giving the literal `/drupal-<tool>`
  form in Claude Code. Each file is scoped via `allowed-tools` to only its own
  `mcp__drupal__<tool>`. The committed files are kept in sync by a staleness test.
- New `src/tools/index.js` — single source of truth aggregating every tool
  definition/handler, shared by the server, the per-tool prompts, and the command
  generator so the three can never drift. Operation classification (write/destructive)
  extracted to `src/lib/operations.js` and reused for the confirm-first warnings.

## [1.6.0] - 2026-06-29

### Added
- **Audit command suite — 22 new read-only audit tools across four groups**, expanding
  the connector from content reporting into link/404 integrity and configuration
  posture. All follow the existing `drupal_report_*` / `drupal_audit_*` convention
  (auto-classified read-only), degrade with a `gatedReport`/`gated` payload when a
  required source is absent, and flag `approximate`/`truncated` when sampling-bounded.
  - **Links & 404 integrity** (`reports-links.js`): `drupal_report_404_log`,
    `drupal_report_redirect_health`, `drupal_report_broken_links`,
    `drupal_report_alias_coverage`, `drupal_report_menu_integrity`,
    `drupal_report_broken_embeds`.
  - **Config & site-health** (`reports-config.js`): `drupal_report_config_drift`,
    `drupal_audit_config_best_practices`, `drupal_report_module_audit`,
    `drupal_report_permission_audit`, `drupal_report_status_report`,
    `drupal_report_text_format_audit`, `drupal_report_cache_config`.
  - **Content quality & governance** (`reports-content.js`):
    `drupal_report_duplicate_content`, `drupal_report_workflow_bottlenecks`,
    `drupal_report_translation_coverage`, `drupal_report_scheduled_content`,
    `drupal_report_readability`, `drupal_report_orphan_pages`,
    `drupal_report_pii_exposure`, `drupal_report_seo_meta_coverage`.
  - **Composite** (`audit-composite.js`): `drupal_audit_site_health` — a scored
    dashboard that runs a configurable battery of the above and rolls them into one
    letter grade, with each section degrading independently.
- **`drupal-full-audit` MCP prompt** — walks a client through running the composite
  audit and turning the dashboard into a prioritized action plan.
- **Opt-in live link checking.** `drupal_report_broken_links` performs no network
  egress by default; with `checkLive: true` it verifies links via a bounded,
  SSRF-guarded checker (`src/lib/link-checker.js`) that refuses
  loopback/private/link-local/metadata addresses, requires a host allowlist for
  external hosts, and caps concurrency, timeout, and link count. Configurable per site
  via an optional `audit` block (`linkCheckAllowedHosts`, `linkCheckConcurrency`,
  `linkCheckTimeoutMs`, `linkCheckMaxLinks`).
- **Self-sufficient privileged audits.** Log/config/module/permission/requirements
  audits read their data through the connector's own **drush bridge** (`watchdog:show`,
  `config:status`/`config:get`, `pm:list`/`pm:security`, `role:list`,
  `core:requirements`, and a read-only `sql:query` to enumerate `filter.format.*`), so
  they work against stock Drupal with **no companion module required**. The
  config-inspection audits additionally prefer the existing governed config server-tool
  when a site has `serverTools` configured. Each returns a `gated`/`unavailable` payload
  (never throws) when no source is configured.

### Changed
- `sshDrush` and `parseDrush` are now exported from `src/tools/drush.js`, and a
  `toolResultData` helper is exported from `src/lib/server-tools.js`, so the audit tool
  groups can reuse the hardened drush bridge and the existing governed config transport.

### Security
- The drush bridge no longer logs secret-bearing flag values (`--password`/`--token`/
  `--secret`/`--api-key`) in clear text — they are redacted to `***` in the operational
  stderr log line (`redactSecretArgs`). Clears a `js/clear-text-logging` finding.

## [1.5.1] - 2026-06-29

### Fixed
- **Node URL aliases set via the connector now actually persist (DEV-116).** Setting an
  alias with `drupal_update_node` (`fields.path = { alias, pathauto: 0 }`) returned
  success but silently reverted, causing nav 404s. Root cause: JSON:API deserialized the
  `path` field without the existing alias's **`pid`**, so Drupal's `PathItem::postSave`
  *created a duplicate* `path_alias` (the older one stayed canonical) instead of updating
  in place. The connector now reads the current alias's `pid` (new
  `backend.getPathInfo`) and round-trips it, so the alias is **updated in place** — one
  canonical alias, no duplicate. Verified end-to-end over JSON:API on Drupal 11.
- **Path-less updates no longer create duplicate aliases.** The DEV-114 "preserve" path
  re-pinned the current alias *without* its `pid`, hitting the same duplicate bug; it now
  round-trips the `pid` too.
- **Honest write responses.** `drupal_create_node` / `drupal_update_node` now **re-read**
  the node after writing and return the *persisted* `url`, instead of echoing the
  requested value (which masked the revert).

### Added
- **Automatic rename redirect.** When an explicit alias change replaces a different
  existing alias, the connector creates a 301 redirect from the old path to the node
  (`entity:node/<id>`, alias-independent), so the previous URL keeps resolving. Idempotent
  — skipped when a redirect for that source already exists or the alias is unchanged.
- **`backend.getPathInfo(ref)`** on the backend interface — exposes the raw `path` field
  (`alias` / `pid` / `langcode`) and internal id; default returns nulls (read-only/
  path-less backends are unaffected). `buildRedirectAttributes()` is now exported from the
  redirects module for reuse.

### Notes
- Connector-created nodes still rely on Pathauto to generate their alias when no explicit
  `path` is given. A **separate, server-side** Pathauto pattern misconfiguration (some
  `pathauto.pattern.*` had `bundles` stored as a sequential array instead of the
  associative map the `entity_bundle` condition requires) prevented alias generation for
  affected bundles (e.g. `industry`, `platform`); that fix lives in the Drupal site
  (webcms), not in the connector.

## [1.5.0] - 2026-06-29

### Added
- **`drupal_update_paragraph`** — update an existing Paragraph entity's field values
  in place (partial JSON:API PATCH) by bundle + UUID, so component / key-capability
  paragraphs can be maintained end-to-end without re-embedding (DEV-114).
- **`drupal_update_menu_link`** — update a menu link by UUID (rename, re-weight,
  re-target, re-parent, enable/disable). `enabled` is preserved across edits unless
  passed explicitly (DEV-114).
- **`drupal_create_menu_link`** now accepts **`parent`** (nest under a parent link
  plugin id) and **`enabled`** on create, and creates links **enabled by default** so
  they render immediately — closing the "menu links created disabled / no parent on
  create" gap (DEV-114).

### Fixed
- **Menu links no longer silently regress to disabled.** Every menu-link write now
  asserts `enabled` explicitly (default true on create; the current value re-pinned on
  update), so an unrelated edit can't drop a live link to disabled through the JSON:API
  write path (DEV-114).
- **Node updates preserve the existing URL alias.** When `drupal_update_node` is called
  without a `path`, the connector reads the current alias and re-pins it
  (`{ alias, pathauto: 0 }`) so a save can't let Pathauto revert the alias to a stale
  value. Pass `fields.path` to set the alias explicitly (DEV-114).
- **Intermittent `drupal_create_menu_link` 422 "path '/…' is inaccessible".** This is a
  transient path-validator/access-cache race in Drupal's `LinkAccessConstraint`; menu-link
  create/update now retries once after a short delay when it hits that specific error.
  Prefer an `entity:node/<id>` target over `internal:/<alias>` to avoid the alias
  resolution step entirely (DEV-114).

## [1.4.0] - 2026-06-29

### Added
- **Redirect tools** (`drupal_create_redirect`, `drupal_update_redirect`) for the
  contrib Redirect module. `drupal_create_redirect` produces a redirect that serves
  its 301 (or chosen code) immediately: the source path's leading slash is stripped
  to the module's stored, slash-less form (the classic "redirect saved but never
  fires" cause), the destination is normalized to a Drupal link-field URI (a bare
  path is wrapped as `internal:`, while `entity:node/ID` and absolute URLs pass
  through), and `status_code` defaults to 301 with 302 (and 303/307/308) accepted.
  `drupal_update_redirect` repoints an existing redirect's source/target or changes
  its status code via a partial update — the path to activate/fix a redirect that
  isn't firing. Both are governed by the per-site security policy (redirect writes /
  `administer redirects`). Resolves the gap where connector-created redirects were
  inactive and could not be enabled (DEV-111).

## [1.3.2] - 2026-06-27

### Fixed
- `drupal_config_set` now forwards the configuration map under the `data` key the
  server-side tool requires, instead of `value`. The governed tool
  (`tool_api.mcp_sentinel_config_set`) declares its inputs as `name` plus `data` (a
  map of top-level keys to new values, applied as a partial update). Previously the
  connector sent `{ name, value }`, so every `config_set` was rejected with
  `-32602 Invalid parameters … Missing required properties: \`data\``. The public
  tool surface is unchanged — callers still pass `value` (a map); it is translated to
  `data` at the call site. `config_get` / `config_list` were unaffected.

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
