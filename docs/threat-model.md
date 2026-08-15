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
| T5 | **Auth bypass on the HTTPS transport** | `/mcp` bearer-gated (GET/POST/DELETE) before body parsing, protocol classification, or session handling; constant-time token compare (`timingSafeEqual` + length check); exact-path match; only `/health` is open and leaks nothing sensitive | ✅ controlled |
| T6 | **Plaintext exposure / MITM** on the network | TLS mandatory off-localhost (process exits without certs unless `MCP_ALLOW_HTTP=1`, which force-binds loopback); HSTS + strict CSP headers | ✅ controlled |
| T7 | **DoS / brute force** against `/mcp` | Optional per-IP rate limiting (`MCP_RATE_LIMIT`), checked before auth; recommend also rate-limiting at the reverse proxy | ✅ opt-in |
| T8 | **SSRF** via request-time URL control | `baseUrl`/endpoints are operator config, not per-call tool inputs; `validateBaseUrl` enforces HTTPS for non-localhost | ✅ controlled |
| T9 | **Unintended DB writes** via the drush `sql:query` bridge | Best-effort read-only allowlist (`validateSqlQuery`); single-statement execution. **Best-effort only** — see residual risks | ⚠️ partial |
| T10 | **Over-privileged writes** (publishing, deleting, editing beyond intent) | Drupal-side governance is authoritative; connector security presets (`auditor`/`write-plane`/…) add a client-side cap; destructive ops gated | ✅ defense-in-depth |
| T11 | **Protocol confusion / cross-era fallback** | One bounded body is classified once by the stable SDK and sent to exactly one arm; modern header/body version, method, and tool-name disagreements are rejected; a failed arm never falls through to the other | ✅ controlled |
| T12 | **Internal error or secret disclosure at the HTTP boundary** | Expected malformed/oversized requests get stable 400/413 responses; unexpected conversion/classification/dispatch failures are sanitized, and partial responses are destroyed without echoing the error | ✅ controlled |

### Note on T3 (filter fields)

Filter/sort field names are intentionally **not** run through `validateFieldName`:
JSON:API supports dotted relationship paths (e.g. `uid.name`,
`field_image.meta.alt`) that a strict machine-name check would wrongly reject.
The `URLSearchParams` encoding already neutralizes injection, so the residual
risk is only malformed/oversized keys (low). Don't "fix" this by tightening the
validator — it would break legitimate relationship filters.

## Residual risks & operator recommendations

- **Drush SQL bridge (T9):** `drupal_drush_sql_query` is now off unless a site
  sets `drushSsh.rawSql: "governed"`, and it runs through mcp_sentinel's
  `mcp-sentinel:sql-query`, where Drupal's policy profile decides and every
  attempt is audited. The residual risk is no longer "the allowlist here is
  best-effort" — that check is only a fast local reject — but that **raw SQL is
  a weaker boundary than an entity read even when governed**: the server's
  guard constrains which tables and columns a statement may touch, not what an
  expression over an allowed column can reconstruct. Leave `allow_raw_sql` off
  on the policy profile unless a reviewed workflow needs it, and **use a
  dedicated read-only database credential** for the bridge connection.
- **The rest of the SSH bridge is outside Drupal governance entirely.**
  `sql:cli`, `sql:dump` and `php:eval` do not load Drupal's module system —
  Drush caps their bootstrap below the level at which module command files are
  discovered — so no Drupal-side policy can apply to them, whatever the site
  configures. Pin `allowedCommands` per site and treat SSH as an operator
  channel rather than an agent one.
- **The connector is not the access-control authority.** Keep a Drupal-side
  governance module active (MCP Sentinel) and a least-privilege OAuth
  consumer/role — the connector's presets are a second layer, not the first.
- **Exposing the HTTPS transport** widens the attack surface; follow the
  pre-exposure checklist in [deployment.md](deployment.md). Non-loopback binds
  **require** `MCP_AUTH_TOKEN` (fail closed) unless `MCP_ALLOW_UNAUTHENTICATED=1`.
  Prefer TLS + tight `MCP_BIND_HOST` + rate limiting (default 120/min on
  non-loopback HTTPS) and/or a reverse-proxy allow-list.

## Residual risks (post 2.2 security suite)

| Item | Status |
|------|--------|
| Specialized tool entity allowlists | Mitigated (#138) |
| Upload arbitrary local paths | Mitigated (`MCP_UPLOAD_ROOT` / cwd allowlist, #137) |
| Media auto-publish / moderation publish gate | Mitigated (#139) |
| Live link-check open redirects to private IPs | Mitigated (`redirect: "manual"`, #143) |
| Omitted `security` defaults to open mode | Mitigated — default is `production-strict` (#140) |
| GraphQL path skips entity allowlist + redaction | Mitigated by fail-closed gate — tools off unless `allowGraphql` (#142); raw results still bypass policy when opted in |
| Transitive MCP transport advisories | Mitigated — stable modular MCP 2.0.0 packages plus maintained npm overrides (#128, #172) |

**When GraphQL is explicitly enabled**, treat results as Drupal-permission-only
(no connector allowlist/redaction on that path). Prefer JSON:API entity tools
for policy-bound reads.

## Managed residuals (not solved by this stack)

Listed here because a threat model that names only mitigated threats reads as a
claim that nothing else is outstanding. Both are verifiable: `npm run verify`
emits them with every evidence document (see
[Verification](verification.md)).

### Prompt injection

**Managed, not solved.** Content read through a governed path can carry
instruction-shaped text, and a model may act on it. No connector setting makes
an agent immune. What the stack bounds is the blast radius: least-privilege
scopes per role, a security preset per site, source-side governance (entity and
field denies, classification egress ceilings, finite read budgets), no agent
publication authority — so a redirected agent's worst case is a draft, not a
live page — and an audit row for every governed action, refusals included.
Treat model output as untrusted input to whatever consumes it next.

### Operator trust

**Managed, not solved.** An operator holding the client secrets can act with the
agent's authority. Secret custody, rotation and revocation stay with the
deploying organisation; the connector reads secrets from the environment and
never stores them.

## Assurance performed

- `eslint-plugin-security` runs in CI lint.
- Unit suite + Drupal integration job in CI.
- `npm run verify` proves the shipped secure defaults on every CI run: the
  example configuration is verified tenant-neutral and secure by the same
  checks an operator runs against their own (#180).
- 2026-07 security audit (upload, publish, HTTPS, entity policy, link-checker)
  drove the 2.1 hardening suite; 2.2 closed remaining default-preset, GraphQL
  gate, and dependency residual items.
