/**
 * Connector-level attach test for #192 / #169 / #201.
 *
 * CI Drupal does not ship Paragraphs + content_moderation, so this is not a
 * live-Drupal integration pass. It drives the real update_node handler against
 * a stub backend that records the outgoing PATCH and serves a working-copy
 * read — the assertion that would have caught the empty-field bug (N members
 * on the *written* revision, plus non-null meta on the payload).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  getPathInfo: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
  rawQuery: vi.fn(),
  resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
};
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

const N = 5;
const ids = Array.from({ length: N }, (_, i) => `p-${i}`);

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
  backend.rawQuery.mockRejectedValue(new Error(
    "Drupal 400 on PATCH /jsonapi/node/solution/n1: The selected entity (n1) " +
    "does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
  ));
  backend.getPathInfo.mockResolvedValue({ alias: null, pid: null, langcode: "en", drupalId: 2 });
  backend.getEntity.mockImplementation(async ({ entityType, id, resourceVersion }) => {
    if (entityType === "paragraph") {
      return {
        id, entityType: "paragraph", bundle: "capability",
        fields: { drupal_internal__revision_id: 100 + Number(String(id).slice(2)) },
      };
    }
    if (resourceVersion === "rel:working-copy") {
      return {
        id: "n1", entityType: "node", bundle: "solution", title: "S", status: false,
        langcode: "en", created: null, changed: null, url: "/s",
        fields: { moderation_state: "draft", drupal_internal__vid: 1 },
        relationships: {
          field_key_capabilities: ids.map((pid, i) => ({
            id: pid, entityType: "paragraph", bundle: "capability",
            meta: { target_revision_id: 100 + i },
          })),
        },
        _backend: "jsonapi",
      };
    }
    return {
      id: "n1", entityType: "node", bundle: "solution", title: "S", status: true,
      langcode: "en", created: null, changed: null, url: "/s",
      fields: { moderation_state: "published", drupal_internal__vid: 1 },
      relationships: { field_key_capabilities: [] },
      _backend: "jsonapi",
    };
  });
  backend.updateEntity.mockResolvedValue({
    id: "n1", entityType: "node", bundle: "solution",
    relationships: { field_key_capabilities: [] },
  });
});

describe("ERR attach against a stub backend (no live Drupal in CI)", () => {
  it("attaches N paragraphs: outgoing payload has vids and the written revision has N members", async () => {
    const out = await handlers.drupal_update_node({
      type: "solution",
      id: "n1",
      relationships: {
        field_key_capabilities: {
          data: ids.map((id) => ({ type: "paragraph--capability", id })),
        },
      },
    });

    const sent = backend.updateEntity.mock.calls[0][0];
    const payload = sent.relationships.field_key_capabilities.data;
    expect(payload).toHaveLength(N);
    for (const item of payload) {
      expect(item.meta.target_revision_id).toEqual(expect.any(Number));
      expect(item.meta.target_revision_id).not.toBeNull();
    }
    // 200 on PATCH is the test that shipped this bug — assert the written revision.
    expect(out._revision.source).toBe("working-copy");
    expect(out.relationships.field_key_capabilities).toHaveLength(N);
  });
});
