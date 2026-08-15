# Verifying a secure install

A README can claim an install is secure. This verifier produces evidence for
the claim, and fails when the claim is false.

```bash
npm run verify                                    # the loaded config
npm run verify -- --config config/config.example.json
npm run verify -- --live --site production        # also exercise a running target
npm run verify -- --live --site staging --json > evidence.json
```

The exit code is `0` only when every applicable check ran **and** passed.

Two non-passing outcomes are deliberately different:

- **`SKIP`** — the check should have run and could not (no usable token, a
  bridge that would not answer, a response it could not measure, no content
  target supplied). A skipped check **fails the run**: a verifier that reports
  success for something it never exercised is worse than no verifier at all.
- **`N/A`** — the check does not apply to this shape of install (no OAuth, so
  no scopes to name and no principals to separate; no tool bridge, so no config
  surface to deny; a principal that legitimately holds `mcp_config`). It does
  **not** fail the run. A verifier a secure install can never pass is a
  verifier people stop running.

Nothing secret reaches the output. The evidence carries hostnames, statuses and
the source's own stable refusal codes — never a token, a client secret, or the
body of a governed read.

## Static checks (no network, no credentials)

These read the configuration a clean install ships with, so they run in CI.

| Check | What it proves |
|---|---|
| `transport` | Every site is reached over HTTPS (an explicit loopback target is the only exception). |
| `principal_auth` | Every site authenticates as a named principal, with the secret read from the environment rather than written into the config file, and `requireSecureAuth` set on governed sites. |
| `scope_grant` | Every OAuth site names the scopes its token carries. An unnamed grant is not a wildcard — see the empty-scope note below. |
| `source_governance` | Governed sites set `requireGovernance`, so the connector denies rather than falling back to an ungoverned JSON:API or GraphQL path. |
| `role_separation` | Each role has its own OAuth client id and its own secret env var; sharing either makes a compromise of one role a compromise of all of them. |
| `entitlement` | Every site pins a security preset, and the permissive `development` preset stays on loopback. |
| `target_resolution` | Every site resolves to exactly one target and the default site exists. |
| `tenant_neutrality` | The configuration names no real deployment: hostnames are documentation-reserved (RFC 2606/6761). |

## Live checks (opt-in, `--live`)

These prove the same claims against a running target, using the site's own
credentials from the environment.

| Check | What it proves |
|---|---|
| `transport` | The target answers over an encrypted transport. |
| `principal_auth` | The principal mints a **usable** access token **and** an anonymous request to a governed path is refused. Without a usable token every authenticated check below is `skipped`, not passed: a 401 is not a policy decision, and a probe that "passes" because it was unauthenticated proves nothing. |
| `source_governance` | The source's governance contract verifies (`GET /drupal-mcp/readiness`); a failure reports the source's own stable reason. |
| `entitlement_filtering` | An out-of-tier operation is filtered for this principal. |
| `target_resolution` | The site resolves to one target that describes itself. |

### Negative probes

Three checks are deliberately inverted: they attempt something a governed
principal must **not** be able to do, and pass only when the target refuses.
A served probe is the finding.

| Probe | Attempts | Passes when |
|---|---|---|
| `probe_mass_read` | a 5000-item collection read | the source refuses it (e.g. `read_budget_exceeded`) **or** serves a materially smaller page — a cap is a bound, and reporting one as an unbounded read would train operators to ignore the verifier. A success whose size cannot be measured is `skipped`, never a pass. |
| `probe_config_change` | a configuration write through the connector's own bridge client — the real MCP session, the governed `tool_api.mcp_sentinel_config_set` name and its argument shape, refusal surfaced as a tool error | the source refuses it. **Skipped** for a principal that holds `mcp_config` (a developer or break-glass role is *supposed* to write config; failing its healthy run would be a false finding). |
| `probe_content_edit` | a publish-bearing edit (`status: true`, nothing else) against the node given by `--content-target` | the source refuses it with **403/401** — an authorisation decision. A 404, 422 or 5xx is `skipped`: a PATCH at an id that does not exist returns 404 *before* any access check, so counting it would claim the publish gate holds without ever reaching it. Skipped entirely when no target is supplied, or for a principal with no write scope. |

**A thrown error is not automatically a refusal.** The bridge client throws for
several unrelated reasons, and only some of them mean the source decided: a
tool-level refusal, a server-defined JSON-RPC error, or a 401/403 on the call
are decisions and pass the probe; a missing `serverTools.url`, a session that
would not initialise, a network failure, or a standard JSON-RPC error (method
not found, invalid params) mean the probe never reached policy, and are
`skipped` with the reason recorded. Scoring those as refusals is exactly how a
verifier ends up green for an install that proved nothing.

The config probe writes nothing when the gate holds. The content probe is
deliberately the one exception, because a publish gate cannot be proven without
attempting a publish: supply `--content-target <uuid>` pointing at a node on a
**non-production** target that you would not mind being published if the floor
fails. The payload sets only `status: true`, so an accepted edit changes nothing
else — and an accepted edit is the finding, reported loudly. Expect audit rows
on the source either way: a refusal is a security event and is recorded as one.

```bash
npm run verify -- --live --site staging --content-target 2f1c…  --json > evidence.json
```

## The empty-scope rule

An OAuth site that names no scopes used to satisfy every scope gate, because an
empty list was read as "unconstrained". It is now read as what it is — an
unnamed grant — and satisfies nothing. Name the scopes your consumer actually
carries:

```json
"oauth": {
  "clientId": "content-agent-production",
  "clientSecretEnv": "MCP_CONTENT_PRODUCTION_SECRET",
  "scopes": ["mcp_read", "mcp_write"]
}
```

A site with no OAuth block at all (a plain `apiTokenEnv` install) is unaffected:
it has no scope vocabulary to name, and its security preset decides alone.

## Managed residuals

The evidence document ends with residuals on purpose. A verification that lists
only what passed reads as a claim that nothing else is outstanding.

### Prompt injection — managed, not solved

Prompt injection is **not** solved by this connector, and no configuration of it
makes an agent immune. Content read through a governed path can carry
instruction-shaped text, and a model may act on it.

What the stack constrains is the blast radius:

- least-privilege OAuth scopes per role, and a security preset per site;
- source-side governance (entity and field denies, classification egress
  ceilings, finite read budgets) that binds what any principal can reach,
  whoever is steering it;
- no agent publication authority — the editorial gate is the source's, so the
  worst case of a redirected agent is a draft, not a live page;
- an audit row for every governed action, including every refusal.

Treat model output as untrusted input to whatever consumes it next. Do not wire
an agent's output into a privileged action without a human decision in between.

### Operator trust — managed, not solved

An operator holding the client secrets can act with the agent's authority.
Secret custody, rotation and revocation stay with the deploying organisation;
the connector reads secrets from the environment and never stores them.

## Evidence for a release proof

`--json` prints the artefact to attach to a release record:

```json
{
  "tool": "drupal-mcp-connector verify",
  "mode": "static",
  "connectorVersion": "2.5.0",
  "generatedAt": "2026-08-15T12:00:00.000Z",
  "subject": { "source": "config/config.json", "siteCount": 4, "configDigest": "sha256:…" },
  "checks": [ { "id": "transport", "status": "pass", "findings": [] } ],
  "residuals": [ { "id": "prompt_injection", "status": "managed", "detail": "…" } ],
  "summary": { "pass": 8, "fail": 0, "skipped": 0, "ok": true }
}
```

`configDigest` is a stable hash of the verified configuration with secrets
redacted, so a later claim can be tied to the exact input without carrying it.
