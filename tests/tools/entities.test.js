import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(),
  deleteEntity: vi.fn(), listResourceTypes: vi.fn(), getEntitySchema: vi.fn(),
  rawQuery: vi.fn(),
  resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: { preset: "development" } })),
}));

import { handlers } from "../../src/tools/entities.js";
import { getSiteConfig } from "../../src/lib/config.js";

// A site whose tier cannot publish (allowPublish false), for the publish-gate tests.
const noPublishSite = { _name: "prod", baseUrl: "https://x", security: { preset: "write-plane" } };

const ent = { id: "p1", entityType: "paragraph", bundle: "text", title: null, status: null,
  langcode: "en", created: null, changed: null, url: null,
  fields: { field_body: "x", drupal_internal__revision_id: 3 }, relationships: {}, _backend: "jsonapi" };

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  backend.rawQuery.mockRejectedValue(new Error(
    "Drupal 400 on PATCH /jsonapi/node/article/n1: The selected entity (n1) " +
    "does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
  ));
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
});

describe("entities tools (migrated)", () => {
  it("entity_list passes structured filters + page to listEntities", async () => {
    backend.listEntities.mockResolvedValue({ entities: [ent], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_entity_list({ entityType: "paragraph", bundle: "text", filters: [{ field: "status", op: "eq", value: true }], limit: 5, offset: 10 });
    expect(out.total).toBe(1);
    expect(out.entities[0].id).toBe("p1");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "paragraph", bundle: "text", page: { limit: 5, offset: 10 } });
    expect(desc.filters).toEqual([{ field: "status", op: "eq", value: true }]);
  });

  it("entity_create dryRun returns a preview and does not write", async () => {
    const out = await handlers.drupal_entity_create({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "create", entityType: "paragraph", bundle: "text" });
    expect(out.attributes).toEqual({ field_body: "x" });
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("entity_create rejects a status:true write when the tier cannot publish (#111)", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await expect(
      handlers.drupal_entity_create({ entityType: "taxonomy_term", bundle: "tags", attributes: { name: "T", status: true } })
    ).rejects.toThrow(/allowPublish/);
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("entity_update dryRun rejects a status:true write the real call would refuse (#112)", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await expect(
      handlers.drupal_entity_update({ entityType: "taxonomy_term", bundle: "tags", id: "11111111-1111-4111-8111-111111111111", attributes: { status: true }, dryRun: true })
    ).rejects.toThrow(/allowPublish/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("entity_create allows a non-publishing (status:false) write on a no-publish tier", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    backend.createEntity.mockResolvedValue(ent);
    await handlers.drupal_entity_create({ entityType: "taxonomy_term", bundle: "tags", attributes: { name: "T", status: false } });
    expect(backend.createEntity).toHaveBeenCalled();
  });

  it("entity_update returning:minimal omits body/attributes, keeps identity + state (#113)", async () => {
    backend.updateEntity.mockResolvedValue({
      id: "p1", entityType: "node", bundle: "article", title: "T", status: true,
      langcode: "en", changed: "2026-01-01T00:00:00+00:00", url: "/t",
      fields: { body: { value: "x", processed: "x" } }, relationships: {},
    });
    const out = await handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id: "11111111-1111-4111-8111-111111111111",
      attributes: { status: true }, returning: "minimal",
    });
    expect(out).not.toHaveProperty("fields");
    expect(out).not.toHaveProperty("relationships");
    expect(out).toMatchObject({ id: "p1", entityType: "node", bundle: "article", title: "T", status: true, url: "/t", changed: "2026-01-01T00:00:00+00:00" });
  });

  it("entity_update returning:full (default) returns the whole entity", async () => {
    const full = { id: "p1", entityType: "node", bundle: "article", fields: { body: { value: "x" } }, relationships: {} };
    backend.updateEntity.mockResolvedValue(full);
    const out = await handlers.drupal_entity_update({ entityType: "node", bundle: "article", id: "11111111-1111-4111-8111-111111111111", attributes: { title: "T" } });
    expect(out).toHaveProperty("fields");
  });

  it("entity_delete dryRun returns a preview and does not delete", async () => {
    const out = await handlers.drupal_entity_delete({ entityType: "paragraph", bundle: "text", id: "p1", dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "delete", entityType: "paragraph", bundle: "text", id: "p1" });
    expect(backend.deleteEntity).not.toHaveBeenCalled();
  });

  it("entity_get returns the canonical entity", async () => {
    backend.getEntity.mockResolvedValue(ent);
    const out = await handlers.drupal_entity_get({ entityType: "paragraph", bundle: "text", id: "p1" });
    expect(out.id).toBe("p1");
  });

  it("entity_create passes attributes + relationships through", async () => {
    backend.createEntity.mockResolvedValue(ent);
    await handlers.drupal_entity_create({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, relationships: { r: {} } });
    expect(backend.createEntity).toHaveBeenCalledWith({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, relationships: { r: {} } });
  });

  it("entity_delete returns success", async () => {
    backend.deleteEntity.mockResolvedValue(undefined);
    const out = await handlers.drupal_entity_delete({ entityType: "paragraph", bundle: "text", id: "p1" });
    expect(out).toMatchObject({ success: true, deletedId: "p1" });
  });

  it("list_entity_types filters resource types through security and reports counts", async () => {
    backend.listResourceTypes.mockResolvedValue([
      { resourceType: "node--article", entityType: "node", bundle: "article" },
      { resourceType: "user--user", entityType: "user", bundle: "user" },
    ]);
    const out = await handlers.drupal_list_entity_types({});
    expect(out.total).toBe(2);
    expect(out.accessible).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(out.resourceTypes)).toBe(true);
  });

  it("get_entity_schema delegates to the backend", async () => {
    backend.getEntitySchema.mockResolvedValue({ entityType: "paragraph", bundle: "text", attributes: { field_body: "string" }, relationships: {} });
    const out = await handlers.drupal_get_entity_schema({ entityType: "paragraph", bundle: "text" });
    expect(out.attributes.field_body).toBe("string");
  });
});

// A published, unmoderated entity — the #171 reproduction shape.
const publishedUnmoderated = {
  id: "m1", entityType: "media", bundle: "video_file", title: "V", status: true,
  langcode: "en", created: null, changed: null, url: null,
  fields: { name: "V" }, relationships: {}, _backend: "jsonapi",
};
const posterRel = { field_poster: { data: { type: "media--image", id: "22222222-2222-4222-8222-222222222222" } } };

describe("#171 live-state mediation on updates", () => {
  it("relationships-only update sends no status or moderation_state", async () => {
    backend.getEntity.mockResolvedValue(publishedUnmoderated);
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated });
    await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      relationships: posterRel,
    });
    const sent = backend.updateEntity.mock.calls[0][0];
    expect(sent.attributes).not.toHaveProperty("status");
    expect(sent.attributes).not.toHaveProperty("moderation_state");
    expect(sent.relationships.field_poster.data.id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("flags an unrequested published-state change on the response", async () => {
    backend.getEntity.mockResolvedValue(publishedUnmoderated);
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated, status: false });
    const out = await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      relationships: posterRel,
    });
    expect(out._statusChanged).toMatchObject({ from: true, to: false });
    expect(out._statusChanged.note).toMatch(/status/);
  });

  it("keeps the unrequested-change flag through returning:minimal", async () => {
    backend.getEntity.mockResolvedValue(publishedUnmoderated);
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated, status: false });
    const out = await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      relationships: posterRel, returning: "minimal",
    });
    expect(out._statusChanged).toMatchObject({ from: true, to: false });
    expect(out).not.toHaveProperty("fields");
  });

  it("does not flag when the caller set status explicitly", async () => {
    backend.getEntity.mockResolvedValue(publishedUnmoderated);
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated, status: false });
    const out = await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      attributes: { status: false },
    });
    expect(out).not.toHaveProperty("_statusChanged");
  });

  it("does not flag (and does not crash) when the pre-read fails", async () => {
    backend.getEntity.mockRejectedValue(new Error("boom"));
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated, status: false });
    const out = await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      relationships: posterRel,
    });
    expect(out).not.toHaveProperty("_statusChanged");
  });

  it("does not flag when the published state is unchanged", async () => {
    backend.getEntity.mockResolvedValue(publishedUnmoderated);
    backend.updateEntity.mockResolvedValue({ ...publishedUnmoderated });
    const out = await handlers.drupal_entity_update({
      entityType: "media", bundle: "video_file", id: "11111111-1111-4111-8111-111111111111",
      relationships: posterRel,
    });
    expect(out).not.toHaveProperty("_statusChanged");
  });
});

