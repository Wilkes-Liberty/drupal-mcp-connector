import { describe, it, expect, vi } from "vitest";
import {
  SAFE_DRAFT_STATE,
  entityLooksModerated,
  isPublishedEntity,
  hasExplicitModerationState,
  shouldDefaultPublishedUpdateToDraft,
  applySafeDraftDefault,
} from "../../src/lib/moderation-default.js";

function moderatedPublished(over = {}) {
  return {
    id: "n1",
    entityType: "node",
    bundle: "article",
    status: true,
    fields: { moderation_state: "published" },
    ...over,
  };
}

describe("moderation-default (#131)", () => {
  it("detects moderated entities via fields.moderation_state", () => {
    expect(entityLooksModerated(moderatedPublished())).toBe(true);
    expect(entityLooksModerated({ status: true, fields: {} })).toBe(false);
    expect(entityLooksModerated(null)).toBe(false);
  });

  it("treats status === true as published", () => {
    expect(isPublishedEntity({ status: true })).toBe(true);
    expect(isPublishedEntity({ status: false })).toBe(false);
    expect(isPublishedEntity({})).toBe(false);
  });

  it("detects an explicit moderation_state on attributes", () => {
    expect(hasExplicitModerationState({ moderation_state: "published" })).toBe(true);
    expect(hasExplicitModerationState({ title: "x" })).toBe(false);
    expect(hasExplicitModerationState(null)).toBe(false);
  });

  it("defaults only when published + moderated + no explicit state", () => {
    expect(shouldDefaultPublishedUpdateToDraft({
      attributes: { title: "x" },
      entity: moderatedPublished(),
    })).toBe(true);
    expect(shouldDefaultPublishedUpdateToDraft({
      attributes: { moderation_state: "published" },
      entity: moderatedPublished(),
    })).toBe(false);
    expect(shouldDefaultPublishedUpdateToDraft({
      attributes: { title: "x" },
      entity: moderatedPublished({ status: false }),
    })).toBe(false);
    expect(shouldDefaultPublishedUpdateToDraft({
      attributes: { title: "x" },
      entity: { status: true, fields: {} },
    })).toBe(false);
  });

  it("applySafeDraftDefault injects draft for published moderated targets", async () => {
    const backend = {
      getEntity: vi.fn().mockResolvedValue(moderatedPublished()),
    };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { title: "wire tags" },
    });
    expect(out).toEqual({ title: "wire tags", moderation_state: SAFE_DRAFT_STATE });
    expect(backend.getEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article", id: "n1",
    });
  });

  it("applySafeDraftDefault leaves attributes alone when state is explicit", async () => {
    const backend = { getEntity: vi.fn() };
    const attrs = { moderation_state: "published", title: "keep live" };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "article", id: "n1", attributes: attrs,
    });
    expect(out).toBe(attrs);
    expect(backend.getEntity).not.toHaveBeenCalled();
  });

  it("applySafeDraftDefault leaves non-moderated published entities alone", async () => {
    const backend = {
      getEntity: vi.fn().mockResolvedValue({ status: true, fields: { body: "x" } }),
    };
    const attrs = { title: "page" };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "page", id: "n1", attributes: attrs,
    });
    expect(out).toBe(attrs);
  });

  it("applySafeDraftDefault leaves unpublished moderated entities alone", async () => {
    const backend = {
      getEntity: vi.fn().mockResolvedValue(moderatedPublished({ status: false, fields: { moderation_state: "draft" } })),
    };
    const attrs = { title: "draft edit" };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "article", id: "n1", attributes: attrs,
    });
    expect(out).toBe(attrs);
  });

  it("applySafeDraftDefault reuses existingEntity and skips getEntity", async () => {
    const backend = { getEntity: vi.fn() };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { field_x: 1 },
      existingEntity: moderatedPublished(),
    });
    expect(out.moderation_state).toBe("draft");
    expect(backend.getEntity).not.toHaveBeenCalled();
  });

  it("applySafeDraftDefault fails open when getEntity throws", async () => {
    const backend = {
      getEntity: vi.fn().mockRejectedValue(new Error("not found")),
    };
    const attrs = { title: "x" };
    const out = await applySafeDraftDefault({
      backend, entityType: "node", bundle: "article", id: "n1", attributes: attrs,
    });
    expect(out).toBe(attrs);
  });
});
