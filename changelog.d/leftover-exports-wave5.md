---
section: Changed
---
Un-export leftover same-file helpers and drop unused eval re-exports. Inbound identity now uses the shared `freezeKeyClaims` helper so the `iss|sub|azp|act` copy cannot drift from principal context.
