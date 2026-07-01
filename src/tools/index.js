/**
 * Tool aggregation — the single source of truth for every Drupal MCP tool.
 *
 * Each tool module exports `definitions` (the MCP `{name, description, inputSchema}`
 * descriptors) and `handlers` (a name → function dispatch map). This module flattens
 * all of them into the runtime payloads consumed by the server (src/index.js) AND by
 * the offline slash-command generator (scripts/generate-commands.js), so the tool
 * list, the per-tool MCP prompts, and the `/drupal-*` command files can never drift.
 *
 * Importing this module has NO side effects (unlike src/index.js, which boots the
 * transport), so generators and tests can import it freely.
 */

import * as nodes    from "./nodes.js";
import * as taxonomy from "./taxonomy.js";
import * as users    from "./users.js";
import * as media    from "./media.js";
import * as graphql  from "./graphql.js";
import * as site     from "./site.js";
import * as entities from "./entities.js";
import * as reports  from "./reports.js";
import * as drush    from "./drush.js";
import * as revisions    from "./revisions.js";
import * as moderation   from "./moderation.js";
import * as scheduler    from "./scheduler.js";
import * as fields       from "./fields.js";
import * as references   from "./references.js";
import * as bulk         from "./bulk.js";
import * as translations from "./translations.js";
import * as paragraphs   from "./paragraphs.js";
import * as structure    from "./structure.js";
import * as redirects    from "./redirects.js";
import * as search       from "./search.js";
import * as reportsExtra from "./reports-extra.js";
import * as reportsLinks   from "./reports-links.js";
import * as reportsConfig  from "./reports-config.js";
import * as reportsContent from "./reports-content.js";
import * as auditComposite from "./audit-composite.js";
import * as config       from "./config.js";

export const allModules = [nodes, taxonomy, users, media, graphql, site, entities, reports, drush,
  revisions, moderation, scheduler, fields, references, bulk, translations, paragraphs, structure, redirects, search, reportsExtra,
  reportsLinks, reportsConfig, reportsContent, auditComposite, config];

// Flatten every module's tool definitions into one ListTools payload, and merge
// their handler maps into a single closed dispatch table keyed by tool name.
export const allDefinitions = allModules.flatMap((m) => m.definitions);
export const allHandlers    = Object.assign({}, ...allModules.map((m) => m.handlers));

// Fast name → definition lookup for prompt/command rendering.
export const definitionsByName = new Map(allDefinitions.map((d) => [d.name, d]));
