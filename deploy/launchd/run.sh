#!/bin/sh
# Launcher invoked by the launchd plist. Sources secrets from a secret manager
# (so they're never stored in the plist) and starts the HTTPS transport.
# Adjust the secret lookups to your platform; see examples/launch-with-secret.sh.
set -eu

cd "$(dirname "$0")/../.."   # connector root (config/config.json resolves here)

# Bearer token required on /mcp, and the OAuth client secret for Drupal.
# macOS Keychain examples: the item names and the env var names below are
# placeholders matching config/config.example.json — replace both with your
# own. Assign then export separately so `set -e` aborts if a lookup fails.
MCP_AUTH_TOKEN="$(security find-generic-password -s drupal-mcp-auth-token -w)"
export MCP_AUTH_TOKEN
MCP_CONTENT_PRODUCTION_SECRET="$(security find-generic-password -s drupal-mcp-content-production -w)"
export MCP_CONTENT_PRODUCTION_SECRET

exec node src/index.js
