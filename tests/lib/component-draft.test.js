import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeComponents,
  writeComponentDraft,
} from "../../src/lib/component-draft.js";

const HERO = "11111111-1111-4111-8111-111111111111";
const TEXT = "22222222-2222-4222-8222-222222222222";

const inventory = (overrides = {}) => ({
  defaultLangcode: "en",
  live: { vid: "10", translations: [{ langcode: "en", status: true, moderation_state: "published", default: true }] },
  working: null,
  operations: ["create_translation", "open_draft", "draft_components"],
  ...overrides,
});

/**
 * A JSON:API backend double. `inventoryMeta` answers mcp-translations; the
 * draft endpoint answers from `draftResponses` in call order.
 */
function backend({ inventoryMeta = inventory(), draftResponses = [], working, live } = {}) {
  const responses = [...draftResponses];
  return {
    rawQuery: vi.fn(async ({ path }) => {
      if (path.endsWith("/mcp-translations")) return { meta: inventoryMeta };
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    resourcePath: (entityType, bundle) => `/jsonapi/${entityType}/${bundle}`,
    toCanonical: vi.fn((x) => x),
    getEntity: vi.fn(async ({ entityType, id, resourceVersion }) => {
      if (entityType === "paragraph") return paragraphs[`${id}@${resourceVersion}`] ?? null;
      return resourceVersion ? working : live;
    }),
  };
}

/** Stored paragraph revisions, keyed `uuid@id:vid`. */
let paragraphs = {};
const stored = (uuid, vid, fields) => {
  paragraphs[`${uuid}@id:${vid}`] = { id: uuid, entityType: "paragraph", fields };
};

const pinned = (heroVid, textVid) => ({
  id: "node-uuid",
  relationships: {
    field_components: [
      { id: HERO, type: "paragraph--hero", meta: { target_revision_id: heroVid } },
      { id: TEXT, type: "paragraph--text_block", meta: { target_revision_id: textVid } },
    ],
  },
});

const args = {
  entityType: "node", bundle: "page", id: "node-uuid",
  attributes: { title: "New home", moderation_state: "draft" },
  components: [
    { id: HERO, type: "hero", attributes: { field_title: "New hero" } },
    { id: TEXT, type: "paragraph--text_block", attributes: { field_body: { value: "<p>x</p>", format: "basic_html" } } },
  ],
};

const preflightOpen = { meta: { draft_preflight: true, live: "10", working: "", operation: "open_draft" } };
const written = { data: { id: "node-uuid", type: "node--page", attributes: { drupal_internal__vid: 12 } } };

describe("normalizeComponents", () => {
  it("accepts a bare bundle or a full resource type", () => {
    expect(normalizeComponents(args.components).map((c) => c.type))
      .toEqual(["paragraph--hero", "paragraph--text_block"]);
  });

  it("treats UUIDs that differ only in case as duplicates", () => {
    expect(() => normalizeComponents([
      { id: HERO, type: "hero", attributes: { a: 1 } },
      { id: HERO.toUpperCase(), type: "hero", attributes: { b: 1 } },
    ])).toThrow(/more than once/);
  });

  it.each([
    ["not a list", { id: HERO }],
    ["empty list", []],
    ["missing id", [{ type: "hero", attributes: { a: 1 } }]],
    ["non-uuid id", [{ id: "hero-1", type: "hero", attributes: { a: 1 } }]],
    ["missing type", [{ id: HERO, attributes: { a: 1 } }]],
    ["non-paragraph type", [{ id: HERO, type: "node--page", attributes: { a: 1 } }]],
    ["empty attributes", [{ id: HERO, type: "hero", attributes: {} }]],
    ["relationships", [{ id: HERO, type: "hero", attributes: { a: 1 }, relationships: { field_media: { data: null } } }]],
    ["duplicate", [{ id: HERO, type: "hero", attributes: { a: 1 } }, { id: HERO, type: "hero", attributes: { b: 1 } }]],
  ])("refuses %s", (_label, components) => {
    expect(() => normalizeComponents(components)).toThrow();
  });
});

describe("writeComponentDraft", () => {
  beforeEach(() => {
    paragraphs = {};
    stored(HERO, 7, { field_title: "New hero" });
    stored(HERO, 9, { field_title: "New hero" });
    stored(TEXT, 8, { field_body: { value: "<p>x</p>", format: "basic_html", processed: "<p>x</p>" } });
  });

  it("opens the first draft with a live-only If-Match and components in meta", async () => {
    const b = backend({
      draftResponses: [preflightOpen, written],
      live: pinned(5, 6),
      working: pinned(7, 8),
    });
    const result = await writeComponentDraft(b, args);
    const draftCalls = b.rawQuery.mock.calls.map(([call]) => call).filter((c) => c.path.endsWith("/mcp-draft"));
    expect(draftCalls).toHaveLength(2);
    const [preflight, write] = draftCalls;
    expect(preflight.options.headers).toMatchObject({ "If-Match": '"10"', "X-MCP-Draft-Preflight": "1", "X-MCP-Draft-Langcode": "en" });
    expect(write.options.headers).toMatchObject({ "If-Match": '"10"', "X-MCP-Draft-Preflight": "0" });
    const body = JSON.parse(write.options.body);
    expect(body.data).toMatchObject({ type: "node--page", id: "node-uuid", attributes: args.attributes });
    expect(body.meta.mcp_components).toEqual(normalizeComponents(args.components));
    expect(result._components).toEqual([
      { id: HERO, type: "paragraph--hero", livePin: "5", workingPin: "7", verified: ["field_title"] },
      { id: TEXT, type: "paragraph--text_block", livePin: "6", workingPin: "8", verified: ["field_body"] },
    ]);
  });

  it("continues an existing working copy with both revision ids", async () => {
    const b = backend({
      inventoryMeta: inventory({
        working: { vid: "11", translations: [{ langcode: "en", status: false, moderation_state: "draft", default: true }] },
      }),
      draftResponses: [{ meta: { draft_preflight: true, live: "10", working: "11" } }, written],
      live: pinned(5, 6),
      working: pinned(9, 8),
    });
    // The pre-write working copy (id:11) pins 4 and 3; the new one (id:12) 9 and 8.
    b.getEntity.mockImplementation(async ({ entityType, id, resourceVersion }) => {
      if (entityType === "paragraph") return paragraphs[`${id}@${resourceVersion}`] ?? null;
      if (resourceVersion === "id:11") return pinned(4, 3);
      return resourceVersion ? pinned(9, 8) : pinned(5, 6);
    });
    await writeComponentDraft(b, args);
    const write = b.rawQuery.mock.calls.map(([c]) => c).filter((c) => c.path.endsWith("/mcp-draft"))[1];
    expect(write.options.headers["If-Match"]).toBe('"10:11"');
  });

  it("measures a continued draft against the working copy's earlier pins", async () => {
    const workingInventory = inventory({
      working: { vid: "11", translations: [{ langcode: "en", status: false, moderation_state: "draft", default: true }] },
    });
    const b = backend({
      inventoryMeta: workingInventory,
      draftResponses: [{ meta: { draft_preflight: true, live: "10", working: "11" } }, written],
      live: pinned(5, 6),
      working: pinned(9, 8),
    });
    // The pre-write working copy (id:11) already pinned 9 and 8: nothing moved.
    b.getEntity.mockImplementation(async ({ entityType, id, resourceVersion }) => {
      if (entityType === "paragraph") return paragraphs[`${id}@${resourceVersion}`] ?? null;
      return resourceVersion ? pinned(9, 8) : pinned(5, 6);
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/earlier revision/);
  });

  it("stops after the preflight on dryRun", async () => {
    const b = backend({ draftResponses: [preflightOpen], live: pinned(5, 6) });
    const result = await writeComponentDraft(b, args, { dryRun: true });
    expect(result.dryRun).toBe(true);
    const draftCalls = b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"));
    expect(draftCalls).toHaveLength(1);
    expect(draftCalls[0][0].options.headers["X-MCP-Draft-Preflight"]).toBe("1");
  });

  it("refuses before any draft request when Sentinel lacks component drafts", async () => {
    const b = backend({ inventoryMeta: inventory({ operations: ["create_translation"] }) });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/draft_components.*No write was attempted/s);
    expect(b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"))).toHaveLength(0);
  });

  it("refuses opening when Sentinel cannot open a draft from live", async () => {
    const b = backend({ inventoryMeta: inventory({ operations: ["draft_components"] }) });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/open_draft/);
    expect(b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"))).toHaveLength(0);
  });

  it("refuses a missing inventory endpoint without falling back to a paragraph write", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(Object.assign(new Error("Drupal 404"), { status: 404 }));
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/No write was attempted/);
    expect(b.rawQuery).toHaveBeenCalledOnce();
  });

  it("refuses a non-default language", async () => {
    const b = backend();
    await expect(writeComponentDraft(b, { ...args, langcode: "es" })).rejects.toThrow(/default language/);
    expect(b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"))).toHaveLength(0);
  });

  it("refuses an alias change", async () => {
    const b = backend();
    await expect(writeComponentDraft(b, { ...args, attributes: { ...args.attributes, path: { alias: "/x" } } }))
      .rejects.toThrow(/alias/);
    expect(b.rawQuery).not.toHaveBeenCalled();
  });

  it("refuses when the default language is still published on the working copy", async () => {
    const b = backend({
      inventoryMeta: inventory({
        working: { vid: "11", translations: [
          { langcode: "en", status: true, moderation_state: "published", default: true },
          { langcode: "es", status: false, moderation_state: "draft" },
        ] },
      }),
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/published on the working copy/);
    expect(b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"))).toHaveLength(0);
  });

  it("refuses a paragraph the host does not pin directly, before any draft request", async () => {
    const nested = "33333333-3333-4333-8333-333333333333";
    const b = backend({ live: pinned(5, 6) });
    await expect(writeComponentDraft(b, {
      ...args,
      components: [{ id: nested, type: "p_faq_item", attributes: { field_title: "Question" } }],
    })).rejects.toThrow(/not a direct paragraph.*drupal_draft_nested_components/s);
    expect(b.rawQuery.mock.calls.filter(([call]) => call.path.endsWith("/mcp-draft"))).toHaveLength(0);
  });

  it("refuses a preflight that does not confirm the open operation", async () => {
    const b = backend({
      draftResponses: [{ meta: { draft_preflight: true, live: "10", working: "" } }],
      live: pinned(5, 6),
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/did not confirm/);
    expect(b.rawQuery.mock.calls.filter(([c]) => c.path.endsWith("/mcp-draft"))).toHaveLength(1);
  });

  it("reports a component whose submitted value did not read back from the working pin", async () => {
    stored(TEXT, 8, { field_body: { value: "<p>old</p>", format: "basic_html" } });
    const b = backend({
      draftResponses: [preflightOpen, written],
      live: pinned(5, 6),
      working: pinned(7, 8),
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(new RegExp(`${TEXT}.*field_body`));
  });

  it("reports a component it cannot read back", async () => {
    delete paragraphs[`${HERO}@id:7`];
    const b = backend({
      draftResponses: [preflightOpen, written],
      live: pinned(5, 6),
      working: pinned(7, 8),
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(/could not read back/);
  });

  it("reports a write whose working copy still pins the live revision of a component", async () => {
    const b = backend({
      draftResponses: [preflightOpen, written],
      live: pinned(5, 6),
      working: pinned(7, 6),
    });
    await expect(writeComponentDraft(b, args)).rejects.toThrow(new RegExp(`still pins.*${TEXT}`));
  });
});
