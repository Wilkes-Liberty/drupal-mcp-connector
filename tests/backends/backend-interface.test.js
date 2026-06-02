import { describe, it, expect } from "vitest";
import { Backend } from "../../src/lib/backends/backend-interface.js";

describe("Backend base class", () => {
  it("throws for unimplemented methods", async () => {
    const b = new Backend();
    await expect(b.listEntities({})).rejects.toThrow(/not implemented/i);
    await expect(b.getEntity({})).rejects.toThrow(/not implemented/i);
    expect(() => b.capabilities()).toThrow(/not implemented/i);
  });

  it("every interface method is unimplemented on the base class", async () => {
    const b = new Backend();
    const syncMethods = ["capabilities", "resolveFieldName"];
    const asyncMethods = [
      "listEntities", "getEntity", "createEntity", "updateEntity",
      "deleteEntity", "introspect", "listContentTypes",
    ];
    for (const m of syncMethods) {
      expect(() => b[m]()).toThrow(/not implemented/i);
    }
    for (const m of asyncMethods) {
      await expect(b[m]()).rejects.toThrow(/not implemented/i);
    }
  });

  it("rawQuery is unimplemented on the base class", async () => {
    const b = new Backend();
    await expect(b.rawQuery({})).rejects.toThrow(/not implemented/i);
  });
});
