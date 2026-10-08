import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(),
  deleteEntity: vi.fn(), listResourceTypes: vi.fn(), getEntitySchema: vi.fn(),
  rawQuery: vi.fn(),
  toCanonical: vi.fn(),
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
  backend.rawQuery.mockImplementation(async ({ path }) => {
    const text = String(path);
    if (/\/jsonapi\/(?:paragraphs_library_item|block_content)\//.test(text)
      && text.endsWith("/mcp-translations")) {
      throw new Error("Drupal 404 inventory unavailable");
    }
    throw new Error(
      "Drupal 400 on PATCH /jsonapi/node/article/n1: The selected entity (n1) " +
      "does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
    );
  });
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
  backend.toCanonical.mockImplementation(x => x);
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
    expect(out.checks).toMatchObject({ serverPreflight: "none", fieldAccess: "not_checked", entityValidation: "not_checked" });
    expect(out.caveat).toMatch(/NOT checked/);
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

  it("entity_create on a Paragraphs Library item: drafts pass, publish is refused on write-plane", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await expect(
      handlers.drupal_entity_create({
        entityType: "paragraphs_library_item", bundle: "paragraphs_library_item",
        attributes: { label: "CTA", moderation_state: "published" },
      })
    ).rejects.toThrow(/allowPublish/);
    expect(backend.createEntity).not.toHaveBeenCalled();

    getSiteConfig.mockReturnValueOnce(noPublishSite);
    backend.createEntity.mockResolvedValue({ ...ent, entityType: "paragraphs_library_item", bundle: "paragraphs_library_item" });
    await handlers.drupal_entity_create({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item",
      attributes: { label: "CTA", moderation_state: "draft" },
    });
    expect(backend.createEntity).toHaveBeenCalledTimes(1);
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
    expect(out.checks).toMatchObject({ serverPreflight: "none", entityAccess: "not_checked" });
    expect(backend.deleteEntity).not.toHaveBeenCalled();
  });

  it("entity_get returns a node's canonical entity with its numeric id", async () => {
    backend.getEntity.mockResolvedValue({
      ...ent,
      entityType: "node",
      bundle: "article",
      fields: { drupal_internal__nid: 42 },
    });
    const out = await handlers.drupal_entity_get({ entityType: "node", bundle: "article", id: "p1" });
    expect(out.id).toBe("p1");
    expect(out.fields.drupal_internal__nid).toBe(42);
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

  it("PATCHes the governed draft endpoint and returns distinct live/working vids", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? draft : live
    ));
    backend.updateEntity.mockResolvedValue(draft);
    backend.rawQuery.mockResolvedValueOnce({ meta: { draft_preflight: true, live: 1500, working: 1510 } })
      .mockResolvedValueOnce({ data: { ...draft, type: "node--article" } });
    const out = await handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id, attributes: { title: "CTA" },
    });
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery.mock.calls[1][0].path).toContain("/mcp-draft");
    expect(out._revisions).toEqual({ live: 1500, working: 1510 });
  });

  // #336: the three preflight outcomes, through the generic entity tool.
  it("entity_update dryRun on an existing draft reports the fields as checked", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? draft : live
    ));
    backend.rawQuery.mockResolvedValueOnce({ meta: { draft_preflight: true, live: 1500, working: 1510 } });
    const out = await handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id, attributes: { title: "CTA" }, dryRun: true,
    });
    const sent = JSON.parse(backend.rawQuery.mock.calls[0][0].options.body);
    expect(sent.data.attributes.title).toBe("CTA");
    expect(out.checks).toMatchObject({ serverPreflight: "sentinel_draft", fieldAccess: "checked", entityValidation: "checked" });
    expect(out).not.toHaveProperty("caveat");
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("entity_update dryRun on a moderated target with no draft says the fields were not evaluated", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? null : live
    ));
    backend.rawQuery.mockImplementation(async ({ path }) => {
      if (String(path).endsWith("/mcp-translations")) throw new Error("Drupal 404 inventory unavailable");
      throw new Error(`Drupal 400 on PATCH ${path}: The selected entity does not match the ID in the payload (probe).`);
    });
    const out = await handlers.drupal_entity_update({
      entityType: "node", bundle: "article", id, attributes: { title: "CTA", field_restricted: "x" }, dryRun: true,
    });
    const probe = backend.rawQuery.mock.calls.map(([q]) => q).find((q) => q.options?.method === "PATCH");
    expect(JSON.parse(probe.options.body).data).not.toHaveProperty("attributes");
    expect(out.checks).toMatchObject({
      serverPreflight: "core_patch_guard", entityAccess: "checked", revisionGuard: "checked",
      fieldAccess: "not_checked", entityValidation: "not_checked",
    });
    expect(out.caveat).toMatch(/field access/i);
    expect(out).not.toHaveProperty("writable");
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("entity_update dryRun on an unmoderated target says no server-side check ran", async () => {
    backend.getEntity.mockResolvedValue({
      id, entityType: "taxonomy_term", bundle: "tags", title: null, status: true,
      fields: { name: "Tag" }, relationships: {}, _backend: "jsonapi",
    });
    const out = await handlers.drupal_entity_update({
      entityType: "taxonomy_term", bundle: "tags", id, attributes: { name: "Renamed" }, dryRun: true,
    });
    expect(out.checks).toMatchObject({ serverPreflight: "none", entityAccess: "not_checked", fieldAccess: "not_checked" });
    expect(out.caveat).toMatch(/NOT checked/);
    expect(backend.rawQuery).not.toHaveBeenCalled();
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });
});

