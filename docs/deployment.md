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
- an agent channel credential store (`MCP_CHANNEL_CREDENTIALS_FILE`, SHA-256
  digests only, hot-reloaded so revocation needs no restart). Each agent
  entry may name `sites`: catalog names that agent is allowed to serve.
  That bind is the tenant boundary. Two agents may stay connected when their
  `sites` lists are disjoint; a second agent without `sites`, or one that
  claims a site already bound, is denied at hello. Omitting `sites` remains
  valid only for a single-agent install;
- TLS material, or the explicit loopback-only `MCP_ALLOW_HTTP=1` opt-in;
- a site catalog with **no credential material** — an entry carrying a token,
  password, or OAuth block refuses startup. The edge cannot leak what it does
  not hold.

Caller credential headers (`Authorization`, `Cookie`, `Proxy-Authorization`)
and identity-assertion headers are stripped before a request is framed down the
tunnel; the frame carries the validated identity object only, plus a
`correlation` object `{ requestId, tenant }` naming the request id and the
agent id. Entitlement is decided before anything about the tenant is
disclosed. Fan-down selects the unique agent bound to the principal's granted
sites; a cross-tenant hint is `not_entitled` with no frame on the other
tunnel, and a missing tenant agent is `no_agent` without naming other
tenants. A response frame from the wrong agent cannot complete another
tenant's in-flight request. Revocation of both the northbound principal and
the agent channel is per-request with no grace window. Northbound is
stateless MCP 2026-07-28; sessionful traffic is refused. This is still not a
hosted-service claim and names no public hostname.

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
