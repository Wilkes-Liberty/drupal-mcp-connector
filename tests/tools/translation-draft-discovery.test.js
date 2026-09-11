import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = {
  rawQuery: vi.fn(), getEntity: vi.fn(), getPathInfo: vi.fn(),
  getEntitySchema: vi.fn(), getFieldDefinition: vi.fn(),
  updateEntity: vi.fn(),
  resourcePath: (et, bundle) => `/jsonapi/${et}/${bundle}`,
  toCanonical: (data) => ({ id: data.id, title: data.attributes.title,
    langcode: data.attributes.langcode, status: data.attributes.status,
    fields: data.attributes, relationships: data.relationships ?? {} }),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: async () => backend }));
vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: () => ({ security: {} }) }));
vi.mock("../../src/lib/security.js", async (original) => ({
  ...await original(),
  resolveSecurityConfig: () => ({ readOnly: false, allowPublish: false,
    allowedEntityTypes: null, deniedEntityTypes: [], globalRedactedFields: [], entityRules: {} }),
}));
import { handlers as nodes } from "../../src/tools/nodes.js";
import { handlers as entities } from "../../src/tools/entities.js";
import { handlers as revisions } from "../../src/tools/revisions.js";

const id = "fc40efc6-b466-49d4-9c74-216bdcb01788";
const live = { id, status: true, langcode: "en", title: "Keystone",
  fields: { drupal_internal__vid: 2559, moderation_state: "published" } };
