import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
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
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({
      readOnly: false,
      allowDestructive: true,
      allowedEntityTypes: null,
      deniedEntityTypes: [],
      globalRedactedFields: [],
      entityRules: {},
    })),
  };
});

import { handlers, definitions } from "../../src/tools/revisions.js";

// A raw JSON:API resource (single) response, as returned by backend.rawQuery.
function rawResource(over = {}) {
  return {
    jsonapi: { version: "1.0" },
    data: {
      type: "node--article",
      id: "n1",
      attributes: {
        drupal_internal__nid: 7,
        drupal_internal__vid: 42,
        revision_timestamp: "2026-01-01T00:00:00+00:00",
        revision_log: "older draft",
        title: "Old title",
        status: false,
        langcode: "en",
        body: { value: "<p>old</p>", format: "full_html", summary: "" },
        path: { alias: "/old" },
        ...over.attributes,
      },
      relationships: {
        uid: { data: { type: "user--user", id: "u1" } },
        ...over.relationships,
      },
      links: { self: { href: "https://x/jsonapi/node/article/n1?resourceVersion=id%3A42" } },
      ...over.dataExtra,
    },
    links: { self: { href: "https://x/jsonapi/node/article/n1?resourceVersion=rel%3Alatest-version" } },
    ...over.top,
  };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
});

