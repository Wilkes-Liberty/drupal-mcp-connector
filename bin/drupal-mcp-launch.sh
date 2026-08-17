#!/bin/sh
# Launch the Drupal MCP connector for an MCP client.
#
# - cd's into the connector root so config/config.json resolves (the connector
#   reads it relative to the process working directory).
# - Trusts a local mkcert root via NODE_EXTRA_CA_CERTS when present.
# - Exec's node. Secret loading lives in src/lib/load-secrets.js so a client
#   that spawns `node src/index.js` directly gets the same behaviour as this
#   script: config/secrets.map (or the shipped example table), then refuse to
#   start if every clientSecretEnv/apiTokenEnv named in config.json is unset.
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

exec node src/index.js
