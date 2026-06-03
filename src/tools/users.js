/**
 * Tool group: User accounts.
 *
 * User CRUD plus role listing, backend-agnostic. Because user records are PII,
 * each handler asserts read/write access against the per-site policy in-handler
 * (in addition to the name-prefix gating in index.js), and reads are redacted
 * via redactCanonicalEntity.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, redactCanonicalEntity } from "../lib/security.js";

/**
 * Build a JSON:API relationship payload assigning the given role IDs.
 * @param {string[]} roles - Role UUIDs.
 * @returns {{data: Array<{type: string, id: string}>}}
 */
const ROLE_REL = (roles) => ({ data: roles.map((id) => ({ type: "user_role--user_role", id })) });

/**
 * List user accounts, optionally filtered by status and/or role machine name.
 *
 * @param {object} args - { site?, status?, role?, limit?, offset? }.
 *   A `role` is matched on the internal role id relationship path.
 * @returns {Promise<{total: number, approximate: boolean, offset: number,
 *   nextOffset: number, users: object[]}>} Paged, redacted user list.
 * @throws {SecurityError} If reading users is not permitted by policy.
 */
async function listUsers({ site: siteName, status, role, limit = 20, offset = 0 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "user", "user");
  const backend = await resolveBackend(site);
  const filters = [];
  if (status !== undefined) filters.push({ field: "status", op: "eq", value: status });
  if (role) filters.push({ field: "roles.meta.drupal_internal__id", op: "eq", value: role });
  const res = await backend.listEntities({ entityType: "user", bundle: "user", filters, sort: [{ field: "name", dir: "asc" }], page: { limit, offset } });
  const users = res.entities.map((e) => redactCanonicalEntity(e, sec, "user"));
  return { total: res.page?.total ?? users.length, approximate: res.approximate ?? false, offset, nextOffset: offset + users.length, users };
}

/**
 * Fetch a single user by UUID, with roles sideloaded, redacted per policy.
 *
 * @param {object} args - { site?, id }.
 * @returns {Promise<object|null>} The redacted user, or null if not found.
 * @throws {SecurityError} If reading users is not permitted.
 */
async function getUser({ site: siteName, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "user", "user");
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "user", bundle: "user", id, include: ["roles"] });
  return entity ? redactCanonicalEntity(entity, sec, "user") : null;
}

/**
 * Look up a user by exact username.
 *
 * @param {object} args - { site?, name }.
 * @returns {Promise<object>} The redacted matching user.
 * @throws {Error} If no user matches the name.
 * @throws {SecurityError} If reading users is not permitted.
 */
async function getUserByName({ site: siteName, name }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "user", "user");
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({ entityType: "user", bundle: "user", filters: [{ field: "name", op: "eq", value: name }], page: { limit: 1 } });
  if (!res.entities.length) throw new Error(`No user found with name: "${name}"`);
  return redactCanonicalEntity(res.entities[0], sec, "user");
}

/**
 * Create a user account. The password is mapped to Drupal's `pass` attribute
 * shape ([{ value }]); roles, if any, become a role relationship.
 *
 * @param {object} args - { site?, name, mail, password?, status?, roles?, timezone? }.
 * @returns {Promise<object>} The created user descriptor.
 * @throws {SecurityError} If creating users is not permitted.
 */
async function createUser({ site: siteName, name, mail, password, status = true, roles = [], timezone = "UTC" }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", "user", "user");
  const backend = await resolveBackend(site);
  const attributes = { name, mail, status, timezone };
  if (password) attributes.pass = [{ value: password }];
  const relationships = roles.length ? { roles: ROLE_REL(roles) } : undefined;
  return backend.createEntity({ entityType: "user", bundle: "user", attributes, relationships });
}

/**
 * Update a user account (partial). Supplying `roles` replaces the full role
 * set; omitting it leaves roles untouched.
 *
 * @param {object} args - { site?, id, name?, mail?, password?, status?, roles?, timezone? }.
 * @returns {Promise<object>} The updated user descriptor.
 * @throws {SecurityError} If updating users is not permitted.
 */
