# HTTP transport eval pack (DEV-866, increment 1: skeleton)

Run: `npm run eval:http`. It is not part of `npm test` or `npm run check` yet.

What it proves: the connector's HTTP request handler, wired as in hosted
(resource-server) mode, refuses a missing identity with 401 before any
dispatch (T1), still serves a legitimate request (T7, the allow twin), and
records the DEV-845 gap as an expected failure (T1n). Everything is synthetic:
keys are generated in memory, the token issuer is a stub that is **not
Paladin**, and the upstream is a fake loopback server with per-tenant canaries.
It proves connector logic, not Paladin, Keystone, or production Sentinel.

| Piece | Where |
|-------|-------|
| Case ids the pack must run | `manifest.json` |
| Strict known-red list (case id -> ticket) | `known-red.json` |
| Stub issuer, keys, fake upstream, counters, taps, fake clock, handler build | `harness/` |
| Cases | `cases/*.eval.js` |
| Pack rules and report (`evals-http-report.json`, gitignored) | `run-pack.js` |

Pack rules: empty or skipped pack fails; discovered ids must equal the
manifest; every run must execute counted assertions; every non-known-red case
needs a mutant that goes red; a known-red case must fail, and fails the pack if
it passes (flip detection).

Mutants in this increment are dependency swaps in `harness/build.js` (the
handler defaults for T1, a deny-everything authenticator for T7). `src/` has no
eval or mutant switch, and `run-pack.js` fails if it ever mentions one. The
patch-based mutant runner, T2 onward, and `eval:http:mutants` are later
increments. `EVAL_HTTP_SRC` points the harness at a scratch copy of `src/`.
