---
name: drupal-mcp-stdio
description: >
  Install the Drupal MCP Connector over local stdio. Use when connecting
  Cursor to Drupal. Public HTTPS stays gated; there is no W&L SaaS MCP URL.
---

Install:

```bash
npx -y drupal-mcp-connector init --preset local-stdio
npx -y drupal-mcp-connector doctor
```

`requireGovernance: true` is the listing default. `--preset public-https` stays gated. There is no Wilkes & Liberty SaaS MCP URL.
