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
| `MCP_AUTH_TOKEN` | Bearer token required on `/mcp` — **always set this** |
| `MCP_BIND_HOST` | Restrict the listen interface (with TLS) |
| `MCP_RATE_LIMIT` / `MCP_RATE_WINDOW_SEC` | Optional per-IP rate limiting (see [security-hardening.md](security-hardening.md)) |
| `MCP_PORT` | Listen port (default 3443) |

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
  -e MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
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
Keep `MCP_AUTH_TOKEN` set on the connector even behind the proxy (defense in
depth), and restrict to the client vendor's documented egress range where you can.

## Pre-exposure checklist

- [ ] TLS configured (`TLS_CERT_PATH`/`TLS_KEY_PATH`) — never plain HTTP off localhost.
- [ ] `MCP_AUTH_TOKEN` set to a long random secret.
- [ ] `MCP_BIND_HOST` and/or proxy IP allow-list restrict who can reach `/mcp`.
- [ ] `MCP_RATE_LIMIT` enabled (or rate limiting at the proxy).
- [ ] Secrets sourced from an env file / secret manager — not in config or the image.
- [ ] Drupal-side governance (e.g. MCP Sentinel) active — the authoritative policy.
- [ ] `/health` returns 200; tools enumerate over the endpoint.
