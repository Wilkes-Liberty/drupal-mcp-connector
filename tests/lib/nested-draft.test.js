import { describe, it, expect, vi } from "vitest";
import { draftNestedComponents, NESTED_DRAFT_PARTIAL_CODE } from "../../src/lib/nested-draft.js";

const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHILD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHILD_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SIBLING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEW_CHILD = "f1111111-1111-4111-8111-111111111111";
const NEW_PARENT = "f2222222-2222-4222-8222-222222222222";

const preflightOpen = { meta: { draft_preflight: true, live: "10", working: "", operation: "open_draft" } };
const written = { data: { id: NODE, type: "node--page" } };

/**
 * @param {string} id
 * @param {string} bundle
 * @param {number} revisionId
 * @returns {object}
 */
function pin(id, bundle, revisionId) {
  return { id, type: `paragraph--${bundle}`, meta: { target_revision_id: revisionId } };
}

const publishedPins = [
  pin(PARENT, "p_faq_group", 50),
  pin(SIBLING, "p_text_block", 60),
];

/**
 * @param {number} vid
 * @param {object[]} pins
 * @returns {object}
 */
function host(vid, pins) {
  return {
    id: NODE,
    entityType: "node",
    bundle: "page",
    fields: { drupal_internal__vid: vid },
    relationships: { field_components: pins },
  };
}

/**
 * @param {object} [fields]
 * @returns {object}
 */
