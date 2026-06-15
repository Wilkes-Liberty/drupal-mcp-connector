#!/bin/sh
# Example launcher for the drupal-mcp-connector.
#
# Set this script as the MCP server `command` in your MCP client. It resolves
# the OAuth client secret from a secret manager at launch time and execs the
# connector, so the secret never lands in any MCP client config file or on disk.
#
# Why a launcher (vs. an `env` block in the client config)?
#   - Keeps the secret out of plaintext client config (e.g. claude_desktop_config.json).
#   - GUI MCP clients do not inherit your shell environment, so sourcing the
#     secret here is more reliable than `export` in a shell profile.
#
# Configure via environment (all optional):
#   MCP_SECRET_ENV   Name of the env var the connector expects — must match
#                    `oauth.clientSecretEnv` in config/config.json.
#                    Default: MCP_CLIENT_SECRET
#   MCP_SECRET_CMD   A shell command that prints the secret to stdout.
#                    Default: a macOS Keychain lookup (edit for your platform).
#
# Examples for MCP_SECRET_CMD:
#   macOS Keychain:  security find-generic-password -s drupal-mcp-secret -w
#   pass:            pass show drupal-mcp/secret
#   HashiCorp Vault: vault kv get -field=secret secret/drupal-mcp
#   1Password CLI:   op read op://vault/drupal-mcp/secret
set -eu

# The connector reads config/config.json relative to the working directory,
# so run from the connector root (this script lives in examples/).
script_dir="$(dirname -- "$0")"
cd "$script_dir/.." || { echo "launch-with-secret: cannot cd to connector root" >&2; exit 1; }

SECRET_ENV="${MCP_SECRET_ENV:-MCP_CLIENT_SECRET}"
SECRET_CMD="${MCP_SECRET_CMD:-security find-generic-password -s drupal-mcp-secret -w}"

secret="$(sh -c "$SECRET_CMD")"
if [ -z "$secret" ]; then
  echo "launch-with-secret: resolved an empty secret (check MCP_SECRET_CMD)" >&2
  exit 1
fi

# Export under the configured name. `env` avoids eval on the secret value.
exec env "$SECRET_ENV=$secret" node src/index.js
