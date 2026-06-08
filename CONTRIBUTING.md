# Contributing to drupal-mcp-connector

Thank you for your interest in contributing! This project was created by **Jeremy Michael Cerda** and is maintained by [Wilkes & Liberty, LLC](https://github.com/Wilkes-Liberty).

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/drupal-mcp-connector`
3. Install dependencies: `npm install`
4. Set up a local Drupal site (we recommend [DDEV](https://ddev.com) or [Lando](https://lando.dev))
5. Copy `config/config.example.json` → `config/config.json` and point it at your local Drupal

## Development Workflow

```bash
# Run the server (stdio mode — default)
node src/index.js

# Run the server (HTTPS transport, port 3443; MCP_ALLOW_HTTP=1 skips TLS for local dev)
MCP_TRANSPORT=https MCP_ALLOW_HTTP=1 MCP_PORT=3443 node src/index.js

# Run tests
npm test

# Lint
npm run lint
```

## Adding a New Tool

All tools follow the same three-part pattern. See [docs/architecture.md](docs/architecture.md) for details.

1. Add your implementation function to the appropriate file in `src/tools/`
2. Add a tool definition to the `definitions` export
3. Add a handler entry to the `handlers` export
4. No changes to `src/index.js` needed unless adding a new module file

## Adding a New Tool Module

1. Create `src/tools/yourmodule.js` following the existing pattern
2. Add `import * as yourmodule from "./tools/yourmodule.js"` in `src/index.js`
3. Add `yourmodule` to the `allModules` array

## Security

If you find a security vulnerability, please do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Pull Request Guidelines

- One feature or fix per PR
- Add a test if you're adding a new tool
- Update CHANGELOG.md under `[Unreleased]`
- Update [docs/tools-reference.md](docs/tools-reference.md) if adding tools
- PRs require one approval from a maintainer

## Releasing

Releases are cut from `master` and published to npm by the `release.yml` GitHub
Actions workflow when a `v*` tag is pushed.

`master` is a protected branch (pull request + passing CI required), so the
release commit lands via a PR — the tag is created **after** the merge, on the
resulting `master` commit:

1. Branch off `master` (e.g. `git checkout -b release/vX.Y.Z`).
2. Roll the `[Unreleased]` CHANGELOG section into a new dated version heading,
   and add its `[X.Y.Z]` link reference at the bottom.
3. Bump the version without tagging yet:
   `npm version <x.y.z> --no-git-tag-version`.
4. Commit (`release: vX.Y.Z — …`), push the branch, and open a PR to `master`.
5. Once CI is green, merge the PR (resolve any review threads first — the branch
   requires conversation resolution).
6. Update local master and tag the merge commit:
   `git checkout master && git pull && git tag -a vX.Y.Z -m "vX.Y.Z"`.
7. Push the tag: `git push origin vX.Y.Z`.
   The tag push triggers `release.yml`, which re-runs lint + tests, verifies the
   tag matches `package.json`, and publishes with provenance.
8. Create the GitHub Release for the tag with the CHANGELOG notes:
   `gh release create vX.Y.Z --title vX.Y.Z --verify-tag --latest --notes-file -`.

**One-time setup — npm trusted publishing (no token, no secret):**
publishing authenticates via GitHub Actions **OIDC** — npm trusts this exact
repo+workflow identity directly, so there is no `NPM_TOKEN` to create, store, or
rotate. Configure it once on npmjs.com:

> Package `drupal-mcp-connector` → **Settings → Trusted Publishing → GitHub Actions**
> - Organization/owner: `Wilkes-Liberty`
> - Repository: `drupal-mcp-connector`
> - Workflow filename: `release.yml`
> - Environment: *(leave blank)*

The workflow already has `id-token: write`; provenance is attached automatically.

To publish manually instead, run `npm publish --access public` in a real terminal
(no `--otp`); npm opens a browser challenge and you tap the YubiKey. The `--otp=`
flag is TOTP-only and does **not** work with a security key.

## Code Style

- ES modules throughout (`import`/`export`)
- 2-space indentation
- Double quotes (enforced by ESLint)
- Async/await (no raw Promise chains)
- JSDoc comments on all exported functions

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add drupal_metatag_update tool
fix(security): correctly redact nested field values
docs: update getting-started for DDEV setup
```
