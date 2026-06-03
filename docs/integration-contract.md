# Integration Contract

**Contract version: 1.0**

This document defines the contract between `drupal-mcp-connector` and an optional
**Drupal-side governance layer**. The connector works against plain Drupal core
(JSON:API and/or GraphQL Compose) with no governance module installed; when a
governance module *is* present, both sides honor the contract below so they
interoperate predictably.

The reference governance implementation is the **[MCP Sentinel](https://www.drupal.org/project/mcp_sentinel)**
module (`drupal/mcp_sentinel`), but the contract is implementation-neutral — any
module that follows it will interoperate.

---

## 1. Identity header (log-only)

Every outbound request the connector makes to Drupal carries:

```
X-MCP-Client: drupal-mcp-connector/<version>
User-Agent:   drupal-mcp-connector/<version>
```

- This is a **log/observability label only** — it MUST NOT be used as an
  enforcement signal. An agent cannot gain or bypass access by setting or
  omitting it.
- The value is overridable via the `MCP_CLIENT_ID` environment variable, or
  disabled by setting it to an empty string.
- A governance layer MAY record this string for audit/attribution display, but
  MUST key authorization on the authenticated identity (below), never on this header.

## 2. Authentication

The connector authenticates to Drupal with **OAuth2** (via Drupal `simple_oauth`):

- **`client_credentials`** grant for unattended/service operation (a dedicated
  Consumer bound to a machine user), or
- **`authorization_code` + PKCE** for named-human attribution (federated to an
  external IdP if configured).

Tokens are obtained from the site's token endpoint (default `/oauth/token`),
cached in memory, and silently refreshed before expiry. The client secret is
sourced from an environment variable (`oauth.clientSecretEnv`) and never stored
in config or surfaced in errors.

## 3. Scopes

Two OAuth2 scopes partition connector operations:

| Scope | Operations |
|-------|-----------|
| `mcp:read` | read / list / explain / introspect |
| `mcp:write` | create / update / delete / write-class actions |

A governance layer MAY require these scopes per tool/operation. The token's
granted scopes are the authoritative capability set; the connector's own preset
(below) is a complementary, client-side restriction.

## 4. Authorization & governance (server-authoritative)

Authorization is decided **inside Drupal**, keyed on the **authenticated account's
role and the token's OAuth scopes** — never on the `X-MCP-Client` header. When a
governance module is installed it is the **authoritative** gate: it may enforce
role-bound policy profiles (operation gates, entity-type allow/deny, field
redaction), audit logging, content locks, and rate limits.

The connector enforces a **complementary, defence-in-depth** policy on its side
(see [security.md](security.md)) — e.g. the `write-plane` preset mirrors a
recommended governance profile (no delete, no GraphQL mutations, entity access
limited to `node`/`taxonomy_term`/`media`, `user` denied, `pass`/`mail` redacted).
The connector preset is advisory hardening; **the Drupal-side policy is the policy
of record.**

## 5. Backends

- **JSON:API** — read + write. The write plane. Writes (`create`/`update`/`delete`)
  require a JSON:API-enabled site with `read_only: false`.
- **GraphQL** (GraphQL Compose) — read-only. The connector refuses write/delete on
  a GraphQL backend with a capability error before any request is sent.

## 6. Optional context endpoint

If the governance module exposes a schema/policy context endpoint (the reference
module serves `GET /drupal-mcp/context`), the connector and clients MAY use it to
discover content types, fields, and the active policy. It is optional; the
connector functions without it.

## 7. Compatibility

| `drupal-mcp-connector` | Reference governance module (`drupal/mcp_sentinel`) | Contract |
|------------------------|-----------------------------------------------------|----------|
| ≥ 0.6 | ≥ 1.0 | 1.0 |

The connector does **not** depend on the governance module, and the governance
module does **not** depend on this specific connector. They are released
independently; this contract is the stable surface between them.

## 8. Versioning

This contract is versioned independently of either project. Backward-compatible
additions bump the minor (1.0 → 1.1); a breaking change to the header semantics,
scope names, auth flow, or endpoint shapes bumps the major (1.0 → 2.0). Both sides
should document the contract version(s) they support.
