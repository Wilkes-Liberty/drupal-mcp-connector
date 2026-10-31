---
section: Changed
---
Drop leftover sql/config/entity-write scope fallbacks from `requiredScopeForTool`. Catalog names already have `TOOL_SCOPE_TABLE` rows; site write-like checks now use `isWriteLikeTool` so the generic entity-write list cannot drift.
