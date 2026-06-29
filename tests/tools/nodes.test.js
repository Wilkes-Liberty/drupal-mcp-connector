import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  getPathInfo: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({
    readOnly: false, allowedEntityTypes: null, deniedEntityTypes: [],
    globalRedactedFields: [], entityRules: {},
  })) };
});

import { handlers } from "../../src/tools/nodes.js";

function canonicalNode(over = {}) {
  return { id: "n1", entityType: "node", bundle: "article", title: "T", status: true,
    langcode: "en", created: null, changed: null, url: "/t", fields: { body: { value: "B" } },
    relationships: {}, _backend: "jsonapi", ...over };
}

/** Default path info (no existing alias) — overridden per alias test. */
function pathInfo(over = {}) {
  return { alias: null, pid: null, langcode: "en", drupalId: 2, ...over };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  // Sane defaults so create/update can read path info + re-read the persisted node.
  backend.getPathInfo.mockResolvedValue(pathInfo());
  backend.getEntity.mockResolvedValue(canonicalNode());
  backend.createEntity.mockResolvedValue(canonicalNode());
  backend.updateEntity.mockResolvedValue(canonicalNode());
});

describe("nodes tools (migrated)", () => {
  it("get_node returns the canonical entity", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode());
    const out = await handlers.drupal_get_node({ type: "article", id: "n1" });
    expect(out.id).toBe("n1");
    expect(backend.getEntity).toHaveBeenCalledWith({ entityType: "node", bundle: "article", id: "n1" });
  });

  it("list_nodes compiles status + structured filters into a descriptor", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalNode()], page: { total: 1, hasNext: false }, approximate: false });
    const out = await handlers.drupal_list_nodes({ type: "article", status: true, filters: [{ field: "promote", op: "eq", value: true }], limit: 5, sort: [{ field: "changed", dir: "desc" }] });
    expect(out.total).toBe(1);
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "node", bundle: "article", page: { limit: 5, offset: 0 } });
    expect(desc.filters).toEqual(expect.arrayContaining([
      { field: "status", op: "eq", value: true },
      { field: "promote", op: "eq", value: true },
    ]));
    expect(desc.sort).toEqual([{ field: "changed", dir: "desc" }]);
  });

  it("search_content uses a title-contains filter", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await handlers.drupal_search_content({ query: "hello", type: "article" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "title", op: "contains", value: "hello" }]));
  });

  it("list_nodes returns offset/nextOffset pagination state", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalNode(), canonicalNode({ id: "n2" })], page: { total: 9 }, approximate: false });
    const out = await handlers.drupal_list_nodes({ type: "article", offset: 20 });
    expect(out.total).toBe(9);
    expect(out.offset).toBe(20);
    expect(out.nextOffset).toBe(22);
  });

  it("update_node merges fields, builds the body wrapper, and calls updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "New", body: "<p>y</p>", fields: { field_x: 1 } });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "node", bundle: "article", id: "n1" });
    expect(arg.attributes.title).toBe("New");
    expect(arg.attributes.field_x).toBe(1);
    expect(arg.attributes.body).toEqual({ value: "<p>y</p>", format: "full_html", summary: "" });
  });

  it("create_node builds the body wrapper and calls createEntity", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_create_node({ type: "article", title: "T", body: "<p>x</p>", summary: "x", status: false });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "node", bundle: "article" });
    expect(arg.attributes.title).toBe("T");
    expect(arg.attributes.body).toEqual({ value: "<p>x</p>", format: "full_html", summary: "x" });
    expect(arg.attributes.status).toBe(false);
  });

  it("create_node with moderationState sends moderation_state and omits status", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_create_node({ type: "article", title: "T", moderationState: "draft" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.moderation_state).toBe("draft");
    expect(arg.attributes).not.toHaveProperty("status");
  });

  it("create_node defaults to status:false when neither status nor moderationState is given", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_create_node({ type: "article", title: "T" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.status).toBe(false);
    expect(arg.attributes).not.toHaveProperty("moderation_state");
  });

  it("create_node with explicit status (non-moderated site) sends status and no moderation_state", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_create_node({ type: "page", title: "P", status: true });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.status).toBe(true);
    expect(arg.attributes).not.toHaveProperty("moderation_state");
  });

  it("update_node with moderationState sends moderation_state and omits status", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({ url: null }));
    backend.updateEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_update_node({ type: "article", id: "n1", moderationState: "published" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.moderation_state).toBe("published");
    expect(arg.attributes).not.toHaveProperty("status");
  });

  it("update_node without a path preserves the existing alias and round-trips its pid (DEV-116)", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: "/keep-me", pid: "204", langcode: "en" }));
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "New" });
    expect(backend.getPathInfo).toHaveBeenCalledWith({ entityType: "node", bundle: "article", id: "n1" });
    const arg = backend.updateEntity.mock.calls[0][0];
    // pid present + pathauto:false → Drupal updates the alias in place (no duplicate).
    expect(arg.attributes.path).toEqual({ alias: "/keep-me", pathauto: false, langcode: "en", pid: "204" });
    expect(arg.attributes.title).toBe("New");
  });

  it("update_node with an explicit alias round-trips the existing pid (in-place, no duplicate)", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: "/platforms/sabal", pid: "204", langcode: "en", drupalId: 2 }));
    await handlers.drupal_update_node({ type: "platform", id: "n1", fields: { path: { alias: "/platforms/nexus", pathauto: 0 } } });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.path).toEqual({ alias: "/platforms/nexus", pathauto: false, langcode: "en", pid: "204" });
  });

  it("update_node creates a 301 redirect from the old alias on rename (DEV-116)", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: "/platforms/sabal", pid: "204", drupalId: 2 }));
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    const out = await handlers.drupal_update_node({ type: "platform", id: "n1", fields: { path: { alias: "/platforms/nexus" } } });
    const redirectCall = backend.createEntity.mock.calls.find((c) => c[0].entityType === "redirect");
    expect(redirectCall).toBeTruthy();
    expect(redirectCall[0].attributes.redirect_source.path).toBe("platforms/sabal");
    expect(redirectCall[0].attributes.redirect_redirect.uri).toBe("entity:node/2");
    expect(out._redirect).toMatchObject({ created: true, source: "/platforms/sabal" });
  });

  it("update_node does not create a redirect when the alias is unchanged (idempotent)", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: "/same", pid: "9" }));
    await handlers.drupal_update_node({ type: "article", id: "n1", fields: { path: { alias: "/same" } } });
    expect(backend.createEntity.mock.calls.find((c) => c[0].entityType === "redirect")).toBeFalsy();
  });

  it("update_node returns the re-read persisted url, not the requested value (honest response)", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: "/old", pid: "1" }));
    backend.getEntity.mockResolvedValue(canonicalNode({ url: "/platforms/nexus" }));
    backend.listEntities.mockResolvedValue({ entities: [], page: {}, approximate: false });
    const out = await handlers.drupal_update_node({ type: "platform", id: "n1", fields: { path: { alias: "/platforms/nexus" } } });
    expect(out.url).toBe("/platforms/nexus");
    expect(backend.getEntity).toHaveBeenCalledWith({ entityType: "node", bundle: "platform", id: "n1" });
  });

  it("update_node sends no path when there is no existing alias to preserve", async () => {
    backend.getPathInfo.mockResolvedValue(pathInfo({ alias: null }));
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "New" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes).not.toHaveProperty("path");
  });

  it("create_node with an explicit alias sends a manual path (pathauto:false, no pid)", async () => {
    await handlers.drupal_create_node({ type: "platform", title: "Nexus", fields: { path: { alias: "/platforms/nexus" } } });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.path).toEqual({ alias: "/platforms/nexus", pathauto: false, langcode: "en" });
    expect(arg.attributes.path).not.toHaveProperty("pid");
  });

  it("create_node without a path omits it (lets pathauto generate) and re-reads", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode({ id: "new1", url: null }));
    backend.getEntity.mockResolvedValue(canonicalNode({ id: "new1", url: "/industries/healthcare" }));
    const out = await handlers.drupal_create_node({ type: "industry", title: "Healthcare", moderationState: "published" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes).not.toHaveProperty("path");
    expect(backend.getEntity).toHaveBeenCalledWith({ entityType: "node", bundle: "industry", id: "new1" });
    expect(out.url).toBe("/industries/healthcare");
  });

  it("create_node dryRun returns a preview and does not write", async () => {
    const out = await handlers.drupal_create_node({ type: "article", title: "T", moderationState: "draft", dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "create", entityType: "node", bundle: "article" });
    expect(out.attributes.title).toBe("T");
    expect(out.attributes.moderation_state).toBe("draft");
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("update_node dryRun returns a preview and does not write", async () => {
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", title: "New", dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "update", entityType: "node", bundle: "article", id: "n1" });
    expect(out.attributes.title).toBe("New");
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("delete_node dryRun returns a preview and does not delete", async () => {
    const out = await handlers.drupal_delete_node({ type: "article", id: "n1", dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "delete", entityType: "node", bundle: "article", id: "n1" });
    expect(backend.deleteEntity).not.toHaveBeenCalled();
  });

  it("delete_node calls deleteEntity and returns success", async () => {
    backend.deleteEntity.mockResolvedValue(undefined);
    const out = await handlers.drupal_delete_node({ type: "article", id: "n1" });
    expect(out).toEqual({ success: true, deletedId: "n1" });
    expect(backend.deleteEntity).toHaveBeenCalledWith({ entityType: "node", bundle: "article", id: "n1" });
  });
});
