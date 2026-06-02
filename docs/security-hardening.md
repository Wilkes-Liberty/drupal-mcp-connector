# Security Hardening (optional controls)

The connector ships safe-by-default and works with no extra setup. The controls below
are **optional** — enable the ones that fit your environment. Any specific products
mentioned here are examples only; none are required.

## MCP-client identity header (on by default)

Every outbound Drupal request sends `X-MCP-Client: drupal-mcp-server/<version>` and a
matching `User-Agent`. Governance layers (e.g. the MCP Sentinel Drupal module) can use
this to label and identify connector traffic without additional config.

Override the value with `MCP_CLIENT_ID`, or disable the header entirely by setting it
to an empty string:

```sh
export MCP_CLIENT_ID="my-org-bot/1.0"  # custom label
export MCP_CLIENT_ID=""                 # disable entirely
```

## Authenticate the HTTPS transport (opt-in)

The `https` transport serves `/mcp` to MCP clients. By default it runs without client
authentication (intended to sit behind a trusted boundary such as a VPN or an auth
proxy). To require a bearer token on every request:

```sh
export MCP_AUTH_TOKEN="<a long random secret>"
```

Clients must then send `Authorization: Bearer <token>`. The `/health` endpoint stays
open regardless.

If you front the connector with an auth proxy (e.g. an OAuth2/OIDC reverse proxy) or
restrict access via a VPN, you may rely on that boundary instead of `MCP_AUTH_TOKEN`.
The connector logs a startup warning when `/mcp` is unauthenticated so the choice is
always explicit.

## Bind address (opt-in)

With TLS configured, `MCP_BIND_HOST` restricts which network interface the server
listens on. Without TLS, the connector always binds loopback only. With TLS the default
is all interfaces — tighten it if you only want the server reachable from a specific
interface (e.g. a private-network IP or `127.0.0.1`):

```sh
export MCP_BIND_HOST="10.0.0.5"    # a private-network IP (e.g. from a VPN)
export MCP_BIND_HOST="127.0.0.1"   # loopback only
```

`NODE_EXTRA_CA_CERTS` can be set to trust a private or self-signed CA chain for
outbound HTTPS connections to Drupal.

## Keep tokens out of the config file (opt-in)

Per site, set `"apiTokenEnv": "VARNAME"` instead of hard-coding `"apiToken"`. The token
is then read from that environment variable at runtime:

```json
"production": {
  "baseUrl": "https://mysite.com",
  "apiTokenEnv": "DRUPAL_TOKEN_PRODUCTION"
}
```

Pair this with a secrets manager (any tool that injects secrets into the process
environment) to keep credentials out of config files. Keep `config/config.json` at
mode `600` regardless.

## Enforce strong auth per site (opt-in)

Per site, set `"requireSecureAuth": true` to enforce strict authentication requirements.
When this flag is set the connector will:

- Reject the site configuration if `baseUrl` is not HTTPS.
- Reject anonymous and HTTP Basic auth — a Bearer `apiToken` (or `apiTokenEnv`) is
  required.

```json
"production": {
  "baseUrl": "https://mysite.com",
  "apiTokenEnv": "DRUPAL_TOKEN_PRODUCTION",
  "requireSecureAuth": true
}
```

Recommended for production and write-plane sites. Sites that do not set this flag
continue to accept any auth method (including Basic auth and anonymous), making the
flag safe to adopt incrementally.

## Recommended write-plane posture

For a site where agents perform CRUD operations, the recommended posture is:

1. **Bearer token** — use `apiToken` or `apiTokenEnv`; prefer a least-privilege token
   scoped to the acting user/role rather than a super-admin credential.
2. **`requireSecureAuth: true`** — reject any accidental misconfiguration that would
   send credentials over plain HTTP or without auth.
3. **A scoped security preset** — set `"security": { "preset": "production-strict" }`
   (or a custom preset) to write only the entity types you intend; deny `user`/PII
   entity access.
4. **HTTPS over a trusted network** — use TLS + `MCP_BIND_HOST` to restrict exposure,
   and optionally front with a VPN or auth proxy.
5. **Drupal-side governance** — the Drupal module (allow/deny rules, audit log, content
   locks, rate limits) is the authoritative enforcement layer; the connector-side
   controls are a complementary defence-in-depth measure.
