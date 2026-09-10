import { describe, it, expect } from "vitest";
import { omitLiveComputedMetatag, METATAG_OMITTED_NOTE } from "../../src/lib/entity-response.js";

describe("omitLiveComputedMetatag (#283)", () => {
  it("drops computed metatag and keeps the stored override field", () => {
    const out = omitLiveComputedMetatag({
      id: "n1",
      title: "Socios",
      langcode: "es",
      fields: {
        field_metatags: '{"title":"Socios","description":"ES"}',
        metatag: [
          { tag: "meta", attributes: { name: "title", content: "Partners" } },
          { tag: "meta", attributes: { name: "description", content: "EN live" } },
        ],
        body: { value: "<p>ES</p>" },
      },
    });
    expect(out.fields.field_metatags).toBe('{"title":"Socios","description":"ES"}');
    expect(out.fields.metatag).toBeUndefined();
    expect(out.fields.body).toEqual({ value: "<p>ES</p>" });
    expect(out._metatagOmitted.reason).toBe(METATAG_OMITTED_NOTE);
  });

  it("is a no-op when metatag is absent", () => {
    const entity = { id: "n1", fields: { field_metatags: "{}" } };
    expect(omitLiveComputedMetatag(entity)).toBe(entity);
  });
});
