import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  getPathInfo: vi.fn(),
  getEntitySchema: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
  rawQuery: vi.fn(),
  resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
};

function schemaWithBody(type, over = {}) {
  return {
    entityType: "node",
    bundle: "article",
    attributes: { title: "string", body: type },
    relationships: {},
    ...over,
  };
}
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({
    readOnly: false, allowDestructive: true, allowPublish: true,
    allowedEntityTypes: null, deniedEntityTypes: [],
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
  backend.rawQuery.mockRejectedValue(new Error(
    "Drupal 400 on PATCH /jsonapi/node/article/n1: The selected entity (n1) " +
    "does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
  ));
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
  // Existing summary tests assume a core text_with_summary body. #163 cases
  // that need a different storage shape override this per test.
  backend.getEntitySchema.mockResolvedValue(schemaWithBody("text_with_summary"));
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
    // No summary supplied → the property is omitted rather than blanked, so an
    // existing body summary survives a body-only update.
    expect(arg.attributes.body).toEqual({ value: "<p>y</p>", format: "full_html" });
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

  it("create_node passes entity-reference fields through as relationships (#115)", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    const relationships = { field_tags: { data: [{ type: "taxonomy_term--tags", id: "t1" }] } };
    await handlers.drupal_create_node({ type: "resource", title: "R", relationships });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.relationships).toEqual(relationships);
    // Reference field is NOT smuggled into attributes.
    expect(arg.attributes).not.toHaveProperty("field_tags");
  });

  it("update_node passes relationships through to the backend (#115)", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({ url: null }));
    backend.updateEntity.mockResolvedValue(canonicalNode());
    const relationships = { field_resource_type: { data: { type: "taxonomy_term--resource_type", id: "rt1" } } };
    await handlers.drupal_update_node({ type: "resource", id: "n1", relationships });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.relationships).toEqual(relationships);
  });

  it("create_node returning:minimal strips the body from the response (#113)", async () => {
    backend.createEntity.mockResolvedValue(canonicalNode());
    backend.getEntity.mockResolvedValue(canonicalNode());
    const out = await handlers.drupal_create_node({ type: "article", title: "T", returning: "minimal" });
    expect(out).not.toHaveProperty("fields");
    expect(out.id).toBe("n1");
    expect(out.url).toBe("/t");
  });

  it("update_node with moderationState sends moderation_state and omits status", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({ url: null }));
    backend.updateEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_update_node({ type: "article", id: "n1", moderationState: "published" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.moderation_state).toBe("published");
    expect(arg.attributes).not.toHaveProperty("status");
  });

  it("update_node on a published moderated node defaults moderation_state to draft (#131)", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({
      status: true,
      fields: { moderation_state: "published", body: { value: "B" } },
    }));
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "Wire tags" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.moderation_state).toBe("draft");
    expect(arg.attributes.title).toBe("Wire tags");
  });

  it("update_node does not default draft when caller passes moderationState (#131)", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({
      status: true,
      fields: { moderation_state: "published" },
    }));
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "Keep live", moderationState: "published" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.moderation_state).toBe("published");
  });

  it("update_node does not inject draft on non-moderated published nodes (#131)", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({ status: true, fields: { body: { value: "B" } } }));
    await handlers.drupal_update_node({ type: "page", id: "n1", title: "Page edit" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes).not.toHaveProperty("moderation_state");
    expect(arg.attributes.title).toBe("Page edit");
  });

  it("update_node dryRun preview includes the draft default for published moderated targets (#131)", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({
      status: true,
      fields: { moderation_state: "published" },
    }));
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", title: "Preview", dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.attributes.moderation_state).toBe("draft");
    expect(backend.updateEntity).not.toHaveBeenCalled();
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