const inventory = () => ({ meta: { live: { vid: "2559" }, working: {
  vid: "2569", translations: [
    { langcode: "en", status: true, moderation_state: "published", default: true },
    { langcode: "es", status: false, moderation_state: "draft", default: false },
  ],
} } });
let calls;
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  backend.getPathInfo.mockResolvedValue({ alias: null });
  backend.getEntitySchema.mockResolvedValue({ attributes: {}, relationships: {} });
  backend.getEntity.mockImplementation(async (ref) => {
    if (ref.resourceVersion === "rel:working-copy") throw new Error("Drupal 403 working-copy alias");
    return live;
  });
  backend.rawQuery.mockImplementation(async ({ path, options }) => {
    calls.push({ path, options });
    if (path.endsWith("/mcp-translations")) return inventory();
    if (path.includes("rel%3Aworking-copy")) throw new Error("Drupal 403 working-copy alias");
    if (path.includes("rel%3Alatest-version")) return { data: { id, attributes: live.fields } };
    if (path.endsWith("/mcp-draft")) {
      const headers = options.headers;
      expect(headers["If-Match"]).toBe('"2559:2569"');
      expect(headers["X-MCP-Draft-Langcode"]).toBe("es");
      if (headers["X-MCP-Draft-Preflight"] === "1") {
        return { meta: { draft_preflight: true, live: "2559", working: "2569", langcode: "es" } };
      }
      return { data: { id, type: "node--solution", attributes: {
        title: "Piedra angular", langcode: "es", status: false, drupal_internal__vid: 2569,
      } } };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe("translation-only forward revisions (#297)", () => {
  it("lists the Sentinel-visible revision with language states, without calling it an English draft", async () => {
    const result = await revisions.drupal_list_revisions({ type: "solution", id });
    expect(String(result.workingCopy.vid)).toBe("2569");
    expect(result.workingCopy.translations).toEqual(inventory().meta.working.translations);
    expect(result.workingCopy.status).toBeUndefined();
    expect(result.note).not.toMatch(/surgery/);
  });

  it.each([true, false])("continues Spanish via node update (dryRun=%s), returning Spanish rather than live English", async (dryRun) => {
    const result = await nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      title: "Piedra angular", moderationState: "draft", dryRun });
    const patches = calls.filter((c) => c.options?.method === "PATCH");
    expect(patches).toHaveLength(dryRun ? 1 : 2);
    expect(patches.every((c) => c.path.endsWith("/mcp-draft"))).toBe(true);
    if (!dryRun) {
      expect(result.title).toBe("Piedra angular");
      expect(result.langcode).toBe("es");
      expect(result._revisions).toEqual({ live: 2559, working: 2569 });
    }
  });

  it("keeps Spanish content when alias verification must re-read English", async () => {
    backend.getPathInfo.mockResolvedValue({ alias: "/keystone", aliasId: "alias1" });
    backend.getEntity.mockImplementation(async (ref) => {
      if (ref.resourceVersion === "rel:working-copy") throw new Error("Drupal 403 alias");
      return { ...live, url: "/keystone" };
    });
    const canonical = backend.toCanonical;
    backend.toCanonical = (data) => ({ ...canonical(data), url: "/wrong-alias" });
    try {
      const result = await nodes.drupal_update_node({ type: "solution", id, langcode: "es",
        title: "Piedra angular", moderationState: "draft" });
      expect(result.title).toBe("Piedra angular");
      expect(result.langcode).toBe("es");
      expect(result.url).toBe("/keystone");
      expect(result._revisions).toEqual({ live: 2559, working: 2569 });
    } finally {
      backend.toCanonical = canonical;
    }
  });

  it("refuses a mismatched working-copy UUID before inventory fallback", async () => {
    backend.getEntity.mockResolvedValue({ ...live, id: "different-node" });
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      moderationState: "draft", dryRun: true })).rejects.toThrow(/ambiguous PATCH target/);
    expect(calls).toEqual([]);
  });

  it("uses the same continuation in generic entity updates", async () => {
    const result = await entities.drupal_entity_update({ entityType: "node", bundle: "solution", id,
      langcode: "es", attributes: { title: "Piedra angular", moderation_state: "draft" } });
    expect(result.title).toBe("Piedra angular");
    expect(result._revisions).toEqual({ live: 2559, working: 2569 });
  });

  it.each([undefined, "en", "fr"])("refuses ambiguous, published or absent language %s without PATCH", async (langcode) => {
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode,
      title: "Keystone", moderationState: "draft", dryRun: true })).rejects.toThrow(/language|langcode|published/i);
    expect(calls.filter((c) => c.options?.method === "PATCH")).toEqual([]);
  });

  it.each(["Drupal 403 forbidden", "Drupal 500 unavailable"])("preserves inventory refusal %s without canonical fallback", async (message) => {
    backend.rawQuery.mockRejectedValue(new Error(message));
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      moderationState: "draft", dryRun: true })).rejects.toThrow(message);
  });

  it("discovers the Spanish draft when core echoes the live revision", async () => {
    backend.getEntity.mockResolvedValue(live);
    const result = await nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      moderationState: "draft", dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/mcp-draft"))).toBe(true);
  });

  it.each([{}, { meta: { live: { vid: "invalid" } } }, {
    meta: { live: { vid: "2559" }, working: { vid: "2569", translations: [null] } },
  }])("refuses malformed inventory without PATCH", async (response) => {
    backend.rawQuery.mockResolvedValue(response);
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      moderationState: "draft", dryRun: true })).rejects.toThrow(/inventory/);
    expect(backend.rawQuery.mock.calls.some(([c]) => c.options?.method === "PATCH")).toBe(false);
  });

  it("does not combine a stale live read with a newer inventory", async () => {
    const response = inventory();
    response.meta.live.vid = "2560";
    backend.rawQuery.mockResolvedValue(response);
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      title: "Nuevo" })).rejects.toThrow(/stale|concurrent/i);
    expect(backend.rawQuery.mock.calls.some(([c]) => c.options?.method === "PATCH")).toBe(false);
  });

  it("lists a permission refusal as an error, not an absent draft", async () => {
    backend.rawQuery.mockImplementation(async ({ path }) => {
      if (path.endsWith("/mcp-translations")) throw new Error("Drupal 403 inventory forbidden");
      if (path.includes("latest-version")) return { data: { id, attributes: live.fields } };
      throw new Error("Drupal 403 working-copy alias");
    });
    await expect(revisions.drupal_list_revisions({ type: "solution", id })).rejects.toThrow("403 inventory forbidden");
  });

  it("preserves a stale Sentinel preflight refusal and never sends a saving write", async () => {
    backend.rawQuery.mockImplementation(async ({ path }) => {
      if (path.endsWith("/mcp-translations")) return inventory();
      throw new Error("Drupal 409 stale revision pair");
    });
    await expect(nodes.drupal_update_node({ type: "solution", id, langcode: "es",
      moderationState: "draft" })).rejects.toThrow("409");
    expect(backend.rawQuery.mock.calls.filter(([c]) => c.options?.headers?.["X-MCP-Draft-Preflight"] === "0")).toHaveLength(0);
  });
});
