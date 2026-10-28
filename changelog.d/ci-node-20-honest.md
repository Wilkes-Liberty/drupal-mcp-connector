---
section: Changed
---
Run the required `Lint, Syntax & Unit (Node 20)` CI job on Node 20 so the check name, `engines.node` (>=20.0.0), and the runner agree. The same quality-gate steps also run on Node 24 in a separate non-required job. The container image and release publish stay on Node 24 LTS.
