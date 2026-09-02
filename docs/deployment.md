# Production Deployment (HTTPS transport)

This guide covers running the connector as a long-lived **HTTPS service** for
remote/hosted MCP clients (Grok API, ChatGPT/Responses API). For local CLIs
(Claude Code/Desktop, Grok Build, Codex) use **stdio** instead — it needs no
service, port, or token; see [mcp-clients.md](mcp-clients.md).

> **Reachability first.** The connector must run somewhere that can reach Drupal
> *and* be reached by the client. If Drupal is on a private network/VPN, run the
> connector on a host that's on that network and exposed (hardened) to the
> client — or front it with a tunnel. Don't widen Drupal's exposure more than
> necessary; the Drupal-side governance module stays the authoritative gate.

## Required environment

| Var | Purpose |
|---|---|
| `MCP_TRANSPORT=https` | Run the HTTP server transport |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | TLS cert + key (mandatory off-localhost) |
| `MCP_RESOURCE_ISSUER` / `MCP_RESOURCE_AUDIENCE` | Inbound OAuth resource server — **required** for non-loopback binds (or set `auth` in config) |
| `MCP_AUTH_TOKEN` | Shared bearer — **loopback only**; refused on a network-facing product path |
| `MCP_ALLOW_UNAUTHENTICATED` | Set to `1` only when a trusted proxy already authenticates clients |
| `MCP_RATE_LIMIT` | Max `/mcp` requests per window per IP (`0` = off; default 120 on non-loopback TLS) |
| `MCP_UPLOAD_ROOT` | Colon-separated absolute dirs allowed for local file uploads (default: process cwd) |
| `MCP_BIND_HOST` | Restrict the listen interface (with TLS) |
| `MCP_RATE_LIMIT` / `MCP_RATE_WINDOW_SEC` | Optional per-IP rate limiting (see [security-hardening.md](security-hardening.md)) |
| `MCP_PORT` | Listen port (default 3443) |
| `MCP_LEGACY_TRANSPORT` | `serve` (default) or `reject` for 2025-era HTTP clients |

Provide the Drupal connection via a mounted `config/config.json` or the
single-site `DRUPAL_*` env vars. Keep all secrets out of config files and images
— use an env file (systemd), a secret manager (launchd/Keychain), or your
orchestrator's secrets.

## Option A — Docker

```sh
docker build -t drupal-mcp-connector .
docker run -d --name drupal-mcp \
  -p 3443:3443 \
  -v /etc/drupal-mcp/config.json:/app/config/config.json:ro \
  -v /etc/ssl/drupal-mcp:/certs:ro \
  -e TLS_CERT_PATH=/certs/tls.crt -e TLS_KEY_PATH=/certs/tls.key \
  -e MCP_RESOURCE_ISSUER="$MCP_RESOURCE_ISSUER" \
  -e MCP_RESOURCE_AUDIENCE="$MCP_RESOURCE_AUDIENCE" \
  -e MCP_RATE_LIMIT=120 \
  drupal-mcp-connector
```

The image runs as a non-root user and ships only production deps + `src/`. See
[`Dockerfile`](../Dockerfile) / [`.dockerignore`](../.dockerignore). The built-in
`HEALTHCHECK` is a TCP liveness probe; for an L7 check, point your orchestrator at
`GET /health` using the cert's real hostname.

## Option B — systemd (Linux)

Use [`deploy/systemd/drupal-mcp-connector.service`](../deploy/systemd/drupal-mcp-connector.service).
Put secrets in `/etc/drupal-mcp-connector/secrets.env` (mode 600, not in git):

```sh
sudo cp deploy/systemd/drupal-mcp-connector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now drupal-mcp-connector
```

The unit includes hardening (`NoNewPrivileges`, `ProtectSystem=strict`, dropped
capabilities). Adjust paths/user to your install.

## Option C — launchd (macOS)

Use [`deploy/launchd/com.example.drupal-mcp-connector.plist`](../deploy/launchd/com.example.drupal-mcp-connector.plist)
+ [`deploy/launchd/run.sh`](../deploy/launchd/run.sh) (sources secrets from the
Keychain so they stay out of the plist):

```sh
cp deploy/launchd/com.example.drupal-mcp-connector.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.example.drupal-mcp-connector.plist
```

## Fronting with a reverse proxy

To terminate public TLS and add IP allow-listing, put Caddy/nginx in front and
bind the connector to loopback. See [`deploy/Caddyfile.example`](../deploy/Caddyfile.example).
Bind the connector to loopback and keep a loopback `MCP_AUTH_TOKEN`, or configure
the inbound resource server even behind the proxy (defense in depth). Restrict
to the client vendor's documented egress range where you can.

## Pre-exposure checklist

