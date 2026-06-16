#!/bin/sh
# Launch the Drupal MCP connector for an MCP client (Claude Code / Claude Desktop).
#
# - cd's into the connector root so config/config.json resolves (the connector
#   reads it relative to the process working directory).
# - Sources the simple_oauth "mcp-agent" client secrets from the macOS login
#   Keychain and exposes them as the env vars the connector's per-site
#   oauth.clientSecretEnv values point at. Secrets never live in any client
#   config file or in this script.
#     prod    -> Keychain item 'drupal-mcp-agent-secret'     -> MCP_AGENT_CLIENT_SECRET
#     staging -> Keychain item 'drupal-mcp-agent-secret-stg' -> MCP_AGENT_CLIENT_SECRET_STG
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

MCP_AGENT_CLIENT_SECRET="$(security find-generic-password -s 'drupal-mcp-agent-secret' -w)"
export MCP_AGENT_CLIENT_SECRET

# Staging secret is optional — only export it if the Keychain item exists, so the
# launcher still works on machines that only have prod configured.
if MCP_AGENT_CLIENT_SECRET_STG="$(security find-generic-password -s 'drupal-mcp-agent-secret-stg' -w 2>/dev/null)"; then
  export MCP_AGENT_CLIENT_SECRET_STG
fi

exec node src/index.js
