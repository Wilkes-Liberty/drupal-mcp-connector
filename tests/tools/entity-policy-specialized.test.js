/**
 * Regression tests for #138: specialized tools honor the same entity
 * allowlist/denylist as drupal_entity_*.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(),
  deleteEntity: vi.fn(), listBundles: vi.fn(), uploadFile: vi.fn(), getPathInfo: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));

const getSiteConfig = vi.fn();
vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: (...a) => getSiteConfig(...a) }));

import { handlers as mediaHandlers } from "../../src/tools/media.js";
import { handlers as taxonomyHandlers } from "../../src/tools/taxonomy.js";
import { handlers as nodeHandlers } from "../../src/tools/nodes.js";
import { handlers as entityHandlers } from "../../src/tools/entities.js";

/** Site that denies media and taxonomy_term (node still allowed). */
function siteDenyMediaTaxonomy() {
  return {
    _name: "strict",
    baseUrl: "https://x",
    security: {
      preset: "write-plane",
      deniedEntityTypes: ["media", "taxonomy_term", "user", "oauth2_token", "key", "consumer", "encryption_profile", "mcp_tool_config", "mcp_policy_profile"],
      allowedEntityTypes: ["node", "paragraph", "block_content", "menu_link_content", "redirect", "path_alias", "file"],
    },
  };
}

/** Site that only allows media (node denied via allowlist). */
function siteMediaOnly() {
  return {
    _name: "media-only",
    baseUrl: "https://x",
    security: {
      readOnly: false,
      allowDestructive: true,
      allowPublish: true,
      allowedEntityTypes: ["media", "file"],
      deniedEntityTypes: [],
      entityRules: {},
      globalRedactedFields: [],
    },
  };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  getSiteConfig.mockReset();
  backend.getPathInfo.mockResolvedValue({ alias: null, pid: null, langcode: "en", drupalId: 1 });
  backend.getEntity.mockResolvedValue({ id: "n1", entityType: "node", bundle: "article", fields: {}, relationships: {} });
  backend.createEntity.mockResolvedValue({ id: "x1" });
  backend.updateEntity.mockResolvedValue({ id: "x1" });
  backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
  backend.listBundles.mockResolvedValue([]);
  backend.uploadFile.mockResolvedValue({ id: "f1", filename: "x.jpg" });
});

describe("entity policy on specialized tools (#138)", () => {
  it("denied media is rejected by media tools and by drupal_entity_*", async () => {
    getSiteConfig.mockReturnValue(siteDenyMediaTaxonomy());

    await expect(mediaHandlers.drupal_list_media({ type: "image" })).rejects.toThrow(/media/i);
    await expect(mediaHandlers.drupal_create_media({ type: "image", name: "x" })).rejects.toThrow(/media/i);
    await expect(mediaHandlers.drupal_upload_file({
      bundle: "image", fieldName: "field_media_image", filePath: "/tmp/x.jpg",
    })).rejects.toThrow(/media/i);
    await expect(entityHandlers.drupal_entity_list({
      entityType: "media", bundle: "image",
    })).rejects.toThrow(/media/i);
    await expect(entityHandlers.drupal_entity_create({
      entityType: "media", bundle: "image", attributes: { name: "x" },
    })).rejects.toThrow(/media/i);

    expect(backend.listEntities).not.toHaveBeenCalled();
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.uploadFile).not.toHaveBeenCalled();
  });

  it("denied taxonomy_term is rejected by taxonomy tools and drupal_entity_*", async () => {
    getSiteConfig.mockReturnValue(siteDenyMediaTaxonomy());

    await expect(taxonomyHandlers.drupal_get_taxonomy_terms({ vocabulary: "tags" })).rejects.toThrow(/taxonomy_term/i);
    await expect(taxonomyHandlers.drupal_create_taxonomy_term({ vocabulary: "tags", name: "t" })).rejects.toThrow(/taxonomy_term/i);
    await expect(entityHandlers.drupal_entity_create({
      entityType: "taxonomy_term", bundle: "tags", attributes: { name: "t" },
    })).rejects.toThrow(/taxonomy_term/i);

    expect(backend.listEntities).not.toHaveBeenCalled();
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("node not on allowlist is rejected by node tools and drupal_entity_*", async () => {
    getSiteConfig.mockReturnValue(siteMediaOnly());

    await expect(nodeHandlers.drupal_list_nodes({ type: "article" })).rejects.toThrow(/node/i);
    await expect(nodeHandlers.drupal_create_node({ type: "article", title: "T" })).rejects.toThrow(/node/i);
    await expect(nodeHandlers.drupal_delete_node({ type: "article", id: "n1" })).rejects.toThrow(/node/i);
    await expect(entityHandlers.drupal_entity_list({
      entityType: "node", bundle: "article",
    })).rejects.toThrow(/node/i);

    expect(backend.listEntities).not.toHaveBeenCalled();
    expect(backend.createEntity).not.toHaveBeenCalled();
    expect(backend.deleteEntity).not.toHaveBeenCalled();
  });

  it("allowed media still works when node is denied", async () => {
    getSiteConfig.mockReturnValue(siteMediaOnly());
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    const out = await mediaHandlers.drupal_list_media({ type: "image" });
    expect(out.media).toEqual([]);
    expect(backend.listEntities).toHaveBeenCalled();
  });
});
