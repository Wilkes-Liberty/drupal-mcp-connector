#!/bin/sh
# Launch the Drupal MCP connector for an MCP client (Claude Code / Claude Desktop).
#
# - cd's into the connector root so config/config.json resolves (the connector
#   reads it relative to the process working directory).
# - Sources the simple_oauth "mcp-agent" client secrets from the macOS login
#   Keychain and exposes them as the env vars the connector's per-site
#   oauth.clientSecretEnv values point at. Secrets never live in any client
#   config file or in this script.
#
#   The governance tiers map to secrets per environment, not per tier — the
#   dev and dev-admin sites share one DDEV consumer secret:
#     prod (content)               -> Keychain 'drupal-mcp-agent-secret'                 -> MCP_AGENT_CLIENT_SECRET
#     staging (content)            -> Keychain 'drupal-mcp-agent-secret-stg'             -> MCP_AGENT_CLIENT_SECRET_STG
#     dev (developer)              -> Keychain 'drupal-mcp-agent-secret-dev'             -> MCP_AGENT_CLIENT_SECRET_DEV
#     dev-admin (admin)            -> reuses MCP_AGENT_CLIENT_SECRET_DEV (same DDEV consumer)
#     prod-audit (config auditor)  -> Keychain 'drupal-mcp-auditor-secret'              -> MCP_AGENT_AUDITOR_SECRET
#     staging-audit (config audit) -> Keychain 'drupal-mcp-auditor-secret-stg'          -> MCP_AGENT_AUDITOR_SECRET_STG
#     prod-content-audit           -> Keychain 'drupal-mcp-content-auditor-secret'      -> MCP_AGENT_CONTENT_AUDITOR_SECRET
#     staging-content-audit        -> Keychain 'drupal-mcp-content-auditor-secret-stg'  -> MCP_AGENT_CONTENT_AUDITOR_SECRET_STG
#     prod-admin (break-glass)     -> Keychain 'drupal-mcp-admin-secret'                -> MCP_AGENT_ADMIN_SECRET
#
#   The break-glass admin is on-demand by secret presence: leave the
#   'drupal-mcp-admin-secret' Keychain item absent to keep prod-admin inert;
#   add it (and restart the client) only for the window you need elevated
#   prod access, then remove it again.
#
# Also trusts DDEV's locally-generated (mkcert) TLS cert via NODE_EXTRA_CA_CERTS so
# Node accepts https://*.wilkesliberty.dev. There is no per-site TLS flag in the
# connector — cert trust is environmental, which is why it is wired here.
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

# Dev secret is optional — local DDEV only. Sourced into the env var the 'dev'
# site's oauth.clientSecretEnv points at (MCP_AGENT_CLIENT_SECRET_DEV).
if MCP_AGENT_CLIENT_SECRET_DEV="$(security find-generic-password -s 'drupal-mcp-agent-secret-dev' -w 2>/dev/null)"; then
  export MCP_AGENT_CLIENT_SECRET_DEV
fi

# Read-only config-auditor secrets (optional) — the 'prod-audit'/'staging-audit'
# least-privilege identities. Only exported when the Keychain item exists, so the
# launcher is a silent no-op until the auditor consumers are provisioned
# (drush mcp-sentinel:agent-provision auditor --env=<env>).
if MCP_AGENT_AUDITOR_SECRET="$(security find-generic-password -s 'drupal-mcp-auditor-secret' -w 2>/dev/null)"; then
  export MCP_AGENT_AUDITOR_SECRET
fi
if MCP_AGENT_AUDITOR_SECRET_STG="$(security find-generic-password -s 'drupal-mcp-auditor-secret-stg' -w 2>/dev/null)"; then
  export MCP_AGENT_AUDITOR_SECRET_STG
fi

# Read-only content-auditor secrets (optional) — the 'prod-content-audit'/
# 'staging-content-audit' least-privilege identities (mcp_read only + the
# 'auditor' preset). Only exported when the Keychain item exists, so the
# launcher is a silent no-op until those consumers are provisioned
# (drush mcp-sentinel:agent-provision content-auditor --env=<env>).
if MCP_AGENT_CONTENT_AUDITOR_SECRET="$(security find-generic-password -s 'drupal-mcp-content-auditor-secret' -w 2>/dev/null)"; then
  export MCP_AGENT_CONTENT_AUDITOR_SECRET
fi
if MCP_AGENT_CONTENT_AUDITOR_SECRET_STG="$(security find-generic-password -s 'drupal-mcp-content-auditor-secret-stg' -w 2>/dev/null)"; then
  export MCP_AGENT_CONTENT_AUDITOR_SECRET_STG
fi

# Break-glass admin secret (optional, on-demand) — the 'prod-admin' full-tier
# identity. This is deliberately NOT a standing credential: the Keychain item
# is absent by default, so prod-admin is inert. Add 'drupal-mcp-admin-secret'
# (and restart the client) only for the window you need elevated prod access,
# then remove it. Provision the consumer with
# `drush mcp-sentinel:agent-provision admin --env=prod`.
if MCP_AGENT_ADMIN_SECRET="$(security find-generic-password -s 'drupal-mcp-admin-secret' -w 2>/dev/null)"; then
  export MCP_AGENT_ADMIN_SECRET
fi

# Trust DDEV's locally-generated (mkcert) root CA so Node accepts the dev site's
# HTTPS cert. Only set when mkcert and its root exist; harmless otherwise.
# If you also need a corporate/private CA (e.g. for api.int.wilkesliberty.com),
# concatenate both PEMs into one file and point NODE_EXTRA_CA_CERTS at that file.
if command -v mkcert >/dev/null 2>&1; then
  _mkcert_root="$(mkcert -CAROOT 2>/dev/null)/rootCA.pem"
  if [ -f "$_mkcert_root" ]; then
    export NODE_EXTRA_CA_CERTS="$_mkcert_root"
  fi
fi

exec node src/index.js
