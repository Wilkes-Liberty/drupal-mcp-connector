# MCP Client Setup

`drupal-mcp-connector` is a standard [Model Context Protocol](https://modelcontextprotocol.io)
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

Regardless of client, a Drupal-side governance module (e.g.
[MCP Sentinel](integration-contract.md)) remains the authoritative policy.

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
claude mcp add drupal --scope user -- /abs/path/drupal-mcp-connector/examples/launch-with-secret.sh
# or, token via env, no launcher:
claude mcp add drupal --scope user -e DRUPAL_BASE_URL=https://drupal.example -e DRUPAL_API_TOKEN=… -- npx -y drupal-mcp-connector
```

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

## Grok (xAI)

### Grok Build (stdio CLI)

Grok Build has native MCP support "the same as Claude Code" and also reads
`AGENTS.md`, hooks, and skills. Register the connector as a stdio server — either
via the CLI's MCP command or its MCP config file (same `command`/`args`/`env`
JSON shape as Claude). Example entry:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "/abs/path/drupal-mcp-connector/examples/launch-with-secret.sh"
    }
  }
}
```

Because Grok Build runs locally, it reaches Drupal over whatever network the host
is on (VPN/Tailscale/localhost). See xAI's Grok Build docs for the exact MCP
config path / `mcp add` command.

### Grok API — Remote MCP Tools (remote HTTP)

The hosted Grok models (incl. `grok-build-0.1`) accept remote MCP servers declared
in the request `tools` array. Run the connector's [HTTPS transport](#remote-http-transport)
and reference its URL:

```jsonc
// xAI chat/completions request (shape; see docs.x.ai → Remote MCP Tools for exact fields)
{
  "model": "grok-build-0.1",
  "tools": [
    {
      "type": "mcp",
      "server_label": "drupal",
      "server_url": "https://mcp.example.com/mcp",
      "authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
    }
  ]
}
```

---

## OpenAI

### Codex CLI (stdio)

`~/.codex/config.toml`:

```toml
[mcp_servers.drupal]
command = "/abs/path/drupal-mcp-connector/examples/launch-with-secret.sh"
# or:
# command = "npx"
# args = ["-y", "drupal-mcp-connector"]
# env = { DRUPAL_BASE_URL = "https://drupal.example", DRUPAL_API_TOKEN = "…" }
```

(Equivalently `codex mcp add drupal -- …`.) Codex supports stdio MCP servers in
both the CLI and IDE extension.

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
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
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
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
MCP_BIND_HOST=0.0.0.0 \
MCP_PORT=3443 \
  node src/index.js
# serves https://host:3443/mcp  (health probe: /health)
```

Hardening (see [security-hardening.md](security-hardening.md)):

- **`MCP_AUTH_TOKEN`** — require this bearer token on `/mcp`. Clients send
  `Authorization: Bearer …`.
- **TLS is mandatory** off localhost (plain HTTP is refused unless `MCP_ALLOW_HTTP=1`, dev only).
- **`MCP_BIND_HOST`** — restrict the listen interface.
- Source the OAuth client secret from env / a secrets manager (not a desktop keychain) on servers.
- Put it behind your reverse proxy and, where possible, IP-allowlist the client's egress.

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
| Grok Build (CLI) | ✅ | ✅ | native MCP, also reads `AGENTS.md` |
| Grok API | — | ✅ | Remote MCP Tools in `tools` array |
| OpenAI Codex CLI | ✅ | ✅ | `~/.codex/config.toml` |
| ChatGPT / Responses API | — | ✅ | remote only; Secure MCP Tunnel for private servers |

Client products evolve quickly — confirm exact config keys/commands in each
vendor's current docs. See also: [getting-started.md](getting-started.md) ·
[oauth-client-credentials.md](oauth-client-credentials.md) ·
[security-hardening.md](security-hardening.md).
