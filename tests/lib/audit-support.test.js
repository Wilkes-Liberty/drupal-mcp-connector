import { describe, it, expect } from "vitest";
import {
  bodyHtml,
  extractAnchors,
  extractImages,
  extractEmbeds,
  classifyLink,
  normalizePath,
  hostOf,
} from "../../src/lib/audit-support.js";

describe("audit-support", () => {
  describe("bodyHtml", () => {
    it("reads a JSON:API {value} body object", () => {
      const entity = { fields: { body: { value: "<p>hi</p>" } } };
      expect(bodyHtml(entity)).toBe("<p>hi</p>");
    });
    it("reads a scalar body and returns '' when absent", () => {
      expect(bodyHtml({ fields: { body: "plain" } })).toBe("plain");
      expect(bodyHtml({ fields: {} })).toBe("");
    });
  });

  describe("extractAnchors / extractImages", () => {
    it("pulls hrefs and srcs in document order", () => {
      const html = '<a href="/a">A</a> <img src="/i.png"> <a href="https://x.com">X</a>';
      expect(extractAnchors(html)).toEqual(["/a", "https://x.com"]);
      expect(extractImages(html)).toEqual(["/i.png"]);
    });
    it("returns [] for empty input", () => {
      expect(extractAnchors("")).toEqual([]);
      expect(extractImages(null)).toEqual([]);
    });
  });

  describe("extractEmbeds", () => {
    it("extracts de-duped entity embeds with type + uuid", () => {
      const html =
        '<drupal-media data-entity-type="media" data-entity-uuid="u1"></drupal-media>' +
        '<drupal-entity data-entity-uuid="u2" data-entity-type="node"></drupal-entity>' +
        '<drupal-media data-entity-type="media" data-entity-uuid="u1"></drupal-media>';
      expect(extractEmbeds(html)).toEqual([
        { entityType: "media", uuid: "u1" },
        { entityType: "node", uuid: "u2" },
      ]);
    });
  });

  describe("classifyLink", () => {
    const base = "https://example.com";
    it("classifies root-relative as internal", () => {
      expect(classifyLink("/about", base)).toMatchObject({ kind: "internal", path: "/about" });
    });
    it("classifies same-host absolute as internal", () => {
      expect(classifyLink("https://example.com/x/", base)).toMatchObject({ kind: "internal", path: "/x" });
    });
    it("classifies other-host absolute as external", () => {
      expect(classifyLink("https://other.org/y", base)).toMatchObject({ kind: "external", host: "other.org" });
    });
    it("classifies fragments, mailto, tel, and js: distinctly", () => {
      expect(classifyLink("#top", base).kind).toBe("fragment");
      expect(classifyLink("mailto:a@b.com", base).kind).toBe("mailto");
      expect(classifyLink("tel:+15551234", base).kind).toBe("tel");
      expect(classifyLink("javascript:void(0)", base).kind).toBe("other");
    });
  });

  describe("normalizePath", () => {
    it("strips query/fragment and trailing slash", () => {
      expect(normalizePath("/a/b/?q=1#x")).toBe("/a/b");
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("no-slash")).toBe("/no-slash");
    });
  });

  describe("hostOf", () => {
    it("returns host from a URL or a bare host", () => {
      expect(hostOf("https://example.com:8080/x")).toBe("example.com:8080");
      expect(hostOf("example.com")).toBe("example.com");
      expect(hostOf("")).toBeNull();
    });
  });
});
