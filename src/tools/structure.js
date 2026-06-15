/**
 * Tool group: Site structure (menu links + custom blocks).
 *
 * CRUD-lite for two structural content entity types:
 *   - `menu_link_content` — editable menu links (the `main`/`footer`/etc menus).
 *   - `block_content`     — reusable custom content blocks ("basic", etc).
 *
 * Both are regular content entities exposed over JSON:API, so they go through the
 * shared backend (no Drush bridge needed). Like the generic entities tools, each
 * handler asserts the appropriate read/write permission in-handler — the
 * name-prefix gating in index.js cannot infer the entity type from these tool
 * names — and read results pass through redactCanonicalEntity so the per-site
 * security policy can strip protected fields before returning. Writes default to
 * whatever the bundle's default publish state is (we never force-publish).
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, redactCanonicalEntity,
} from "../lib/security.js";

const MENU_LINK_TYPE = "menu_link_content";
const BLOCK_TYPE = "block_content";

/**
 * Normalize limit/offset args into the backend's page descriptor.
 *
 * @param {{limit?: number, offset?: number}} args
 * @returns {{limit: number, offset: number}}
 */
function pageOf({ limit = 20, offset = 0 }) {
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Menu links
// ---------------------------------------------------------------------------

/**
 * List custom menu links, optionally scoped to a single menu.
 *
 * `menu_link_content` has a single bundle (also `menu_link_content`), so the menu
 * is selected with a `menu_name` field filter rather than a bundle.
 *
 * @param {object} args - { site?, menu?, limit?, offset?, sort? }.
 * @returns {Promise<{total: number, approximate: boolean, offset: number,
 *   nextOffset: number, menuLinks: object[]}>} Paged, redacted menu-link list.
 * @throws {SecurityError} If reading menu_link_content is not permitted.
 */
async function listMenuLinks({ site: siteName, menu, limit = 20, offset = 0, sort = [{ field: "weight", dir: "asc" }] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, MENU_LINK_TYPE, MENU_LINK_TYPE);
  const backend = await resolveBackend(site);
  const filters = [];
  if (menu !== undefined) filters.push({ field: "menu_name", op: "eq", value: menu });
  const res = await backend.listEntities({
    entityType: MENU_LINK_TYPE, bundle: MENU_LINK_TYPE, filters, sort, page: pageOf({ limit, offset }),
  });
  const menuLinks = res.entities.map((e) => redactCanonicalEntity(e, sec, MENU_LINK_TYPE));
  return {
    total: res.page?.total ?? menuLinks.length,
    approximate: res.approximate ?? false,
    offset,
    nextOffset: offset + menuLinks.length,
    menuLinks,
  };
}

/**
 * Create a custom menu link.
 *
 * The `link` field is a Drupal link field: it takes a `{ uri }` object where the
 * URI is a Drupal-style target, e.g. `internal:/about`, `entity:node/42`, or an
 * absolute `https://…` URL.
 *
 * @param {object} args - { site?, title, link, menu, weight? }.
 * @returns {Promise<object>} The created menu-link descriptor from the backend.
 * @throws {SecurityError} If creating menu_link_content is not permitted.
 */
async function createMenuLink({ site: siteName, title, link, menu, weight }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", MENU_LINK_TYPE, MENU_LINK_TYPE);
  const backend = await resolveBackend(site);
  const attributes = {
    title,
    link: { uri: link },
    menu_name: menu,
    weight: weight === undefined ? 0 : weight,
  };
  return backend.createEntity({ entityType: MENU_LINK_TYPE, bundle: MENU_LINK_TYPE, attributes });
}

// ---------------------------------------------------------------------------
// Custom blocks
// ---------------------------------------------------------------------------

/**
 * List custom content blocks, optionally scoped to a single block type (bundle).
 *
 * @param {object} args - { site?, type?, limit?, offset?, sort? }.
 * @returns {Promise<{total: number, approximate: boolean, offset: number,
 *   nextOffset: number, blocks: object[]}>} Paged, redacted block list.
 * @throws {SecurityError} If reading block_content is not permitted.
 */
async function listBlocks({ site: siteName, type, limit = 20, offset = 0, sort = [{ field: "info", dir: "asc" }] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, BLOCK_TYPE, type);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({
    entityType: BLOCK_TYPE, bundle: type, sort, page: pageOf({ limit, offset }),
  });
  const blocks = res.entities.map((e) => redactCanonicalEntity(e, sec, BLOCK_TYPE));
  return {
    total: res.page?.total ?? blocks.length,
    approximate: res.approximate ?? false,
    offset,
    nextOffset: offset + blocks.length,
    blocks,
  };
}

/**
 * Create a custom content block of a given block type (bundle).
 *
 * `info` is the administrative label; `body` (optional) is rendered HTML wrapped
 * in a `{ value, format }` text field. When no body is supplied the field is
 * omitted so the block can be created with body-less / field-only bundles.
 *
 * @param {object} args - { site?, type, info, body? }.
 * @returns {Promise<object>} The created block descriptor from the backend.
 * @throws {SecurityError} If creating the block type is not permitted.
 */
async function createBlock({ site: siteName, type, info, body }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", BLOCK_TYPE, type);
  const backend = await resolveBackend(site);
  const attributes = { info };
  if (body !== undefined) attributes.body = { value: body, format: "full_html" };
  return backend.createEntity({ entityType: BLOCK_TYPE, bundle: type, attributes });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_menu_links",
    description: "List custom (content) menu links, optionally scoped to a single menu (e.g. 'main', 'footer'). Returns each link's title, target URI, menu, and weight. Note: this lists editable menu_link_content entities, not code-defined static links.",
    inputSchema: {
      type: "object",
      properties: {
        site:   { type: "string", description: "Named site (omit for default)" },
        menu:   { type: "string", description: "Menu machine name to filter by, e.g. 'main', 'footer', 'admin'. Omit to list links across all menus." },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
        sort:   { type: "array", description: "Sort specs: [{ field, dir }]. Defaults to weight asc.", items: { type: "object" } },
      },
    },
  },
  {
    name: "drupal_create_menu_link",
    description: "Create a custom menu link. The link target is a Drupal URI such as 'internal:/about', 'entity:node/42', or an absolute 'https://…' URL. Checked against the site security config.",
    inputSchema: {
      type: "object", required: ["title", "link", "menu"],
      properties: {
        site:   { type: "string" },
        title:  { type: "string", description: "Link label shown in the menu" },
        link:   { type: "string", description: "Target URI, e.g. 'internal:/about', 'entity:node/42', or 'https://example.com'" },
        menu:   { type: "string", description: "Menu machine name to place the link in, e.g. 'main' or 'footer'" },
        weight: { type: "number", default: 0, description: "Ordering weight within the menu (lower sorts first)" },
      },
    },
  },
  {
    name: "drupal_list_blocks",
    description: "List custom content blocks (block_content entities), optionally scoped to a single block type (bundle). Returns each block's admin label (info) and body. Does not list code/plugin-defined blocks.",
    inputSchema: {
      type: "object",
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Block type (bundle) machine name to filter by, e.g. 'basic'. Omit to list all custom blocks." },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
        sort:   { type: "array", description: "Sort specs: [{ field, dir }]. Defaults to info asc.", items: { type: "object" } },
      },
    },
  },
  {
    name: "drupal_create_block",
    description: "Create a custom content block of a given block type (bundle). 'info' is the administrative label; 'body' is optional rendered HTML. Checked against the site security config.",
    inputSchema: {
      type: "object", required: ["type", "info"],
      properties: {
        site: { type: "string" },
        type: { type: "string", description: "Block type (bundle) machine name, e.g. 'basic'" },
        info: { type: "string", description: "Administrative label / block description" },
        body: { type: "string", description: "Block body HTML (optional)" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_list_menu_links:  listMenuLinks,
  drupal_create_menu_link: createMenuLink,
  drupal_list_blocks:      listBlocks,
  drupal_create_block:     createBlock,
};
