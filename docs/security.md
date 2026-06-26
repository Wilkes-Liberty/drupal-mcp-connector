# Security Guide

> For optional transport, identity, and secrets controls (bearer-authenticated HTTPS, bind-address restriction, `apiTokenEnv`, `requireSecureAuth`), see [security-hardening.md](security-hardening.md).

## Defense-in-Depth Model

`drupal-mcp-connector` sits between the MCP client and Drupal. Two independent layers must both permit an operation for it to proceed.

```
MCP Client
    │
    ▼
[Layer 1] Connector Security (src/lib/security.js + backend capabilities)
  · Security presets
  · read-only / allowDestructive gates
  · Entity type allow/deny lists
  · Field redaction
  · GraphQL mutation blocking
  · Backend capability gating (writes refused on a read-only backend)
    │
    ▼
[Layer 2] Drupal-side enforcement
  · Drupal core access system (the API user's role + permissions)
  · MCP Sentinel governance — drupal/mcp_sentinel (if installed):
    role-bound policy profiles, audit log, content locks, OAuth scopes
    │
    ▼
Drupal Database
```

Neither layer trusts the other. A misconfigured Drupal permission cannot bypass connector security, and a misconfigured connector preset cannot bypass Drupal's access system. When MCP Sentinel is installed, it is the **authoritative** server-side gate — it enforces policy on the authenticated account's role and OAuth scopes regardless of how any connector is configured.

### Backend capability gating

Because the connector speaks both JSON:API and GraphQL, write protection is also enforced at the backend layer. The GraphQL (GraphQL Compose) backend advertises `write: false`, so any create/update/delete tool against a GraphQL-only site returns a clear capability error before reaching Drupal. Route writes through a JSON:API backend.

---

## Security Presets

Choose the preset that matches your use case. Every site in `config.json` gets its own independent preset.

### `development`
```json
{ "preset": "development" }
```
Everything allowed. **Local development only.** Never use on a site accessible to the internet.

### `content-editor`
```json
{ "preset": "content-editor" }
```
Allows create/update on nodes, media, taxonomy. No deletes. No access to user entities. No GraphQL mutations.

Good for: content staging sites, editorial workflows.

### `auditor`
```json
{ "preset": "auditor" }
```
Read-only. Accesses all entity types. User `pass` and `mail` fields are redacted in all responses.

Good for: analytics, content audits, SEO analysis, reporting.

### `production-strict`
```json
{ "preset": "production-strict" }
```
Read-only. User entities blocked entirely. Broad PII field redaction (`pass`, `mail`, `field_private`, `field_api_key`, `field_token`).

Good for: live production sites where any write access is unacceptable.

### `write-plane`
```json
{ "preset": "write-plane" }
```
Governed write access for automated agents. Create and update are allowed on `node`, `taxonomy_term`, and `media`; deletes and GraphQL mutations are blocked, the `user` entity type is denied, and `pass`/`mail` are redacted in all responses.

This preset mirrors the server-side governance profile so the connector and the server agree on what is permitted. The Drupal-side governance layer remains **authoritative** — this preset is defence in depth, not the policy of record.

Good for: an OAuth2 client-credentials agent writing content through the JSON:API write plane.

---

## Overriding Preset Defaults

Any key specified alongside a preset overrides it:

```json
{
  "preset": "auditor",
  "allowedEntityTypes": ["node", "media", "taxonomy_term"],
  "globalRedactedFields": ["pass", "mail", "field_ssn", "field_tax_id", "field_dob"]
}
```

---

## Entity Type Access Control

### Allowlist (most restrictive)
```json
{
  "allowedEntityTypes": ["node", "media", "taxonomy_term"]
}
```
Only the listed types are accessible. All others return "Access denied."

### Denylist (additive block)
```json
{
  "deniedEntityTypes": ["user", "commerce_order", "webform_submission"]
}
```
These types are always blocked, even if they appear in `allowedEntityTypes`.

### Per-entity-type rules
```json
{
  "entityRules": {
    "node": {
      "allowedOperations": ["read", "create", "update"],
      "deniedBundles": ["private_document", "internal_memo"],
      "redactedFields": ["field_internal_notes"]
    },
    "user": {
      "allowedOperations": ["read"],
      "redactedFields": ["pass", "mail", "field_phone", "field_address"]
    }
  }
}
```

---

## Field Redaction

Redacted fields are replaced with `"[REDACTED]"` in all responses. They are never returned to the client, regardless of what is requested.

**Global redaction** — applies to every entity type:
```json
{
  "globalRedactedFields": ["pass", "mail", "field_api_key", "field_token", "field_secret"]
}
```

**Per-entity-type redaction** — applies only to that type:
```json
{
  "entityRules": {
    "user": {
      "redactedFields": ["pass", "mail", "field_phone"]
    }
  }
}
```

Fields are also excluded from `drupal_entity_create` and `drupal_entity_update` inputs — the connector silently strips them before writing.

### PII Field Recommendations

| Field | Type | Why to redact |
|-------|------|--------------|
| `pass` | user | Password hash |
| `mail` | user | Email address — PII |
| `field_phone` | varies | PII |
| `field_address` | varies | PII |
| `field_api_key` | varies | Credential |
| `field_token` | varies | Credential |
| `field_ssn` | varies | Sensitive PII |
| `field_dob` | varies | PII |

