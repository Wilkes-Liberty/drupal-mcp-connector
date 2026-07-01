---
description: "Create an active URL redirect (contrib Redirect module). The redirect serves its 301 (or chosen code) immediately: 'source' is the old path (a leading slash is fine — it is normalized to the module's stored, slash-less form so the redirect actually matches and fires), and 'target' is the destination as a path ('/new'), an 'entity:node/ID', or an absolute URL. status_code defaults to 301; pass 302 for a temporary redirect. Governed by the site security policy (needs redirect write / 'administer redirects')."
argument-hint: "[site] <source> <target> [statusCode] [language]"
allowed-tools: mcp__drupal__drupal_create_redirect
---

Call the `mcp__drupal__drupal_create_redirect` MCP tool.

Create an active URL redirect (contrib Redirect module). The redirect serves its 301 (or chosen code) immediately: 'source' is the old path (a leading slash is fine — it is normalized to the module's stored, slash-less form so the redirect actually matches and fires), and 'target' is the destination as a path ('/new'), an 'entity:node/ID', or an absolute URL. status_code defaults to 301; pass 302 for a temporary redirect. Governed by the site security policy (needs redirect write / 'administer redirects').

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `source` (string): Source/old path to redirect from, e.g. '/old-slug'. Leading slash optional.
- `target` (string): Destination: a path ('/new-slug'), 'entity:node/42', or an absolute 'https://…' URL.

**Optional:**
- `site` (string): Named site (omit for default)
- `statusCode` (number): HTTP redirect status code. 301 (permanent, default) or 302 (temporary); 303/307/308 also accepted.
- `language` (string): Langcode the redirect applies to. Defaults to 'und' (all languages).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
