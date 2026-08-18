# Agent instructions — drupal-mcp-connector

**Provider-agnostic** project rules for any coding agent or IDE assistant.
This file is the only committed agent instruction surface. Keep it short and
actionable. Product docs: `docs/`. Contribution workflow: `CONTRIBUTING.md`.

## What this repo is

Node.js **MCP server** that fronts one or more Drupal sites over JSON:API and/or
GraphQL, with connector-level security policy, optional SSH Drush bridge, and
governed write tools. It is **not** a Drupal module.

## Commands

```bash
npm install
npm test                 # vitest, once
npm run test:watch
npm run lint             # eslint src/
npm run lint:fix
npm run audit            # fail on high-severity npm advisories
npm run check            # lint + audit (mirrors CI quality gate)
npm run generate:commands  # regenerate client slash stubs under .claude/commands/
```

Before treating work as done: `npm test` and `npm run lint` must pass. Prefer
targeted tests while iterating (`npx vitest run tests/tools/nodes.test.js`).

## Layout

| Path | Role |
|------|------|
| `src/index.js` | Entry, transports, security middleware, tool dispatch |
| `src/tools/` | Tool groups (`definitions` + `handlers` per module) |
| `src/lib/` | Config, security, backends, OAuth, HTTP, validation |
| `src/lib/backends/` | JSON:API + GraphQL adapters → canonical entity shape |
| `tests/` | Mirrors `src/` (e.g. `src/tools/nodes.js` → `tests/tools/nodes.test.js`) |
| `config/config.example.json` | Documented example site config |
| `config/config.json` | **Local only — gitignored secrets** |
| `.claude/commands/` | Generated slash-command stubs for one MCP client (see below) |

## Conventions

- **ES modules**, 2-space indent, double quotes (ESLint-enforced).
- **Tool names:** `drupal_<verb>_<noun>`. Operation gating is inferred from name
  prefixes (`get_`/`list_` = read, `create_`/`update_` = write, `delete_` =
  destructive, `graphql` = GraphQL). Follow the pattern so new tools stay gated.
- **Resolved target:** every site-addressing response includes
  `_target: { name, baseUrl, source }` (`hint` | `default` | `grant`). Reads may
  omit `site` and default to `defaultSite`. Writes must pass `site` when more
  than one site is configured.
- New tools: implement + `definitions` + `handlers` in the right module; add
  tests. After tool description/schema changes run `npm run generate:commands`.
- JSDoc on exported functions.
- Conventional Commits (`feat:`, `fix:`, `docs:`, …).
- Update `CHANGELOG.md` under `[Unreleased]` for user-visible changes.
- Branch names for tracked work: `fix/<issue>-<slug>` or `feat/<issue>-<slug>`.

## Security (non-negotiable)

- Never commit `config/config.json`, `.env*`, tokens, OAuth secrets, or SSH keys.
- Connector security (`src/lib/security.js`) is defense-in-depth on top of Drupal
  permissions — do not weaken presets or redaction without an explicit decision.
- Destructive tools and publish (`status: true` / `moderation_state: "published"`)
  are gated; media create defaults unpublished.
- Specialized node/media/taxonomy tools use the same entity allowlists as
  `drupal_entity_*` — do not reintroduce bypasses.
- **Published moderated updates**: omitting moderation state on a published
  moderated node defaults the write to `moderation_state: "draft"`.
- Uploads: only under `MCP_UPLOAD_ROOT` (or cwd). Non-loopback HTTPS requires
  an inbound OAuth resource server (`auth.issuer` + `auth.audience`).
  `MCP_AUTH_TOKEN` is loopback-only (or trusted proxy + `MCP_ALLOW_UNAUTHENTICATED=1`).
- Default security preset is `production-strict` when `security` is omitted.
- GraphQL tools require `allowGraphql` (development preset only by default).
  When enabled, results still skip entity allowlist/redaction — prefer JSON:API
  for policy-bound reads.
- Report vulnerabilities privately per `SECURITY.md` — not as public issues.

## Provider-agnostic policy

| In the repo | Out of the repo |
|-------------|-----------------|
| **`AGENTS.md` only** for agent *development* rules | Vendor rule trees (`.grok/`, `.cursor/rules/`, `.claude/rules/`, root `CLAUDE.md`, `GEMINI.md`, …) |
| Generated client stubs under `.claude/commands/` (product ergonomics for operators using one popular MCP client; not project rules) | Personal permission allowlists, host paths, API keys, model prefs |

Personal or vendor-specific agent config belongs in the operator’s home
directory for that tool — never committed here. Do not add a second instruction
file “for Grok” or “for Claude”; extend **this** file instead.
