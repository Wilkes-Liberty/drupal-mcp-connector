import { describe, it, expect } from "vitest";
import { mapTranslationRow, inventoryTranslationRows, inventoryRowMatching } from "../../src/lib/translation-rows.js";

describe("translation-rows", () => {
  it("passes through outdated and source only when present", () => {
    expect(mapTranslationRow({
      langcode: "es", default: false, status: false, title: "Hola", moderation_state: "draft",
    })).toEqual({
      langcode: "es", default: false, status: false, title: "Hola", moderation_state: "draft",
    });
    expect(mapTranslationRow({
      langcode: "es", default: false, status: true, title: "Hola", moderation_state: "published",
      outdated: true, source: "en",
    })).toEqual({
      langcode: "es", default: false, status: true, title: "Hola", moderation_state: "published",
      outdated: true, source: "en",
    });
  });

  it("prefers working rows over live for the same langcode", () => {
    const inventory = {
      live: {
        translations: [
          { langcode: "es", default: false, status: true, title: "Live", moderation_state: "published" },
        ],
      },
      working: {
        translations: [
          { langcode: "es", default: false, status: false, title: "Working", moderation_state: "draft" },
        ],
      },
    };
    expect(inventoryTranslationRows(inventory).find((row) => row.langcode === "es")?.title).toBe("Working");
    expect(inventoryRowMatching(inventory, { langcode: "es", state: "draft" })?.title).toBe("Working");
    expect(inventoryRowMatching(inventory, { langcode: "es", state: "published" })).toBeNull();
  });
});
