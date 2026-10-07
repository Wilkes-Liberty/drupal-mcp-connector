import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/tools/drush.js", () => ({
  sshDrush: vi.fn(),
  parseDrush: (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
}));

import { sshDrush } from "../../src/tools/drush.js";
import {
  FALLBACK_TEXT_FORMAT,
  resolveTextFormat,
  resolveFieldDefinition,
  parseFieldConfigObject,
} from "../../src/lib/field-definition.js";
import {
  clearTextFormatContextCache,
  rememberTextFormatContext,
} from "../../src/lib/text-format-context.js";

describe("resolveTextFormat", () => {
  it("uses the single allowed format when the caller omits format", () => {
    expect(resolveTextFormat({
      fieldName: "field_mission_impact",
      requested: undefined,
      allowedFormats: ["headless_clean"],
    })).toBe("headless_clean");
  });

  it("refuses a requested format outside the allowed list", () => {
    expect(() => resolveTextFormat({
      fieldName: "field_mission_impact",
      requested: "full_html",
      allowedFormats: ["headless_clean"],
    })).toThrow(/field_mission_impact[\s\S]*full_html[\s\S]*headless_clean/s);
  });

  it("uses site defaultTextFormat only when it is in a multi-entry list", () => {
    expect(resolveTextFormat({
      fieldName: "body",
      requested: undefined,
      allowedFormats: ["basic_html", "restricted_html"],
      site: { defaultTextFormat: "basic_html" },
    })).toBe("basic_html");
  });

  it("refuses an omitted format when site default / full_html is not allowed", () => {
    expect(() => resolveTextFormat({
      fieldName: "body",
      requested: undefined,
      allowedFormats: ["headless_clean", "basic_html"],
      site: { defaultTextFormat: "full_html" },
    })).toThrow(/body[\s\S]*full_html[\s\S]*headless_clean[\s\S]*basic_html/s);
  });

  it("keeps the historical body fallback only when the list is unknown", () => {
    expect(resolveTextFormat({
      fieldName: "body",
      requested: undefined,
      allowedFormats: null,
      defaultWhenUnknown: true,
    })).toBe(FALLBACK_TEXT_FORMAT);
    expect(resolveTextFormat({
      fieldName: "body",
      requested: undefined,
      allowedFormats: null,
      site: { defaultTextFormat: "site_default_format" },
      defaultWhenUnknown: true,
    })).toBe("site_default_format");
  });

  it("does not invent a format for non-body fields when the list is unknown", () => {
    expect(resolveTextFormat({
      fieldName: "field_mission_impact",
      requested: undefined,
      allowedFormats: null,
      site: { defaultTextFormat: "full_html" },
    })).toBeUndefined();
  });

  it("treats an empty allowed list as unrestricted, not as deny-all", () => {
    expect(resolveTextFormat({
      fieldName: "field_summary",
      requested: "headless_clean",
      allowedFormats: [],
    })).toBe("headless_clean");
  });
});

describe("parseFieldConfigObject", () => {
  it("reads settings.allowed_formats without using any site default", () => {
    expect(parseFieldConfigObject({
      field_name: "field_mission_impact",
      field_type: "text_long",
      settings: { allowed_formats: ["headless_clean"] },
    })).toEqual({
      fieldName: "field_mission_impact",
      fieldType: "text_long",
      allowedFormats: ["headless_clean"],
    });
  });

  it("keeps enabled checkbox values and drops disabled ones", () => {
    expect(parseFieldConfigObject({
      field_name: "body",
      field_type: "text_with_summary",
      settings: {
        allowed_formats: { client_html: "client_html", full_html: 0, basic_html: "0" },
      },
    }).allowedFormats).toEqual(["client_html"]);
  });
});