- [ ] TLS configured (`TLS_CERT_PATH`/`TLS_KEY_PATH`) — never plain HTTP off localhost.
- [ ] Inbound resource server configured (`auth.issuer` + `auth.audience`), or loopback + `MCP_AUTH_TOKEN`.
- [ ] `MCP_BIND_HOST` and/or proxy IP allow-list restrict who can reach `/mcp`.
- [ ] `MCP_RATE_LIMIT` enabled (or rate limiting at the proxy).
- [ ] Secrets sourced from an env file / secret manager — not in config or the image.
- [ ] Drupal-side governance (e.g. MCP Sentinel) active — the authoritative policy.
- [ ] `/health` returns 200; tools enumerate over the endpoint.
- [ ] A pinned MCP v2 client proves 2026-07-28 `server/discover`, stateless tool
      calls, and malformed/mismatched request rejection in this environment.
- [ ] If legacy clients are unnecessary, set `MCP_LEGACY_TRANSPORT=reject`; if
      retained, record their owner and removal date.

## Transport compatibility and exposure claims

The single `/mcp` endpoint serves both eras, but they have different state
contracts. Current 2026-07-28 POSTs are request-scoped and do not issue
`Mcp-Session-Id`; 2025-era clients use a session created only by `initialize`.
Bearer authentication and rate limiting precede body parsing and era
classification. A successful local or non-production test is not evidence of a
production public URL: record the client version, gateway configuration,
protocol mismatch tests, date, and artifact separately before making an
exposure claim.

## Relay edge and tenant agent (outbound path)

