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

1. Roll the `[Unreleased]` CHANGELOG section into a new dated version heading.
2. Bump the version without tagging yet:
   `npm version <x.y.z> --no-git-tag-version`
3. Commit (`release: vX.Y.Z — …`) and tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
4. Push: `git push origin master && git push origin vX.Y.Z`.
   The tag push triggers `release.yml`, which re-runs lint + tests, verifies the
   tag matches `package.json`, and publishes with provenance.

**One-time setup — `NPM_TOKEN` secret (required for automated publish):**
the maintainer npm account uses a **YubiKey (WebAuthn)** for 2FA, which cannot run
in CI. Create a **granular automation token** (npm → Access Tokens → Generate →
*Automation*), scope it to publish this package, and store it as the `NPM_TOKEN`
repository secret. Automation tokens bypass interactive 2FA by design.

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
