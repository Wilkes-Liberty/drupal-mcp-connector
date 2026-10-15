# HTTP transport eval pack (DEV-866, increment 3)

Run:

```bash
npm run eval:http          # synthetic pack (stub issuer, fake upstream)
npm run eval:mutants       # source mutants over that pack
npm run eval:http:staging  # same deny/allow twins against a staging endpoint
```

Prerequisites: Node, npm, and an `openssl` executable on `PATH` (T1n
generates a one-day throwaway TLS pair with it; the pack names the missing
binary rather than failing on ENOENT). None of these scripts are part of
`npm test` or `npm run check`. Separate, non-required GitHub Actions jobs
run `eval:http` and `eval:mutants` on pull requests.

What it proves: the connector HTTP transport, started through the same
`startHttpsTransport` path `src/index.js` uses, refuses a missing identity
with 401 and `resource_metadata` before any dispatch (T1), refuses a bad
token (T2), still serves a legitimate request (T7, the allow twin of every
T1 shape), and exercises the DEV-840 / #452 route and method shapes (T9–T14,
T16). T1n drives real startup (the shared function plus a spawn of
`src/index.js`) so a non-loopback bind with `MCP_ALLOW_UNAUTHENTICATED=1`
is fatal (DEV-845). T4/T4b cover grant deny-by-default (DEV-848). T8 records
exactly one audit row per hosted request on `/mcp`, `/usage`, and `/assessor`,
including 401 / 429 / bad-Origin, with a throwing sink that still refuses
(DEV-858 / #451). A missing credential is `actor: anonymous`, a bad bearer
is `actor: unverified`, and a verified success or post-auth denial keeps
`principal` (#472).

Increment 3 adds token-shape deny twins (wrong audience T2a, expired T2e,
insufficient scope T2s, non-member T2m; allow twin T7), the X1 scanner
(every live route and tool reaches dispatch only after authn and authz),
a source-mutant runner, and a staging pack mode.

Everything in `eval:http` is synthetic: keys are generated in memory, the
token issuer is a stub that is **not Paladin**, and the upstream is a fake
loopback server with per-tenant canaries. It proves connector logic, not
Paladin, Keystone, or production Sentinel.
DEV-862 adds T17: a built-in tool with no scope-table row is absent from
`tools/list` and refused on `tools/call` with zero upstream calls. DEV-861
adds T18: a disallowed Host is 403 after auth with no dispatch, while an
unauthenticated request with a bad Host is still the shared 401
(DEV-845 / DEV-877).

| Piece | Where |
|-------|-------|
| Case ids and T1/T7 request-label twins | `manifest.json` |
| Live tool/route → covering case (a-5) | `coverage.json`, `cases/ta5.eval.js` |
| Live route/tool authn+authz scanner (X1) | `harness/scanner.js`, `cases/x1.eval.js` |
| Declared source mutants | `harness/mutations.js`, `run-mutants.js` |
| Staging mode (env-configured, read-only) | `harness/staging.js`, `run-staging.js` |
| Strict known-red list (`ticket` + `expires` + `reason`) | `known-red.json` |
| Stub issuer, keys, fake upstream, counters, taps, fake clock, handler build | `harness/` |
| Cases | `cases/*.eval.js` |
| Pack rules and report (`evals-http-report.json`, gitignored) | `run-pack.js` |

Pack rules: empty or skipped pack fails; discovered ids must equal the
manifest; T1/T7 request labels must equal `manifest.requestLabels`; every
live tool (`allDefinitions`) and HTTP route (transport tables) must have
a covering case (Ta5); every run must execute counted assertions; every
non-known-red case needs a mutant killed on its pinned assertion label
(a-2); a known-red case must fail for its pinned reason, and needs an
open ticket plus an expiry date (c-1, c-2). Every deny case has a mutant
and an allow twin.

In-process mutants are dependency swaps in `harness/build.js`. Source
mutants (`npm run eval:mutants`) patch a scratch copy of `src/` at the
auth-gate order, Origin check, grant fall-through, scope table, and audit
denial-code sites. `src/` has no eval or mutant switch. The production
entry builds HTTPS options through `buildProductionHttpsOptions` so X1
and the unit tests can import and inspect them (no source-text "no hooks"
pin). `EVAL_HTTP_SRC` points the harness at a scratch copy of `src/`.
T17 swaps in a fail-open scope table (the v3.2.x default) and T18 a Host
no-op; both go red.

## Staging mode

`npm run eval:http:staging` is read-only. It sends the same T1 / T2a /
T2e / T2s / T2m / T11 deny twins and the T7 `mcp_read` allow twin to a
real endpoint. Set:

| Variable | Role |
|----------|------|
| `EVAL_HTTP_STAGING_BASE_URL` | Sentinel `/mcp` base (required to run) |
| `EVAL_HTTP_STAGING_ISSUER` | Paladin issuer URL (required to run) |
| `EVAL_HTTP_STAGING_AUDIENCE` | Optional audience |
| `EVAL_HTTP_STAGING_TOKEN_READ` | Legitimate `mcp_read` bearer |
| `EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE` | Wrong-audience bearer |
| `EVAL_HTTP_STAGING_TOKEN_EXPIRED` | Expired bearer |
| `EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE` | Missing required scope |
| `EVAL_HTTP_STAGING_TOKEN_NON_MEMBER` | Verified but not admitted |

When the base URL or issuer is unset the process exits 0 with a skip
reason. Tokens are never committed. The harness refuses write tool names.
Source mutants do not apply to a remote endpoint; the synthetic pack
already pins each deny to a killed mutant.