---

## HTTPS Enforcement

### For Drupal `baseUrl` connections

The connector enforces HTTPS for all non-localhost `baseUrl` values. Plain HTTP on a non-local host throws a `SecurityError` at startup:

```
SecurityError: Site "production": baseUrl "http://mysite.com" uses plain HTTP
on a non-localhost host. All non-local connections must use HTTPS.
```

Localhost targets (`localhost`, `127.0.0.1`, `.lndo.site`, `.ddev.site`, `.local`) log a warning but are permitted.

### For the HTTP transport (multi-client mode)

`MCP_TRANSPORT=https` requires TLS certificates. Without them, the server **refuses to start** unless `MCP_ALLOW_HTTP=1` is set:

```bash
# Correct — production
TLS_CERT_PATH=/etc/ssl/certs/mcp.crt \
TLS_KEY_PATH=/etc/ssl/private/mcp.key \
MCP_TRANSPORT=https node src/index.js

# Development only — plain HTTP on localhost
MCP_ALLOW_HTTP=1 MCP_TRANSPORT=https node src/index.js
```

Security headers applied to every HTTP/HTTPS response:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`
- `Content-Security-Policy: default-src 'none'`

### Getting TLS Certificates

**Development (self-signed):**
```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj '/CN=localhost'
```

**Production (Let's Encrypt via Certbot):**
```bash
certbot certonly --standalone -d your-server.example.com
# Certs at: /etc/letsencrypt/live/your-server.example.com/
```

**Production (Caddy — automatic HTTPS, recommended):**
```caddyfile
your-server.example.com {
    reverse_proxy localhost:3443
}
```
Caddy handles cert issuance and renewal automatically.

---

## Credential Management

### Bearer Token (Recommended)

1. Install [Simple OAuth](https://www.drupal.org/project/simple_oauth)
2. Create a client with `client_credentials` grant type
3. Generate keys: `drush simple-oauth:create-keys /path/to/keys`
4. Request a token; store as `apiToken` in config or `DRUPAL_API_TOKEN` env var
5. Set a reasonable token expiry (e.g. 1 hour); implement refresh in CI if needed

Tokens can be revoked independently of the user's password. Use separate tokens per environment.

### Environment Variables vs. Config File

```bash
# Preferred for containers / CI / production
export DRUPAL_API_TOKEN="eyJhbGci..."
export DRUPAL_BASE_URL="https://mysite.com"
node src/index.js
```

```json
// Acceptable for local dev — file is gitignored
{
  "sites": {
    "local": { "apiToken": "..." }
  }
}
```

**Never commit `config/config.json`.** It is gitignored. Verify with `git status` before any push.

### Dedicated API User

Create a Drupal user specifically for the connector. Do **not** use the `admin` account:

```bash
drush user:create mcp-api --mail="mcp-api@internal.example.com" --password="$(openssl rand -base64 32)"
drush user:role:add mcp_api mcp-api   # a dedicated least-privilege role you define
```

Give that role only what the connector needs — for read-only auditing, typically:
- `access content`
- `access user profiles`
- `view media`

Grant additional permissions only as needed. Never grant `administer nodes`, `bypass content access`, or any `administer` permission to the API user.

> With the **MCP Sentinel** module installed, bind this role to an `mcp_policy_profile` and issue the connector an OAuth token (Consumer with `mcp_read`/`mcp_write` scopes). Governance and audit then key off the authenticated role and scopes server-side. See the [MCP Sentinel project page](https://www.drupal.org/project/mcp_sentinel).

---

## Drush Bridge Security

The Drush SSH bridge has additional requirements:

- **SSH key auth only** — password-based SSH is not supported
- **Ed25519 keys recommended** — stronger than RSA: `ssh-keygen -t ed25519`
- **Key path validation** — key must be under `$HOME` or `/etc/ssh`
- **No agent forwarding** — disabled in the SSH client config
- **Argument escaping** — all args are single-quote escaped before shell execution
- **Machine name validation** — module names and role names are validated against `/^[a-z][a-z0-9_]*$/`
- **SQL allowlist** — only `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` are permitted; secondary injection patterns are also checked

For production: restrict the SSH key to specific commands in `~/.ssh/authorized_keys`:
```
restrict,command="/var/www/html/vendor/bin/drush" ssh-ed25519 AAAA... mcp-api-key
```

---

## Security Checklist

Before going live with any non-development site:

- [ ] `baseUrl` uses `https://`
- [ ] `apiToken` is a scoped Bearer token (not admin password)
- [ ] `config/config.json` is not committed (`git status` verified)
- [ ] `security.preset` is `auditor` or `production-strict` on live sites
- [ ] `security.allowDestructive` is `false`
- [ ] `security.readOnly` is `true` for analysis-only workloads
- [ ] Dedicated Drupal API user created with `mcp_api` role only
- [ ] TLS certificates configured for HTTP transport mode
- [ ] `drupal_security_info` called to verify the active policy
- [ ] ESLint passing: `npm run lint`
- [ ] No known vulnerabilities: `npm audit`