describe("body text format and summary handling", () => {
  it("uses an explicit format over any default", async () => {
    await handlers.drupal_create_node({
      type: "article", title: "T", body: "<p>x</p>", format: "headless_clean",
    });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.body.format).toBe("headless_clean");
  });

  it("falls back to the site config's defaultTextFormat", async () => {
    const { getSiteConfig } = await import("../../src/lib/config.js");
    getSiteConfig.mockReturnValueOnce({
      _name: "d", baseUrl: "https://x", security: {}, defaultTextFormat: "site_default_format",
    });
    await handlers.drupal_create_node({ type: "article", title: "T", body: "<p>x</p>" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.body.format).toBe("site_default_format");
  });

  it("keeps full_html only as the last-resort fallback", async () => {
    await handlers.drupal_create_node({ type: "article", title: "T", body: "<p>x</p>" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.body.format).toBe("full_html");
  });

  it("omits summary when it was not supplied, so a body-only update cannot blank it", async () => {
    await handlers.drupal_update_node({ type: "article", id: "n1", body: "<p>y</p>" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.body).not.toHaveProperty("summary");
  });

  it("writes an empty summary only when explicitly asked to clear it", async () => {
    await handlers.drupal_update_node({ type: "article", id: "n1", body: "<p>y</p>", summary: "" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.body.summary).toBe("");
  });
});

describe("#163 summary is refused when body has no summary property", () => {
  it("create_node refuses summary against a text_formatted body and does not write", async () => {
    backend.getEntitySchema.mockResolvedValue(schemaWithBody("text_formatted"));
    await expect(handlers.drupal_create_node({
      type: "article", title: "T", body: "<p>x</p>", summary: "teaser",
    })).rejects.toThrow(/no summary property/i);
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("update_node refuses summary against a text_formatted body and does not write", async () => {
    backend.getEntitySchema.mockResolvedValue(schemaWithBody("text_formatted"));
    await expect(handlers.drupal_update_node({
      type: "article", id: "n1", body: "<p>y</p>", summary: "teaser",
    })).rejects.toThrow(/no summary property/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("create_node refuses summary when the body schema cannot be determined", async () => {
    backend.getEntitySchema.mockResolvedValue({
      entityType: "node",
      bundle: "article",
      note: "No entities exist yet — schema unavailable.",
      attributes: {},
      relationships: {},
    });
    await expect(handlers.drupal_create_node({
      type: "article", title: "T", body: "<p>x</p>", summary: "teaser",
    })).rejects.toThrow(/no summary property|could not be determined/i);
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("create_node dryRun refuses summary against a text_formatted body", async () => {
    backend.getEntitySchema.mockResolvedValue(schemaWithBody("text_formatted"));
    await expect(handlers.drupal_create_node({
      type: "article", title: "T", body: "<p>x</p>", summary: "teaser", dryRun: true,
    })).rejects.toThrow(/no summary property/i);
  });

  it("update_node dryRun refuses summary against a text_formatted body", async () => {
    backend.getEntitySchema.mockResolvedValue(schemaWithBody("text_formatted"));
    await expect(handlers.drupal_update_node({
      type: "article", id: "n1", body: "<p>y</p>", summary: "teaser", dryRun: true,
    })).rejects.toThrow(/no summary property/i);
  });

  it("create_node still writes summary on text_with_summary and flags deprecation", async () => {
    const out = await handlers.drupal_create_node({
      type: "article", title: "T", body: "<p>x</p>", summary: "teaser",
    });
    expect(backend.createEntity.mock.calls[0][0].attributes.body.summary).toBe("teaser");
    expect(out._warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "summary_parameter_deprecated" }),
    ]));
  });

  it("create_node without summary does not introspect the schema", async () => {
    await handlers.drupal_create_node({ type: "article", title: "T", body: "<p>x</p>" });
    expect(backend.getEntitySchema).not.toHaveBeenCalled();
  });
});

describe("#171 status stays opt-in on node updates", () => {
  it("update_node without status on a published unmoderated node sends neither status nor moderation_state", async () => {
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "Rename only" });
    const sent = backend.updateEntity.mock.calls[0][0];
    expect(sent.attributes).not.toHaveProperty("status");
    expect(sent.attributes).not.toHaveProperty("moderation_state");
  });
});

describe("#171 unrequested published-state flip is flagged on node updates", () => {
  it("flags a flip observed in the post-write re-read", async () => {
    // Pre-read published; the persisted node re-reads unpublished.
    backend.getEntity
      .mockResolvedValueOnce(canonicalNode({ status: true }))
      .mockResolvedValue(canonicalNode({ status: false }));
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", title: "Rename only" });
    expect(out._statusChanged).toMatchObject({ from: true, to: false });
  });

  it("does not flag when the caller passed an explicit moderationState", async () => {
    backend.getEntity.mockResolvedValue(canonicalNode({ status: false }));
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", moderationState: "draft" });
    expect(out).not.toHaveProperty("_statusChanged");
  });
});

const WC_400 = new Error(
  "Drupal 400 on PATCH /jsonapi/node/article/n1: Updating a resource object " +
  "that has a working copy is not yet supported. See " +
  "https://www.drupal.org/project/drupal/issues/2795279."
);

describe("#192 ERR attach, #169 written revision, #201 preflight", () => {
  const publishedModerated = () => canonicalNode({
    status: true,
    fields: { moderation_state: "published", body: { value: "B" } },
    relationships: {
      field_key_capabilities: [{ id: "old-1", entityType: "paragraph", bundle: "capability" }],
    },
  });

  const paras = [
    { type: "paragraph--capability", id: "p-a" },
    { type: "paragraph--capability", id: "p-b" },
  ];

  it("resolves vids, probes, PATCHes with meta, and reads the working-copy", async () => {
    backend.getEntity.mockImplementation(async ({ entityType, id, resourceVersion }) => {
      if (entityType === "paragraph") {
        return {
          id, entityType: "paragraph", bundle: "capability",
          fields: { drupal_internal__revision_id: id === "p-a" ? 11 : 12 },
        };
      }
      if (resourceVersion === "rel:working-copy") {
        return {
          ...publishedModerated(),
          status: false,
          fields: { moderation_state: "draft" },
          relationships: {
            field_key_capabilities: [
              { id: "p-a", entityType: "paragraph", bundle: "capability", meta: { target_revision_id: 11 } },
              { id: "p-b", entityType: "paragraph", bundle: "capability", meta: { target_revision_id: 12 } },
            ],
          },
        };
      }
      return publishedModerated();
    });
    // PATCH body is the default revision — the #169 lie if we returned it as proof.
    backend.updateEntity.mockResolvedValue(publishedModerated());

    const out = await handlers.drupal_update_node({
      type: "article", id: "n1",
      relationships: { field_key_capabilities: { data: paras } },
    });

    expect(backend.rawQuery).toHaveBeenCalledTimes(1);
    const probe = backend.rawQuery.mock.calls[0][0];
    const probeData = JSON.parse(probe.options.body).data;
    expect(probeData).not.toHaveProperty("relationships");
    expect(probeData).not.toHaveProperty("attributes");
    expect(probeData.id).not.toBe("n1");
    const sent = backend.updateEntity.mock.calls[0][0];
    expect(sent.relationships.field_key_capabilities.data).toEqual([
      { type: "paragraph--capability", id: "p-a", meta: { target_revision_id: 11 } },
      { type: "paragraph--capability", id: "p-b", meta: { target_revision_id: 12 } },
    ]);
    expect(out.relationships.field_key_capabilities).toHaveLength(2);
    expect(out._revision.source).toBe("working-copy");
    expect(out._revision.relationshipsUnverified).toBeUndefined();
  });

  it("does not call updateEntity when a paragraph GET 404s", async () => {
    backend.getEntity.mockImplementation(async ({ entityType }) => {
      if (entityType === "paragraph") return null;
      return publishedModerated();
    });
    await expect(handlers.drupal_update_node({
      type: "article", id: "n1",
      relationships: { field_key_capabilities: { data: paras } },
    })).rejects.toThrow(/target_revision_id/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("probe 400 aborts before the real payload; dryRun also fails", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        return { ...publishedModerated(), fields: { drupal_internal__vid: 2070 } };
      }
      return publishedModerated();
    });
    backend.rawQuery.mockRejectedValue(WC_400);
    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "T" }))
      .rejects.toThrow(/stale or concurrent|#166/);
    expect(backend.updateEntity).not.toHaveBeenCalled();

    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "T", dryRun: true }))
      .rejects.toThrow(/stale or concurrent|#166/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("marks the response unverified when relationships were sent but no working-copy is addressable", async () => {
    backend.getEntity.mockImplementation(async ({ entityType, resourceVersion }) => {
      if (entityType === "paragraph") {
        return { id: "p-a", entityType: "paragraph", bundle: "capability", fields: { drupal_internal__revision_id: 11 } };
      }
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return publishedModerated();
    });
    backend.updateEntity.mockResolvedValue(publishedModerated());
    const out = await handlers.drupal_update_node({
      type: "article", id: "n1",
      relationships: { field_key_capabilities: { data: [paras[0]] } },
    });
    expect(out._revision.relationshipsUnverified).toBe(true);
    // Canonical/PATCH body still has the old single ref — not accepted as proof.
    expect(out.relationships.field_key_capabilities).toHaveLength(1);
    expect(out.relationships.field_key_capabilities[0].id).toBe("old-1");
  });
});

