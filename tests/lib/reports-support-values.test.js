import { describe, it, expect } from "vitest";
import { fieldPresence, isEmptyFieldValue, FIELDS_NOT_VISIBLE_NOTE } from "../../src/lib/reports-support.js";

describe("fieldPresence", () => {
  const entity = {
    id: "n1", title: null, url: null,
    fields: { body: null, field_text: "" },
    relationships: { field_image: null, field_tags: [{ id: "t1" }] },
  };

  it("reads a field key and keeps an empty value apart from an absent key", () => {
    expect(fieldPresence(entity, "body")).toEqual({ present: true, value: null });
    expect(fieldPresence(entity, "field_text")).toEqual({ present: true, value: "" });
    expect(fieldPresence(entity, "field_denied")).toEqual({ present: false, value: undefined });
  });

  it("reads relationship keys after field keys", () => {
    expect(fieldPresence(entity, "field_image")).toEqual({ present: true, value: null });
    expect(fieldPresence(entity, "field_tags")).toEqual({ present: true, value: [{ id: "t1" }] });
  });

  it("treats promoted base attributes as always present, and path as url", () => {
    expect(fieldPresence(entity, "title")).toEqual({ present: true, value: null });
    expect(fieldPresence(entity, "path")).toEqual({ present: true, value: null });
  });

  it("does not read inherited object keys as fields", () => {
    expect(fieldPresence(entity, "constructor").present).toBe(false);
    expect(fieldPresence(entity, "__proto__").present).toBe(false);
  });

  it("survives an entity without fields or relationships", () => {
    expect(fieldPresence({ id: "n1" }, "body")).toEqual({ present: false, value: undefined });
    expect(fieldPresence(undefined, "body")).toEqual({ present: false, value: undefined });
  });
});

describe("isEmptyFieldValue", () => {
  it("treats null, undefined, empty string and empty arrays as empty", () => {
    for (const v of [null, undefined, "", [], [null], [{ id: "" }]]) expect(isEmptyFieldValue(v)).toBe(true);
  });

  it("treats zero and false as values", () => {
    expect(isEmptyFieldValue(0)).toBe(false);
    expect(isEmptyFieldValue(false)).toBe(false);
  });

  it("reads text objects by their value", () => {
    expect(isEmptyFieldValue({ value: "", summary: "s" })).toBe(true);
    expect(isEmptyFieldValue({ value: "text" })).toBe(false);
  });

  it("reads relationship refs by their id", () => {
    expect(isEmptyFieldValue({ id: "m1", entityType: "media" })).toBe(false);
    expect(isEmptyFieldValue({ id: null })).toBe(true);
    expect(isEmptyFieldValue([{ id: "t1" }])).toBe(false);
  });

  it("reads links and other keyed objects", () => {
    expect(isEmptyFieldValue({ uri: "https://example.org", title: "More" })).toBe(false);
    expect(isEmptyFieldValue({ uri: "" })).toBe(true);
    expect(isEmptyFieldValue({ lat: 1, lng: 2 })).toBe(false);
    expect(isEmptyFieldValue({})).toBe(true);
  });
});

describe("FIELDS_NOT_VISIBLE_NOTE", () => {
  it("says the fields were not scored and why", () => {
    expect(FIELDS_NOT_VISIBLE_NOTE).toMatch(/absent from every sampled/);
    expect(FIELDS_NOT_VISIBLE_NOTE).toMatch(/not scored/);
  });
});
