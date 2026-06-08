# Contributing to drupal-mcp-connector

Thank you for your interest in contributing! This project was created by **Jeremy Michael Cerda** and is maintained by [Wilkes & Liberty, LLC](https://github.com/Wilkes-Liberty).

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

**Prerequisites:** Node.js 20+ and npm (ships with Node). A local Drupal site is
only needed to exercise the connector end to end — the unit test suite runs
without one.

1. Fork the repository.
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/drupal-mcp-connector`
3. Install dependencies: `npm install`
4. (Optional, for end-to-end work) Set up a local Drupal site — we recommend
   [DDEV](https://ddev.com) or [Lando](https://lando.dev) — then copy
   `config/config.example.json` → `config/config.json` and point it at the site.
   See [docs/getting-started.md](docs/getting-started.md) for a full walkthrough.

## Development Workflow

```bash
node src/index.js                 # run the server (stdio mode — default)
npm run start:dev                 # run over HTTPS transport on :3443, TLS skipped for local dev

npm test                          # run the test suite once (vitest)
npm run test:watch                # re-run tests on change
npm run lint                      # eslint — must be clean
npm run lint:fix                  # auto-fix what eslint can
npm run audit                     # fail on high-severity dependency advisories
npm run check                     # lint + audit together
```

Before pushing, run `npm run check` and `npm test` — these mirror what CI enforces.

## Tests

Tests use [vitest](https://vitest.dev) and live under `tests/`, mirroring the
`src/` layout (e.g. `src/tools/nodes.js` → `tests/tools/nodes.test.js`). Run a
single file with `npx vitest run tests/tools/nodes.test.js`. Add or update a test
for every new tool and every bug fix.

## Adding a New Tool

All tools follow the same three-part pattern (see [docs/architecture.md](docs/architecture.md),
and [docs/tools-reference.md](docs/tools-reference.md) for naming conventions):

1. Add your implementation function to the appropriate file in `src/tools/`.
2. Add a tool definition to the file's `definitions` export. Name it
   `drupal_<verb>_<noun>` — security gating is inferred from the `get_`/`list_`/
   `create_`/`update_`/`delete_`/`graphql` prefix, so follow the convention.
3. Add a handler entry to the file's `handlers` export.

No changes to `src/index.js` are needed unless you add a new module file.

### Adding a New Tool Module

1. Create `src/tools/yourmodule.js` following the existing pattern.
2. Add `import * as yourmodule from "./tools/yourmodule.js"` in `src/index.js`.
3. Add `yourmodule` to the `allModules` array.

## Code Style

- ES modules throughout (`import`/`export`).
- 2-space indentation; double quotes (both enforced by ESLint — `npm run lint:fix`).
- `async`/`await`, not raw Promise chains.
- JSDoc comments on all exported functions.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add drupal_metatag_update tool
fix(security): correctly redact nested field values
docs: update getting-started for DDEV setup
```

## Pull Requests

`master` is a protected branch — all changes land via pull request.

- One feature or fix per PR.
- Add a test if you're adding a tool or fixing a bug.
- Update `CHANGELOG.md` under `[Unreleased]`. A `CHANGELOG updated` CI check
  enforces this; a trivial PR that genuinely needs no entry can carry the
  `no-changelog` label to bypass it.
- Update [docs/tools-reference.md](docs/tools-reference.md) if you add or change tools.
- CI must pass before merge: lint + unit tests (Node 20 and 22), the Drupal
  integration job, and CodeQL analysis.
- Any review conversations must be resolved before merging (a branch-protection
  requirement). Maintainer review is welcomed but not required to merge a
  green PR.

## Security

If you find a security vulnerability, please do **not** open a public issue.
See [SECURITY.md](SECURITY.md) for private reporting.

## Releasing

Releases are cut from `master` and published to npm by the `release.yml` GitHub
Actions workflow when a `v*` tag is pushed.

Because `master` is protected, the release commit lands via a PR and the tag is
created **after** the merge, on the resulting `master` commit:

1. Branch off `master` (e.g. `git checkout -b release/vX.Y.Z`).
2. Roll the `[Unreleased]` CHANGELOG section into a new dated version heading,
   and add its `[X.Y.Z]` link reference at the bottom.
3. Bump the version without tagging yet:
   `npm version <x.y.z> --no-git-tag-version`.
4. Commit (`release: vX.Y.Z — …`), push the branch, and open a PR to `master`.
5. Once CI is green, merge the PR (resolve any review threads first).
6. Update local master and tag the merge commit:
   `git checkout master && git pull && git tag -a vX.Y.Z -m "vX.Y.Z"`.
7. Push the tag: `git push origin vX.Y.Z`.
   The tag push triggers `release.yml`, which re-runs lint + tests, verifies the
   tag matches `package.json`, and publishes with provenance.
8. Create the GitHub Release for the tag with the CHANGELOG notes:
   `gh release create vX.Y.Z --title vX.Y.Z --verify-tag --latest --notes-file -`.

The connector reports its own version from `package.json` at runtime (MCP
handshake, `X-MCP-Client` header, startup logs), so step 3 is the only place a
version number needs to change.

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