describe("reusable library revision identity (#420)", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const library = (revisionId, status, pins) => ({
    id,
    entityType: "paragraphs_library_item",
    bundle: "paragraphs_library_item",
    status,
    title: "Reusable",
    fields: {
      moderation_state: status ? "published" : "draft",
      drupal_internal__revision_id: revisionId,
      label: "Reusable",
    },
    relationships: {
      paragraphs: pins.map((pin) => ({
        id: pin.id,
        entityType: "paragraph",
        bundle: "p_text_block",
        meta: { target_revision_id: pin.revisionId },
      })),
    },
  });
  const publishedPins = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revisionId: 10 }];
  const draftPins = [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionId: 30 }];

  function versionedLibrary({ afterWorking, afterLive } = {}) {
    let written = false;
    backend.getEntity.mockImplementation(async ({ entityType, resourceVersion }) => {
      if (entityType === "paragraph") {
        return {
          id: draftPins[0].id, entityType: "paragraph", bundle: "p_text_block",
          fields: { drupal_internal__revision_id: 30 },
        };
      }
      const live = afterLive && written ? afterLive : library(20, true, publishedPins);
      if (resourceVersion === "rel:working-copy") {
        if (written && afterWorking) return afterWorking;
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return live;
    });
    backend.updateEntity.mockImplementation(async () => {
      written = true;
      return { id, entityType: "paragraphs_library_item", bundle: "paragraphs_library_item" };
    });
    return () => { written = true; };
  }

  it("opens one draft from an echoed published item and re-reads the pins", async () => {
    versionedLibrary({ afterWorking: library(21, false, draftPins) });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: { paragraphs: { data: [{ type: "paragraph--p_text_block", id: draftPins[0].id }] } },
    });
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    expect(backend.updateEntity.mock.calls[0][0].attributes.moderation_state).toBe("draft");
    expect(backend.rawQuery.mock.calls.some(([call]) => String(call.path).includes("mcp-draft"))).toBe(false);
    expect(out._revisions).toEqual({ live: 20, working: 21 });
    expect(out.fields.drupal_internal__revision_id).toBe(21);
    expect(out._revision.source).toBe("working-copy");

    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Again" },
    })).rejects.toThrow(/no governed continuation endpoint/);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the published pin changes", async () => {
    versionedLibrary({
      afterLive: library(20, true, draftPins),
      afterWorking: library(21, false, draftPins),
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/published paragraph pins changed/);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
  });

  it("rejects a forward revision whose paragraph order does not match the request", async () => {
    const pinA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revisionId: 30 };
    const pinB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revisionId: 31 };
    let written = false;
    backend.getEntity.mockImplementation(async ({ entityType, id: entityId, resourceVersion }) => {
      if (entityType === "paragraph") {
        const pin = entityId === pinB.id ? pinB : pinA;
        return {
          id: pin.id, entityType: "paragraph", bundle: "p_text_block",
          fields: { drupal_internal__revision_id: pin.revisionId },
        };
      }
      if (resourceVersion === "rel:working-copy") {
        if (written) return library(21, false, [pinB, pinA]);
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.updateEntity.mockImplementation(async () => {
      written = true;
      return { id, entityType: "paragraphs_library_item", bundle: "paragraphs_library_item" };
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: {
        paragraphs: {
          data: [
            { type: "paragraph--p_text_block", id: pinA.id },
            { type: "paragraph--p_text_block", id: pinB.id },
          ],
        },
      },
    })).rejects.toThrow(/does not pin the submitted paragraphs/);
  });

  it("accepts the later paragraph revision saved with the new library draft", async () => {
    const paragraphId = draftPins[0].id;
    versionedLibrary({
      afterWorking: library(21, false, [{ id: paragraphId, revisionId: 31 }]),
    });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: { paragraphs: { data: [{ type: "paragraph--p_text_block", id: paragraphId }] } },
    });
    expect(out._revisions).toEqual({ live: 20, working: 21 });
    expect(out.fields.drupal_internal__revision_id).toBe(21);
  });

  it("rejects a draft that pins an older revision of the submitted paragraph", async () => {
    const paragraphId = draftPins[0].id;
    let written = false;
    backend.getEntity.mockImplementation(async ({ entityType, resourceVersion }) => {
      if (entityType === "paragraph") {
        return {
          id: paragraphId, entityType: "paragraph", bundle: "p_text_block",
          fields: { drupal_internal__revision_id: 31 },
        };
      }
      if (resourceVersion === "rel:working-copy") {
        if (written) return library(21, false, [{ id: paragraphId, revisionId: 30 }]);
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.updateEntity.mockImplementation(async () => {
      written = true;
      return { id, entityType: "paragraphs_library_item", bundle: "paragraphs_library_item" };
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: { paragraphs: { data: [{ type: "paragraph--p_text_block", id: paragraphId }] } },
    })).rejects.toThrow(/does not pin the submitted paragraphs/);
  });

  it("accepts that later revision on the advertised library draft", async () => {
    const paragraphId = draftPins[0].id;
    let written = false;
    backend.getEntity.mockImplementation(async ({ entityType, resourceVersion }) => {
      if (entityType === "paragraph") {
        return {
          id: paragraphId, entityType: "paragraph", bundle: "p_text_block",
          fields: { drupal_internal__revision_id: 30 },
        };
      }
      if (resourceVersion === "rel:working-copy") {
        if (written) return library(21, false, [{ id: paragraphId, revisionId: 31 }]);
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.rawQuery.mockImplementation(async ({ path, options }) => {
      const text = String(path);
      if (text.endsWith("/mcp-translations")) {
        return {
          meta: {
            defaultLangcode: "en",
            live: { vid: "20" },
            operations: ["open_draft"],
          },
        };
      }
      if (text.endsWith("/mcp-draft")) {
        if (options?.headers?.["X-MCP-Draft-Preflight"] === "1") {
          return { meta: { draft_preflight: true, live: "20", working: "", operation: "open_draft" } };
        }
        written = true;
        return { data: { type: "paragraphs_library_item--paragraphs_library_item", id } };
      }
      throw new Error(`unexpected query ${text}`);
    });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: { paragraphs: { data: [{ type: "paragraph--p_text_block", id: paragraphId }] } },
    });
    expect(out._revisions).toEqual({ live: 20, working: 21 });
    const drafts = backend.rawQuery.mock.calls.filter(([call]) => String(call.path).endsWith("/mcp-draft"));
    expect(drafts.map(([call]) => call.options.headers["X-MCP-Draft-Preflight"])).toEqual(["1", "0"]);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("returns a Drupal 422 when the re-read matches the published revision", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.updateEntity.mockRejectedValue(new Error(
      "Drupal 422 on PATCH /jsonapi/paragraphs_library_item/paragraphs_library_item/x: cannot be referenced"
    ));
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/Drupal 422[\s\S]*Re-read matched the published revision/);
  });

  it("does not trust a 422 when a forward revision appeared", async () => {
    let landed = false;
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        if (landed) return library(21, false, publishedPins);
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.updateEntity.mockImplementation(async () => {
      landed = true;
      throw new Error("Drupal 422 on PATCH /jsonapi/x: validation failed");
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/uncertain[\s\S]*Drupal 422[\s\S]*forward revision is present/);
  });

  it("does not report success when no forward revision appears", async () => {
    versionedLibrary();
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/no forward revision was verified/);
  });

  it("reports a lost response from the re-read and does not call it a rollback", async () => {
    let landed = false;
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        if (landed) return library(21, false, publishedPins);
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.updateEntity.mockImplementation(async () => {
      landed = true;
      throw new Error("socket hang up");
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/uncertain[\s\S]*socket hang up[\s\S]*forward revision is present/);
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Again" },
    })).rejects.toThrow(/no governed continuation endpoint/);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
  });

  it("refuses a denied working-copy read before the probe or the write", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403 on GET /jsonapi/paragraphs_library_item/paragraphs_library_item/x");
      }
      return library(20, true, publishedPins);
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" }, dryRun: true,
    })).rejects.toThrow(/was denied/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("dry-runs an echoed library item on the core probe and does not call the draft endpoint", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy" || resourceVersion === "rel:latest-version") {
        return library(20, true, publishedPins);
      }
      return library(20, true, publishedPins);
    });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" }, dryRun: true,
    });
    expect(out.checks.serverPreflight).toBe("core_patch_guard");
    expect(out.checks.fieldAccess).toBe("not_checked");
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery.mock.calls.some(([call]) => String(call.path).includes("mcp-draft"))).toBe(false);
  });

  it("updates a never-published library item without requiring a new forward revision", async () => {
    let written = false;
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      const revisionId = written ? 6 : 5;
      return library(revisionId, false, publishedPins);
    });
    backend.updateEntity.mockImplementation(async () => {
      written = true;
      return { id, entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", status: false };
    });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Still draft" },
    });
    expect(out.id).toBe(id);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    expect(out._revisions).toBeUndefined();
  });

  /**
   * @param {{continuation?: boolean}} [options]
   */
  function installAdvertisedLibrary({ continuation = false } = {}) {
    let saved = false;
    const published = library(20, true, publishedPins);
    const beforeWorking = library(21, false, draftPins);
    const afterWorking = library(continuation ? 22 : 21, false, draftPins);
    backend.getEntity.mockImplementation(async ({ entityType, resourceVersion }) => {
      if (entityType === "paragraph") {
        return {
          id: draftPins[0].id, entityType: "paragraph", bundle: "p_text_block",
          fields: { drupal_internal__revision_id: 30 },
        };
      }
      if (resourceVersion === "rel:working-copy") {
        if (continuation) return saved ? afterWorking : beforeWorking;
        if (!saved) throw new Error("Drupal 403: No pending revision for moderated entity.");
        return afterWorking;
      }
      return published;
    });
    backend.rawQuery.mockImplementation(async ({ path, options }) => {
      const text = String(path);
      if (text.endsWith("/mcp-translations")) {
        return {
          meta: {
            defaultLangcode: "en",
            operations: ["open_draft"],
            live: { vid: "20" },
            working: continuation ? {
              vid: "21",
              translations: [{ langcode: "en", status: false, moderation_state: "draft" }],
            } : null,
          },
        };
      }
      if (!text.endsWith("/mcp-draft")) throw new Error(`unexpected ${text}`);
      if (options?.headers?.["X-MCP-Draft-Preflight"] === "0") saved = true;
      if (options?.headers?.["X-MCP-Draft-Preflight"] === "1") {
        return {
          meta: {
            draft_preflight: true,
            live: "20",
            working: continuation ? "21" : "",
            operation: continuation ? null : "open_draft",
          },
        };
      }
      return { data: { id, type: "paragraphs_library_item--paragraphs_library_item" } };
    });
  }

  function draftCalls() {
    return backend.rawQuery.mock.calls.map(([call]) => call).filter((call) => call.path.endsWith("/mcp-draft"));
  }

  it("opens an advertised library draft through /mcp-draft and leaves the canonical update unused", async () => {
    installAdvertisedLibrary();
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
      relationships: { paragraphs: { data: [{ type: "paragraph--p_text_block", id: draftPins[0].id }] } },
    });
    const drafts = draftCalls();
    expect(drafts).toHaveLength(2);
    expect(drafts[0].options.headers["X-MCP-Draft-Preflight"]).toBe("1");
    expect(drafts[1].options.headers["X-MCP-Draft-Preflight"]).toBe("0");
    expect(drafts[0].options.headers["If-Match"]).toBe('"20"');
    expect(drafts[1].options.headers["If-Match"]).toBe('"20"');
    for (const call of drafts) {
      const body = JSON.parse(call.options.body);
      expect(body.meta).toBeUndefined();
      expect(body.data.attributes.moderation_state).toBe("draft");
    }
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(out._revisions).toEqual({ live: 20, working: 21 });
    expect(out.fields.drupal_internal__revision_id).toBe(21);
  });

  it("continues an advertised library draft and compares forward pins with the working copy", async () => {
    installAdvertisedLibrary({ continuation: true });
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    });
    const drafts = draftCalls();
    expect(drafts).toHaveLength(2);
    expect(drafts[0].options.headers["If-Match"]).toBe('"20:21"');
    expect(drafts[1].options.headers["If-Match"]).toBe('"20:21"');
    expect(JSON.parse(drafts[1].options.body).meta).toBeUndefined();
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(out._revisions).toEqual({ live: 20, working: 22 });
    expect(out.relationships.paragraphs[0].id).toBe(draftPins[0].id);
    expect(out.relationships.paragraphs[0].meta.target_revision_id).toBe(30);
  });

  it("refuses a denied library inventory before any draft write", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => {
      if (resourceVersion === "rel:working-copy") {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }
      return library(20, true, publishedPins);
    });
    backend.rawQuery.mockImplementation(async ({ path }) => {
      if (String(path).endsWith("/mcp-translations")) {
        throw new Error("Drupal 403 on GET /jsonapi/paragraphs_library_item/paragraphs_library_item/x/mcp-translations");
      }
      throw new Error(`unexpected ${path}`);
    });
    await expect(handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" },
    })).rejects.toThrow(/reading the draft inventory was denied/);
    expect(draftCalls()).toHaveLength(0);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("dry-runs an advertised library draft on the real /mcp-draft preflight", async () => {
    installAdvertisedLibrary();
    const out = await handlers.drupal_entity_update({
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id,
      attributes: { label: "Reusable" }, dryRun: true,
    });
    const drafts = draftCalls();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].options.headers["X-MCP-Draft-Preflight"]).toBe("1");
    expect(drafts[0].options.headers["If-Match"]).toBe('"20"');
    expect(out.checks.serverPreflight).toBe("sentinel_draft");
    expect(out.checks.fieldAccess).toBe("checked");
    expect(out).not.toHaveProperty("caveat");
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });
});

