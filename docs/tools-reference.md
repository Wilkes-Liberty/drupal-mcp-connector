# Tools Reference

Complete reference for all 66 tools across 9 modules.

> **Tip:** Call `drupal_list_entity_types` first on an unfamiliar site to discover available resource types, and `drupal_security_info` to see the active access policy.

> **Backends & output shape.** Read tools run against whichever backend the site declares (`api`: JSON:API or GraphQL) and return a canonical entity shape
> (`{ id, entityType, bundle, title, status, langcode, created, changed, url, fields, relationships, _backend }`), so the same tools behave identically across backends. Write tools (create/update/delete) require a JSON:API backend; against a read-only GraphQL site they return a clear capability error. On GraphQL, filters are applied client-side over a bounded fetch and results may be flagged `approximate`/`truncated`.

---

## Navigation

- [Nodes](#nodes) — 6 tools
- [Taxonomy](#taxonomy) — 6 tools  
- [Users](#users) — 7 tools
- [Media](#media) — 9 tools
- [GraphQL](#graphql) — 2 tools
- [Site](#site) — 3 tools
- [Entities (Generic)](#entities-generic) — 8 tools
- [Reports](#reports) — 10 tools
- [Drush](#drush) — 15 tools

---

## Nodes

Tools for creating, reading, updating, and deleting Drupal content nodes. Reads use the configured backend; writes require a JSON:API backend.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_get_node` | `type`, `id` | Fetch a single node by UUID. Returns all attributes. |
| `drupal_list_nodes` | `type` | List nodes with filter, sort, pagination support. |
| `drupal_search_content` | `query` | Search nodes by title substring. |
| `drupal_create_node` | `type`, `title` | Create a node. Pass arbitrary fields via `fields` object. |
| `drupal_update_node` | `type`, `id` | Update node fields. Only send what you want to change. |
| `drupal_delete_node` | `type`, `id` | Permanently delete a node. Requires `allowDestructive: true`. |

### drupal_get_node

```json
{
  "site": "production",
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

Returns a canonical entity: `id`, `entityType`, `bundle`, `title`, `status`, `langcode`, `created`, `changed`, `url`, `fields` (body, summary, and other non-base fields), `relationships`, `_backend`.

### drupal_list_nodes

```json
{
  "type": "article",
  "status": true,
  "limit": 20,
  "offset": 0,
  "sort": "-changed",
  "filter": {
    "filter[field_category.name][value]": "Technology"
  }
}
```

The `filter` object accepts raw JSON:API filter parameters for advanced filtering.

### drupal_create_node

```json
{
  "type": "article",
  "title": "My New Article",
  "body": "<p>Article body HTML</p>",
  "summary": "A brief summary",
  "status": false,
  "fields": {
    "field_tags": [{"type": "taxonomy_term--tags", "id": "term-uuid-here"}],
    "field_category": {"type": "taxonomy_term--category", "id": "cat-uuid-here"}
  }
}
```

---

## Taxonomy

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_vocabularies` | — | List all vocabularies on the site. |
| `drupal_get_taxonomy_terms` | `vocabulary` | List terms in a vocabulary. |
| `drupal_get_taxonomy_term` | `vocabulary`, `id` | Fetch a single term by UUID. |
| `drupal_create_taxonomy_term` | `vocabulary`, `name` | Create a term. Supports hierarchy via `parentId`. |
| `drupal_update_taxonomy_term` | `vocabulary`, `id` | Update a term's name, description, or weight. |
| `drupal_delete_taxonomy_term` | `vocabulary`, `id` | Delete a term. Requires `allowDestructive: true`. |

---

## Users

All user tools respect the security config. Set `"deniedEntityTypes": ["user"]` to block all user access. User `pass` and `mail` are redacted in `auditor` and `production-strict` presets.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_users` | — | List users. Filter by `status` (boolean) or `role`. |
| `drupal_get_user` | `id` | Fetch a user by UUID including roles. |
| `drupal_get_user_by_name` | `name` | Look up a user by exact username. |
| `drupal_create_user` | `name`, `mail` | Create a user with optional roles and password. |
| `drupal_update_user` | `id` | Update user fields. Role list is a full replacement. |
| `drupal_block_user` | `id` | Block or unblock an account. |
| `drupal_list_roles` | — | List all defined user roles. |

---

## Media

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_media_types` | — | List all media types (image, document, remote_video, etc.). |
| `drupal_list_media` | — | List media entities. Filter by type, status, name. |
| `drupal_get_media` | `type`, `id` | Fetch a single media entity by UUID. |
| `drupal_create_media` | `type`, `name` | Create a media entity. Pass source field in `fields`. |
| `drupal_update_media` | `type`, `id` | Update a media entity. |
| `drupal_delete_media` | `type`, `id` | Delete a media entity. Requires `allowDestructive: true`. |
| `drupal_upload_file` | `filePath`, `bundle`, `fieldName` | Upload a local file. Returns file UUID for use in create_media. |
| `drupal_upload_file_and_create_media` | `filePath`, `mediaType`, `fieldName` | Upload + create media in one step. |
| `drupal_find_orphaned_media` | — | Find media entities not referenced by any content. |

### Remote Video Example

```json
{
  "type": "remote_video",
  "name": "My YouTube Video",
  "fields": {
    "field_media_oembed_video": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }
}
```

---

## GraphQL

Requires the [GraphQL Compose](https://www.drupal.org/project/graphql_compose) module. GraphQL Compose exposes a read-only schema (no mutations); when `allowGraphqlMutations` is off (the default), any document containing a mutation is rejected by the connector before it is sent.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_graphql` | `query` | Execute a GraphQL query. Mutations are gated by `allowGraphqlMutations`. |
| `drupal_graphql_introspect` | — | Inspect schema. Add `typeName` for detailed field info on a specific type. |

### Example Query

GraphQL Compose exposes per-bundle connection fields (e.g. `nodeArticles { nodes { … } }`):

```json
{
  "query": "query GetArticles($first: Int) { nodeArticles(first: $first) { nodes { id title } } }",
  "variables": { "first": 10 }
}
```

### Introspect a Specific Type

```json
{
  "typeName": "NodeArticle"
}
```

---

## Site

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_site_info` | — | Base URL and all available JSON:API resource types. |
| `drupal_list_content_types` | — | All content types with machine names and descriptions. |
| `drupal_list_sites` | — | All configured site profiles (from config.json). |

---

## Entities (Generic)

Works with **any** Drupal entity type — paragraphs, commerce products, webform submissions, custom entities, and anything else exposed via JSON:API.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_entity_types` | — | Discover all accessible JSON:API resource types on this site. |
| `drupal_get_entity_schema` | `entityType`, `bundle` | Inspect available fields before creating/updating. |
| `drupal_entity_list` | `entityType`, `bundle` | List entities with filter, sort, pagination. |
| `drupal_entity_get` | `entityType`, `bundle`, `id` | Fetch any entity by UUID. |
| `drupal_entity_create` | `entityType`, `bundle` | Create any entity with arbitrary attributes and relationships. |
| `drupal_entity_update` | `entityType`, `bundle`, `id` | Update any entity. |
| `drupal_entity_delete` | `entityType`, `bundle`, `id` | Delete any entity. Requires `allowDestructive: true`. |
| `drupal_security_info` | — | Show active security configuration for a site. |

### Paragraphs Example

```json
{
  "entityType": "paragraph",
  "bundle": "text",
  "attributes": {
    "field_text": { "value": "<p>Hello world</p>", "format": "full_html" }
  }
}
```

### Commerce Product Example

```json
{
  "entityType": "commerce_product",
  "bundle": "default",
  "filter": { "filter[status]": "1" },
  "limit": 20
}
```

---

## Reports

Read-only audit and analysis tools. All respect the security config.

| Tool | Key params | Description |
|------|-----------|-------------|
| `drupal_report_content_summary` | — | Node counts by type and status. Start here for any audit. |
| `drupal_report_stale_content` | `type`, `days` | Content not updated in N days. Default: 180 days. |
| `drupal_report_content_by_author` | `type` | Node count per author UUID, sorted by most prolific. |
| `drupal_report_recently_published` | `type`, `limit` | Most recently published content. |
| `drupal_report_field_completeness` | `type` | % of nodes with optional fields populated. Finds SEO gaps. |
| `drupal_report_taxonomy_usage` | `vocabulary` | How many nodes reference each term. Finds orphaned terms. |
| `drupal_report_revision_hotspots` | `type` | Nodes with most revisions — spots churn. Requires D9.3+. |
| `drupal_report_user_activity` | `inactiveDays` | Active/blocked/inactive user summary. |
| `drupal_report_seo_audit` | `type`, `sampleSize` | Missing meta descriptions, title length, thin content. |
| `drupal_report_accessibility_audit` | `type`, `sampleSize` | Missing alt text, H1s in body, bad link text, tables without captions. |

---

## Drush

Requires `drushSsh` config block. SSH key auth only — no passwords.

| Tool | Write? | Description |
|------|:------:|-------------|
| `drupal_drush_status` | — | Site status report: version, DB, file paths. |
| `drupal_drush_config_status` | — | Config sync status: in sync or list of differences. |
| `drupal_drush_security_updates` | — | Modules with known security advisories. |
| `drupal_drush_module_list` | — | List modules. Filter by enabled/disabled. |
| `drupal_drush_watchdog` | — | Recent dblog entries. Filter by type/severity. |
| `drupal_drush_sql_query` | — | Read-only SQL (SELECT/SHOW/DESCRIBE/EXPLAIN only). |
| `drupal_drush_user_list` | — | List users via Drush. |
| `drupal_drush_cache_rebuild` | ✅ | `drush cache:rebuild`. |
| `drupal_drush_cron` | ✅ | `drush cron`. |
| `drupal_drush_config_export` | ✅ | Export config to sync directory. |
| `drupal_drush_config_import` | ✅ | Import config from sync directory. Confirm before prod. |
| `drupal_drush_updatedb` | ✅ | Run pending DB updates. |
| `drupal_drush_module_enable` | ✅ | Enable a module. Machine name validated. |
| `drupal_drush_module_disable` | ✅ | Uninstall a module. Irreversible. Confirm first. |
| `drupal_drush_user_create` | ✅ | Create a user with roles. Password min 12 chars. |

All write operations require `security.readOnly: false`. Delete-class operations additionally require `security.allowDestructive: true`.

---

## MCP Resources

Browsable resources (not tools) — the client reads these for ambient site context.

| URI | Description |
|-----|-------------|
| `drupal://sites` | All configured site names |
| `drupal://{site}/content-types` | Content types with machine names |
| `drupal://{site}/security-policy` | Active security configuration |

## MCP Prompts

Slash-command workflow templates.

| Name | Arguments | Description |
|------|-----------|-------------|
| `drupal-content-audit` | `site?` | Full content audit: inventory, staleness, SEO, a11y |
| `drupal-create-article` | `site?`, `topic` | Research, draft, and publish an article |
| `drupal-seo-fix` | `site?`, `type?` | Find and fix SEO gaps interactively |
| `drupal-user-cleanup` | `site?` | Audit and clean up user accounts |