function parentEntity(fields = {}) {
  return {
    id: PARENT,
    entityType: "paragraph",
    bundle: "p_faq_group",
    fields: { drupal_internal__revision_id: 50, field_title: "Questions", ...fields },
    relationships: {
      field_items: [
        pin(CHILD_A, "p_faq_item", 70),
        pin(CHILD_B, "p_faq_item", 71),
      ],
    },
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function nodeInventory(overrides = {}) {
  return {
    defaultLangcode: "en",
    live: { vid: "10", translations: [{ langcode: "en", status: true, moderation_state: "published", default: true }] },
    working: null,
    operations: ["open_draft", "create_translation"],
    ...overrides,
  };
}

const replaceChild = {
  op: "replace",
  id: CHILD_A,
  type: "p_faq_item",
  attributes: { field_title: "New question" },
};

const input = {
  entityType: "node",
  bundle: "page",
  id: NODE,
  field: "field_components",
  parentId: PARENT,
  childField: "field_items",
  children: [replaceChild, { op: "keep", id: CHILD_B }],
};

/**
 * @param {object} [options]
 * @returns {object}
 */
function backend(options = {}) {
  const createdIds = [...(options.createdIds ?? [NEW_CHILD, NEW_PARENT])];
  const draftResponses = [...(options.draftResponses ?? [preflightOpen, written])];
  const paragraphInventory = options.paragraphInventory ?? {
    live: { vid: "50", translations: [{ langcode: "en", status: true, default: true }] },
  };
  let createdCount = 0;
  let confirmArmed = false;
  const b = {
    updateEntity: vi.fn(async () => {
      throw new Error("updateEntity must not run");
    }),
    createEntity: vi.fn(async ({ bundle, attributes, relationships }) => {
      const id = createdIds[createdCount] ?? `created-${createdCount}`;
      createdCount += 1;
      return {
        id,
        bundle,
        entityType: "paragraph",
        attributes,
        relationships,
        fields: { drupal_internal__revision_id: 100 + createdCount, ...(attributes ?? {}) },
      };
    }),
    resourcePath: (entityType, bundle) => `/jsonapi/${entityType}/${bundle}`,
    toCanonical: (data) => data,
    getEntity: vi.fn(async ({ entityType, id, resourceVersion, langcode }) => {
      if (confirmArmed && options.failConfirm && resourceVersion === "rel:working-copy") {
        throw new Error("re-read failed");
      }
      if (entityType === "paragraph") {
        if (langcode) {
          return options.translatedParent ?? { id: PARENT, fields: { field_title: "Preguntas" } };
        }
        if (id === PARENT) return options.parent ?? parentEntity();
        return options.extraParagraphs?.[id] ?? null;
      }
      if (resourceVersion === "rel:working-copy") return options.afterWorking ?? host(12, publishedPins);
      if (resourceVersion === "id:11") return options.workingHost ?? host(11, publishedPins);
      return options.published ?? host(10, publishedPins);
    }),
    rawQuery: vi.fn(async ({ path, options: queryOptions }) => {
      if (path.includes("/paragraph/") && path.endsWith("/mcp-translations")) {
        if (options.paragraphInventoryError) throw options.paragraphInventoryError;
        return { meta: paragraphInventory };
      }
      if (path.endsWith("/mcp-translations")) return { meta: options.nodeInventory ?? nodeInventory() };
      if (path.endsWith("/mcp-draft/translations")) {
        const parts = path.split("/");
        return { data: { id: parts.at(-3), type: `paragraph--${parts.at(-4)}` } };
      }
      if (path.endsWith("/mcp-draft")) {
        if (queryOptions?.headers?.["X-MCP-Draft-Preflight"] === "0") confirmArmed = true;
        const next = draftResponses.shift();
        if (!next) throw new Error("unexpected draft request");
        if (next instanceof Error) throw next;
        return next;
      }
      throw new Error(`unexpected ${path}`);
    }),
  };
  return b;
}

/**
 * @param {object} b
 * @param {string} suffix
 * @returns {object[]}
 */
function callsEnding(b, suffix) {
  return b.rawQuery.mock.calls.map(([call]) => call).filter((call) => call.path.endsWith(suffix));
}

const landedPins = [
  pin(NEW_PARENT, "p_faq_group", 102),
  pin(SIBLING, "p_text_block", 60),
];

describe("draftNestedComponents", () => {
  it("creates a new child and parent and pins only the host draft", async () => {
    const b = backend({ afterWorking: host(12, landedPins) });
    const result = await draftNestedComponents(b, input);
    expect(b.updateEntity).not.toHaveBeenCalled();
    expect(b.createEntity).toHaveBeenCalledTimes(2);
    const [childCall, parentCall] = b.createEntity.mock.calls.map(([call]) => call);
    expect(childCall).toMatchObject({ entityType: "paragraph", bundle: "p_faq_item" });
    expect(childCall.relationships).toBeUndefined();
    expect(parentCall.bundle).toBe("p_faq_group");
    expect(parentCall.attributes.field_title).toBe("Questions");
    expect(parentCall.relationships.field_items.data.map((ref) => ref.id)).toEqual([NEW_CHILD, CHILD_B]);
    expect(parentCall.relationships.field_items.data[1].meta.target_revision_id).toBe(71);
    const drafts = callsEnding(b, "/mcp-draft").filter((call) => !call.path.endsWith("/translations"));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].options.headers["If-Match"]).toBe('"10"');
    expect(drafts[1].options.headers["X-MCP-Draft-Preflight"]).toBe("0");
    const body = JSON.parse(drafts[1].options.body);
    expect(body.meta).toBeUndefined();
    expect(body.data.attributes).toEqual({ moderation_state: "draft" });
    expect(body.data.relationships.field_components.data.map((ref) => ref.id)).toEqual([NEW_PARENT, SIBLING]);
    expect(body.data.relationships.field_components.data[1].meta.target_revision_id).toBe(60);
    expect(result.publishedParentId).toBe(PARENT);
    expect(result.draftParentId).toBe(NEW_PARENT);
    expect(result.publishedPinsUnchanged).toBe(true);
    expect(result.prepared.map((row) => row.id)).toEqual([NEW_CHILD, NEW_PARENT]);
  });

  it("omits a child from the draft parent and can reorder the ones that stay", async () => {
    const b = backend({
      afterWorking: host(12, landedPins),
      createdIds: [NEW_PARENT],
    });
    await draftNestedComponents(b, {
      ...input,
      children: [{ op: "keep", id: CHILD_B }, { op: "keep", id: CHILD_A }],
    });
    const parentCall = b.createEntity.mock.calls[0][0];
    expect(parentCall.relationships.field_items.data.map((ref) => ref.id)).toEqual([CHILD_B, CHILD_A]);
    expect(b.createEntity).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing translation before creating paragraphs", async () => {
    const b = backend({
      paragraphInventory: {
        live: { vid: "50", translations: [
          { langcode: "en", status: true, default: true },
          { langcode: "es", status: true },
        ] },
      },
    });
    await expect(draftNestedComponents(b, input)).rejects.toThrow(/es translation/);
    expect(b.createEntity).not.toHaveBeenCalled();
    expect(callsEnding(b, "/mcp-draft")).toHaveLength(0);
  });

  it("creates supplied translations and copies the parent's other language", async () => {
    const b = backend({
      afterWorking: host(12, landedPins),
      paragraphInventory: {
        live: { vid: "50", translations: [
          { langcode: "en", status: true, default: true },
          { langcode: "es", status: true },
        ] },
      },
    });
    await draftNestedComponents(b, {
      ...input,
      children: [{
        ...replaceChild,
        translations: [{ langcode: "es", attributes: { field_title: "Nueva pregunta" } }],
      }, { op: "keep", id: CHILD_B }],
    });
    const translationCalls = callsEnding(b, "/mcp-draft/translations");
    expect(translationCalls.map((call) => call.path)).toEqual([
      `/jsonapi/paragraph/p_faq_item/${NEW_CHILD}/mcp-draft/translations`,
      `/jsonapi/paragraph/p_faq_group/${NEW_PARENT}/mcp-draft/translations`,
    ]);
    expect(JSON.parse(translationCalls[0].options.body).data.attributes.field_title).toBe("Nueva pregunta");
    expect(JSON.parse(translationCalls[1].options.body).data.attributes.field_title).toBe("Preguntas");
    expect(translationCalls[0].options.headers["If-Match"]).toBe('"101"');
    expect(translationCalls[1].options.headers["If-Match"]).toBe('"102"');
  });

  it("does not require the default language as an extra translation", async () => {
    const b = backend({
      afterWorking: host(12, landedPins),
      nodeInventory: nodeInventory({ defaultLangcode: "es" }),
      paragraphInventory: {
        live: { vid: "50", translations: [{ langcode: "es", status: true, default: true }] },
      },
    });
    await draftNestedComponents(b, input);
    expect(callsEnding(b, "/mcp-draft/translations")).toHaveLength(0);
  });

  it("treats a missing paragraph translation endpoint as no extra languages", async () => {
    const b = backend({
      afterWorking: host(12, landedPins),
      paragraphInventoryError: Object.assign(new Error("Drupal 404"), { status: 404 }),
    });
    await draftNestedComponents(b, input);
    expect(callsEnding(b, "/mcp-draft/translations")).toHaveLength(0);
    expect(b.createEntity).toHaveBeenCalledTimes(2);
  });

  it("refuses a reusable child before creating paragraphs", async () => {
    const library = "99999999-9999-4999-8999-999999999999";
    const b = backend({
      parent: {
        ...parentEntity(),
        relationships: {
          field_items: [
            pin(CHILD_A, "p_faq_item", 70),
            { id: library, type: "paragraph--from_library", meta: { target_revision_id: 3 } },
          ],
        },
      },
    });
    await expect(draftNestedComponents(b, input)).rejects.toThrow(/drupal_entity_update/);
    expect(b.createEntity).not.toHaveBeenCalled();
  });

  it("refuses a stale live revision and a denied paragraph read before creating", async () => {
    const stale = backend();
    await expect(draftNestedComponents(stale, { ...input, liveRevisionId: "9" })).rejects.toThrow(/stale/);
    expect(stale.createEntity).not.toHaveBeenCalled();

    const denied = backend();
    denied.getEntity.mockImplementation(async ({ entityType }) => {
      if (entityType === "paragraph") {
        throw Object.assign(new Error("Drupal 403"), { status: 403 });
      }
      return host(10, publishedPins);
    });
    await expect(draftNestedComponents(denied, input)).rejects.toThrow(/Reading a nested component was denied/);
    expect(denied.createEntity).not.toHaveBeenCalled();
  });

  it("refuses opening the first draft when Sentinel has no open_draft", async () => {
    const b = backend({ nodeInventory: nodeInventory({ operations: ["create_translation"] }) });
    await expect(draftNestedComponents(b, input)).rejects.toThrow(/open_draft.*2\.29\.0/s);
    expect(b.createEntity).not.toHaveBeenCalled();
    expect(b.getEntity).not.toHaveBeenCalled();
  });

  it("does not create paragraphs or evaluate the host payload on dryRun", async () => {
    const b = backend();
    const result = await draftNestedComponents(b, input, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.hostPayloadEvaluated).toBe(false);
    expect(result.checks.serverPreflight).toBe("none");
    expect(b.createEntity).not.toHaveBeenCalled();
    expect(callsEnding(b, "/mcp-draft")).toHaveLength(0);
  });

  it("reports prepared paragraphs when the host write fails and the pins are unchanged", async () => {
    const b = backend({
      draftResponses: [preflightOpen, new Error("socket hang up")],
      afterWorking: host(10, publishedPins),
    });
    const error = await draftNestedComponents(b, input).catch((err) => err);
    expect(error.code).toBe(NESTED_DRAFT_PARTIAL_CODE);
    expect(error.prepared.map((row) => row.id)).toEqual([NEW_CHILD, NEW_PARENT]);
    expect(error.message).toMatch(/socket hang up/);
    expect(error.message).toMatch(/resumeParentId/);
    expect(error.uncertain).toBeUndefined();
  });

  it("returns success when a lost host response re-reads as the new pin", async () => {
    const b = backend({
      draftResponses: [preflightOpen, new Error("socket hang up")],
      afterWorking: host(12, landedPins),
    });
    const result = await draftNestedComponents(b, input);
    expect(result.draftParentId).toBe(NEW_PARENT);
    expect(result._revisions).toEqual({ live: "10", working: "12" });
  });

  it("stays uncertain when the follow-up read fails", async () => {
    const b = backend({
      draftResponses: [preflightOpen, { data: {} }],
      failConfirm: true,
    });
    await expect(draftNestedComponents(b, input)).rejects.toThrow(/outcome is uncertain/);
  });

  it("refuses a second edit once the forward draft no longer pins the published component", async () => {
    const b = backend({
      nodeInventory: nodeInventory({
        working: { vid: "11", translations: [{ langcode: "en", status: false, moderation_state: "draft", default: true }] },
      }),
      workingHost: host(11, landedPins),
    });
    await expect(draftNestedComponents(b, input)).rejects.toThrow(/forward draft already replaces/);
    expect(b.createEntity).not.toHaveBeenCalled();
  });

  it("retries only the host pin with resumeParentId", async () => {
    const b = backend({
      nodeInventory: nodeInventory({
        working: { vid: "11", translations: [{ langcode: "en", status: false, moderation_state: "draft", default: true }] },
      }),
      workingHost: host(11, publishedPins),
      afterWorking: host(12, landedPins),
      draftResponses: [
        { meta: { draft_preflight: true, live: "10", working: "11" } },
        written,
      ],
      extraParagraphs: {
        [NEW_PARENT]: {
          id: NEW_PARENT,
          bundle: "p_faq_group",
          fields: { drupal_internal__revision_id: 102 },
        },
      },
    });
    const result = await draftNestedComponents(b, { ...input, resumeParentId: NEW_PARENT });
    expect(b.createEntity).not.toHaveBeenCalled();
    const drafts = callsEnding(b, "/mcp-draft").filter((call) => !call.path.endsWith("/translations"));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].options.headers["If-Match"]).toBe('"10:11"');
    expect(result.draftParentId).toBe(NEW_PARENT);
  });

  it("does not patch again when the working copy already pins the prepared parent", async () => {
    const b = backend({
      nodeInventory: nodeInventory({
        working: { vid: "11", translations: [{ langcode: "en", status: false, moderation_state: "draft", default: true }] },
      }),
      workingHost: host(11, landedPins),
      afterWorking: host(12, landedPins),
      extraParagraphs: {
        [NEW_PARENT]: {
          id: NEW_PARENT,
          bundle: "p_faq_group",
          fields: { drupal_internal__revision_id: 102 },
        },
      },
    });
    const result = await draftNestedComponents(b, { ...input, resumeParentId: NEW_PARENT });
    expect(b.createEntity).not.toHaveBeenCalled();
    expect(callsEnding(b, "/mcp-draft")).toHaveLength(0);
    expect(result.publishedPinsUnchanged).toBe(true);
    expect(result.draftParentId).toBe(NEW_PARENT);
  });

  it("refuses relationships inside a child before any read", async () => {
    const b = backend();
    await expect(draftNestedComponents(b, {
      ...input,
      children: [{ ...replaceChild, relationships: { field_media: { data: null } } }],
    })).rejects.toThrow(/cannot change references/);
    expect(b.rawQuery).not.toHaveBeenCalled();
  });
});
