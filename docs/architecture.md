# Architecture

## Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                          MCP Clients                               │
│        desktop apps · IDE extensions · CLI tools · agents          │
└──────────┬───────────────────────────┬───────────────────────────┘
           │ stdio (local)              │ HTTPS (remote / multi-client)
           ▼                            ▼
┌──────────────────────────────────────────────────────────────────┐
│                   drupal-mcp-connector (Node.js)                   │
│                                                                    │
│  src/index.js ── MCP server ── security middleware ── transports   │
│                         │                                          │
│        ┌────────────────┼─────────────────┐                       │
│        ▼                ▼                 ▼                        │
│   src/tools/       src/lib/           MCP primitives               │
│   (119 tools)      backends/          Tools · Resources · Prompts  │
│                    + canonical/security                            │
└──────────┬─────────────────────────────────────────────────────────┘
           │           backend abstraction (resolveBackend)
   ┌───────┴───────────────┬────────────────────┐
   ▼                       ▼                     ▼
JSON:API backend     GraphQL backend       SSH → Drush
(read + write)       (GraphQL Compose,      (optional admin ops)
                      read-only)
   │                       │                     │
   └───────────┬───────────┴─────────────────────┘
               ▼
       ┌───────────────┐
       │  Drupal site  │  one or many — each with its own backend,
       │               │  auth, and security configuration
       └───────────────┘
```

---

## Backend Abstraction

The defining feature of this connector is that every tool runs against an **abstract backend**, not a specific protocol. A tool asks for entities; the backend layer decides how to fetch them.

### Backend selection (`resolveBackend`)

`src/lib/backends/index.js` exposes `resolveBackend(site)`, which returns a backend instance for a site based on its `api` configuration:

- `"jsonapi"` — use the JSON:API backend.
- `"graphql"` — use the GraphQL backend.
- `["graphql","jsonapi"]` — try each in priority order, falling back to the next if a backend is unreachable.
- *(omitted)* — **auto-detect**: probe both once (`/jsonapi` for JSON:API, a `{__typename}` ping for GraphQL) and cache the reachable one.

The registry maps `jsonapi` and `graphql` to their implementations; resolution results are cached per site for the process lifetime.

### Canonical entity shape

Both backends normalize Drupal entities into one shape so that tool output is protocol-independent:

```jsonc
{
  "id":            "uuid",
  "entityType":    "node",
  "bundle":        "article",
  "title":         "…",
  "status":        true,
  "langcode":      "en",
  "created":       "2026-01-01T00:00:00+00:00",
  "changed":       "2026-01-02T00:00:00+00:00",
  "url":           "https://…",
  "fields":        { /* non-base fields */ },
  "relationships": { /* normalized references */ },
  "_backend":      "jsonapi"   // or "graphql"
}
```

`src/lib/canonical.js` defines the base attribute set and the helpers (`makeCanonicalEntity`, `normalizeRelationship`) both backends use.

### Capability model

Each backend advertises a capability descriptor:

```jsonc
{ "read": true, "write": true, "delete": true,
  "count": true, "filter": true, "sort": true,
  "revisions": true, "fieldAvailability": "schema" }
```

Tools consult capabilities before acting. A write tool against the GraphQL backend (which has `write: false`) raises a `BackendCapabilityError` with a clear message rather than attempting an unsupported operation.

| Capability | JSON:API | GraphQL (GraphQL Compose) |
|------------|:--------:|:-------------------------:|
| Read | ✅ | ✅ |
| Write / delete | ✅ | ❌ (no mutations) |
| Server-side filter | ✅ | ❌ → client-side, bounded, flagged `approximate`/`truncated` |
| Server-side sort | ✅ | partial (`created`/`changed`/`title` native; others client-side) |
| Total count | exact, paginated (Drupal core JSON:API has no `meta.count`, so counts walk `links.next`; flagged `approximate` past a 1000-record safety cap) | bounded fetch, always `approximate` |
| Revisions | ✅ | depends on schema |

The GraphQL backend is introspection-driven and type-aware (handles irregular plurals, scalar-wrapper objects like `DateTime`/`Language`/`TextSummary`, and entity-reference unions). See [graphql-local-setup.md](graphql-local-setup.md).

---

## MCP Primitives: Tools, Resources, and Prompts

This server exposes all three MCP primitives.

### Tools
Callable operations a client invokes on demand. All 119 tools follow the naming convention
`drupal_{operation}_{entity}` or `drupal_{module}_{action}`.

### Resources
Browsable, always-fresh context a client can read without calling a tool:

| URI | Description |
|-----|-------------|
| `drupal://sites` | All configured site profiles (no credentials) |
| `drupal://{site}/content-types` | Content types with full field schemas |
| `drupal://{site}/security-policy` | Active security configuration |

### Prompts
Workflow templates exposed as slash-commands in MCP-aware clients:

| Name | Description |
|------|-------------|
| `drupal-content-audit` | Full site content audit walkthrough |
| `drupal-create-article` | Guided article creation with field prompts |
| `drupal-seo-fix` | Find and fix SEO gaps across content |
| `drupal-user-cleanup` | Identify inactive/orphaned accounts |

---

## Transport Modes

### stdio (default — local)
The server runs as a child process of the MCP client. Zero network exposure.

```bash
node src/index.js
```

### HTTPS (multi-client — remote)
The server runs as a standalone HTTPS service; multiple clients connect simultaneously.

```bash
MCP_TRANSPORT=https \
TLS_CERT_PATH=/etc/ssl/certs/mcp.crt \
TLS_KEY_PATH=/etc/ssl/private/mcp.key \
MCP_PORT=3443 node src/index.js
```

