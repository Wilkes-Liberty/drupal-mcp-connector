#!/bin/sh
# Launch the Drupal MCP connector for an MCP client (Claude Code / Claude Desktop).
#
# - cd's into the connector root so config/config.json resolves (the connector
#   reads it relative to the process working directory).
# - Sources each site's OAuth client secret from the macOS login Keychain and
#   exposes it as the env var that site's oauth.clientSecretEnv points at.
#   Secrets never live in any client config file, or in this script.
#
# The mapping is DATA, not code: one "ENV_VAR=keychain-item" pair per line in
# the table below, so this launcher fits any deployment without being edited
# into a description of one. The shipped table matches the tiers in
# config/config.example.json — replace the pairs with your own, or keep the
# table empty here and put your pairs in config/secrets.map (gitignored, one
# pair per line, '#' comments allowed), which takes precedence when present.
#
# Every lookup is OPTIONAL: a pair whose Keychain item does not exist is
# skipped silently, so one launcher serves a machine that has only some of the
# tiers provisioned. That is also the on-demand break-glass pattern — leave the
# admin tier's Keychain item absent to keep that site inert, add it only for
# the window you need it, then remove it again.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Default table: ENV_VAR=keychain-item, matching config/config.example.json.
SECRET_MAP="
MCP_CONTENT_PRODUCTION_SECRET=drupal-mcp-content-production
MCP_CONTENT_STAGING_SECRET=drupal-mcp-content-staging
MCP_DEVELOPER_DEVELOPMENT_SECRET=drupal-mcp-developer-development
MCP_ADMIN_BREAKGLASS_SECRET=drupal-mcp-admin-breakglass
"

# A per-machine table overrides the default one.
if [ -f config/secrets.map ]; then
  SECRET_MAP="$(sed 's/#.*//' config/secrets.map)"
fi

# Iterate in THIS shell, not a subshell: a `... | while read` pipeline would
# export into a child that exits immediately, leaving every secret unset while
# the script still reported success.
_old_ifs="$IFS"
IFS='
'
for _pair in $SECRET_MAP; do
  IFS="$_old_ifs"
  case "$_pair" in *=*) ;; *) IFS='
'; continue ;; esac
  _var="$(printf '%s' "${_pair%%=*}" | tr -d '[:space:]')"
  _item="$(printf '%s' "${_pair#*=}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [ -n "$_var" ] && [ -n "$_item" ]; then
    if _value="$(security find-generic-password -s "$_item" -w 2>/dev/null)"; then
      export "$_var=$_value"
    fi
  fi
  IFS='
'
done
IFS="$_old_ifs"

# Trust a locally-generated development root CA (e.g. mkcert) so Node accepts a
# local site's HTTPS certificate. Only set when mkcert and its root exist;
# harmless otherwise. If you also need a private/corporate CA for an internal
# host, concatenate both PEMs into one file and point NODE_EXTRA_CA_CERTS at it.
if command -v mkcert >/dev/null 2>&1; then
  _mkcert_root="$(mkcert -CAROOT 2>/dev/null)/rootCA.pem"
  if [ -f "$_mkcert_root" ]; then
    export NODE_EXTRA_CA_CERTS="$_mkcert_root"
  fi
fi

exec node src/index.js
