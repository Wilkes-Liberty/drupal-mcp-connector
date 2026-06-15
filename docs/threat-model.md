# Threat Model

A concise threat model for `drupal-mcp-connector`, current as of the 1.0
hardening pass. It records the trust boundaries, the controls in place, and the
residual risks an operator should know about. For how to report a vulnerability,
see [SECURITY.md](../SECURITY.md).

## Architecture & trust boundaries

```
[MCP client / AI]  --(MCP: stdio or HTTPS)-->  [connector]  --(JSON:API/GraphQL/OAuth)-->  [Drupal]
                                                    └--(optional SSH)-->  [Drupal host: drush]
```

| Boundary | Trust assumption |
|---|---|
| **Operator config** (`config/config.json`, env, TLS certs, SSH key, `baseUrl`, `drupalRoot`) | **Trusted.** Set by the operator, not the AI. Not attacker-controlled. |
| **MCP tool inputs** (ids, bundles, titles, field values, filters, drush args, SQL) | **Untrusted.** An AI client (or a compromised/confused one) can send arbitrary values. Validate at this boundary. |
| **Drupal** | **Authoritative.** Drupal core permissions + the governance module (e.g. MCP Sentinel) are the real access-control gate. The connector is defense-in-depth, not the primary control. |
| **HTTPS transport network** | Untrusted when exposed; protected by TLS + bearer auth + bind-host + rate limiting. |

## Assets

- Drupal **content and PII** (users, fields).
- The **OAuth client secret / bearer tokens / basic-auth passwords**.
- The **Drupal host** itself (via the SSH Drush bridge — RCE-adjacent if misused).

## Threats & mitigations

| # | Threat | Mitigation | Status |
|---|--------|-----------|--------|
| T1 | **Shell/command injection** via drush args on the Drupal host | All args POSIX single-quote escaped (`sanitizeSshArg`); module/role/type args additionally `validateMachineName`'d; SSH is key-only, no agent-forward; `drupalRoot` is trusted config | ✅ controlled |
| T2 | **Path traversal / cross-resource access** via `id`/`bundle`/`entityType` interpolated into JSON:API paths (e.g. `id="../../user/user/…"` to read PII despite an entity-type denylist) | `validateUuid(id)` + `validateMachineName(entityType, bundle)` at the backend, plus `encodeURIComponent` on every path segment | ✅ fixed (this pass) |
| T3 | **Query-param injection** via filter `field`/`value` | `URLSearchParams` percent-encodes keys and values, so inputs cannot break out into separate params | ✅ controlled (see note below) |
| T4 | **Secret leakage** into logs / errors / tool output | Secrets sourced from env; never logged; `OAuthError` carries status only; tool errors return `err.message` without credentials; `Authorization` header never echoed; `getSecuritySummary` omits credentials | ✅ controlled |
| T5 | **Auth bypass on the HTTPS transport** | `/mcp` bearer-gated (GET+POST) before session handling; constant-time token compare (`timingSafeEqual` + length check); exact-path match (no `/mcp?…` bypass); only `/health` is open and leaks nothing sensitive | ✅ controlled |
| T6 | **Plaintext exposure / MITM** on the network | TLS mandatory off-localhost (process exits without certs unless `MCP_ALLOW_HTTP=1`, which force-binds loopback); HSTS + strict CSP headers | ✅ controlled |
| T7 | **DoS / brute force** against `/mcp` | Optional per-IP rate limiting (`MCP_RATE_LIMIT`), checked before auth; recommend also rate-limiting at the reverse proxy | ✅ opt-in |
| T8 | **SSRF** via request-time URL control | `baseUrl`/endpoints are operator config, not per-call tool inputs; `validateBaseUrl` enforces HTTPS for non-localhost | ✅ controlled |
| T9 | **Unintended DB writes** via the drush `sql:query` bridge | Best-effort read-only allowlist (`validateSqlQuery`); single-statement execution. **Best-effort only** — see residual risks | ⚠️ partial |
| T10 | **Over-privileged writes** (publishing, deleting, editing beyond intent) | Drupal-side governance is authoritative; connector security presets (`auditor`/`write-plane`/…) add a client-side cap; destructive ops gated | ✅ defense-in-depth |

### Note on T3 (filter fields)

Filter/sort field names are intentionally **not** run through `validateFieldName`:
JSON:API supports dotted relationship paths (e.g. `uid.name`,
`field_image.meta.alt`) that a strict machine-name check would wrongly reject.
The `URLSearchParams` encoding already neutralizes injection, so the residual
risk is only malformed/oversized keys (low). Don't "fix" this by tightening the
validator — it would break legitimate relationship filters.

## Residual risks & operator recommendations

- **Drush SQL bridge (T9):** the read-only allowlist is a denylist-assisted
  best-effort, not a guarantee. If you enable the drush bridge and expose
  `drupal_drush_sql_query`, **use a dedicated read-only database credential** for
  that connection. Better still, leave the drush bridge disabled unless needed.
- **The connector is not the access-control authority.** Keep a Drupal-side
  governance module active (MCP Sentinel) and a least-privilege OAuth
  consumer/role — the connector's presets are a second layer, not the first.
- **Exposing the HTTPS transport** widens the attack surface; follow the
  pre-exposure checklist in [deployment.md](deployment.md) and keep
  `MCP_AUTH_TOKEN` + TLS + bind-host (+ rate limiting / IP allow-list) on.

## Assurance performed (1.0 security pass)

- `npm audit` — **0 vulnerabilities**.
- `eslint-plugin-security` runs in CI lint.
- Adversarial code review across command/query/path injection, secret handling,
  auth/transport, and SSRF — one MEDIUM finding (T2) fixed; LOWs (T3, T9)
  documented above with rationale. No critical/high issues.