`drupal-mcp-edge` and `drupal-mcp-agent` (#232) split the deployment into an
authenticated northbound edge and a tenant-side agent that dials out, so the
Drupal site and its credentials never face inbound traffic. These are entry
points and libraries; running them is not a hosted service, and nothing in this
section is a production-exposure claim.

**The edge** terminates northbound `/mcp` on the inbound OAuth resource server
— the only authentication arm compiled into this entry point. `MCP_AUTH_TOKEN`
and `MCP_ALLOW_UNAUTHENTICATED` are not read. Startup refuses without all of:

- `auth.issuer` + `auth.audience` (an HTTPS resource identifier), at any bind
  host including loopback;
- a non-empty `auth.grants` table (client id → site names) — the library's
  all-sites fallback does not apply here;
- optional `auth.tenantGrants` (client id → tenant agent ids). When present,
  tenant routing is token-resolved: the JWT `azp` selects the tenant, caller
  `tenant` / `site` arguments are hints inside that grant, and a hint for
  another tenant is `not_entitled` with no fan-down. Omit the table to keep
  the single-agent site-derived path;
- optional `auth.actors` (`sub` or client id → `{ uuid, delegators? }`). When
  present, write-like `tools/call` requires a mapped Drupal user UUID. The
  granted actor is stamped on `identity.actor`; JWT `act.sub` is a confirming
  hint inside `delegators` and becomes `identity.delegator`. Caller `actor` /
  `delegator` arguments and spoofable identity headers are never authority.
  Unmapped or disallowed-delegation writes are `not_entitled` with no
  fan-down. Omit to keep writes on the site OAuth consumer's owner account;
- optional `auth.policies` (`sub` or client id → SHA-256 digest). When
  present, non-diagnostic `tools/call` requires a mapped digest. The
  granted digest is stamped on `identity.policy` and
  `correlation.policyDigest`. Caller `policy` / `digest` arguments are
  never authority. Unmapped calls (including a missing tool name) are
  `not_entitled` with no fan-down. Diagnostic tools stay callable. Omit
  to keep the prior path (no digest required at the edge). Local
  verify/activate/attest stays on Sentinel;
- optional `auth.promotions` (digest → `{ document, approvals }`). W&L-operated
  dual-control of an already-sealed portable bundle: two distinct operator
  ids, document digest matching the map key, seal prefixed `hmac-sha256:`.
  When the table is present, the edge fans each eligible document down the
  agent channel as a `policy-bundle` frame after hello. Non-diagnostic
  `tools/call` then requires the bound `auth.policies` digest **and** a
  matching agent attestation (`policy-bundle-ack`). Missing promotion,
  missing attestation, or a digest mismatch is `not_entitled` with no
  fan-down. The edge never mints a Sentinel HMAC key. Omit to keep the
  digest-only path. Tenant self-service is not this table;
- optional `auth.quotas` (`tenants` / `principals` rows of
  `{ requests, windowSec }`, plus `abuse: { denials, windowSec, lockSec }`).
  When a `tenants` or `principals` table names any id, a request for a
  tenant or principal without a row is `not_entitled`; an exhausted window
  is `429 quota_exceeded` with `Retry-After`; a principal that earns
  `denials` post-authentication refusals inside `windowSec` is
  `429 abuse_locked` for `lockSec`. Every refusal is zero frames on any
  tunnel. Windows are per process and count every request that reaches the
  quota boundary, allowed or not. Only refusals that describe the caller's
  own behaviour feed its abuse lock: a shared tenant window running out, or
  a misconfigured table, never locks an individual principal. A table the
  edge cannot read — an unknown key, a sub-table that is not an object, a
  row whose `requests` / `windowSec` is not a positive integer, a malformed
  `abuse` block — **refuses startup** and names the offending path; it is
  never treated as "no quotas". An agent outage on the site-derived path
  is still `503 no_agent`, answered before the quota boundary. Omit the
  table to keep the prior path;
- optional usage ledger (`MCP_EDGE_USAGE_MAX_RECORDS` or
  `relay.usage.maxRecords`, a positive integer; a value that is set but
  unreadable is fatal). When set, every edge decision (allow or deny) and
  every fan-down receipt is recorded against the grant-resolved tenant and
  the validated principal (`sub`, then `azp`) with the `requestId` the
  frame carries, a `decisionId`, the bound `policyDigest`, the refusal
  `scope` when a quota decided, and measured cost signals (units, bytes
  in / out, duration). A response the northbound listener cannot relay
  (an invalid status or header from the agent) is `502 fan_down_failed`
  with a `failed` receipt, never an `ok` receipt for a response nobody
  received. A metering failure never changes a verdict: the decision
  stands, is logged as unmetered, and the request proceeds. The ledger is
  in-process and bounded; a restart clears it and reconciliation reports
  truncation. Unset, nothing is recorded and `/usage` is 404;
- an agent channel credential store (`MCP_CHANNEL_CREDENTIALS_FILE`, SHA-256
  digests only, hot-reloaded so revocation needs no restart). Each agent
  entry may name `sites`: catalog names that agent is allowed to serve.
  That bind is the tenant boundary. Two agents may stay connected when their
  `sites` lists are disjoint; a second agent without `sites`, or one that
  claims a site already bound, is denied at hello. Omitting `sites`, or
  supplying an empty / comment-only list, is unscoped and remains valid
  only for a single-agent install;
- TLS material, or the explicit loopback-only `MCP_ALLOW_HTTP=1` opt-in;
- a site catalog with **no credential material** — an entry carrying a token,
  password, or OAuth block refuses startup. The edge cannot leak what it does
  not hold.

Caller credential headers (`Authorization`, `Cookie`, `Proxy-Authorization`)
and identity-assertion headers are stripped before a request is framed down the
tunnel; the frame carries the validated identity object only (with `tenant` and,
when mapped, `actor` / `delegator` / `policy` stamped from the grant, never from a
caller argument), plus a `correlation` object `{ requestId, tenant, target,
source, actor?, delegator?, policyDigest? }`. Caller `tenant` / `actor` /
`delegator` / `policy` / `digest` are
stripped from the framed body. JSON:API writes attach `relationships.uid`
from the grant-stamped actor. The southbound Authorization header is the
tenant site credential, never the northbound JWT. Entitlement is decided
before anything about the tenant is disclosed. Fan-down selects the unique
agent bound to the principal's granted
sites; a cross-tenant hint is `not_entitled` with no frame on the other
tunnel, and a missing tenant agent is `no_agent` without naming other
tenants. A response frame from the wrong agent cannot complete another
tenant's in-flight request. Revocation of both the northbound principal and
the agent channel is per-request with no grace window. Northbound is
stateless MCP 2026-07-28; sessionful traffic is refused. This is still not a
hosted-service claim and names no public hostname.

**Usage reads.** With the ledger enabled, `GET /usage` on the northbound
listener is authenticated on the same resource server as `/mcp` and answers
the caller's own tenant partition: the tenant comes from `auth.tenantGrants`
(a `tenant` query value is a confirming hint inside that grant, never
authority; `principal` narrows to one principal key). Any other tenant, a
principal with no tenant grant, a multi-tenant grant without a hint, or an
install without `auth.tenantGrants` is `not_entitled` with no records. The
response carries `records` and a `reconciliation` over that partition:
`settled`, `denied`, `missing` (dispatch without receipt, or receipt without
dispatch), `duplicate` (repeated decision or receipt for one `requestId`),
and `uncertain` (fan-down timeout or channel loss after the frame crossed,
or a receipt whose tenant or decision id disagrees with its decision).
A response frame nobody is waiting for — late, repeated, fabricated, or
injected from another tenant's tunnel — is recorded against the sending
tunnel, so the injecting tenant's own reconciliation shows it. A refusal
made before any tenant can be attributed (a client with no tenant grant, or
a multi-tenant grant without a hint) is recorded with `tenant: null`; it
stays in the ledger for the operator but no tenant partition serves it.
Usage is measured, not priced; billing and invoicing are not this surface.

**The agent** dials out to the edge's channel port and never listens. It
authenticates the channel with its own issued credential (`MCP_CHANNEL_TOKEN`
or `MCP_CHANNEL_TOKEN_FILE`) — never a northbound token, never a site
credential — and serves the real connector surface with the site config, so
southbound credentials exist only in the tenant process. The channel is TLS by
default (`MCP_EDGE_ALLOW_TCP=1` permits plain TCP to loopback only). A lost
channel exits non-zero for a supervised restart.

**Issuer requirements.** The edge validates the token's audience against its
HTTPS resource identifier and keys grants on the `azp`/`client_id` claim. An
issuer that mints neither — a plain simple_oauth Drupal site mints `aud` = the
consumer's client id and no client identity claim — fails closed at every
layer and can never be entitled. Use an issuer that mints audience-bound
tokens with a client identity claim (for example Keycloak with an audience
mapper), or see the upstream enhancement tracked on the MCP Sentinel issue
queue (d.o #3619398).
