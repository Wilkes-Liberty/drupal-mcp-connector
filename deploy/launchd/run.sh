#!/bin/sh
# Launcher invoked by the launchd plist. Sources secrets from a secret manager
# (so they're never stored in the plist) and starts the HTTPS transport.
# Adjust the secret lookups to your platform; see examples/launch-with-secret.sh.
set -eu

cd "$(dirname "$0")/../.."   # connector root (config/config.json resolves here)

# Bearer token required on /mcp, and the OAuth client secret for Drupal.
# macOS Keychain examples (replace item names to match yours). Assign then
# export separately so `set -e` aborts if a secret lookup fails.
MCP_AUTH_TOKEN="$(security find-generic-password -s drupal-mcp-auth-token -w)"
export MCP_AUTH_TOKEN
MCP_AGENT_CLIENT_SECRET="$(security find-generic-password -s drupal-mcp-agent-secret -w)"
export MCP_AGENT_CLIENT_SECRET

exec node src/index.js
