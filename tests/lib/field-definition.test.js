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
});

describe("resolveFieldDefinition chain", () => {
  beforeEach(() => vi.mocked(sshDrush).mockReset());

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

  it("returns null rather than inventing formats when both sources miss", async () => {
    const backend = { getFieldDefinition: vi.fn(async () => null) };
    const out = await resolveFieldDefinition(backend, { _name: "d" }, "node", "article", "body");
    expect(out).toBeNull();
    expect(sshDrush).not.toHaveBeenCalled();
  });
});