describe("#166 iterative working-copy PATCH", () => {
  const live = () => canonicalNode({
    title: "Published",
    status: true,
    url: "/published",
    fields: { moderation_state: "published", drupal_internal__vid: 1500, body: { value: "B" } },
  });
  const draft = (vid = 1510) => canonicalNode({
    title: "CTA pass",
    status: false,
    url: "/draft-alias",
    fields: { moderation_state: "draft", drupal_internal__vid: vid, body: { value: "B" } },
  });

  function mockNoWorkingCopy() {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return live();
    });
  }

  function mockWorkingCopy({ id = "n1" } = {}) {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") return { ...draft(), id };
      return live();
    });
  }

  it("published with no working copy PATCHes the canonical URL", async () => {
    mockNoWorkingCopy();
    backend.updateEntity.mockResolvedValue(live());
    await handlers.drupal_update_node({ type: "article", id: "n1", title: "First draft" });
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    const sent = backend.updateEntity.mock.calls[0][0];
    expect(sent).not.toHaveProperty("resourceVersion");
    expect(backend.rawQuery.mock.calls[0][0].path).toBe("/jsonapi/node/article/n1");
    expect(backend.rawQuery.mock.calls[0][0].path).not.toMatch(/working-copy/);
  });

  it("addressable working copy PATCHes rel:working-copy and does not say publish or discard", async () => {
    mockWorkingCopy();
    backend.updateEntity.mockResolvedValue(draft());
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", title: "CTA pass" });
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    expect(backend.updateEntity.mock.calls[0][0].resourceVersion).toBe("rel:working-copy");
    expect(out.title).toBe("CTA pass");
    expect(out.status).toBe(false);
    expect(out.url).toBe("/draft-alias");
    expect(out._revisions).toEqual({ live: 1500, working: 1510 });
  });

  it("dryRun with a working copy probes the working-copy URL", async () => {
    mockWorkingCopy();
    const out = await handlers.drupal_update_node({ type: "article", id: "n1", title: "CTA", dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery.mock.calls[0][0].path).toContain("resourceVersion=rel%3Aworking-copy");
    expect(backend.rawQuery.mock.calls[0][0].path).not.toBe("/jsonapi/node/article/n1");
  });

  it("dryRun fails when the working-copy probe 400s — it does not report success", async () => {
    mockWorkingCopy();
    backend.rawQuery.mockRejectedValue(WC_400);
    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "CTA", dryRun: true }))
      .rejects.toThrow(/stale or concurrent|#166/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery.mock.calls[0][0].path).toContain("resourceVersion=rel%3Aworking-copy");
  });

  it("working copy does not resolve plus core 400 keeps the #201 stray-revision message", async () => {
    mockNoWorkingCopy();
    backend.rawQuery.mockRejectedValue(WC_400);
    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "T" }))
      .rejects.toThrow(/revision surgery|#201/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("refuses a stale working-copy write and does not retry the canonical URL", async () => {
    mockWorkingCopy();
    backend.updateEntity.mockRejectedValue(WC_400);
    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "CTA" }))
      .rejects.toThrow(/stale or concurrent|#166/i);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    expect(backend.updateEntity.mock.calls[0][0].resourceVersion).toBe("rel:working-copy");
  });

  it("refuses when the working-copy id does not match the target", async () => {
    mockWorkingCopy({ id: "other-node" });
    await expect(handlers.drupal_update_node({ type: "article", id: "n1", title: "CTA" }))
      .rejects.toThrow(/does not match|ambiguous|#166/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.createEntity).not.toHaveBeenCalled();
  });
});

