#!/bin/sh
# Launch the Drupal MCP connector for an MCP client.
#
# - cd's into the connector root so config/config.json resolves (the connector
#   reads it relative to the process working directory).
# - Trusts a local mkcert root via NODE_EXTRA_CA_CERTS when present.
# - Warns when the secret table and config.json share no env-var names.
#   Per-item Keychain misses stay silent (break-glass). Lookup itself lives
#   in src/lib/load-secrets.js so a client that spawns `node src/index.js`
#   still applies config/secrets.map and refuses to start if every named
#   secret is unset.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

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

# Zero-overlap check only. Table var names must stay in sync with
# DEFAULT_SECRET_PAIRS in src/lib/load-secrets.js.
warn_secret_table_mismatch() {
  _cfg="$DIR/config/config.json"
  [ -f "$_cfg" ] || return 0

  _table=" "
  _src="default"
  if [ -f "$DIR/config/secrets.map" ]; then
    _src="map"
    _map_body=$(sed -e 's/\r$//' -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$DIR/config/secrets.map" 2>/dev/null) || _map_body=""
    while IFS= read -r _line || [ -n "${_line-}" ]; do
      case "$_line" in
        *=*)
          _var=${_line%%=*}
          _item=${_line#*=}
          if [ -n "$_var" ] && [ -n "$_item" ]; then
            _table="$_table$_var "
          fi
          ;;
      esac
    done <<EOF
$_map_body
EOF
  else
    _table=" MCP_CONTENT_PRODUCTION_SECRET MCP_CONTENT_STAGING_SECRET MCP_DEVELOPER_DEVELOPMENT_SECRET MCP_ADMIN_BREAKGLASS_SECRET "
  fi

  # Quote-split so a minified one-line config.json still yields every name.
  # After the key token, the next token is `: `, then the value.
  _named=""
  _ncount=0
  _overlap=0
  _unset=""
  _take=
  _cfg_tokens=$(tr '"' '\n' < "$_cfg" 2>/dev/null | tr -d '\r') || return 0
  while IFS= read -r _tok || [ -n "${_tok-}" ]; do
    if [ "$_take" = "colon" ]; then
      _take="value"
      continue
    fi
    if [ "$_take" = "value" ]; then
      _take=
      [ -n "$_tok" ] || continue
      case " $_named " in
        *" $_tok "*) continue ;;
      esac
      _named="$_named$_tok "
      _ncount=$((_ncount + 1))
      case "$_table" in
        *" $_tok "*) _overlap=$((_overlap + 1)) ;;
      esac
      if [ -z "$(printenv "$_tok" 2>/dev/null || true)" ]; then
        _unset="$_unset$_tok "
      fi
      continue
    fi
    if [ "$_tok" = "clientSecretEnv" ] || [ "$_tok" = "apiTokenEnv" ]; then
      _take="colon"
    fi
  done <<EOF
$_cfg_tokens
EOF

  [ "$_ncount" -gt 0 ] || return 0
  [ "$_overlap" -eq 0 ] || return 0

  _list=$(printf '%s' "$_named" | sed -e 's/[[:space:]]*$//' -e 's/[[:space:]]\{1,\}/, /g') || return 0
  if [ -n "$_unset" ]; then
    _closer="Unset: $(printf '%s' "$_unset" | sed -e 's/[[:space:]]*$//' -e 's/[[:space:]]\{1,\}/, /g'). Those sites will fail closed."
  else
    _closer="Named secrets already in the environment stay set; the table will not populate any of them."
  fi
  if [ "$_src" = "default" ]; then
    printf '%s\n' "drupal-mcp-launch: no secret-table entries match clientSecretEnv/apiTokenEnv names in config.json ($_list); using shipped defaults; config/secrets.map is absent. $_closer" >&2
  else
    printf '%s\n' "drupal-mcp-launch: no secret-table entries match clientSecretEnv/apiTokenEnv names in config.json ($_list); config/secrets.map does not name them. $_closer" >&2
  fi
}

# A diagnostic failure must not prevent start. Node still loads secrets.
set +e
warn_secret_table_mismatch
set -e

exec node src/index.js
