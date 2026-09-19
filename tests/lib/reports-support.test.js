import { describe, it, expect, vi } from "vitest";
import { collectEntities, gatedReport, fieldValue, fieldPresence, daysSince } from "../../src/lib/reports-support.js";

describe("collectEntities", () => {
  it("pages via offset up to maxItems", async () => {
    const backend = { listEntities: vi.fn() };
    backend.listEntities
      .mockResolvedValueOnce({ entities: [{ id: "a" }, { id: "b" }], page: { hasNext: true } })
      .mockResolvedValueOnce({ entities: [{ id: "c" }], page: { hasNext: false } });
    const out = await collectEntities(backend, { entityType: "node", bundle: "article" }, 50, 2);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(backend.listEntities.mock.calls[0][0].page).toEqual({ limit: 2, offset: 0 });
    expect(backend.listEntities.mock.calls[1][0].page).toEqual({ limit: 2, offset: 2 });
  });
  it("stops at maxItems", async () => {
    const backend = { listEntities: vi.fn().mockResolvedValue({ entities: [{ id: "x" }, { id: "y" }], page: { hasNext: true } }) };
    const out = await collectEntities(backend, { entityType: "node", bundle: "article" }, 3, 2);
    expect(out.length).toBe(3);
  });
});

describe("gatedReport", () => {
  it("returns an unavailable result", () => {
    expect(gatedReport("revision_hotspots", "graphql", "no revisions")).toEqual({
      unavailable: true, report: "revision_hotspots", backend: "graphql", reason: "no revisions",
    });
  });
});

describe("fieldValue", () => {
  const entity = { title: "T", status: true, url: "/t", fields: { metaDescription: "d", body: { value: "x" } } };
  it("reads base fields and the first present field candidate", () => {
    expect(fieldValue(entity, ["title"])).toBe("T");
    expect(fieldValue(entity, ["field_meta_description", "metaDescription"])).toBe("d");
    expect(fieldValue(entity, ["missing"])).toBeUndefined();
  });
  it("returns falsy base values (false/empty/null) rather than skipping them", () => {
    expect(fieldValue({ status: false, fields: {} }, ["status"])).toBe(false);
    expect(fieldValue({ title: "", fields: {} }, ["title"])).toBe("");
    expect(fieldValue({ url: null, fields: {} }, ["url"])).toBeNull();
  });
});

describe("fieldPresence (#337)", () => {
  const entity = {
    id: "n1", title: null, url: null, status: true,
    fields: { body: null, field_text: "", field_list: [], field_zero: 0 },
    relationships: { field_image: null, field_tags: [] },
  };

  it("reports a key with an empty value as present", () => {
    for (const name of ["body", "field_text", "field_list", "field_zero", "field_image", "field_tags"]) {
      expect(fieldPresence(entity, name).present).toBe(true);
    }
    expect(fieldPresence(entity, "field_zero").value).toBe(0);
    expect(fieldPresence(entity, "field_image").value).toBeNull();
  });

  it("reports a missing key as absent, in fields and relationships alike", () => {
    expect(fieldPresence(entity, "field_internal_notes")).toEqual({ present: false, value: undefined });
    expect(fieldPresence({ id: "x" }, "body")).toEqual({ present: false, value: undefined });
    expect(fieldPresence(null, "body")).toEqual({ present: false, value: undefined });
  });

  it("treats promoted base attributes, and path as url, as always present", () => {
    expect(fieldPresence(entity, "title")).toEqual({ present: true, value: null });
    expect(fieldPresence(entity, "path")).toEqual({ present: true, value: null });
    expect(fieldPresence({ ...entity, url: "/a" }, "path").value).toBe("/a");
  });

  it("does not read inherited object properties as fields", () => {
    expect(fieldPresence(entity, "constructor").present).toBe(false);
    expect(fieldPresence(entity, "toString").present).toBe(false);
  });
});

describe("daysSince", () => {
  it("computes whole days from an ISO date", () => {
    const iso = new Date(Date.now() - 3 * 86400000).toISOString();
    expect(daysSince(iso)).toBe(3);
  });
});
