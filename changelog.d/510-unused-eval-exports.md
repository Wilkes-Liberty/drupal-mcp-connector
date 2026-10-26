---
section: Removed
---

- Unused leftover eval/test exports (fourth wave after #509): same-file
  helpers and constants that nothing outside the defining file imported
  (`REQUIRED_SCOPES` / `mutantSwap`, `knownRedEntry`, `FIXTURE_NOW`,
  `ORPHAN_TOOL` / `DELETED_CASE`, `canaryFor`, `emptyPost`,
  `STUB_ISSUER_URL` / `STUB_AUDIENCE`, `opensslAvailable`,
  `INTROSPECTION_URL` / `INTROSPECTION_CLIENT_ID` /
  `INTROSPECTION_CLIENT_SECRET`). Implementations stay except
  `inboundAuthModeForEval`, `mutantIds`, `FAKE_INTROSPECTION_URL`,
  `STUB_INTROSPECTION_URL`, the unused `EVAL_HTTP_MODE` child-env key,
  and the `fixtures.js` re-export of `createMemoryApproval` /
  `createMemoryEvidenceSink` / `createLocalRelay`, which had no call
  sites. Callers keep importing those three from their defining files
  or the documented `contracts/index.js` barrel. `createMemoryBackend`
  stays on `fixtures.js`.