async function updateUser({ site: siteName, id, name, mail, password, status, roles, timezone }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "user", "user");
  const backend = await resolveBackend(site);
  const attributes = {};
  if (name !== undefined) attributes.name = name;
  if (mail !== undefined) attributes.mail = mail;
  if (status !== undefined) attributes.status = status;
  if (timezone !== undefined) attributes.timezone = timezone;
  if (typeof password !== "undefined") attributes.pass = [{ value: password }];
  const relationships = roles !== undefined ? { roles: ROLE_REL(roles) } : undefined;
  return backend.updateEntity({ entityType: "user", bundle: "user", id, attributes, relationships });
}

/**
 * Block or unblock a user by toggling its status (no deletion).
 *
 * @param {object} args - { site?, id, block? }. block=true sets status=false.
 * @returns {Promise<object>} The updated user descriptor.
 * @throws {SecurityError} If updating users is not permitted.
 */
async function blockUser({ site: siteName, id, block = true }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "user", "user");
  const backend = await resolveBackend(site);
  return backend.updateEntity({ entityType: "user", bundle: "user", id, attributes: { status: !block } });
}

/**
 * List all user roles defined on the site.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object[]>} Role descriptors.
 */
async function listRoles({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.listRoles();
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_users",
    description: "List Drupal user accounts. Filter by active/blocked status or by role machine name.",
    inputSchema: {
      type: "object",
      properties: {
        site:   { type: "string" },
        status: { type: "boolean", description: "true = active only, false = blocked only" },
        role:   { type: "string", description: "Filter by role machine name, e.g. 'editor'" },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
      },
    },
  },
  {
    name: "drupal_get_user",
    description: "Fetch a single Drupal user account by UUID, including their assigned roles.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        site: { type: "string" },
        id:   { type: "string", description: "User UUID" },
      },
    },
  },
  {
    name: "drupal_get_user_by_name",
    description: "Look up a Drupal user by their exact username.",
    inputSchema: {
      type: "object", required: ["name"],
      properties: {
        site: { type: "string" },
        name: { type: "string", description: "Drupal username (exact match)" },
      },
    },
  },
  {
    name: "drupal_create_user",
    description: "Create a new Drupal user account with optional roles and password.",
    inputSchema: {
      type: "object", required: ["name", "mail"],
      properties: {
        site:     { type: "string" },
        name:     { type: "string", description: "Username" },
        mail:     { type: "string", description: "Email address" },
        password: { type: "string", description: "Initial password (plaintext — sent over HTTPS)" },
        status:   { type: "boolean", default: true, description: "true = active (default)" },
        roles:    { type: "array", items: { type: "string" }, description: "Role UUIDs to assign" },
        timezone: { type: "string", default: "UTC" },
      },
    },
  },
  {
    name: "drupal_update_user",
    description: "Update a Drupal user account. Only include fields you want to change. Can reassign roles by providing a full replacement role list.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        site:     { type: "string" },
        id:       { type: "string", description: "User UUID" },
        name:     { type: "string" },
        mail:     { type: "string" },
        password: { type: "string" },
        status:   { type: "boolean" },
        roles:    { type: "array", items: { type: "string" }, description: "Full replacement role UUID list" },
        timezone: { type: "string" },
      },
    },
  },
  {
    name: "drupal_block_user",
    description: "Block or unblock a Drupal user account without deleting it.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: {
        site:  { type: "string" },
        id:    { type: "string", description: "User UUID" },
        block: { type: "boolean", default: true, description: "true = block, false = unblock" },
      },
    },
  },
  {
    name: "drupal_list_roles",
    description: "List all user roles defined on this Drupal site.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
];

export const handlers = {
  drupal_list_users:       listUsers,
  drupal_get_user:         getUser,
  drupal_get_user_by_name: getUserByName,
  drupal_create_user:      createUser,
  drupal_update_user:      updateUser,
  drupal_block_user:       blockUser,
  drupal_list_roles:       listRoles,
};
