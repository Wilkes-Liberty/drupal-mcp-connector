import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(),
  updateEntity: vi.fn(), deleteEntity: vi.fn(), listRoles: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({ globalRedactedFields: [], entityRules: {} })),
    assertReadAllowed: vi.fn(), assertWriteAllowed: vi.fn(), assertDeleteAllowed: vi.fn(),
  };
});

import { handlers } from "../../src/tools/users.js";
import { assertReadAllowed, assertWriteAllowed } from "../../src/lib/security.js";

const user = { id: "u1", entityType: "user", bundle: "user", title: null, status: true,
  langcode: "en", created: null, changed: null, url: null,
  fields: { name: "jane", mail: "j@x.com" }, relationships: { roles: [] }, _backend: "jsonapi" };

beforeEach(() => { Object.values(backend).forEach((f) => f.mockReset()); vi.mocked(assertReadAllowed).mockReset(); vi.mocked(assertWriteAllowed).mockReset(); });

describe("users tools (migrated)", () => {
  it("list_users asserts read access and compiles status into a filter", async () => {
    backend.listEntities.mockResolvedValue({ entities: [user], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_list_users({ status: true, limit: 5 });
    expect(out.total).toBe(1);
    expect(vi.mocked(assertReadAllowed)).toHaveBeenCalledWith(expect.anything(), "user", "user");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "user", bundle: "user" });
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "status", op: "eq", value: true }]));
  });

  it("get_user returns the (redacted) canonical user", async () => {
    backend.getEntity.mockResolvedValue(user);
    const out = await handlers.drupal_get_user({ id: "u1" });
    expect(out.id).toBe("u1");
    expect(vi.mocked(assertReadAllowed)).toHaveBeenCalledWith(expect.anything(), "user", "user");
  });

  it("create_user asserts write, builds attributes + roles relationship", async () => {
    backend.createEntity.mockResolvedValue(user);
    await handlers.drupal_create_user({ name: "jane", mail: "j@x.com", password: "pw", roles: ["r1"] });
    expect(vi.mocked(assertWriteAllowed)).toHaveBeenCalledWith(expect.anything(), "create", "user", "user");
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.name).toBe("jane");
    expect(arg.attributes.pass).toEqual([{ value: "pw" }]);
    expect(arg.relationships.roles.data).toEqual([{ type: "user_role--user_role", id: "r1" }]);
  });

  it("get_user_by_name asserts read, filters by name, throws when not found", async () => {
    backend.listEntities.mockResolvedValue({ entities: [user], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_get_user_by_name({ name: "jane" });
    expect(out.id).toBe("u1");
    expect(vi.mocked(assertReadAllowed)).toHaveBeenCalledWith(expect.anything(), "user", "user");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual([{ field: "name", op: "eq", value: "jane" }]);
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await expect(handlers.drupal_get_user_by_name({ name: "ghost" })).rejects.toThrow(/No user found/);
  });

  it("update_user asserts write, sets only provided fields + pass, builds roles", async () => {
    backend.updateEntity.mockResolvedValue(user);
    await handlers.drupal_update_user({ id: "u1", mail: "n@x.com", password: "pw2", roles: ["r2"] });
    expect(vi.mocked(assertWriteAllowed)).toHaveBeenCalledWith(expect.anything(), "update", "user", "user");
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "user", bundle: "user", id: "u1" });
    expect(arg.attributes.mail).toBe("n@x.com");
    expect(arg.attributes.pass).toEqual([{ value: "pw2" }]);
    expect(arg.attributes).not.toHaveProperty("name");
    expect(arg.relationships.roles.data).toEqual([{ type: "user_role--user_role", id: "r2" }]);
  });

  it("block_user updates status via updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(user);
    await handlers.drupal_block_user({ id: "u1", block: true });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "user", bundle: "user", id: "u1" });
    expect(arg.attributes.status).toBe(false);
  });

  it("list_roles delegates to the backend", async () => {
    backend.listRoles.mockResolvedValue([{ id: "r1", machineName: "editor", label: "Editor", weight: 1 }]);
    const out = await handlers.drupal_list_roles({});
    expect(out[0].machineName).toBe("editor");
  });
});
