---
description: "Create an active URL redirect (contrib Redirect module). The redirect serves its 301 (or chosen code) immediately: 'source' is the old path (a leading slash is fine — it is normalized to the module's stored, slash-less form so the redirect actually matches and fires), and 'target' is the destination as a path ('/new'), an 'entity:node/ID', or an absolute URL. status_code defaults to 301; pass 302 for a temporary redirect. Governed by the site security policy (needs redirect write / 'administer redirects')."
argument-hint: "<source> <target> [site] [statusCode] [language]"
---

Call the MCP tool `drupal_create_redirect`.

Create an active URL redirect (contrib Redirect module). The redirect serves its 301 (or chosen code) immediately: 'source' is the old path (a leading slash is fine — it is normalized to the module's stored, slash-less form so the redirect actually matches and fires), and 'target' is the destination as a path ('/new'), an 'entity:node/ID', or an absolute URL. status_code defaults to 301; pass 302 for a temporary redirect. Governed by the site security policy (needs redirect write / 'administer redirects').

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `source` (string): Source/old path to redirect from, e.g. '/old-slug'. Leading slash optional.
- `target` (string): Destination: a path ('/new-slug'), 'entity:node/42', or an absolute 'https://…' URL.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `statusCode` (number): HTTP redirect status code. 301 (permanent, default) or 302 (temporary); 303/307/308 also accepted.
- `language` (string): Langcode the redirect applies to. Defaults to 'und' (all languages).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
