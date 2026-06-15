# Drupal MCP Connector — Vision & Whitepaper

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Background: The Model Context Protocol](#2-background-the-model-context-protocol)
3. [Architecture at a Glance](#3-architecture-at-a-glance)
4. [Who Benefits & How](#4-who-benefits--how)
5. [Capabilities & Roadmap](#5-capabilities--roadmap)
6. [Ecosystem & Companion Modules](#6-ecosystem--companion-modules)
7. [Security Model](#7-security-model)

---

## 1. Executive Summary

Drupal is one of the world's most powerful and flexible content management systems, trusted by governments, universities, media companies, and enterprises globally. Despite its power, day-to-day work — writing content, managing taxonomy, debugging configurations, auditing large sites — is still largely manual, UI-bound, and context-switching-heavy. A content audit that should take minutes requires filtering, clicking, exporting, and repeating across dozens of screens.

The **Drupal MCP Connector** bridges Drupal's rich API surface with the Model Context Protocol, giving any MCP-compatible client a governed, programmatic interface to any Drupal site. You ask in natural language; the connector translates that into authenticated API calls, normalizes the results, and returns structured data ready for action or further processing. Operations that previously required hours of clicking can be expressed as a single request.

This document describes the connector's architecture, the personas it serves, its current capabilities, and its forward-looking roadmap. It is intended for technical evaluators, open-source contributors, and integration architects assessing the connector for production use.

---

## 2. Background: The Model Context Protocol

The **Model Context Protocol (MCP)** is an open standard for connecting external systems to MCP-compatible clients via structured tool interfaces. An MCP server exposes a set of named tools with typed inputs and outputs; a set of resources (read-only contextual data); and a set of prompts (reusable interaction templates). The client discovers these, calls them by name, and interprets the results.

MCP servers run locally as a subprocess (stdio transport) or remotely over HTTPS (HTTP transport). Authentication, schema, and transport details are standardized, meaning any conforming client can use the same server without modification. The protocol is vendor-neutral and client-agnostic.

For Drupal, this means: one connector, programmatic access to every Drupal site that runs it, usable by any MCP-compatible client.

---

## 3. Architecture at a Glance

The connector implements a **dual-protocol backend abstraction**: it speaks Drupal core **JSON:API** (read + write) and **GraphQL** via the **GraphQL Compose** module (`drupal/graphql_compose`, read-only). The active backend is selected per site via an `api` config key (`"jsonapi"`, `"graphql"`, or a priority array); omit it to trigger auto-detection. Both backends are normalized to one canonical entity shape:

```
{ id, entityType, bundle, title, status, langcode,
  created, changed, url, fields, relationships, _backend }
```

Each backend advertises its capabilities (read / write / delete / filter / sort). Write and delete requests directed at a read-only backend are refused with a descriptive error rather than silently failing. The Drush bridge adds a third channel for administrative operations that the HTTP APIs cannot reach.

```
MCP Client
    │  stdio or HTTPS
    ▼
Drupal MCP Connector  (Node.js)
Tool registry · auth · routing · normalization · security presets
    │               │               │
 JSON:API        GraphQL          Drush / SSH
 (core, D10+)  (graphql_compose) (optional)
    │               │               │
    └───────────────┴───────────────┘
                    │
            Drupal Site(s)
    one or many — named profiles, per-site auth
```

See `docs/architecture.md` for a full description of request lifecycle, normalization pipeline, and capability registry.

---

## 4. Who Benefits & How

### 4.1 Content Editors

Content editors spend most of their time in the Drupal admin UI — powerful but manual. The connector turns a single natural-language request into bulk operations, audits, and workflow changes that would otherwise require hours of clicking.

**Example requests:**

- "Unpublish all articles in the 'Events' category older than 6 months." — The connector filters, pages, and returns the matched node list; a follow-up write call unpublishes each one.
- "Find all pages missing a meta description." — Returns a list with titles, UUIDs, and edit URLs.
- "What content hasn't been updated in over a year?" — Sorted staleness report, ready for editorial triage.
- "Check whether every article mentioning 'COVID-19' also has our updated disclaimer block."
- "List all taxonomy terms in the 'Tags' vocabulary used by only one piece of content — likely duplicates or typos."
- "Reassign all content by user john.smith@example.com to jane.doe@example.com."
- "Move all content in 'Needs Review' submitted more than two weeks ago to 'Editorial Escalation'." (Requires Content Moderation module.)
- "Find all nodes that reference taxonomy terms which no longer exist."

---

### 4.2 Content Creators & Copywriters

For people whose job is producing content, the connector removes friction between writing and publishing.

**Example requests:**

- "Create draft Spanish translations of these 5 articles, mark them unpublished, assign to the translation queue."
- "Create a 5-part series on cloud security: all 5 nodes, sequential titles, cross-linked, tagged 'cloud-security-series'."
- "I have 30 blog topics. Create a draft node for each, distributed across next quarter's publishing dates."
- "Scan all published articles and flag any that use 'utilize' instead of 'use'."
- "Find all article nodes containing images without alt text in the body field."

---

### 4.3 SEO & Digital Marketing Specialists

**Example requests:**

- "What percentage of published articles have a custom meta description? List the ones that don't."
- "Flag all nodes where the page title is over 60 or under 30 characters."
- "Are there URL alias inconsistencies — some articles under /blog/ and some under /articles/?"
- "List all nodes that have more than one redirect pointing to them."
- "Find articles in the 'Security' category that never link to our main 'Security Overview' page."
- "List all published pages with body content under 500 words not marked as short-form."
- "Are there published 'landing_page' nodes excluded from the sitemap?"

---

### 4.4 Site Builders

**Example requests:**

- "What content types exist? For each: node count, fields, date of most recent node."
- "List all custom fields across all content types and flag any that share a machine name but have different field types."
- "Which fields are defined but attached to no content type?"
- "Which nodes are using custom Layout Builder overrides? A content type layout change won't affect these."
- "List every permission held by the 'Editor' role. Flag any that seem overly broad."
- "What image styles are defined and which are actually referenced in active displays?"

---

### 4.5 Drupal Developers

**Example requests:**

- "I need to migrate content from a legacy CMS. Here's the old schema — map it to our Drupal content types and flag fields without a clean equivalent."
- "Generate a skeleton module that implements hook_node_presave to auto-generate a summary from the body field if empty."
- "I need 50 realistic article nodes for testing. Base titles and tags on patterns already in production."
- "Generate an OpenAPI-style spec for our JSON:API surface, limited to content types configured for external access."
- "List all nodes containing raw `<script>` tags in their body field."
- "Which nodes have had more than 20 revisions in the past month?"

---

### 4.6 DevOps & Site Administrators

**Example requests:**

- "List all users that have logged in within the past 30 days but haven't been assigned to any editorial role."
- "All users in the 'Contractor' role need the 'Content Editor' role added before Monday."
- "List all accounts that have never logged in and were created over 180 days ago."
- "List all media entities not referenced by any node — orphaned files consuming storage."
- "Which enabled contrib modules have available security updates?" (Drush bridge.)
- "Are there pending configuration changes between the database and the config sync directory?" (Drush bridge.)

---

### 4.7 Project Managers & Agency Account Managers

**Example requests:**

- "How many article nodes are in Draft, Needs Review, and Published states? Broken down by author."
- "The client committed to 20 new case study nodes this quarter. How many have been published?"
- "Which nodes have been in 'Needs Review' for more than 5 business days?"
- "Are there any nodes in Draft that were supposed to be published? Any scheduled nodes past their publish date but still unpublished?"

---

### 4.8 Accessibility Specialists

**Example requests:**

- "Find all nodes with image fields that are empty or set to decorative across all published content."
- "Scan article body fields for H1 tags inside the body — this creates duplicate H1s."
- "Find all nodes with anchor text of 'click here', 'read more', or 'learn more'."
- "Identify nodes whose body contains HTML tables without `<caption>` or `scope` attributes."
- "Find all nodes that link to PDFs that don't have '(PDF)' in their link text per our accessibility policy."

---

### 4.9 Data & Analytics Teams

**Example requests:**

- "Export a list of all published articles from the past year with title, author, publish date, category, and word count."
- "How is content distributed across our main category taxonomy? Are there categories with no published content?"
- "Show a time-series breakdown of node creation by author over the past 12 months."
- "For the 'product' content type, what percentage of nodes have all optional fields populated?"
- "What is the average time from Draft creation to Published for articles?"

---

### 4.10 Multi-site Operators

Agencies, universities, and enterprises often run dozens of Drupal sites on a single platform. The connector supports named site profiles with per-site authentication, enabling cross-site queries from a single session.

**Example requests:**

- "Across all 12 client sites, how many nodes are published? Which site has the most stale content?"
- "Do all sites in our network have a 'Privacy Policy' page published? List any that don't."
- "Our 'Industry' vocabulary should be identical across all sites. Find any that have diverged."
- "Scan all sites for nodes containing inline scripts in body fields — potential XSS vectors."

---

## 5. Capabilities & Roadmap

### What Ships Today

The connector currently delivers **89 tools across 20 modules**, **3 MCP resources**, and **4 MCP prompts**, targeting Drupal 10 and 11.

| Module | Tools | Notes |
|---|---|---|
| **Nodes** | ~6 | Full CRUD, filter, sort, pagination — JSON:API |
| **Taxonomy** | ~6 | Vocabularies, terms, hierarchy |
| **Users** | ~6 | User CRUD, role management |
| **Media** | ~6 | Media entity management |
| **GraphQL** | ~4 | Query execution, schema introspection — GraphQL Compose |
| **Site** | ~4 | Site info, resource type discovery, status |
| **Entities** | ~8 | Generic any-entity-type read/write operations |
| **Reports** | 10 | Read-only audit and reporting tools (staleness, coverage, counts) |
| **Drush** | 15 | SSH bridge: cache, cron, config sync, module management |

**Also implemented:**

- Dual-protocol backend (JSON:API read/write + GraphQL read-only via GraphQL Compose), auto-detectable per site
- Canonical entity shape normalized across both backends; `_backend` field identifies the source
- Capability gating: write/delete requests to read-only backends return a clear refusal
- Multi-site support with named profiles and per-site authentication
- Four security presets: `development`, `content-editor`, `auditor`, `production-strict`
- Entity allow/deny lists, per-bundle operation rules, field-level PII redaction
- `apiTokenEnv` and `requireSecureAuth` options for secrets-from-env and HTTPS enforcement
- stdio transport (default, local subprocess) and HTTPS transport (multi-client, TLS required, port 3443 default)
- `X-MCP-Client` header sent on every outbound request for server-side log attribution

### Forward-Looking Roadmap

The following represent intended directions, not committed release dates.

- **Search API integration** — full-text search via Search API + Solr/Elasticsearch backends; faceted search across content types
- **Scheduled publish / workflow transitions** — first-class support for Scheduler and Content Moderation state machines
- **Cross-site fan-out** — parallel query execution across all named sites with merged, sorted results
- **Persisted GraphQL queries** — register named queries server-side, reducing introspection overhead in production
- **External integrations** — issue tracker bridging (create tickets from audit findings), analytics correlation, hosting platform APIs
- **Expanded Drush bridge** — migration execution, queue workers, database updates
- **Published npm package** — versioned releases with a changelog and semantic versioning

---

## 6. Ecosystem & Companion Modules

### Drupal Modules That Expand Connector Capability

| Module | What it unlocks |
|---|---|
| **JSON:API** (core) | Base content CRUD — included in Drupal core since 8.7 |
| **GraphQL Compose** (`drupal/graphql_compose`) | Flexible read-only GraphQL schema; required for the GraphQL backend |
| **Search API** (contrib) | Full-text search beyond title-substring matching |
| **Content Moderation** (core) | Workflow state transitions, editorial pipeline management |
| **Scheduler** (contrib) | Time-based publish/unpublish operations |
| **Metatag** (contrib) | SEO field read/write |
| **Pathauto** (contrib) | URL alias pattern analysis |
| **Redirect** (contrib) | Redirect chain detection and management |
| **Webform** (contrib) | Form submission querying and reporting |
| **Paragraphs** (contrib) | Structured composite content read/write |
| **Simple OAuth** (contrib) | Token-based auth — preferred over Basic Auth in production |

### Companion Governance Module: `drupal/mcp_sentinel`

`drupal/mcp_sentinel` is an independent Drupal module (available on drupal.org, pre-1.0/alpha, requires Drupal `^10.3 || ^11`) that provides the authoritative server-side governance layer for connector-initiated operations.

When installed, MCP Sentinel enforces:

- **Role-bound policy profiles** — operations are permitted or denied based on the authenticated Drupal account's role, not request headers
- **OAuth scope enforcement** — `mcp:read` and `mcp:write` scopes gate read vs. write operations at the Drupal authentication layer
- **Tamper-evident audit log** — every connector-initiated operation is attributed to the acting account and recorded in a tamper-evident log
- **Content locks** — prevents concurrent connector and editorial writes on the same entity
- **HMAC-signed webhooks** — outbound event notifications for downstream integrations
- **`/drupal-mcp/context` schema endpoint** — exposes a structured capability and policy document the connector can consume at startup

The connector sends an `X-MCP-Client` header on every request purely as a log label; governance decisions are made by MCP Sentinel based on the authenticated account's role and OAuth scopes. `drupal/mcp_sentinel` is the recommended companion for any production deployment.

---

## 7. Security Model

The connector is designed for defense-in-depth: hardening at the connector layer combined with authoritative enforcement at the Drupal layer when MCP Sentinel is installed.

**Connector-side controls** include four named security presets (`development`, `content-editor`, `auditor`, `production-strict`) that constrain available operations without requiring per-tool configuration. Entity allow/deny lists restrict which resource types are accessible. Per-bundle operation rules control which CRUD operations are permitted on each content type. Field-level PII redaction strips configured fields from responses before they leave the connector. GraphQL mutation support can be gated independently of read access. Transport options include bind-address restriction, mandatory HTTPS (`requireSecureAuth`), and secrets loaded from environment variables (`apiTokenEnv`) rather than config files.

**Drupal-side enforcement** — when `drupal/mcp_sentinel` is installed — is the authoritative governance layer. Policy decisions are made based on the authenticated account's Drupal role and OAuth scopes; the connector cannot escalate beyond what the authenticated credential allows. All operations are logged with account attribution.

For full configuration reference, see `docs/security.md` and `docs/security-hardening.md`.

---

*This document is maintained by [Wilkes & Liberty](https://wilkesliberty.com). Contributions and issue reports are welcome via the project repository.*
