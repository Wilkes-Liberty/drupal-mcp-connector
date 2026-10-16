# Security Hardening (optional controls)

The connector ships safe-by-default and works with no extra setup. The controls below
are **optional** — enable the ones that fit your environment. Any specific products
mentioned here are examples only; none are required.

## MCP-client identity header (on by default)

Every outbound Drupal request sends `X-MCP-Client: drupal-mcp-connector/<version>` and a
matching `User-Agent`. Governance layers (e.g. the MCP Sentinel Drupal module) can use
this to label and identify connector traffic without additional config.

Override the value with `MCP_CLIENT_ID`, or disable the header entirely by setting it
to an empty string:

```sh
export MCP_CLIENT_ID="my-org-bot/1.0"  # custom label
export MCP_CLIENT_ID=""                 # disable entirely
```

## Authenticate the HTTPS transport

The `https` transport serves `/mcp` to MCP clients.

**Network-facing product path (required):** if the process binds beyond loopback
(`MCP_BIND_HOST` other than `127.0.0.1` / `::1` / `localhost`, or the TLS default
`0.0.0.0`), the connector is an OAuth **protected resource**. Configure exactly
one issuer (RFC 8414 / OIDC discovery), the resource audience, and RFC 7662
introspection. Startup refuses to listen when any of those are missing
(DEV-844). `MCP_AUTH_TOKEN` was removed in 4.0.0 (#231); setting it is
fatal at startup.

```json
"auth": {
  "issuer": "https://idp.example.com",
  "audience": "https://mcp.example.com/mcp",
  "resource": "https://mcp.example.com/mcp",
  "requiredScopes": ["mcp_read"],
  "maxTokenLifetime": 3600,
  "algorithms": ["RS256", "ES256"],
  "introspectionUrl": "https://idp.example.com/introspect",
  "introspectionTimeoutMs": 2000,
  "introspectionClientIdEnv": "MCP_INTROSPECTION_CLIENT_ID",
  "introspectionClientSecretEnv": "MCP_INTROSPECTION_CLIENT_SECRET"
}
```

```sh
export MCP_RESOURCE_ISSUER="https://idp.example.com"
export MCP_RESOURCE_AUDIENCE="https://mcp.example.com/mcp"
export MCP_INTROSPECTION_URL="https://idp.example.com/introspect"
export MCP_INTROSPECTION_CLIENT_ID="mcp-connector"
export MCP_INTROSPECTION_CLIENT_SECRET="…from the issuer, never committed…"
export MCP_INTROSPECTION_TIMEOUT_MS="2000"
export MCP_MAX_TOKEN_LIFETIME="3600"
export MCP_TOKEN_ALGORITHMS="RS256,ES256"
```

Clients send `Authorization: Bearer <access-token>`. Every authenticated
network call is introspected at the issuer (RFC 7662). There is **no positive
cache**: a revoke takes effect on the next call. Introspection unreachable,
timed out (default **2s**), or errored is **503** and the tool never runs.
`active: false` is **401**. `iss` must be present and equal the configured
issuer; audience is an exact match against the one configured plane. JWT
algorithms are pinned (`none` never; `HS*` only when explicitly configured).
Issuer discovery and JWKS retrieval abort after 30s; introspection uses the
shorter timeout above. A stuck issuer fails closed.

**Governed writes re-introspect (DEV-846).** Immediately before a write
commits (JSON:API mutating methods, GraphQL mutations, uploads, and
write-like MCP tools), the connector introspects the same bearer again.
`active !== true` or Paladin `killed: true` aborts with
`A verified principal context is required.` The 8s `/ready` probe cache
is not consulted here, so a kill cannot hide behind that window. Matching
in-flight calls in **this process** are cancelled (global cap 128, 16 per
principal; the per-principal cap keys on the exact `iss|sub|actor`
string, so a second `azp` is a second principal). The introspection body
is never echoed. A network-origin call with no bearer is denied,
including loopback `MCP_ALLOW_UNAUTHENTICATED`; only stdio may skip. On
the hosted relay the edge re-introspects before fan-down (the Paladin
bearer never crosses the
tunnel) and stamps `tokenLive` so the tenant agent does not fail open.
Cancel-on-kill does not cross that process boundary, and there is no
Paladin kill subscription.

**Tenant comes from the token (DEV-839).** Network calls take tenant only
from the Paladin `tenant` claim. `X-MCP-Tenant`, `X-Forwarded-Tenant`,
and a `tenant` tool argument are not authority. A missing claim is the
same generic deny. Session, rate-limit, and budget keys are
`iss|sub|actor` from the mcp_sentinel twin, never `client_id`.
**Breaking:** a hosted token with no `tenant` claim, or with only
`client_id` and no `azp`/`act.sub`, is denied, and existing session and
rate-limit buckets reset onto the new formula.

The JSON revocation file (`{ "jti": [], "sub": [] }`) is not read on stdio.
Stdio has no bearer authentication or revocation path. The file is also
not an authority on network admission: a hosted bind accepts or rejects a
bearer from the live introspection result. Do not treat a file revoke as
sufficient for a hosted bind.

**Bearer lifetime and algorithms (DEV-876).** Access tokens must carry numeric
`exp` and `iat`. `exp` must still be in the future (jose `clockTolerance`,
default 5 seconds). `iat` must not be in the future beyond that same
tolerance. `exp - iat` must not exceed `auth.maxTokenLifetime`
(default **3600** seconds), and a token whose `iat` is older than that cap is
also refused (`maxTokenAge` on the JWT path; the same local check on
introspection). Pin `auth.algorithms` to the asymmetric algorithms your issuer
actually uses. The documented default is `RS256`/`RS384`/`RS512`,
`ES256`/`ES384`/`ES512`, `PS256`/`PS384`/`PS512`, `EdDSA`. `alg: none` is
never accepted, even if named in config. HMAC (`HS*`) is not in the default
so a JWKS public key cannot be treated as a shared secret. Env overrides:
`MCP_MAX_TOKEN_LIFETIME` (seconds) and `MCP_TOKEN_ALGORITHMS` (comma- or
space-separated). **Breaking:** an authorization server that mints tokens
without `exp`/`iat`, or with a lifetime longer than the cap, gets
`401 invalid_token`. Raise the cap only when the issuer cannot issue shorter
access tokens. `exp` is an exclusive boundary on both paths: a token is
refused from its `exp` second onward (less `clockTolerance`). When
introspection is configured, a compact JWS whose protected header names an
algorithm outside `auth.algorithms` (or `none`) is refused before the
introspection call, so the allowlist cannot be bypassed by letting local
verification fail and treating the token as opaque. Tokens that are not a
decodable three-segment JWS are still introspected.

**Missing `iss` on introspection is refused.** When `auth.issuer` is
configured, an RFC 7662 result without `iss` (or with a different issuer) is
`401 invalid_token`. Audience was already fail-closed when missing; issuer is
now the same. The introspection URL is configured independently of the
issuer, so an `active: true` body that does not name the authorization server
cannot be bound to this resource. Ask the authorization server to return
`iss` (RFC 7662 recommends it). JWT validation already required `iss` via
`jwtVerify({ issuer })`.

Unauthenticated clients receive `401` with a `WWW-Authenticate` challenge that
points at RFC 9728 metadata. On a configured resource server and on the relay
edge, the same pointer is on every 401 (missing, invalid, expired, or
wrong-audience token; authenticator throw; unresolved identity; edge `/usage`
and `/assessor`). Unauthenticated loopback serves no metadata document, so a
refusal there is a `Bearer` challenge with `error="invalid_token"` and no
`resource_metadata`:

`GET /.well-known/oauth-protected-resource` (and `/mcp` on that path).

After the token is accepted, tool / resource / prompt / site discovery is
filtered by that principal (#178). A **built-in** tool without an explicit
`requiredScopes` row in the deny-by-default scope table is omitted from
`tools/list` and refused on `tools/call` (DEV-862). Hosted/network startup
is fatal when any registered built-in tool is missing from the table or has
empty `requiredScopes`. Module-owned tools (`drupal_module_*`) are the one
exception: they are appended by the module-tool registry and gated by the
`scope` their binding policy declares, not by a table row. `auth.grants` (optional) maps inbound `client_id` / `azp`
to configured site names; when the map is present, unknown clients see no
targets. When the map is omitted, a token with no `sites` / `mcp_sites`
claim is entitled to no sites (DEV-848). Caller-supplied `site` /
`environment` / `tenant` / `target` arguments cannot widen the grant.
Stdio has no bearer authentication or revocation path. Loopback with no
resource-server config stays the local operator. A loopback bind that sets
`auth.issuer` or `auth.audience` without a complete resource server refuses
to start. The scope-table gate still applies on any network listener.

`/health` stays open as a liveness probe (`{status: "ok"}`) and does
not expose a tool catalog. Missing a required scope is `403` with
`error="insufficient_scope"`.

`GET /ready` and `GET /metrics` are not served on the public listener
(normal `401` or `404`). They exist only when `MCP_OPS_LISTEN` / `ops.listen`
is set, on a second socket that may bind loopback or Tailscale
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) only — `0.0.0.0`, `::`, port 0,
and any other public or non-mesh address are fatal (DEV-863). **The ops
listener has no authentication.** `100.64.0.0/10` is also carrier-grade
NAT (CGNAT) space, not Tailscale-only: confirm the bind address is
actually a Tailscale interface, and restrict the port with Tailscale
ACLs so arbitrary tailnet peers cannot scrape `/ready` or `/metrics`.
`/ready` is `200` only on a 2xx introspection response with an RFC 7662
body (`active` boolean) plus a complete hosted scope table and
allowlists; `401` / `404` / `5xx` are `503`. Probes are single-flighted
and cached for a few seconds so mesh peers cannot amplify traffic to the
identity provider. `/metrics` is Prometheus text with no principals,
subjects, client ids, tokens, tenants, or IPs.

The inbound access token is never forwarded to Drupal. Outbound Drupal
credentials stay the per-site OAuth client or `apiTokenEnv`.

**Loopback:** the shared bearer (`MCP_AUTH_TOKEN`) was removed in 4.0.0 (#231).
Loopback HTTPS is unauthenticated (local operator) only when no resource-server
config is present. Once `auth.issuer` or `auth.audience` is set, startup
requires the complete resource server (issuer, audience, and RFC 7662
introspection) and names any missing setting. An incomplete loopback config
is fatal and does not fall through to unauthenticated. A set `MCP_AUTH_TOKEN`
is fatal at startup.
**`MCP_ALLOW_UNAUTHENTICATED=1`** is loopback-only, and on loopback it does
not override a partial resource server. Remove the resource-server settings
to run unauthenticated. A non-loopback bind with that flag is fatal at
startup (DEV-845). There is no trusted-proxy exception
beyond loopback: network-facing HTTPS requires `auth.issuer` + `auth.audience`
+ RFC 7662 introspection.

For `/mcp`, rate limiting and bearer authentication run before any request body
is parsed, converted, or classified. After a resolved identity, the handler
validates `Origin` (DNS-rebinding), `MCP-Protocol-Version`, and `Accept`, then
refuses JSON-RPC batches. POST bodies are bounded to 1 MiB, read once, and
dispatched to exactly one era. Current 2026-07-28 requests are stateless;
2025-era sessions are accepted by default, bound to the authenticated
principal (`iss|sub|actor` from the Paladin token), and can be disabled with:

```sh
export MCP_LEGACY_TRANSPORT=reject
export MCP_ALLOWED_ORIGINS="https://app.example.com"
```

`auth.allowedOrigins` / `MCP_ALLOWED_ORIGINS` is the Streamable HTTP Origin
allowlist. Matching is exact (`https://host[:port]` after URL normalization);
there are no wildcards. This guard only limits browsers and DNS rebinding.
It does not authenticate clients. A request with no `Origin` header is
allowed by design so non-browser clients (desktop Cursor, Grok Bot, curl,
CI) can connect; missing identity is still `401` before dispatch. A present
`Origin` that is not on the list is `403` (`bad_origin` on the audit row).
An omitted or empty extra list refuses every present third-party Origin
(fail closed, DEV-953). The origin of `auth.resource` / `auth.audience` is
still auto-included, so a same-origin browser of the MCP resource URL is
allowed even when the extra list is empty. The example config lists the
HTTPS Origins of the keystone#1539 `cursor-mcp` and `grok-bot` clients:
`https://cursor.com`, `https://www.cursor.com`, `https://grok.com`, and
`https://console.x.ai`. Matching is exact only — no wildcards, no suffix
match, and the request Origin is never reflected. Lookalikes such as
`http://cursor.com` or `https://cursor.com.evil.test` stay refused. A
present `MCP_ALLOWED_ORIGINS`, including empty, replaces the extra list
(the resource/audience origin is still added after that).

`auth.allowedHosts` / `MCP_ALLOWED_HOSTS` is the Host allowlist (DEV-861).
After a resolved identity, a missing or disallowed `Host` is `403`. The
default list is the host of `auth.resource` / `auth.audience`; a loopback
bind also includes `localhost`, `127.0.0.1`, and `::1`. A hostname-only
entry matches any port. Unauthenticated requests still receive the shared
`401` with `resource_metadata` first. Session ids never replace per-request
token validation: a stolen `Mcp-Session-Id` presented with another
principal's bearer is `403`.

Unexpected conversion/classification/dispatch failures return only a generic
500 before headers. If a handler already began a response, the connection is
terminated without a second response. Diagnostics receive the failed stage,
not the raw error or credentials.

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

## Rate limiting

The HTTPS transport throttles `/mcp` with a built-in fixed-window limiter
(DEV-860):

- **Unauthenticated** requests (no Bearer) are limited **per client address
  before any auth work**. A request still under that limit is refused with the
  shared 401 writer (`writeUnauthorized`, DEV-845 / DEV-877). A 429 body is
  only `Too Many Requests` and never includes tool data.
- **Authenticated** requests are limited **per verified principal**
  (`iss|sub|actor` from the Paladin token via the mcp_sentinel twin).
  Caller-supplied identity headers (`X-MCP-Subject`, `X-Forwarded-User`,
  …) are never the key. `client_id` is never the actor.
- **Non-loopback TLS bind:** defaults to **120 requests per 60s** for both
  gates when `MCP_RATE_LIMIT` is unset.
- **Loopback / plain-HTTP dev:** off unless you set a positive `MCP_RATE_LIMIT`.
- Set `MCP_RATE_LIMIT=0` to disable even on non-loopback. `MCP_PRINCIPAL_RATE_LIMIT`
  overrides the post-auth gate only.
- Tracked keys are hard-capped (`MCP_RATE_MAX_KEYS`, default 10_000) so
  spraying principals or addresses cannot grow limiter memory without bound.

```sh
export MCP_RATE_LIMIT=120              # per-address (unauth) and default per-principal
export MCP_PRINCIPAL_RATE_LIMIT=120    # optional post-auth override
export MCP_RATE_WINDOW_SEC=60          # window length in seconds (default 60)
export MCP_RATE_MAX_KEYS=10000         # hard cap on tracked keys (default 10000)
export MCP_TRUSTED_PROXIES=""          # default: trust none
```

`X-Forwarded-For` is honored **only** when the immediate peer is on
`MCP_TRUSTED_PROXIES` or `auth.trustedProxies` (CIDR or single IP). The
default list is empty: a spoofed forwarded header from an untrusted peer is
ignored and the socket address is used. There is still no trusted-proxy
exception to the DEV-845 loopback-only unauthenticated bind.

Over-limit requests get `429 Too Many Requests` with a `Retry-After` header.
The `/health` probe is never rate limited.

Counts are kept per process, so this protects a single connector instance. For
multi-replica deployments, prefer rate limiting at the reverse proxy (shared
state) — or use both. This change does not claim a hosted MCP URL is live.

## Local file upload roots

`drupal_upload_file` and `drupal_upload_file_and_create_media` may only read files
that resolve under an allowed root (after `realpath`). Default root is the
connector process working directory. Expand or replace roots with:

```sh
export MCP_UPLOAD_ROOT="/var/mcp-uploads:/home/editor/media-drop"
```

Paths under `.ssh`, `.gnupg`, `.env*`, and connector `config/config.json` are
always refused, even when under an allowed root. Entity type, bundle, and field
name path segments are validated as Drupal machine names.

## Per-machine secret map

`bin/drupal-mcp-launch.sh` sets the working directory and (when present) a
local mkcert CA. If the secret table and `config.json` share no
`clientSecretEnv` / `apiTokenEnv` names, it prints one stderr line naming
the mismatch. **Secret loading still runs inside `node src/index.js`**,
because MCP clients often spawn that file directly.

The shipped Keychain table matches `config/config.example.json`. If your
`config/config.json` uses different `oauth.clientSecretEnv` names, put the
mapping in **`config/secrets.map`** (gitignored):

```
MCP_AGENT_CLIENT_SECRET=drupal-mcp-agent-secret
```

One `ENV_VAR=keychain-item` pair per line. `#` comments allowed. The file
**replaces** the shipped table, it does not merge with it.

If `config.json` names secret env vars and **none** of them are set after
that step, the process exits 1 and names the variables. It will not start a
server that can only advertise diagnostic tools. A single named variable
being unset (an inert break-glass tier) is a warning, not a fatal.

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


### HTTP tool audit outcomes

Each finished HTTP request still emits one audit row with its transport status
and transport `code`. A dispatched tool call additionally carries `toolOutcome`:
`success`, `error`, or `denied`. A tool refusal can legitimately have HTTP 200,
so monitoring must inspect this outcome as well as the HTTP status.

The connector marks `denied` when its authorization code handles a
`SecurityError`; it does not classify message text from tools or backends.
The outer SDK tool-call result determines `success` or `error` for ordinary
results and thrown failures. A marked authorization denial takes precedence
over that result, including a nested refusal handled by an outer tool. An
ordinary nested error handled successfully by the outer tool is not itself a
request-level error. Requests that never dispatch a tool omit `toolOutcome`.

The outcome is a closed enum stored in request-local context and sanitized
alongside the verified principal and tenant. Tool names, arguments, results,
error messages, headers and tokens are not added to the row. Logging failure
does not change an authorization decision or enable a fallback credential.

### HTTP audit actor classification

`principal` is copied only from an identity the handler has already bound:
`sub`, or `clientId` when `sub` is absent. A bound loopback local operator
has no OAuth principal, so that row omits both `principal` and `actor`.

When no identity is bound, the row carries `actor` instead:

| `actor` | When |
| --- | --- |
| `anonymous` | The request has no `Authorization` header. |
| `unverified` | An `Authorization` header is present and verification did not bind an identity. This includes invalid, expired, revoked, and wrong-audience credentials, and an issuer that cannot be reached. |

`actor` is omitted once an identity is bound. A denial after that bind
(tool authorization, Host, or Origin) keeps `principal`. An auth-layer
refusal that does not bind an identity, such as a missing scope, stays
`unverified` and has no `principal`.

The field is additive. Consumers that only read `principal` keep working.
`actor` is a closed enum; any other value is dropped. Classification uses
header presence and the bound identity. It does not decode tokens. Bearer
tokens, cookies, and other credentials stay scrubbed from the row.
