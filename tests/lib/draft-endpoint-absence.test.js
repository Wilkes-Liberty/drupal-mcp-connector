import { describe, it, expect, vi } from "vitest";
import { writeDraft, isMissingDraftEndpoint } from "../../src/lib/sentinel-draft.js";
import { writeComponentDraft } from "../../src/lib/component-draft.js";
import { draftNestedComponents } from "../../src/lib/nested-draft.js";
import { preflightGovernedCanonicalDraft } from "../../src/lib/canonical-draft.js";

const MISSING_DRAFT =
  "The site does not provide Sentinel's governed draft endpoint (d.o #3621022). " +
  "Update the server-side module; the draft was not discarded and no canonical fallback was attempted.";

const HERO = "11111111-1111-4111-8111-111111111111";
const TEXT = "22222222-2222-4222-8222-222222222222";
const NODE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHILD_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHILD_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SIBLING = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEW_CHILD = "f1111111-1111-4111-8111-111111111111";
const NEW_PARENT = "f2222222-2222-4222-8222-222222222222";
const LIBRARY_ID = "33333333-3333-4333-8333-333333333333";

/**
 * @param {number} status
 * @returns {Error}
 */
function draftHttpError(status) {
  return Object.assign(
    new Error(`Drupal ${status} on PATCH /jsonapi/node/page/x/mcp-draft`),
    { status },
  );
}

/**
 * @param {unknown} err
 */
function expectIdenticalRewrite(err) {
  expect(isMissingDraftEndpoint(err)).toBe(true);
  expect(err.message).toBe(MISSING_DRAFT);
}

const writeDraftInput = {
  entityType: "node", bundle: "page", id: "example-uuid",
  attributes: { title: "Next draft", moderation_state: "draft" },
  draftRevision: { liveVid: 10, workingVid: 11 },
};

/**
 * @param {(call: object) => Promise<object>} rawQuery
 * @returns {object}
 */
function jsonapiBackend(rawQuery) {
  return {
    rawQuery: vi.fn(rawQuery),
    resourcePath: (entityType, bundle) => `/jsonapi/${entityType}/${bundle}`,
    toCanonical: (data) => data,
    getEntity: vi.fn(),
    createEntity: vi.fn(),
  };
}

const nodeInventory = {
  defaultLangcode: "en",
  live: { vid: "10", translations: [{ langcode: "en", status: true, moderation_state: "published", default: true }] },
  working: null,
  operations: ["create_translation", "open_draft", "draft_components"],
};

const nestedInventory = {
  ...nodeInventory,
  operations: ["open_draft", "create_translation"],
};

const atomicInventory = {
  ...nodeInventory,
  operations: ["open_draft", "create_translation", "nested_replacement"],
};

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

const nestedInput = {
  entityType: "node",
  bundle: "page",
  id: NODE,
  field: "field_components",
  parentId: PARENT,
  childField: "field_items",
  children: [
    { op: "replace", id: CHILD_A, type: "p_faq_item", attributes: { field_title: "New question" } },
    { op: "keep", id: CHILD_B },
  ],
};

/**
 * @param {object} spec
 * @returns {object}
 */
function nestedBackend({ inventory, onDraft }) {
  return jsonapiBackend(async ({ path }) => {
    if (path.includes("/paragraph/") && path.endsWith("/mcp-translations")) {
      return { meta: { live: { vid: "50", translations: [{ langcode: "en", status: true, default: true }] } } };
    }
    if (path.endsWith("/mcp-translations")) return { meta: inventory };
    if (path.endsWith("/mcp-draft/translations")) {
      const parts = path.split("/");
      return { data: { id: parts.at(-3), type: `paragraph--${parts.at(-4)}` } };
    }
    if (path.endsWith("/mcp-draft")) return onDraft();
    throw new Error(`unexpected ${path}`);
  });
}

/**
 * @param {object} b
 */
function attachNestedReads(b) {
  const createdIds = [NEW_CHILD, NEW_PARENT];
  b._createdCount = 0;
  b.createEntity = vi.fn(async ({ bundle, attributes, relationships, langcode }) => {
    const id = createdIds[b._createdCount] ?? `created-${b._createdCount}`;
    b._createdCount += 1;
    return {
      id, bundle, langcode: langcode ?? "en", entityType: "paragraph",
      attributes, relationships,
      fields: { drupal_internal__revision_id: 100 + b._createdCount, ...(attributes ?? {}) },
    };
  });
  b.getEntity = vi.fn(async ({ entityType, id }) => {
    if (entityType === "paragraph") {
      if (id === PARENT) {
        return {
          id: PARENT, entityType: "paragraph", bundle: "p_faq_group",
          fields: { drupal_internal__revision_id: 50, field_title: "Questions" },
          relationships: {
            field_items: [pin(CHILD_A, "p_faq_item", 70), pin(CHILD_B, "p_faq_item", 71)],
          },
        };
      }
      return null;
    }
    return {
      id: NODE, entityType: "node", bundle: "page",
      fields: { drupal_internal__vid: 10 },
      relationships: { field_components: publishedPins },
    };
  });
}

const componentArgs = {
  entityType: "node", bundle: "page", id: "node-uuid",
  attributes: { title: "New home", moderation_state: "draft" },
  components: [
    { id: HERO, type: "hero", attributes: { field_title: "New hero" } },
    { id: TEXT, type: "paragraph--text_block", attributes: { field_body: { value: "<p>x</p>", format: "basic_html" } } },
  ],
};

const pinnedHost = {
  id: "node-uuid",
  relationships: {
    field_components: [
      { id: HERO, type: "paragraph--hero", meta: { target_revision_id: 5 } },
      { id: TEXT, type: "paragraph--text_block", meta: { target_revision_id: 6 } },
    ],
  },
};

const paths = [
  ["writeDraft", async (status) => {
    const b = jsonapiBackend(async () => { throw draftHttpError(status); });
    return writeDraft(b, writeDraftInput, true);
  }],
  ["canonical preflight", async (status) => {
    const b = jsonapiBackend(async () => { throw draftHttpError(status); });
    return preflightGovernedCanonicalDraft(b, {
      entityType: "paragraphs_library_item",
      bundle: "paragraphs_library_item",
      id: LIBRARY_ID,
      attributes: { label: "Reusable" },
      governedDraft: { live: "20", working: "", langcode: "en" },
    });
  }],
  ["component draftRequest", async (status) => {
    const b = jsonapiBackend(async ({ path }) => {
      if (path.endsWith("/mcp-translations")) return { meta: nodeInventory };
      throw draftHttpError(status);
    });
    b.getEntity = vi.fn(async () => pinnedHost);
    return writeComponentDraft(b, componentArgs);
  }],
  ["nested hostDraftRequest", async (status) => {
    const b = nestedBackend({
      inventory: nestedInventory,
      onDraft: () => { throw draftHttpError(status); },
    });
    attachNestedReads(b);
    return draftNestedComponents(b, nestedInput);
  }],
  ["nested atomicDraftRequest", async (status) => {
    const b = nestedBackend({
      inventory: atomicInventory,
      onDraft: () => { throw draftHttpError(status); },
    });
    attachNestedReads(b);
    return draftNestedComponents(b, nestedInput);
  }],
];

describe("missing /mcp-draft endpoint rewrite", () => {
  it.each(paths.flatMap(([name, run]) => [
    [name, 404, run],
    [name, 405, run],
  ]))("%s rewrites Drupal %s identically", async (_name, status, run) => {
    const err = await run(status).catch((error) => error);
    expectIdenticalRewrite(err);
  });
});
