# Tools Reference

Complete reference for all 89 tools across 20 modules.

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
- [Revisions](#revisions) — 3 tools
- [Moderation](#moderation) — 3 tools
- [Scheduler](#scheduler) — 1 tool
- [Fields](#fields) — 1 tool
- [References](#references) — 1 tool
- [Bulk](#bulk) — 2 tools
- [Translations](#translations) — 2 tools
- [Paragraphs](#paragraphs) — 2 tools
- [Structure](#structure) — 4 tools
- [Search](#search) — 1 tool
- [Reports (Extra)](#reports-extra) — 3 tools

**Total: 89 tools across 20 modules.**

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

### Preview writes with `dryRun`

`drupal_create_node`, `drupal_update_node`, and `drupal_delete_node` all accept an
optional `dryRun` boolean (default `false`). When `true`, the tool validates the
request and returns a preview of exactly what would be written — without committing
anything to Drupal. Use this to confirm the resolved attributes before a real write.

```json
{
  "type": "article",
  "title": "My New Article",
  "body": "<p>Article body HTML</p>",
  "dryRun": true
}
```

Returns a preview envelope instead of a created entity:

```json
{
  "dryRun": true,
  "operation": "create",
  "entityType": "node",
  "bundle": "article",
  "attributes": { "title": "My New Article", "body": { "value": "<p>Article body HTML</p>" } }
}
```

For `update` the preview also includes the target `id`; for `delete` it returns
`{ dryRun: true, operation: "delete", entityType, bundle, id }`.

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

### Preview writes with `dryRun`

`drupal_entity_create`, `drupal_entity_update`, and `drupal_entity_delete` accept an
optional `dryRun` boolean (default `false`). When `true`, the tool validates the
request and returns a preview of the write without committing it.

```json
{
  "entityType": "paragraph",
  "bundle": "text",
  "attributes": { "field_text": { "value": "<p>Hello world</p>", "format": "full_html" } },
  "dryRun": true
}
```

Returns a preview envelope:

```json
{
  "dryRun": true,
  "operation": "create",
  "entityType": "paragraph",
  "bundle": "text",
  "attributes": { "field_text": { "value": "<p>Hello world</p>", "format": "full_html" } },
  "relationships": {}
}
```

For `update` the preview also includes the target `id`; for `delete` it returns
`{ dryRun: true, operation: "delete", entityType, bundle, id }`.

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

## Revisions

Address and restore node revisions over JSON:API. JSON:API cannot enumerate full chronological history — it only addresses revisions by version id or the `latest-version` / `working-copy` aliases. For per-node revision counts use [`drupal_report_revision_hotspots`](#reports); for full history enumeration use the Drush bridge.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_revisions` | `type`, `id` | Surface a node's addressable revisions: the latest default revision and the working-copy (forward) revision, with version ids and links. |
| `drupal_get_revision` | `type`, `id`, `version` | Fetch a single revision by version id or alias. Read-only; attributes redacted per security policy. |
| `drupal_revert_revision` | `type`, `id`, `version` | Revert a node to a prior revision (governed write). Replays the target revision's editable content as a new current revision — history is preserved. Confirm before calling. |

`version` accepts a numeric vid (e.g. `42`), an explicit `id:<vid>`, or the relative aliases `rel:latest-version` / `rel:working-copy`.

### drupal_get_revision

```json
{
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "version": "rel:latest-version"
}
```

### drupal_revert_revision

```json
{
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "version": 41
}
```

---

## Moderation

Drive content under a `content_moderation` editorial workflow. Authoritative state transitions require the Drush bridge; these tools are best-effort over JSON:API.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_set_moderation_state` | `type`, `id`, `state` | Transition a node to a moderation state, e.g. `draft`, `needs_review`, `published`, `archived`. Governed write. |
| `drupal_content_by_moderation_state` | `type`, `state` | List nodes of a content type currently in a given moderation state. Supports `limit` / `offset`. |
| `drupal_list_moderation_states` | `type` | List the moderation states observed on a content type's content (best-effort; `sample` controls how many recent items to inspect). |

### drupal_set_moderation_state

```json
{
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "published"
}
```

### drupal_content_by_moderation_state

```json
{
  "type": "article",
  "state": "needs_review",
  "limit": 20,
  "offset": 0
}
```

---

## Scheduler

Schedule future publish/unpublish using the Drupal [Scheduler](https://www.drupal.org/project/scheduler) module. Requires Scheduler installed and enabled for the content type with the `publish_on` / `unpublish_on` fields present on the bundle — otherwise the call fails with a clear capability error.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_schedule_publish` | `type`, `id` | Set the Scheduler `publish_on` and/or `unpublish_on` fields on a node. Provide at least one of `publishOn` / `unpublishOn`. |

Timestamps accept ISO 8601 (e.g. `2026-07-01T12:00:00Z`) or a Unix epoch and are passed through unchanged.

### drupal_schedule_publish

```json
{
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "publishOn": "2026-07-01T12:00:00Z",
  "unpublishOn": "2026-08-01T12:00:00Z"
}
```

---

## Fields

Introspect the fields of an entity type + bundle before writing. Built on schema **sampling** (an existing entity), so results are approximate — only populated fields are visible, and required/cardinality/allowed-values are inferred from value shape. Authoritative field metadata comes from the Drush bridge (Field API).

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_describe_fields` | `site`, `type` | Return a per-field list of `{ name, type, kind, cardinality?, approximate }`. Pass `bundle` for multi-bundle types (defaults to the entity type for single-bundle types). |

### drupal_describe_fields

```json
{
  "site": "production",
  "type": "node",
  "bundle": "article"
}
```

---

## References

Resolve a human label to an entity UUID before wiring up an entity-reference field, when you know the name but not the UUID.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_resolve_reference` | `entityType`, `bundle`, `name` | Resolve a name/title (matched as a substring) to a UUID. Returns the best match `{ id, title }` plus any ambiguous candidates. Filters on `title` for nodes and `name` for taxonomy_term / user. |

### drupal_resolve_reference

```json
{
  "entityType": "taxonomy_term",
  "bundle": "tags",
  "name": "Technology",
  "limit": 10
}
```

---

## Bulk

Create or update many entities of a single type + bundle in one call. Permission is checked once; each item runs independently, so the batch continues past individual failures (partial success). Returns per-item `{ index, success, id | error }` and a summary. Writes default to unpublished/draft.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_bulk_create` | `entityType`, `bundle`, `items` | Create many entities. Each item is `{ attributes?, relationships? }`. Summary: `{ created, failed }`. |
| `drupal_bulk_update` | `entityType`, `bundle`, `items` | Update many entities. Each item requires an `id`; items missing one are reported as failures. Summary: `{ updated, failed }`. |

### drupal_bulk_create

```json
{
  "entityType": "node",
  "bundle": "article",
  "items": [
    { "attributes": { "title": "First article" } },
    { "attributes": { "title": "Second article" } }
  ]
}
```

### drupal_bulk_update

```json
{
  "entityType": "node",
  "bundle": "article",
  "items": [
    { "id": "550e8400-e29b-41d4-a716-446655440000", "attributes": { "title": "Updated title" } }
  ]
}
```

---

## Translations

Inspect and create entity translations (multilingual / `content_translation`). Core JSON:API serves one language per resource and does not enumerate all translations; `create_translation` requires the `content_translation` module enabled and the bundle configured as translatable. Both tools default to `node`.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_translations` | `type`, `id` | List the translation langcode(s) observable on an entity. Pass `entityType` to target a non-node entity (default `node`). |
| `drupal_create_translation` | `type`, `id`, `langcode` | Create or replace a translation for a target language (governed write), setting the supplied translated field values in `attributes`. |

### drupal_create_translation

```json
{
  "type": "article",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "langcode": "de",
  "attributes": {
    "title": "Mein Artikel",
    "body": { "value": "<p>Hallo Welt</p>", "format": "full_html" }
  }
}
```

---

## Paragraphs

Create and fetch [Paragraph](https://www.drupal.org/project/paragraphs) entities (content fragments). Paragraphs are **not** standalone — they must be referenced by a host entity's paragraph / Entity Reference Revisions field. The create tool returns `relationshipData` you can drop into a host field's `relationships` via [`drupal_entity_update`](#entities-generic) / [`drupal_update_node`](#nodes). Run [`drupal_get_entity_schema`](#entities-generic) (entityType `paragraph`, the bundle) first to discover fields.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_create_paragraph` | `paragraphType` | Create a Paragraph of a given bundle. Returns the paragraph plus `relationshipData` (`{ type: 'paragraph--<bundle>', id }`). Governed write. |
| `drupal_get_paragraph` | `paragraphType`, `id` | Fetch a single Paragraph by bundle + UUID. Returns the redacted paragraph plus a `ref` for embedding in a host field. |

### drupal_create_paragraph

```json
{
  "paragraphType": "text",
  "attributes": {
    "field_body": { "value": "<p>A reusable text fragment</p>", "format": "full_html" }
  }
}
```

---

## Structure

Manage editable site structure — custom (content) menu links and custom content blocks. These tools operate on `menu_link_content` and `block_content` entities; they do **not** list code/plugin-defined links or blocks.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_list_menu_links` | — | List custom menu links, optionally scoped to one `menu` (e.g. `main`, `footer`). Returns title, target URI, menu, and weight. Supports `limit` / `offset` / `sort`. |
| `drupal_create_menu_link` | `title`, `link`, `menu` | Create a custom menu link. `link` is a Drupal URI such as `internal:/about`, `entity:node/42`, or an absolute URL. |
| `drupal_list_blocks` | — | List custom content blocks, optionally scoped to one block `type` (bundle). Returns admin label (`info`) and body. Supports `limit` / `offset` / `sort`. |
| `drupal_create_block` | `type`, `info` | Create a custom content block. `info` is the administrative label; `body` is optional HTML. |

### drupal_create_menu_link

```json
{
  "title": "About us",
  "link": "internal:/about",
  "menu": "main",
  "weight": 0
}
```

### drupal_create_block

```json
{
  "type": "basic",
  "info": "Homepage callout",
  "body": "<p>Welcome to our site.</p>"
}
```

---

## Search

Best-effort content search. Title-match fallback over a content type (`mode: 'fallback'`); relevance-ranked search requires a Search API / Solr endpoint.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_search` | `query` | Search content by query string. Defaults to the `article` content type; `type` and `limit` are optional. |

### drupal_search

```json
{
  "query": "annual report",
  "type": "article",
  "limit": 10
}
```

---

## Reports (Extra)

Additional read-only audit tools that complement the [Reports](#reports) module. Sampling-bounded scans flag `approximate` when the scan is capped.

| Tool | Required params | Description |
|------|----------------|-------------|
| `drupal_report_unpublished` | — | List unpublished/draft content of a type (default `article`). Returns titles, last-changed dates, and paths — surfaces forgotten drafts. |
| `drupal_report_missing_field` | `field` | Find entities where a given field is empty (scalar or entity-reference). Bounded by `sampleSize`. |
| `drupal_report_orphaned_references` | — | Find entities whose entity-reference fields point at targets that no longer exist. Best-effort; bounded by `sampleSize`. |

### drupal_report_missing_field

```json
{
  "type": "article",
  "field": "field_meta_description",
  "sampleSize": 100
}
```

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