Endpoint: `https://host:3443/mcp` (health probe at `/health`). HTTPS is mandatory; plain HTTP is refused on non-localhost unless `MCP_ALLOW_HTTP=1` is set explicitly (development only). Without TLS the server binds loopback only. Optional bearer auth (`MCP_AUTH_TOKEN`) and bind-address restriction (`MCP_BIND_HOST`) are documented in [security-hardening.md](security-hardening.md).

---

## Source Layout

```
src/
├── index.js                  # Entry point: MCP server, security middleware, transports
├── lib/
│   ├── config.js             # Config loading, site resolution, auth headers, token/secure-auth
│   ├── canonical.js          # Canonical entity shape + normalization helpers
│   ├── drupal-fetch.js       # Authenticated HTTP wrappers (JSON:API, GraphQL, file upload)
│   ├── http-auth.js          # Bearer check for the HTTPS transport (timing-safe)
│   ├── security.js           # Presets, assertions, field redaction
│   ├── reports-support.js    # Shared collectors/helpers for the reports module
│   ├── errors.js             # toolResult / toolError helpers
│   └── backends/
│       ├── index.js          # resolveBackend + registry + reachability probes
│       ├── backend-interface.js
│       ├── errors.js         # BackendCapabilityError, BackendResolutionError
│       ├── jsonapi.js        # JSON:API backend (read + write)
│       ├── graphql.js        # GraphQL backend (read-only)
│       ├── graphql-names.js  # entity ↔ GraphQL type/plural mapping
│       ├── graphql-schema.js # introspection
│       ├── graphql-query.js  # selection building + query execution
│       ├── graphql-normalize.js
│       └── graphql-filter.js # client-side filter/sort
└── tools/
    ├── nodes.js  taxonomy.js  users.js  media.js  graphql.js
    ├── site.js   entities.js  reports.js  drush.js
```

---

## Adding a Tool

Every tool module exports `definitions` (array) and `handlers` (object). Tools call the backend layer rather than a protocol directly:

```javascript
// src/tools/mymodule.js
import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";
import { toolResult } from "../lib/errors.js";

async function myTool({ site: siteName, entityType, bundle }) {
  const site = getSiteConfig(siteName);
  const sec  = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);

  const backend = await resolveBackend(site);
  const result  = await backend.list({ entityType, bundle, page: { limit: 50, offset: 0 } });
  return toolResult(result); // canonical entities, redaction applied by the tool
}

export const definitions = [{
  name: "drupal_my_tool",
  description: "One sentence: what it does and when to use it.",
  inputSchema: {
    type: "object",
    required: ["entityType"],
    properties: {
      site:       { type: "string", description: "Named site (omit for default)" },
      entityType: { type: "string", description: "Entity type machine name" },
      bundle:     { type: "string", description: "Bundle machine name" },
    },
  },
}];

export const handlers = { drupal_my_tool: myTool };
```

Then add one import + array entry in `src/index.js`. Tool registration, the security middleware, and dispatch are automatic.

---

## Security Middleware

All tool calls pass through the security layer in `index.js` before reaching a handler:

```
CallTool request
      │
      ▼
infer operation (read/write/delete/graphql) from tool name
      ├─ resolve site security config
      ├─ assert operation allowed (readOnly, allowDestructive, allowGraphqlMutations)
      ▼
handler(args)        ← entity-type/bundle checks (assertReadAllowed, …)
      │              ← backend capability checks (write/delete gated)
      ▼
toolResult(data)     ← field redaction applied before returning
```

`SecurityError` and `BackendCapabilityError` produce clean, explicit messages; all other errors surface as standard MCP error responses.

---

## Config Schema

```typescript
interface SiteConfig {
  baseUrl: string;                       // Required
  api?: "jsonapi" | "graphql" | ("jsonapi" | "graphql")[]; // backend selector; omit to auto-detect
  apiToken?: string;                     // Bearer token (preferred)
  apiTokenEnv?: string;                  // Read the Bearer token from this env var instead
  requireSecureAuth?: boolean;           // Reject anon/Basic/HTTP; require HTTPS + Bearer
  username?: string;                     // Basic auth fallback (local dev)
  password?: string;
  oauth?: {                              // OAuth2 client_credentials write plane
    tokenUrl?: string;                   // Default: "/oauth/token"
    clientId: string;
    clientSecretEnv: string;             // Read the client secret from this env var
    scopes?: string[];
    grant?: string;                      // Default: "client_credentials"
  };
  graphqlEndpoint?: string;              // Default: "/graphql"
  drushSsh?: {
    host: string; user: string; keyPath: string; drupalRoot: string; port?: number; // default 22
  };
  security?: {
    preset?: "development" | "content-editor" | "auditor" | "production-strict" | "write-plane";
    readOnly?: boolean;
    allowDestructive?: boolean;
    allowGraphqlMutations?: boolean;
    allowedEntityTypes?: string[] | null;
    deniedEntityTypes?: string[];
    globalRedactedFields?: string[];
    entityRules?: {
      [entityType: string]: {
        allowedOperations?: ("read" | "create" | "update" | "delete")[];
        allowedBundles?: string[] | null;
        deniedBundles?: string[];
        redactedFields?: string[];
      };
    };
  };
}
```

Top-level config also accepts `defaultSite`, a `tls` block (`certPath`/`keyPath`/`port`) for the HTTPS transport, and `sites` (the map above). See [config.example.json](../config/config.example.json).
