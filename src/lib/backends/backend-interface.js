/**
 * Backend interface contract. Concrete adapters (JsonApiBackend, GraphqlBackend)
 * extend this and override every method.
 *
 * capabilities() returns:
 *   {
 *     read: boolean,
 *     write: boolean,
 *     delete: boolean,
 *     count: boolean,                 // can return exact totals cheaply
 *     filter: boolean,                // server-side field filtering
 *     sort: "full" | "enum" | "none",
 *     revisions: boolean,
 *     fieldAvailability: ((entityType: string, bundle: string) => string[]) | null
 *   }
 */
function notImplemented(name) {
  throw new Error(`Backend.${name} is not implemented`);
}

export class Backend {
  capabilities() { return notImplemented("capabilities"); }
  async listEntities(_descriptor) { return notImplemented("listEntities"); }
  async getEntity(_ref) { return notImplemented("getEntity"); }
  async createEntity(_input) { return notImplemented("createEntity"); }
  async updateEntity(_input) { return notImplemented("updateEntity"); }
  async deleteEntity(_ref) { return notImplemented("deleteEntity"); }
  async introspect(_opts) { return notImplemented("introspect"); }
  async listContentTypes() { return notImplemented("listContentTypes"); }
  async listBundles(_entityType) { return notImplemented("listBundles"); }
  async listResourceTypes() { return notImplemented("listResourceTypes"); }
  async getEntitySchema(_entityType, _bundle) { return notImplemented("getEntitySchema"); }
  async listRoles() { return notImplemented("listRoles"); }
  async uploadFile(_opts) { return notImplemented("uploadFile"); }
  async countEntities(_descriptor) { return notImplemented("countEntities"); }
  async rawQuery(_input) { return notImplemented("rawQuery"); }
  resolveFieldName(_entityType, _bundle, _candidates) { return notImplemented("resolveFieldName"); }
}
