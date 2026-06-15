# Versioning & Stability Policy

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
This document defines **what counts as the public, stable surface** — i.e. what a
breaking change is — so you can upgrade with confidence and know what 1.0 will
guarantee.

## Pre-1.0 (current: `0.x`)

While on `0.x` the project is maturing toward a stable 1.0. We already practice
the policy below and avoid gratuitous breakage, but per semver, **`0.x` minor
releases may include a breaking change to the surfaces listed under "Stable
surface"** when necessary. Such changes are always called out in
[CHANGELOG.md](../CHANGELOG.md). At **1.0** the guarantees below become firm:
breaking changes to the stable surface require a major bump.

Tracking issue for 1.0: [#29](https://github.com/Wilkes-Liberty/drupal-mcp-connector/issues/29).

## Stable surface (the contract)

A change that breaks any of these is a **MAJOR** change (post-1.0):

- **Tool names and input schemas** — the `drupal_*` tool names and the shape of
  their accepted arguments (removing a tool, renaming it, removing/retyping a
  required input, or tightening validation in a backward-incompatible way).
- **Resource URIs & prompt names** — e.g. `drupal://sites`,
  `drupal://{site}/content-types`, and the published prompt identifiers.
- **Configuration schema** — recognized keys in `config/config.json` (site
  fields, `oauth`, `security`, `drushSsh`, `tls`, …) and their meaning.
- **Environment variables** — the documented `DRUPAL_*`, `MCP_*`, and `TLS_*`
  variable names and semantics.
- **Transports & endpoints** — stdio transport, and the Streamable-HTTP
  endpoints (`/mcp`, `/health`) plus their auth/status-code contract.
- **Security preset names** — `development`, `content-editor`, `auditor`,
  `production-strict`, `write-plane` (semantics may *tighten* in a minor only if
  it never grants more than before).
- **Integration contract** — versioned independently; see
  [integration-contract.md](integration-contract.md) (currently 1.0).

Additive changes to the above (new tools, new optional inputs, new env vars, new
presets) are **MINOR**.

## Not covered (may change in MINOR/PATCH)

These are implementation details — don't build automation on them:

- Internal module layout under `src/lib/**` and function signatures.
- Exact human-readable error/log message wording and formatting.
- Canonical-entity field ordering (the set of fields is stable; ordering is not).
- The exact MCP protocol version negotiated at runtime (see below).
- Test/CI tooling and dev dependencies.

## MCP protocol version

The connector does not pin a protocol version: it supports up to the
`LATEST_PROTOCOL_VERSION` shipped by its pinned `@modelcontextprotocol/sdk`
(currently **2025-11-25**, per the README badge) and **negotiates the highest
version each client supports** at connect time. So a client may report an older
negotiated version (e.g. `2025-06-18`) without anything being wrong. SDK upgrades
that raise the supported protocol ship in a normal release and are noted in the
changelog.

## Runtime support

- **Node.js 20+** (`engines.node`). CI runs the suite on Node 20 and 22.
- **Drupal 10 / 11** for the Drupal side.

## Deprecation policy

When something on the stable surface must change:

1. It's marked **Deprecated** in [CHANGELOG.md](../CHANGELOG.md) (and in tool/CLI
   output where practical), with the replacement and timeline.
2. It keeps working for **at least one subsequent MINOR** release.
3. It's removed **no earlier than the next MAJOR**.

Security fixes may move faster when leaving a vulnerability in place is the
greater risk; such exceptions are documented in the release notes.

## Releases

Releases are cut by pushing a `vX.Y.Z` tag; CI publishes to npm via trusted
publishing. [CHANGELOG.md](../CHANGELOG.md) (Keep a Changelog format) is the
source of truth for what changed. Release candidates use `-rc.N` suffixes.
