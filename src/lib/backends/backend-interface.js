/**
 * Backend interface contract for the dual-protocol data layer.
 *
 * Single responsibility: define the abstract surface that every concrete
 * adapter (JsonApiBackend, GraphqlBackend) must implement so the rest of the
 * connector can read/write Drupal entities without knowing which protocol is
 * in use. Each method here throws until overridden; adapters override every
 * method and return the canonical shapes documented below.
 *
 * Canonical shapes referenced throughout:
 *   - QueryDescriptor: the entity descriptor used by list/count operations,
 *       { entityType, bundle, filters?, sort?, fields?, include?, page? }
 *       (see {@link import("../canonical.js").QueryDescriptor}).
 *   - CanonicalEntity: the protocol-neutral entity returned by read/write ops
 *       (see {@link import("../canonical.js").CanonicalEntity}).
 *
 * @typedef {Object} Capabilities
 * @property {boolean} read   Adapter can read entities.
 * @property {boolean} write  Adapter can create/update entities.
 * @property {boolean} delete Adapter can delete entities.
 * @property {boolean} count  Adapter can return exact totals cheaply.
 * @property {boolean} filter Adapter supports server-side field filtering.
 * @property {"full"|"enum"|"none"} sort Server-side sort support: arbitrary
 *   fields ("full"), a fixed enum of keys ("enum"), or none ("none").
 * @property {boolean} revisions Adapter exposes entity revisions.
 * @property {((entityType: string, bundle: string) => string[])|null} fieldAvailability
 *   Optional resolver returning the known field names for a bundle, or null
 *   when the adapter cannot cheaply enumerate fields.
 *
 * @typedef {Object} ListResult
 * @property {import("../canonical.js").CanonicalEntity[]} entities Page of entities.
 * @property {{total: ?number, hasNext: boolean, cursor: ?string}} page Paging
 *   info; `total` is null when the backend cannot count.
 * @property {boolean} approximate True when paging/total are estimated (e.g.
 *   client-side filtered results) rather than authoritative.
 * @property {boolean} truncated True when the client-side record cap was hit
 *   and results may be incomplete.
 */

/**
 * Throw a uniform "not implemented" error for an un-overridden method.
 * @param {string} name Method name being invoked on the base class.
 * @returns {never}
 * @throws {Error} Always.
 */
function notImplemented(name) {
  throw new Error(`Backend.${name} is not implemented`);
}

/**
 * Abstract backend. Concrete adapters extend this and override every method.
 */
export class Backend {
  /**
   * Report what this adapter can do, so callers can adapt behavior.
   * @returns {Capabilities}
   */
  capabilities() { return notImplemented("capabilities"); }

  /**
   * List entities matching an entity descriptor.
   * @param {import("../canonical.js").QueryDescriptor} _descriptor
   * @returns {Promise<ListResult>}
   */
  async listEntities(_descriptor) { return notImplemented("listEntities"); }

  /**
   * Fetch a single entity by reference.
   * @param {{entityType: string, bundle: string, id: string}} _ref
   * @returns {Promise<?import("../canonical.js").CanonicalEntity>} Entity, or null when absent.
   */
  async getEntity(_ref) { return notImplemented("getEntity"); }

  /**
   * Create an entity.
   * @param {{entityType: string, bundle: string, attributes?: object, relationships?: object}} _input
   * @returns {Promise<import("../canonical.js").CanonicalEntity>}
   */
  async createEntity(_input) { return notImplemented("createEntity"); }

  /**
   * Update an entity.
   * @param {{entityType: string, bundle: string, id: string, attributes?: object, relationships?: object}} _input
   * @returns {Promise<import("../canonical.js").CanonicalEntity>}
   */
  async updateEntity(_input) { return notImplemented("updateEntity"); }

  /**
   * Delete an entity by reference.
   * @param {{entityType: string, bundle: string, id: string}} _ref
   * @returns {Promise<void>}
   */
  async deleteEntity(_ref) { return notImplemented("deleteEntity"); }

  /**
   * Discover the resource/content surface exposed by the backend.
   * @param {object} [_opts]
   * @returns {Promise<{resourceTypes: string[]}>} `entityType--bundle` identifiers.
   */
  async introspect(_opts) { return notImplemented("introspect"); }

  /**
   * List node content types.
   * @returns {Promise<Array<{id: string, label: string, description: ?string}>>}
   */
  async listContentTypes() { return notImplemented("listContentTypes"); }

  /**
   * List the bundles of a given entity type.
   * @param {string} _entityType
   * @returns {Promise<Array<{id: string, label: ?string, description: ?string}>>}
   */
  async listBundles(_entityType) { return notImplemented("listBundles"); }

  /**
   * List all resource types as entityType/bundle pairs.
   * @returns {Promise<Array<{resourceType: string, entityType: string, bundle: string}>>}
   */
  async listResourceTypes() { return notImplemented("listResourceTypes"); }

  /**
   * Describe a bundle's fields/relationships.
   * @param {string} _entityType
   * @param {string} _bundle
   * @returns {Promise<{entityType: string, bundle: string, attributes: object, relationships: object}>}
   */
  async getEntitySchema(_entityType, _bundle) { return notImplemented("getEntitySchema"); }

  /**
   * List user roles.
   * @returns {Promise<Array<{id: string, machineName: string, label: string, weight: number}>>}
   */
  async listRoles() { return notImplemented("listRoles"); }

  /**
   * Upload a file and return its descriptor.
   * @param {{entityType?: string, bundle: string, fieldName: string, filePath: string}} _opts
   * @returns {Promise<{id: string, drupalId: number, filename: string, uri: ?string, url: ?string, size: number, mimeType: string}>}
   */
  async uploadFile(_opts) { return notImplemented("uploadFile"); }

  /**
   * Count entities matching an entity descriptor.
   * @param {import("../canonical.js").QueryDescriptor} _descriptor
   * @returns {Promise<{count: number, approximate: boolean}>}
   */
  async countEntities(_descriptor) { return notImplemented("countEntities"); }

  /**
   * Escape hatch: run a protocol-native request and return its raw response.
   * @param {object} _input Protocol-specific request shape.
   * @returns {Promise<*>} Raw backend response.
   */
  async rawQuery(_input) { return notImplemented("rawQuery"); }

  /**
   * Resolve the first usable field name from a candidate list for a bundle.
   * @param {string} _entityType
   * @param {string} _bundle
   * @param {string[]} _candidates Field names in preference order.
   * @returns {?string|Promise<?string>} Chosen field name, or null when none match.
   */
  resolveFieldName(_entityType, _bundle, _candidates) { return notImplemented("resolveFieldName"); }
}