describe("resolveFieldDefinition chain", () => {
  const site = { _name: "d", baseUrl: "https://x", drushSsh: { host: "x" } };

  beforeEach(() => {
    vi.mocked(sshDrush).mockReset();
    clearTextFormatContextCache();
  });

  it("prefers backend.getFieldDefinition over Drush", async () => {
    const backend = {
      getFieldDefinition: vi.fn(async () => ({
        fieldName: "body", fieldType: "text_with_summary", allowedFormats: ["headless_clean"],
      })),
    };
    const site = { drushSsh: { host: "x" } };
    const out = await resolveFieldDefinition(backend, site, "node", "article", "body");
    expect(out.allowedFormats).toEqual(["headless_clean"]);
    expect(sshDrush).not.toHaveBeenCalled();
  });

  it("falls back to drush config:get when JSON:API returns null", async () => {
    vi.mocked(sshDrush).mockResolvedValue(JSON.stringify({
      field_name: "field_mission_impact",
      field_type: "text_long",
      settings: { allowed_formats: ["headless_clean"] },
    }));
    const backend = { getFieldDefinition: vi.fn(async () => null) };
    const site = { drushSsh: { host: "x" } };
    const out = await resolveFieldDefinition(backend, site, "node", "solution", "field_mission_impact");
    expect(out).toEqual({
      fieldName: "field_mission_impact",
      fieldType: "text_long",
      allowedFormats: ["headless_clean"],
    });
    expect(sshDrush).toHaveBeenCalledWith(site, [
      "config:get", "field.field.node.solution.field_mission_impact", "--format=json",
    ]);
  });

  it("reads core.base_field_override when field.field is missing", async () => {
    vi.mocked(sshDrush)
      .mockRejectedValueOnce(new Error("Config field.field.node.article.body does not exist"))
      .mockResolvedValueOnce(JSON.stringify({
        field_name: "body",
        field_type: "text_with_summary",
        settings: { allowed_formats: { client_html: "client_html", full_html: "0" } },
      }));
    const backend = { getFieldDefinition: vi.fn(async () => null) };
    const site = { drushSsh: { host: "x" } };
    const out = await resolveFieldDefinition(backend, site, "node", "article", "body");
    expect(out).toEqual({
      fieldName: "body",
      fieldType: "text_with_summary",
      allowedFormats: ["client_html"],
    });
    expect(sshDrush).toHaveBeenNthCalledWith(2, site, [
      "config:get", "core.base_field_override.node.article.body", "--format=json",
    ]);
  });

  it("returns null rather than inventing formats when both sources miss", async () => {
    const backend = { getFieldDefinition: vi.fn(async () => null) };
    const out = await resolveFieldDefinition(backend, { _name: "d" }, "node", "article", "body");
    expect(out).toBeNull();
    expect(sshDrush).not.toHaveBeenCalled();
  });

  it("prefers a matching JSON:API row over Sentinel context (#429)", async () => {
    rememberTextFormatContext(site, {
      content_types: {
        solution: {
          fields: { field_summary: { type: "text_long", allowed_formats: ["headless_clean"] } },
        },
      },
    });
    const backend = {
      getFieldDefinition: vi.fn(async () => ({
        fieldName: "field_summary", fieldType: "text_long", allowedFormats: ["plain_text"],
      })),
    };
    const out = await resolveFieldDefinition(backend, site, "node", "solution", "field_summary");
    expect(out.allowedFormats).toEqual(["plain_text"]);
    expect(sshDrush).not.toHaveBeenCalled();
  });

  it("uses context when the JSON:API row names a different field (#429)", async () => {
    rememberTextFormatContext(site, {
      content_types: {
        solution: {
          fields: { field_summary: { type: "text_long", allowed_formats: ["plain_text"] } },
        },
      },
    });
    const backend = {
      getFieldDefinition: vi.fn(async () => ({
        fieldName: "body", fieldType: "text_with_summary", allowedFormats: ["full_html"],
      })),
    };
    const out = await resolveFieldDefinition(backend, site, "node", "solution", "field_summary");
    expect(out).toEqual({
      fieldName: "field_summary",
      fieldType: "text_long",
      allowedFormats: ["plain_text"],
    });
    expect(sshDrush).not.toHaveBeenCalled();
  });

  it("treats a context field with no allowed_formats key as unknown (#429)", async () => {
    rememberTextFormatContext(site, {
      content_types: {
        solution: { fields: { field_summary: { type: "text_long" } } },
      },
    });
    const backend = { getFieldDefinition: vi.fn(async () => null) };
    const out = await resolveFieldDefinition(
      backend, { _name: "d", baseUrl: "https://x" }, "node", "solution", "field_summary",
    );
    expect(out).toBeNull();
    expect(sshDrush).not.toHaveBeenCalled();
  });
});
