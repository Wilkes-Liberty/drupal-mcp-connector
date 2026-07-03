# Getting Started

This guide covers every setup path: local dev with DDEV/Lando, staging, production, multi-site, and both Drupal backends.

---

## 1. Prerequisites

- **Node.js 20+** — `node --version`
- **A Drupal 10 or 11 site** exposing at least one backend:
  - **JSON:API** — in core, enabled by default (required for write operations), or
  - **GraphQL** — via the [GraphQL Compose](https://www.drupal.org/project/graphql_compose) module (read-only)
- **npm** — comes with Node

---

## 2. Install

```bash
git clone https://github.com/Wilkes-Liberty/drupal-mcp-connector
cd drupal-mcp-connector
npm install
```

---

## 3. Configure Your Site

```bash
cp config/config.example.json config/config.json
```

Edit `config/config.json`. At minimum you need `baseUrl`, a backend (`api`), and one auth method:

```json
{
  "defaultSite": "mysite",
  "sites": {
    "mysite": {
      "baseUrl": "https://mysite.com",
      "api": "jsonapi",
      "apiToken": "your-bearer-token-here"
    }
  }
}
```

**Never commit `config/config.json`** — it is gitignored.

### Choosing a backend with `api`

| `api` value | Behavior |
|-------------|----------|
| `"jsonapi"` | JSON:API only (read + write) |
| `"graphql"` | GraphQL only via GraphQL Compose (read-only) |
| `["graphql","jsonapi"]` | Try GraphQL first, fall back to JSON:API |
| *(omitted)* | Auto-detect — probe both once and use whichever responds |

Writes (create/update/delete) require a JSON:API backend. A GraphQL-only site is read-only by design.

---

## 4. Authentication

### Option A — Bearer Token (recommended for production)

Install [Simple OAuth](https://www.drupal.org/project/simple_oauth):

```bash
composer require drupal/simple_oauth
drush en simple_oauth
```

Then in Drupal admin:
1. **Configuration → Simple OAuth → Add Client**
2. Create a client with an appropriate grant
3. Generate keys: `drush simple-oauth:create-keys /path/to/key/dir`

Request a token and store it as `apiToken` — or, to keep it out of the config file, set `apiTokenEnv` and provide the token via that environment variable:

```json
{
  "sites": {
    "production": {
      "baseUrl": "https://mysite.com",
      "api": "jsonapi",
      "apiTokenEnv": "DRUPAL_TOKEN_PRODUCTION",
      "requireSecureAuth": true
    }
  }
}
```

`requireSecureAuth: true` rejects anonymous/Basic auth and non-HTTPS `baseUrl` values — recommended for production and any write plane.

### Option B — Basic Auth (local dev only)

```json
{
  "sites": {
    "local": {
      "baseUrl": "http://mysite.lndo.site",
      "api": "jsonapi",
      "username": "admin",
      "password": "admin"
    }
  }
}
```

Create a dedicated, least-privilege API user rather than using `admin`:

```bash
drush user:create mcp-api --mail="mcp@example.com" --password="$(openssl rand -base64 32)"
drush user:role:add editor mcp-api
```

### Option C — Environment Variables (CI / single site)

```bash
export DRUPAL_BASE_URL=https://mysite.com
export DRUPAL_API_TOKEN=your-token
node src/index.js
```

### Option D — OAuth2 `client_credentials` (recommended for production write planes)

For unattended machine access with a Drupal-side governance layer, use the
`client_credentials` grant. There are non-obvious requirements — the token's
permissions come from **OAuth2 scope→role mapping** (not the consumer's owner
user), JSON:API must have `read_only: false` for writes, and the scope/settings
config must live in `config/sync` to survive deploys. See the dedicated
**[OAuth client_credentials Deployment Guide](oauth-client-credentials.md)**.

---

## 5. Test the Connection

```bash
node src/index.js
```

You should see:

```
[drupal-mcp-connector v1.7.0] stdio transport active. 119 tools · 3 resources · 124 prompts
```

---

## 6. Register with an MCP Client (stdio)

Most desktop and CLI MCP clients launch the connector as a stdio subprocess. Add an entry to your client's MCP server configuration:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-mcp-connector/src/index.js"]
    }
  }
}
```

To pass credentials via the environment instead of `config.json`:

```json
{
  "mcpServers": {
    "drupal": {
      "command": "node",
      "args": ["/absolute/path/to/drupal-mcp-connector/src/index.js"],
      "env": {
        "DRUPAL_BASE_URL": "https://mysite.com",
        "DRUPAL_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

Restart the client; you should see the `drupal` server's tools listed.

---

## 7. HTTPS Transport (multi-client mode)

To serve multiple clients (or a remote client) from one process, run the HTTPS transport:

```bash
MCP_TRANSPORT=https \
TLS_CERT_PATH=/etc/ssl/certs/mcp.crt \
TLS_KEY_PATH=/etc/ssl/private/mcp.key \
MCP_PORT=3443 node src/index.js
```

The server listens at `https://host:3443/mcp` with a health probe at `/health`. Register that URL with any HTTP-capable MCP client.

> **Security:** HTTPS is mandatory; plain HTTP is refused on non-localhost unless `MCP_ALLOW_HTTP=1` (dev only). Add `MCP_AUTH_TOKEN` to require a bearer token, and `MCP_BIND_HOST` to restrict the listen interface. See [security-hardening.md](security-hardening.md).

---

## 8. Local Dev with DDEV

```bash
ddev config --project-type drupal11
ddev start
ddev drush en jsonapi          # JSON:API is on by default in core
ddev describe | grep "https://"
```

DDEV serves HTTPS with a locally-trusted mkcert CA that Node does not trust by default. Point Node at the CA root:

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

```json
{
  "defaultSite": "ddev",
  "sites": {
    "ddev": {
      "baseUrl": "https://myproject.ddev.site",
      "api": "jsonapi",
      "username": "admin",
      "password": "admin",
      "security": { "preset": "development" }
    }
  }
}
```

See [graphql-local-setup.md](graphql-local-setup.md) for the GraphQL-backend variant.

---

## 9. Local Dev with Lando

```bash
lando start
lando drush uli   # one-time login link to set the admin password
```

```json
{
  "sites": {
    "lando": {
      "baseUrl": "https://mysite.lndo.site",
      "api": "jsonapi",
      "username": "admin",
      "password": "yourpassword",
      "security": { "preset": "development" }
    }
  }
}
```

---

## 10. Multi-Site Setup

Add multiple named entries to `sites`. Each has its own backend, auth, and security policy:

```json
{
  "defaultSite": "production",
  "sites": {
    "production":   { "baseUrl": "https://mysite.com",        "api": "jsonapi", "apiTokenEnv": "PROD_TOKEN", "requireSecureAuth": true, "security": { "preset": "auditor" } },
    "staging":      { "baseUrl": "https://staging.mysite.com", "api": "jsonapi", "apiTokenEnv": "STG_TOKEN",  "security": { "preset": "content-editor" } },
    "read_replica": { "baseUrl": "https://api.mysite.com",     "api": "graphql", "security": { "preset": "auditor" } }
  }
}
```

In your MCP client: "List all content types on the staging site" or "Run an SEO audit on production." To see all configured sites, call `drupal_list_sites`.

---

## 11. Enable the GraphQL Backend (optional)

Install [GraphQL Compose](https://www.drupal.org/project/graphql_compose):

```bash
composer require drupal/graphql_compose
drush en graphql_compose -y
```

Enable the entity types/bundles you want exposed in the GraphQL Compose settings, then set the site's backend:

```json
"api": "graphql",
"graphqlEndpoint": "/graphql"
```

GraphQL is read-only (no mutations). Use `drupal_graphql_introspect` to discover the schema before writing queries. Full details: [graphql-local-setup.md](graphql-local-setup.md).

---

## 12. Enable the Drush Bridge (optional)

Requires SSH key access to the server (key auth only — no passwords). Add to your site config:

```json
"drushSsh": {
  "host": "ssh.myhost.com",
  "user": "deploy",
  "keyPath": "~/.ssh/id_ed25519",
  "drupalRoot": "/var/www/html/web"
}
```

Then tools like `drupal_drush_cache_rebuild`, `drupal_drush_cron`, and `drupal_drush_config_status` become available. See the Drush Bridge Security section of [security.md](security.md#drush-bridge-security).

Add an optional `"allowedCommands"` array to pin the bridge to specific subcommands on
that site — every other `drupal_drush_*` tool is then blocked. For example, a developer
site can be limited to config export/status only:

```json
"drushSsh": {
  "host": "ssh.myhost.com", "user": "deploy", "keyPath": "~/.ssh/id_ed25519",
  "drupalRoot": "/var/www/html/web",
  "allowedCommands": ["config:export", "config:status"]
}
```

---

## 12a. Governance Tiers & Governed Config (optional)

`config/config.example.json` ships a reference **environment-keyed least-privilege**
layout: `prod`/`staging` (content tier), `dev` (developer tier), and `dev-admin`
(admin/break-glass). The tier is set by the consumer's OAuth scopes and mirrored by the
`security.preset`. Add a `serverTools` block to enable the governed configuration tools
(`drupal_config_get` / `_list` / `_set`), which call Drupal's authoritative server-side
MCP tools rather than drush:

```json
"serverTools": { "url": "/mcp" }
```

`drupal_config_set` requires the `config-editor` (Developer) tier (or
`security.allowConfigWrite: true`). Call `drupal_mcp_whoami` to see the effective tier,
scopes, and capabilities for a site. See [integration-contract.md](integration-contract.md#5a-server-tool-bridge-transport).

---

## 13. Security Checklist

Before going to production, verify:

- [ ] `apiToken`/`apiTokenEnv` is a scoped Bearer token, not an admin password
- [ ] `requireSecureAuth: true` on production and any write-plane site
- [ ] `config/config.json` is NOT committed (`git status`)
- [ ] `security.preset` is `auditor` or `production-strict` for live sites
- [ ] `security.allowDestructive` is `false` unless deletes are required
- [ ] A dedicated, least-privilege Drupal API user (not `admin`)
- [ ] TLS configured for the HTTPS transport; `MCP_AUTH_TOKEN`/`MCP_BIND_HOST` set if exposed beyond loopback
- [ ] Call `drupal_security_info` to confirm the active policy

---

## Next Steps

- [Architecture](architecture.md) — backend abstraction and how to extend the server
- [Tools Reference](tools-reference.md) — every tool with examples
- [Security Guide](security.md) — full security configuration reference
- [Security Hardening](security-hardening.md) — optional transport and secrets controls
