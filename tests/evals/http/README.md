# HTTP transport eval pack (DEV-866, increment 2)

Run: `npm run eval:http`. Prerequisites: Node, npm, and an `openssl`
executable on `PATH` (T1n generates a one-day throwaway TLS pair with it;
the pack names the missing binary rather than failing on ENOENT). It is not part of `npm test` or `npm run check`.
A separate, non-required GitHub Actions job runs the pack on pull requests.

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
(DEV-858 / #451).

Everything is synthetic: keys are generated in memory, the token issuer is
a stub that is **not Paladin**, and the upstream is a fake loopback server
with per-tenant canaries. It proves connector logic, not Paladin, Keystone,
or production Sentinel.
DEV-862 adds T17: a built-in tool with no scope-table row is absent from
`tools/list` and refused on `tools/call` with zero upstream calls. DEV-861
adds T18: a disallowed Host is 403 after auth with no dispatch, while an
unauthenticated request with a bad Host is still the shared 401
(DEV-845 / DEV-877).

| Piece | Where |
|-------|-------|
| Case ids and T1/T7 request-label twins | `manifest.json` |
| Live tool/route → covering case (a-5) | `coverage.json`, `cases/ta5.eval.js` |
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
open ticket plus an expiry date (c-1, c-2).

Mutants are dependency swaps in `harness/build.js`. `src/` has no eval or
mutant switch. The only `src/` change in this increment is the test seam:
`startHttpsTransport` (what `index.js` calls) plus injectable handler
predicates the mutants swap. `EVAL_HTTP_SRC` points the harness at a scratch
copy of `src/`.
T17 swaps in a fail-open scope table (the v3.2.x default) and T18 a Host
no-op; both go red.
