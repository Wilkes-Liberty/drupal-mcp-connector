# GraphQL backend + local DDEV (mkcert TLS)

The connector supports JSON:API and GraphQL backends per site. Select with the
`api` key in `config/config.json` (`"graphql"`, `"jsonapi"`, or a priority array
like `["graphql","jsonapi"]`). Omit `api` to auto-detect (probes both once).

## Local DDEV over HTTPS (mkcert)

DDEV serves HTTPS with a locally-trusted mkcert CA that Node does not trust by
default (you'll see `UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Point Node at the mkcert
root CA when running the server:

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
node src/index.js
```

When registering with an MCP client, set `NODE_EXTRA_CA_CERTS` in the server env.

## Example: GraphQL-only site (JSON:API disabled)

```json
{
  "defaultSite": "graphql_site",
  "sites": {
    "graphql_site": {
      "baseUrl": "https://api.example.com",
      "graphqlEndpoint": "/graphql",
      "api": "graphql",
      "security": { "preset": "auditor" }
    }
  }
}
```

GraphQL is **read-only** here (graphql_compose exposes no mutations), so
create/update/delete tools return a clear "read-only backend" error by design.

## What the GraphQL backend does and doesn't support

- **Reads**: full. Entities are returned in the same canonical shape as JSON:API
  (`{ id, entityType, bundle, title, status, langcode, created, changed, url,
  fields, relationships, _backend }`).
- **Sorting**: native for `created`/`changed`/`title` (mapped to graphql_compose
  `ConnectionSortKeys`); any other sort is applied client-side.
- **Filtering**: graphql_compose has no server-side field filter, so filters are
  applied client-side over a bounded fetch (up to 1000 records). Such results are
  flagged `approximate: true`, and `truncated: true` if the cap was hit.
- **Writes**: unsupported (no mutations) — use a JSON:API site for writes.
- **Field selection** is introspection-driven and type-aware: scalar-wrapper
  objects (`DateTime`→`time`, `Language`→`id`, `TextSummary`→`value/summary/format`)
  are sub-selected; entity references (incl. `MediaUnion`/`TermUnion`) become
  canonical relationships; non-entity unions (e.g. metatags) are skipped.