describe("Paragraphs Library items default to unpublished on a no-publish tier", () => {
  const item = { entityType: "paragraphs_library_item", bundle: "paragraphs_library_item" };

  beforeEach(() => {
    backend.createEntity.mockResolvedValue({ ...ent, ...item });
  });

  it("sends status:false when the caller says nothing about publication", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await handlers.drupal_entity_create({ ...item, attributes: { label: "CTA" } });
    expect(backend.createEntity.mock.calls[0][0].attributes).toEqual({ label: "CTA", status: false });
  });

  it("leaves a moderation_state draft to the workflow", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await handlers.drupal_entity_create({ ...item, attributes: { label: "CTA", moderation_state: "draft" } });
    expect(backend.createEntity.mock.calls[0][0].attributes).toEqual({ label: "CTA", moderation_state: "draft" });
  });

  it("refuses status:true before any write", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await expect(
      handlers.drupal_entity_create({ ...item, attributes: { label: "CTA", status: true } })
    ).rejects.toThrow(/allowPublish/);
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("does not change other types or a tier that may publish", async () => {
    getSiteConfig.mockReturnValueOnce(noPublishSite);
    await handlers.drupal_entity_create({ entityType: "taxonomy_term", bundle: "tags", attributes: { name: "T" } });
    expect(backend.createEntity.mock.calls[0][0].attributes).toEqual({ name: "T" });
    await handlers.drupal_entity_create({ ...item, attributes: { label: "CTA" } });
    expect(backend.createEntity.mock.calls[1][0].attributes).toEqual({ label: "CTA" });
  });
});
