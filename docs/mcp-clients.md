# MCP Client Setup

**Drupal MCP Connector** (`drupal-mcp-connector`) is a standard [Model Context Protocol](https://modelcontextprotocol.io)
server, so any MCP-capable client can use it. There are two integration shapes —
pick per client:

- **stdio** (local subprocess): the client launches `node src/index.js` and talks
  over stdin/stdout. Best for local CLIs/desktop apps on the same machine as (or
  network-routable to) Drupal.
- **Streamable HTTP** (remote): run the connector as an HTTPS service and register
  its URL. Required for hosted/cloud assistants that can't spawn a local process.

> **Two recurring decisions for every client:**
> 1. **Reachability** — a *local* (stdio) client inherits your machine's network
>    (VPN/Tailscale, localhost) and reaches Drupal directly. A *remote/hosted*
>    client reaches the connector over the public internet, so the connector must
>    be exposed (auth + TLS) on a host that can itself reach Drupal. See
>    [§ Remote HTTP transport](#remote-http-transport).
> 2. **Secrets** — keep the OAuth client secret out of client config. Locally, use
>    a secret-manager launcher ([`examples/launch-with-secret.sh`](../examples/launch-with-secret.sh));
>    on a server, use env vars / a secrets manager. See
>    [oauth-client-credentials.md](oauth-client-credentials.md).

### Operator wizard

```bash
npx -y drupal-mcp-connector init
# CI: npx -y drupal-mcp-connector init --yes --json
```

Prints Cursor + Claude Code `mcpServers` snippets (and writes them only with
`--write`). `--preset public-https` stays gated (operator-run TLS). For the
Wilkes & Liberty hosted URLs, see [§ Hosted endpoints](#hosted-endpoints).

```bash
npx -y drupal-mcp-connector doctor          # one failing gate + next fix
npx -y drupal-mcp-connector init --preset local-stdio
npx -y drupal-mcp-connector init --preset tailscale --host https://drupal.tailnet.ts.net
npx -y drupal-mcp-connector init --preset public-https --yes --json
# public-https is gated/later — operator-run snippet shape; W&L hosted URLs are below
```

| Preset | Example | Constraint |
|--------|---------|------------|
| Local stdio | `https://drupal.ddev.site` | Client subprocess; Drupal on this machine/LAN |
| Tailscale VPN | `https://drupal.<tailnet>.ts.net` | VPN-required; not public internet |
| Public HTTPS | `https://mcp.example.com/mcp` | Gated/later; operator-run TLS + inbound OAuth |

### Hosted endpoints

Wilkes & Liberty operates Streamable HTTP endpoints (DEV-817):

| Environment | MCP URL | Protected-resource discovery (RFC 9728) |
|-------------|---------|-----------------------------------------|
| Production | `https://mcp.wilkesliberty.com/mcp` | `https://mcp.wilkesliberty.com/.well-known/oauth-protected-resource` |
| Staging | `https://mcp.staging.wilkesliberty.com/mcp` | `https://mcp.staging.wilkesliberty.com/.well-known/oauth-protected-resource` |

Both advertise `scopes_supported: ["mcp_read"]`. `/mcp` is an OAuth protected resource (no token → 401). Discovery is unauthenticated. The resource-specific path `/.well-known/oauth-protected-resource/mcp` is also served.

OAuth path per client (`mcp_read` only):

- **Cursor** — public PKCE client `cursor-mcp`. Register the MCP URL (`url` in `.cursor/mcp.json` or `~/.cursor/mcp.json`); Cursor completes authorization-code + PKCE against that client.
- **Grok Bot** — pre-registered public PKCE client `grok-bot` (CIMD is published but not accepted as `client_id`; gated anonymous DCR stays closed). Register the same MCP URL as a remote MCP server (`grok mcp add … --url … --type http`, or the Grok API `server_url`).

Hosted `/mcp` Origin allowlist (DEV-953 / infra-overlay v1.16.1): `https://cursor.com`, `https://www.cursor.com`, `https://grok.com`, `https://console.x.ai`, `https://claude.ai`. Matching is exact. POST with an allowlisted Origin is the 401 challenge; OPTIONS is 204. A true foreign Origin (`https://evil.example`) and a lookalike (`https://claude.ai.evil.example`) stay 403. Copy the Cursor / Grok Origins into a connector you host (`auth.allowedOrigins` / `MCP_ALLOWED_ORIGINS`); Claude is allowlisted on the Wilkes & Liberty edge.

Repeatable operator probe (no secrets in output):

```bash
npm run eval:hosted
npm run eval:hosted -- --host staging --json
# After keystone#1559 Grok CIMD + Claude hosted are applied to the realm:
npm run eval:hosted -- --clients-provisioned
# HOSTED_MCP_CLIENTS_PROVISIONED=1 is the same flag.
# Signed-in initialize / tools/list / drupal_list_content_types:
HOSTED_MCP_TOKEN=… npm run eval:hosted -- --require-signed-in
# Or the documented Paladin smoke clients (mcp-edge-alpha / mcp-edge-prod-alpha):
HOSTED_MCP_CLIENT_SECRET=… npm run eval:hosted -- --require-signed-in
```

The probe prints `Client inventory: provisioned` or `not provisioned` so the
operator can see which authorize expects it used. Default is not provisioned
(live realm as of 2026-10-19). Consent and the mcp-operators staff gate are
signed-in authorize steps; the unauthenticated login page does not expose them.

OAuth facts the probe asserts:

| Client | Registration | `client_id` | Redirects authorize accepts | Redirects authorize rejects | `/mcp` Origin |
|---|---|---|---|---|---|
| Cursor | Pre-registered public PKCE (`cursor-mcp`), S256, `mcp_read` | `cursor-mcp` | `https://www.cursor.com/agents/mcp/oauth/callback`, `http://localhost:8787/callback` | `https://cursor.com/agents/mcp/oauth/callback` (apex, not registered), any other host | `https://cursor.com`, `https://www.cursor.com` → 401 challenge; OPTIONS 204 |
| Grok Bot | Pre-registered public PKCE (`grok-bot`). CIMD is published at `https://grok.com/oauth/mcp-client.json`. The short id is on the live realm (keystone#1539). The CIMD URL as `client_id` is the keystone#1559 client: `client_not_found` until provisioned; then the published Grok redirects must not be `client_not_found` and any other host is still refused. Anonymous DCR stays closed (Trusted Hosts). | `grok-bot` | Grok CIMD redirects plus the Cursor www callback (keystone#1531) | any other host; CIMD URL as `client_id` until provisioned | `https://grok.com`, `https://console.x.ai` → 401 challenge; OPTIONS 204 |
| Claude (hosted OAuth) | Public PKCE client in realm-as-code (keystone#1559). Not on the live realm until `--clients-provisioned`. DCR stays closed. AS metadata does not advertise CIMD (`client_id_metadata_document_supported` absent; `token_endpoint_auth_methods_supported` has no `none`). | `claude` | `https://claude.ai/api/mcp/auth_callback` when provisioned | that callback is `client_not_found` until provisioned; any other host is refused once the client is present | `https://claude.ai` → 401 challenge; OPTIONS 204 (infra-overlay v1.16.1) |
| Claude Code / Claude Desktop | **stdio** (local subprocess), or remote HTTP with an operator-supplied `Authorization: Bearer` header. Not browser Origin. | — | loopback (Claude Code CIMD) is a local redirect, not a hosted `/mcp` Origin | — | missing Origin allowed |
| Local stdio | No inbound OAuth. The client launches `node src/index.js`. | — | — | — | n/a |

stdio remains the default local path. A connector you host on Tailscale / local VPN is unchanged.

Regardless of client, a Drupal-side governance module (e.g.
[MCP Sentinel](integration-contract.md)) remains the authoritative policy.

Both transports accept current MCP 2026-07-28 clients and a time-boxed 2025-era
compatibility path. HTTP clients share one URL but not one state model: current
requests are stateless; legacy clients keep a session bound to the authenticated
principal. Operators can set `MCP_LEGACY_TRANSPORT=reject` once all registered
clients are current. Browser clients that send `Origin` must be listed on
`auth.allowedOrigins` / `MCP_ALLOWED_ORIGINS` (exact match, no wildcards).
This guard only limits browsers and DNS rebinding; it does not
authenticate. A request with no `Origin` is allowed by design for
non-browser clients. An omitted or empty extra list refuses every present
third-party Origin. The origin of `auth.resource` / `auth.audience` is
still auto-included (same-origin browser of the MCP URL). The example
config lists `https://cursor.com`, `https://www.cursor.com`, `https://grok.com`,
and `https://console.x.ai` (DEV-953; HTTPS origins of the keystone#1539
`cursor-mcp` and `grok-bot` clients, plus the Cursor browser Origin).
The `Host` header must match `auth.allowedHosts` / `MCP_ALLOWED_HOSTS`
(default: the host of `auth.resource` / `auth.audience`, plus loopback on
a loopback bind).

---

## Generic stdio

The lowest common denominator — most stdio clients accept this `command`/`args`/`env` shape:

```json
{
  "command": "npx",
  "args": ["-y", "drupal-mcp-connector"],
  "env": {
    "DRUPAL_BASE_URL": "https://drupal.example",
    "DRUPAL_API_TOKEN": "your-token"
  }
}
```

Or run from a clone via a launcher that sources the secret and sets the working
directory (so `config/config.json` resolves):

```json
{ "command": "/abs/path/drupal-mcp-connector/examples/launch-with-secret.sh" }
```

---

## Claude

### Claude Code (stdio, user scope)

```bash
# Add (launcher form — sources the secret from your keychain):
claude mcp add drupal --scope user -- /abs/path/drupal-mcp-connector/examples/launch-with-secret.sh
# Or token via env, no launcher:
claude mcp add drupal --scope user -e DRUPAL_BASE_URL=https://drupal.example -e DRUPAL_API_TOKEN=… -- npx -y drupal-mcp-connector

# Manage:
claude mcp list           # list configured servers
claude mcp get drupal     # show one server
claude mcp remove drupal  # remove it
```

Bare `/drupal-*` commands: MCP prompts appear as `/mcp__drupal__…`. For the
short form, from a connector clone run `npm run install:commands` (writes
`~/.claude/commands`). Add `-- --modules` to also write
`/drupal-<namespace>-<alias>` commands for module-owned tools
([module-tools.md](module-tools.md#prompts-and-slash-commands)). Do not commit a `.claude/` folder to this or any
consuming repo — see the README.

For a remote endpoint instead of stdio: `claude mcp add --transport http drupal https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"`.

### Claude Desktop (stdio)

`claude_desktop_config.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "drupal": { "command": "/abs/path/drupal-mcp-connector/examples/launch-with-secret.sh" }
  }
}
```

Restart the app. (GUI apps don't inherit your shell env — prefer the launcher,
which reads the secret from your OS keychain. First launch may prompt for keychain
access; approve it.)

---

## Cursor

Project file `.cursor/mcp.json`, or user file `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "npx",
      "args": ["-y", "drupal-mcp-connector"],
      "env": {
        "DRUPAL_BASE_URL": "https://drupal.example",
        "DRUPAL_API_TOKEN": "${env:DRUPAL_API_TOKEN}"
      }
    }
  }
}
```

Remote HTTPS — Wilkes & Liberty hosted (DEV-817), or a connector you host
(Tailscale / local VPN):

```json
{
  "mcpServers": {
    "drupal": {
      "url": "https://mcp.wilkesliberty.com/mcp"
    }
  }
}
```

Cursor uses the `cursor-mcp` public PKCE client (`mcp_read` only). Staging:
`https://mcp.staging.wilkesliberty.com/mcp`. Discovery:
`https://mcp.wilkesliberty.com/.well-known/oauth-protected-resource`
(see [§ Hosted endpoints](#hosted-endpoints)). `npx drupal-mcp-connector init`
prints the stdio shape as well.

---

## Grok (xAI)

### Grok Build (stdio CLI)

Grok Build has native MCP support "the same as Claude Code" and also reads
`AGENTS.md`, hooks, and skills. Manage servers with `grok mcp` (writes to
`~/.grok/config.toml`):

```bash
# Add (stdio, launcher form):
grok mcp add drupal --command /abs/path/drupal-mcp-connector/examples/launch-with-secret.sh
# Or via npx with env vars:
grok mcp add drupal --command npx --args -y drupal-mcp-connector \
  --env DRUPAL_BASE_URL=https://drupal.example --env DRUPAL_API_TOKEN=…

# Manage:
grok mcp list             # list configured servers
grok mcp doctor           # live test: starts the server, checks handshake + tool count
grok mcp remove drupal    # remove it
```

`grok mcp doctor` is the quickest verification — it should report
`✓ handshake OK` and `✓ N tools discovered`. Because Grok Build runs locally, it
reaches Drupal over whatever network the host is on (VPN/Tailscale/localhost).
For a remote endpoint instead: `grok mcp add drupal --url https://mcp.wilkesliberty.com/mcp --type http` (Grok Bot uses the `grok-bot` client; see [§ Hosted endpoints](#hosted-endpoints)).

When this repo is the project, Grok loads `.agents/commands/` as `/drupal-*`.
From any other directory, `npm run install:commands` copies the same stubs into
`~/.grok/commands`.

### Grok API — Remote MCP Tools (remote HTTP)

The hosted Grok models (incl. `grok-build-0.1`) accept remote MCP servers declared
in the request `tools` array. Point `server_url` at a [hosted endpoint](#hosted-endpoints)
or at a connector you run via [HTTPS transport](#remote-http-transport):

```jsonc
// xAI chat/completions request (shape; see docs.x.ai → Remote MCP Tools for exact fields)
{
  "model": "grok-build-0.1",
  "tools": [
    {
      "type": "mcp",
      "server_label": "drupal",
      "server_url": "https://mcp.wilkesliberty.com/mcp",
      "authorization": "Bearer <access token issued by auth.issuer>"
    }
  ]
}
```

---

## OpenAI

### Codex CLI (stdio)

Manage with `codex mcp` (writes to `~/.codex/config.toml`):

```bash
# Add (launcher form):
codex mcp add drupal -- /abs/path/drupal-mcp-connector/examples/launch-with-secret.sh
# Or via npx with env vars:
codex mcp add drupal --env DRUPAL_BASE_URL=https://drupal.example --env DRUPAL_API_TOKEN=… -- npx -y drupal-mcp-connector

# Manage:
codex mcp list
codex mcp remove drupal
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.drupal]
command = "/abs/path/drupal-mcp-connector/examples/launch-with-secret.sh"
# or:
# command = "npx"
# args = ["-y", "drupal-mcp-connector"]
# env = { DRUPAL_BASE_URL = "https://drupal.example", DRUPAL_API_TOKEN = "…" }
```

Codex supports stdio MCP servers in both the CLI and the IDE extension. Run
`codex mcp add --help` to confirm flags on your version.

Bare `/drupal-*` command files are **not** a Codex surface — custom prompts under
`~/.codex/prompts` are deprecated in favor of [skills](https://developers.openai.com/codex/skills).
From a connector clone, `npm run install:commands` (or `--clients codex`) writes
one skill to `$HOME/.agents/skills/drupal-mcp/SKILL.md` with a tool catalog at
`references/tools.md`. MCP tool connectivity is independent (`codex mcp add`);
the skill tells Codex when and how to call those tools. Restart Codex if a
freshly installed skill does not appear.

### ChatGPT & the Responses API (remote HTTP only)

ChatGPT (Developer Mode / connectors) and the Responses API connect **only to
remote HTTPS MCP servers** — no stdio. Run the [HTTPS transport](#remote-http-transport)
and add it:

```jsonc
// Responses API
{
  "model": "gpt-5.3",
  "tools": [
    {
      "type": "mcp",
      "server_label": "drupal",
      "server_url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <access token issued by auth.issuer>" }
    }
  ]
}
```

In ChatGPT, add the same URL as a connector/MCP server in Developer Mode.

> **Private/internal Drupal?** OpenAI's **Secure MCP Tunnel** lets a tunnel-client
> running inside your network make *outbound* HTTPS to OpenAI and forward requests
> to a private MCP server — so you can use ChatGPT/Codex against an internal-only
> connector without opening any inbound port. A good fit when Drupal is reachable
> only on a private network/VPN.

---

## Remote HTTP transport

For any remote/hosted client, run the connector as an HTTPS service instead of a
subprocess:

```bash
MCP_TRANSPORT=https \
TLS_CERT_PATH=/etc/ssl/certs/mcp.crt \
TLS_KEY_PATH=/etc/ssl/private/mcp.key \
MCP_RESOURCE_ISSUER="https://idp.example.com" \
MCP_RESOURCE_AUDIENCE="https://mcp.example.com/mcp" \
MCP_BIND_HOST=0.0.0.0 \
MCP_PORT=3443 \
  node src/index.js
# serves https://host:3443/mcp  (health probe: /health)
```

Hardening (see [security-hardening.md](security-hardening.md)):

- **Inbound OAuth resource server** — required on `/mcp` beyond loopback.
  Clients send `Authorization: Bearer <access-token>` issued by `auth.issuer`.
- **`MCP_AUTH_TOKEN`** — removed in 4.0.0 (#231). Setting it is fatal at startup.
- **TLS is mandatory** off localhost (plain HTTP is refused unless `MCP_ALLOW_HTTP=1`, dev only).
- **`MCP_BIND_HOST`** — restrict the listen interface.
- Source the OAuth client secret from env / a secrets manager (not a desktop keychain) on servers.
- Put it behind your reverse proxy and, where possible, IP-allowlist the client's egress.
- Test `server/discover`, version/method/name mismatch rejection, and the absence
  of `Mcp-Session-Id` with the exact client/gateway build before claiming current
  protocol compatibility.

> **Security tradeoff:** a remote endpoint that bridges a hosted assistant into
> your Drupal widens the attack surface. Prefer a local stdio client when Drupal
> is on a private network; if you must go remote, host the connector where it can
> reach Drupal, lock down the endpoint, and lean on the Drupal-side governance
> module as the authoritative gate. For private Drupal with OpenAI clients,
> consider the Secure MCP Tunnel (above) instead of inbound exposure.

---

## Client capability matrix

| Client | stdio | Remote HTTP | Notes |
|---|---|---|---|
| Claude Code | ✅ | ✅ | `claude mcp add` (user/project scope) |
| Claude Desktop | ✅ | ✅ | `claude_desktop_config.json` |
| Cursor | ✅ | ✅ | `.cursor/mcp.json` or `~/.cursor/mcp.json` |
| Grok Build (CLI) | ✅ | ✅ | native MCP, also reads `AGENTS.md` |
| Grok API | — | ✅ | Remote MCP Tools in `tools` array |
| OpenAI Codex CLI | ✅ | ✅ | `~/.codex/config.toml`; skills at `$HOME/.agents/skills/drupal-mcp/` (not `~/.codex/prompts`) |
| ChatGPT / Responses API | — | ✅ | remote only; Secure MCP Tunnel for private servers |

Client products evolve quickly — confirm exact config keys/commands in each
vendor's current docs. See also: [getting-started.md](getting-started.md) ·
[oauth-client-credentials.md](oauth-client-credentials.md) ·
[security-hardening.md](security-hardening.md).
