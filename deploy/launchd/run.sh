#!/bin/sh
# Launcher invoked by the launchd plist. Sources secrets from a secret manager
# (so they're never stored in the plist) and starts the HTTPS transport.
# Adjust the secret lookups to your platform; see examples/launch-with-secret.sh.
set -eu

cd "$(dirname "$0")/../.."   # connector root (config/config.json resolves here)

# The OAuth client secret for Drupal. Inbound /mcp authentication is the
# OAuth resource server in config (auth.issuer + auth.audience); do not export
# MCP_AUTH_TOKEN, which was removed in 4.0.0 and is fatal at startup.
# macOS Keychain example: the item name and the env var name below are
# placeholders matching config/config.example.json — replace both with your
# own. Assign then export separately so `set -e` aborts if a lookup fails.
MCP_CONTENT_PRODUCTION_SECRET="$(security find-generic-password -s drupal-mcp-content-production -w)"
export MCP_CONTENT_PRODUCTION_SECRET

exec node src/index.js