const WC_400 = new Error(
  "Drupal 400 on PATCH /jsonapi/node/article/n1: Updating a resource object " +
  "that has a working copy is not yet supported. See " +
  "https://www.drupal.org/project/drupal/issues/2795279."
);

describe("#192 / #201 on entity_update", () => {
  const publishedModerated = {
    id: "n1", entityType: "node", bundle: "article", title: "T", status: true,
    langcode: "en", created: null, changed: null, url: "/t",
    fields: { moderation_state: "published" }, relationships: {}, _backend: "jsonapi",
  };

  it("injects paragraph revision meta and does not PATCH when a ref 404s", async () => {
    backend.getEntity.mockImplementation(async ({ entityType, id }) => {
      if (entityType === "paragraph") {
        return id === "p-ok"
          ? { id, entityType: "paragraph", bundle: "text", fields: { drupal_internal__revision_id: 5 } }
          : null;
      }
      return publishedModerated;
    });
    await expect(handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id: "11111111-1111-4111-8111-111111111111",
      relationships: {
        field_cards: { data: [
          { type: "paragraph--text", id: "p-ok" },
          { type: "paragraph--text", id: "p-missing" },
        ] },
      },
    })).rejects.toThrow(/p-missing/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("probe 400 skips the real updateEntity; dryRun fails too", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        return { ...publishedModerated, fields: { ...publishedModerated.fields, drupal_internal__vid: 2070 } };
      }
      return publishedModerated;
    });
    backend.rawQuery.mockRejectedValue(WC_400);
    await expect(handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id: "11111111-1111-4111-8111-111111111111",
      attributes: { title: "T" },
    })).rejects.toThrow(/stale or concurrent|#166/);
    expect(backend.updateEntity).not.toHaveBeenCalled();

    await expect(handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id: "11111111-1111-4111-8111-111111111111",
      attributes: { title: "T" }, dryRun: true,
    })).rejects.toThrow(/stale or concurrent|#166/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("entity_create for a paragraph GETs the vid and fails if still missing", async () => {
    backend.createEntity.mockResolvedValue({
      ...ent, fields: { field_body: "x", drupal_internal__revision_id: undefined },
    });
    backend.getEntity.mockResolvedValue({
      ...ent, fields: { field_body: "x", drupal_internal__revision_id: 8 },
    });
    const out = await handlers.drupal_entity_create({
      entityType: "paragraph", bundle: "text", attributes: { field_body: "x" },
    });
    expect(out.relationshipData).toEqual({
      type: "paragraph--text", id: "p1", meta: { target_revision_id: 8 },
    });

    backend.createEntity.mockResolvedValue({
      ...ent, fields: { field_body: "x", drupal_internal__revision_id: undefined },
    });
    backend.getEntity.mockResolvedValue({ ...ent, fields: { field_body: "x" } });
    await expect(handlers.drupal_entity_create({
      entityType: "paragraph", bundle: "text", attributes: { field_body: "x" },
    })).rejects.toThrow(/revision_id/);
  });

  it("entity_get for paragraph keeps drupal_internal__revision_id", async () => {
    backend.getEntity.mockResolvedValue({
      ...ent, fields: { ...ent.fields, drupal_internal__revision_id: 4 },
    });
    const out = await handlers.drupal_entity_get({ entityType: "paragraph", bundle: "text", id: "p1" });
    expect(out.fields.drupal_internal__revision_id).toBe(4);
  });
});

describe("#166 entity_update targets an addressable working copy", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const live = {
    id, entityType: "node", bundle: "article", title: "T", status: true,
    langcode: "en", created: null, changed: null, url: "/t",
    fields: { moderation_state: "published", drupal_internal__vid: 1500 },
    relationships: {}, _backend: "jsonapi",
  };
  const draft = {
    ...live, status: false,
    fields: { moderation_state: "draft", drupal_internal__vid: 1510 },
  };

  it("PATCHes rel:working-copy and returns distinct live/working vids", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? draft : live
    ));
    backend.updateEntity.mockResolvedValue(draft);
    const out = await handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id, attributes: { title: "CTA" },
    });
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.updateEntity.mock.calls[0][0].resourceVersion).toBe("rel:working-copy");
    expect(out._revisions).toEqual({ live: 1500, working: 1510 });
  });
});
