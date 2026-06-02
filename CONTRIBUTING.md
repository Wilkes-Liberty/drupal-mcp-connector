# Contributing to drupal-mcp-server

Thank you for your interest in contributing! This project is maintained by [Wilkes & Liberty](https://github.com/wilkes-liberty).

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/drupal-mcp-server`
3. Install dependencies: `npm install`
4. Set up a local Drupal site (we recommend [DDEV](https://ddev.com) or [Lando](https://lando.dev))
5. Copy `config/config.example.json` → `config/config.json` and point it at your local Drupal

## Development Workflow

```bash
# Run the server (stdio mode)
node src/index.js

# Run the server (HTTP mode, port 3000)
MCP_TRANSPORT=http node src/index.js

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

## Code Style

- ES modules throughout (`import`/`export`)
- 2-space indentation
- Single quotes
- Async/await (no raw Promise chains)
- JSDoc comments on all exported functions

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tools): add drupal_metatag_update tool
fix(security): correctly redact nested field values
docs: update getting-started for DDEV setup
```
