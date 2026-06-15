# OAuth2 `client_credentials` Deployment Guide

This guide covers deploying the connector against a Drupal site using the
**OAuth2 `client_credentials`** grant via [Simple OAuth](https://www.drupal.org/project/simple_oauth)
(and `simple_oauth_21`). It documents the non-obvious parts that most commonly
break a first deployment — especially how a machine token gets its **permissions**.

> TL;DR — A `client_credentials` token's permissions come from **OAuth2 scopes
> that map to Drupal roles**, *not* from the consumer's owner user. If you skip
> the scope→role mapping, the token authenticates but behaves like an anonymous
> user (reads return `200` with empty data; writes are denied).

---

## 1. Mental model: where a machine token's permissions come from

With the `client_credentials` grant there is no interactive user. In
`simple_oauth_21`, the access token's effective permissions are determined by the
**OAuth2 scopes** granted to it, where each scope is an `oauth2_scope` config
entity configured with **role granularity** — i.e. the scope *grants a Drupal
role* to the token.

```
consumer (client_id + secret)
   └── requests scopes:  mcp_read, mcp_write
          └── each scope (granularity: role) → grants a Drupal role
                 └── role's permissions → what the token can read/write
```

Consequences that surprise people:

- **The consumer's "owner" user roles are irrelevant** to a `client_credentials`
  token. Granting the owner user the `content editor` role does **nothing** for
  the token. Map a scope to the role instead.
- **A token with no (valid) scopes is effectively anonymous.** On a locked-down
  site that means JSON:API reads return `200` with an **empty** `data` array and
  writes are refused — with no obvious error pointing at scopes.
- **Scopes must actually exist.** A consumer can reference a `scope_id` that has
  no corresponding `oauth2_scope` entity. The reference is silently dangling, and
  token requests that ask for it fail with `invalid_scope`.

---

## 2. Create the scopes (role granularity)

Create one `oauth2_scope` config entity per capability you want to grant. Model
them on any existing scope on your site. Example for a read and a write scope,
both mapping to a `content_editor` role:

`config/sync/simple_oauth.oauth2_scope.mcp_read.yml`

```yaml
uuid: <generate-a-uuid>
langcode: en
status: true
dependencies: {  }
id: mcp_read
name: mcp_read
description: 'MCP read access'
grant_types:
  client_credentials:
    status: true
    description: ''
  refresh_token:
    status: false
    description: ''
  authorization_code:
    status: false
    description: ''
umbrella: false
parent: _none
granularity_id: role
granularity_configuration:
  role: content_editor
```

Repeat for `mcp_write` (often mapped to the same or a higher-privileged role).
Split read vs. write into separate roles if you want least-privilege tokens; map
both to one role for the simplest setup.

You can also create them imperatively (handy for a quick test), but see
[§5 Persist config](#5-persist-config-or-a-deploy-will-delete-it) before relying
on imperative creation:

```bash
drush php:eval '
  \Drupal::entityTypeManager()->getStorage("oauth2_scope")->create([
    "id" => "mcp_read", "name" => "mcp_read", "description" => "MCP read access",
    "grant_types" => ["client_credentials" => ["status" => true, "description" => ""]],
    "granularity_id" => "role",
    "granularity_configuration" => ["role" => "content_editor"],
  ])->save();
'
```

---

## 3. Create the consumer and capture the secret

Create a confidential consumer with the `client_credentials` grant and attach the
scopes from §2. Two field gotchas:

- **`simple_oauth_21` has a dedicated `client_id` field** that is **not** the
  consumer UUID. Use that field's value as the OAuth `client_id`. Using the UUID
  yields `invalid_client`.
- **The secret is stored hashed and cannot be read back.** Capture the plaintext
  at creation time (or reset it) and store it in a secret manager — never in
  config. See [§6 Secret handling](#6-secret-handling).

Verify the consumer can mint a token:

```bash
curl -s -X POST "$BASE_URL/oauth/token" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode 'scope=mcp_read mcp_write'
# → {"token_type":"Bearer","expires_in":3600,"access_token":"..."}
```

Then confirm the token actually carries permissions (not anonymous) by reading a
bundle you know has content:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/jsonapi/node/<bundle>" | jq '.data | length'   # expect > 0
```

---

## 4. Enable JSON:API writes (for the write plane)

Drupal core ships JSON:API in **read-only mode by default**. Creating or editing
content through the connector requires:

```yaml
# config/sync/jsonapi.settings.yml
read_only: false
```

or `drush cset jsonapi.settings read_only 0 -y`. With `read_only: true`, the
connector reports the JSON:API backend as **not usable** for write operations.

> Writes still require authentication **and** Drupal entity-access permissions.
> Enabling JSON:API writes does not grant write access by itself — the token's
> scope→role mapping (§2) does. Reachability of the write endpoint should be
> controlled at the edge (e.g. only expose JSON:API on an internal/authenticated
> network).

---

## 5. Persist config, or a deploy will delete it

`oauth2_scope` entities and `jsonapi.settings` are **configuration**. On a site
that uses Drupal configuration management (`config/sync` + `drush config:import`
on deploy), anything created only in the live database is **reverted on the next
deploy** — the scopes vanish and `read_only` flips back.

Always commit the scope YAMLs and the `jsonapi.settings` change to your
`config/sync` directory and let them deploy through `config:import`. Imperative
`drush` creation is fine for a quick local test, but treat the repo as the source
of truth for anything that must survive a deploy.

> Content entities behave differently. The **consumer** is a content entity, so
> it is **not** in `config/sync` and survives `config:import` — but it also only
> exists in whatever environment you created it in. Each environment needs its
> own consumer + secret.

---

## 6. Secret handling

The client secret must reach the connector process as the environment variable
named by `oauth.clientSecretEnv` (see [getting-started](getting-started.md)).
Keep it out of both the connector config and your MCP client config.

A robust pattern for desktop/CLI MCP clients is a thin **launcher script** set as
the MCP server `command`. It sources the secret from a secret manager at launch
and never writes it to disk:

```sh
#!/bin/sh
# Resolve the secret from a secret manager, then exec the connector.
set -eu
cd "$(dirname "$0")/.."                 # connector reads config/ relative to CWD
# Examples (pick one for your platform):
#   macOS Keychain:  security find-generic-password -s drupal-mcp-secret -w
#   pass:            pass show drupal-mcp/secret
#   Vault:           vault kv get -field=secret secret/drupal-mcp
MCP_CLIENT_SECRET="$(security find-generic-password -s drupal-mcp-secret -w)"
export MCP_CLIENT_SECRET
exec node src/index.js
```

A ready-to-adapt version lives at
[`examples/launch-with-secret.sh`](../examples/launch-with-secret.sh).

> GUI clients (e.g. desktop apps) do not inherit your shell environment, so a
> launcher that reads from a secret manager is more reliable than `export` in a
> shell profile. The first launch may prompt for secret-manager access — approve
> it.

---

## 7. Connector config

A minimal `client_credentials` site (omit `scopes` only if your governance layer
does not key on them — most do):

```json
{
  "defaultSite": "mysite",
  "sites": {
    "mysite": {
      "baseUrl": "https://drupal.internal.example",
      "api": "jsonapi",
      "requireSecureAuth": true,
      "oauth": {
        "tokenUrl": "/oauth/token",
        "clientId": "my-machine-client",
        "clientSecretEnv": "MCP_CLIENT_SECRET",
        "grant": "client_credentials",
        "scopes": ["mcp_read", "mcp_write"]
      },
      "security": { "preset": "write-plane" }
    }
  }
}
```

`requireSecureAuth: true` enforces HTTPS + a resolved client secret. The
connector's `security.preset` is a complementary client-side restriction; a
server-side governance module (e.g. [MCP Sentinel](integration-contract.md))
remains the authoritative policy.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Token request → `invalid_client` | Using the consumer **UUID** as `client_id` | Use the dedicated `client_id` field value |
| Token request → `invalid_scope` ("Check the `…` scope") | Scope referenced but no `oauth2_scope` entity exists | Create the scope (§2) |
| Token issues, but JSON:API reads return `200` with empty `data` | Token has no role (no/invalid scopes, or scope not role-granularity) | Map a scope to a role; request that scope (§2) |
| Reads work but writes fail / backend "not usable" | JSON:API `read_only: true` | Set `read_only: false` (§4) |
| Worked yesterday, broken after a deploy | Scopes/`read_only` were live-only and `config:import` reverted them | Commit to `config/sync` (§5) |
| `403`/`401` on specific operations even with a role | `mcp_sentinel`/governance policy or missing entity permission | Check the governance policy and the mapped role's permissions |

See also: [getting-started](getting-started.md) ·
[integration-contract](integration-contract.md) · [security](security.md).
