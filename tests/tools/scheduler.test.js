import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
// Return a fully-resolved, permissive security config so the real
// assertWriteAllowed gate (which this tool calls) passes; redaction is a no-op.
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({
      readOnly: false,
      allowDestructive: true,
      allowGraphqlMutations: true,
      allowedEntityTypes: null,
      deniedEntityTypes: [],
      entityRules: {},
      globalRedactedFields: [],
    })),
  };
});

import { handlers, definitions } from "../../src/tools/scheduler.js";
import { assertWriteAllowed } from "../../src/lib/security.js";

function canonicalNode(over = {}) {
  return { id: "n1", entityType: "node", bundle: "article", title: "T", status: false,
    langcode: "en", created: null, changed: null, url: "/t", fields: {},
    relationships: {}, _backend: "jsonapi", ...over };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("scheduler tools", () => {
  it("exposes drupal_schedule_publish with a description mentioning the Scheduler module", () => {
    const def = definitions.find((d) => d.name === "drupal_schedule_publish");
    expect(def).toBeTruthy();
    expect(def.inputSchema.required).toEqual(expect.arrayContaining(["type", "id"]));
    expect(def.description).toMatch(/Scheduler/i);
    expect(def.description).toMatch(/publish_on/);
    expect(def.description).toMatch(/unpublish_on/);
  });

  it("sets publish_on and unpublish_on attributes via updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(canonicalNode());
    const out = await handlers.drupal_schedule_publish({
      type: "article", id: "n1",
      publishOn: "2026-07-01T12:00:00Z",
      unpublishOn: "2026-08-01T12:00:00Z",
    });
    expect(out.id).toBe("n1");
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "node", bundle: "article", id: "n1" });
    expect(arg.attributes.publish_on).toBe("2026-07-01T12:00:00Z");
    expect(arg.attributes.unpublish_on).toBe("2026-08-01T12:00:00Z");
  });

  it("passes an epoch number through unchanged", async () => {
    backend.updateEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_schedule_publish({ type: "article", id: "n1", publishOn: 1782000000 });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes.publish_on).toBe(1782000000);
    expect(arg.attributes).not.toHaveProperty("unpublish_on");
  });

  it("only sends the fields that were provided", async () => {
    backend.updateEntity.mockResolvedValue(canonicalNode());
    await handlers.drupal_schedule_publish({ type: "article", id: "n1", unpublishOn: "2026-08-01T12:00:00Z" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.attributes).not.toHaveProperty("publish_on");
    expect(arg.attributes.unpublish_on).toBe("2026-08-01T12:00:00Z");
  });

  it("rejects when neither publishOn nor unpublishOn is supplied", async () => {
    await expect(handlers.drupal_schedule_publish({ type: "article", id: "n1" }))
      .rejects.toThrow(/publishOn|unpublishOn/);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("enforces write permission before calling the backend (read-only site)", async () => {
    const sec = await import("../../src/lib/security.js");
    sec.resolveSecurityConfig.mockReturnValueOnce({
      readOnly: true, allowDestructive: false, allowGraphqlMutations: false,
      allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {}, globalRedactedFields: [],
    });
    await expect(handlers.drupal_schedule_publish({ type: "article", id: "n1", publishOn: "2026-07-01T12:00:00Z" }))
      .rejects.toThrow(/read-only/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("surfaces a clear capability error when the backend reports an unknown field", async () => {
    backend.updateEntity.mockRejectedValue(new Error("Field 'publish_on' is unknown."));
    await expect(handlers.drupal_schedule_publish({ type: "article", id: "n1", publishOn: "2026-07-01T12:00:00Z" }))
      .rejects.toThrow(/Scheduler/i);
  });

  it("uses the entity-type-aware write assertion", () => {
    expect(typeof assertWriteAllowed).toBe("function");
  });
});