describe("revisions tools", () => {
  it("exports the three revision tool definitions and handlers", () => {
    const names = definitions.map((d) => d.name).sort();
    expect(names).toEqual(["drupal_get_revision", "drupal_list_revisions", "drupal_revert_revision"]);
    expect(typeof handlers.drupal_list_revisions).toBe("function");
    expect(typeof handlers.drupal_get_revision).toBe("function");
    expect(typeof handlers.drupal_revert_revision).toBe("function");
  });

  it("list_revisions surfaces latest-version and working-copy via resourceVersion rawQuery", async () => {
    backend.rawQuery
      .mockResolvedValueOnce(rawResource({ attributes: { drupal_internal__vid: 42 } }))   // latest-version
      .mockResolvedValueOnce(rawResource({ attributes: { drupal_internal__vid: 43, status: false } })); // working-copy
    const out = await handlers.drupal_list_revisions({ type: "article", id: "n1" });

    expect(backend.rawQuery).toHaveBeenNthCalledWith(1, { path: "/jsonapi/node/article/n1?resourceVersion=rel%3Alatest-version" });
    expect(backend.rawQuery).toHaveBeenNthCalledWith(2, { path: "/jsonapi/node/article/n1?resourceVersion=rel%3Aworking-copy" });
    expect(out.entityType).toBe("node");
    expect(out.bundle).toBe("article");
    expect(out.id).toBe("n1");
    expect(out.latestVersion).toMatchObject({ vid: 42 });
    expect(out.workingCopy).toMatchObject({ vid: 43 });
    // Graceful degradation note about full history enumeration.
    expect(out.note).toMatch(/Drush/i);
    expect(out.fullHistoryAvailable).toBe(false);
  });

  it("list_revisions degrades gracefully when working-copy is absent (no moderation)", async () => {
    backend.rawQuery
      .mockResolvedValueOnce(rawResource({ attributes: { drupal_internal__vid: 42 } }))
      .mockRejectedValueOnce(new Error("404 Not Found"));
    const out = await handlers.drupal_list_revisions({ type: "article", id: "n1" });
    expect(out.latestVersion).toMatchObject({ vid: 42 });
    expect(out.workingCopy).toBeNull();
  });

  it("get_revision fetches a numeric vid via resourceVersion=id:<vid> and redacts", async () => {
    backend.rawQuery.mockResolvedValue(rawResource({ attributes: { drupal_internal__vid: 42 } }));
    const out = await handlers.drupal_get_revision({ type: "article", id: "n1", version: 42 });
    expect(backend.rawQuery).toHaveBeenCalledWith({ path: "/jsonapi/node/article/n1?resourceVersion=id%3A42" });
    expect(out.id).toBe("n1");
    expect(out.vid).toBe(42);
    expect(out.attributes.title).toBe("Old title");
  });

  it("get_revision accepts rel:latest-version / rel:working-copy aliases", async () => {
    backend.rawQuery.mockResolvedValue(rawResource());
    await handlers.drupal_get_revision({ type: "article", id: "n1", version: "rel:latest-version" });
    expect(backend.rawQuery).toHaveBeenCalledWith({ path: "/jsonapi/node/article/n1?resourceVersion=rel%3Alatest-version" });

    backend.rawQuery.mockClear();
    await handlers.drupal_get_revision({ type: "article", id: "n1", version: "rel:working-copy" });
    expect(backend.rawQuery).toHaveBeenCalledWith({ path: "/jsonapi/node/article/n1?resourceVersion=rel%3Aworking-copy" });
  });

  it("get_revision accepts a bare id:<vid> string", async () => {
    backend.rawQuery.mockResolvedValue(rawResource());
    await handlers.drupal_get_revision({ type: "article", id: "n1", version: "id:42" });
    expect(backend.rawQuery).toHaveBeenCalledWith({ path: "/jsonapi/node/article/n1?resourceVersion=id%3A42" });
  });

  it("get_revision redacts configured fields", async () => {
    const { resolveSecurityConfig } = await import("../../src/lib/security.js");
    resolveSecurityConfig.mockReturnValueOnce({
      readOnly: false, allowedEntityTypes: null, deniedEntityTypes: [],
      globalRedactedFields: ["body"], entityRules: {},
    });
    backend.rawQuery.mockResolvedValue(rawResource());
    const out = await handlers.drupal_get_revision({ type: "article", id: "n1", version: 42 });
    expect(out.attributes.body).toBe("[REDACTED]");
  });

  it("revert_revision reads the target revision then updateEntity to restore its attributes", async () => {
    backend.rawQuery.mockResolvedValue(rawResource({ attributes: { drupal_internal__vid: 42 } }));
    backend.updateEntity.mockResolvedValue({ id: "n1", entityType: "node", bundle: "article" });
    const out = await handlers.drupal_revert_revision({ type: "article", id: "n1", version: 42 });

    expect(backend.rawQuery).toHaveBeenCalledWith({ path: "/jsonapi/node/article/n1?resourceVersion=id%3A42" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "node", bundle: "article", id: "n1" });
    // Restored editable attributes from the target revision.
    expect(arg.attributes.title).toBe("Old title");
    expect(arg.attributes.body).toEqual({ value: "<p>old</p>", format: "full_html", summary: "" });
    // Internal / immutable bookkeeping fields are NOT written back.
    expect(arg.attributes).not.toHaveProperty("drupal_internal__nid");
    expect(arg.attributes).not.toHaveProperty("drupal_internal__vid");
    expect(arg.attributes).not.toHaveProperty("revision_timestamp");
    expect(arg.attributes).not.toHaveProperty("path");
    expect(out.success).toBe(true);
    expect(out.revertedFrom).toBe(42);
  });

  it("revert_revision is a governed write — blocked when update not allowed", async () => {
    const { resolveSecurityConfig } = await import("../../src/lib/security.js");
    resolveSecurityConfig.mockReturnValueOnce({
      globalRedactedFields: [], entityRules: {}, readOnly: true,
      allowedEntityTypes: null, deniedEntityTypes: [],
    });
    await expect(handlers.drupal_revert_revision({ type: "article", id: "n1", version: 42 }))
      .rejects.toThrow(/read-only/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("revert_revision throws if the target revision cannot be read", async () => {
    backend.rawQuery.mockResolvedValue({ data: null });
    await expect(handlers.drupal_revert_revision({ type: "article", id: "n1", version: 999 }))
      .rejects.toThrow(/revision/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });
});
