import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addModernCatalogNotifier,
  clearCatalogNotifications,
  emitCatalogListChanged,
  emitIfCatalogAdvertisementChanged,
  registerLiveCatalogServer,
  subscribeCatalogNotifications,
} from "../../src/lib/catalog-notify.js";

afterEach(() => {
  clearCatalogNotifications();
});

describe("catalog-notify", () => {
  it("notifies live servers and modern HTTP notifiers", () => {
    const server = { notification: vi.fn(async () => {}) };
    const modern = { toolsChanged: vi.fn(), promptsChanged: vi.fn() };
    const events = [];
    registerLiveCatalogServer(server);
    addModernCatalogNotifier(modern);
    subscribeCatalogNotifications((event) => events.push(event));

    emitCatalogListChanged({ tools: true, prompts: true });

    expect(events).toEqual([{ tools: true, prompts: true }]);
    expect(server.notification).toHaveBeenCalledWith({ method: "notifications/tools/list_changed" });
    expect(server.notification).toHaveBeenCalledWith({ method: "notifications/prompts/list_changed" });
    expect(modern.toolsChanged).toHaveBeenCalledTimes(1);
    expect(modern.promptsChanged).toHaveBeenCalledTimes(1);
  });

  it("emits only when the advertised set changes", () => {
    const events = [];
    subscribeCatalogNotifications((event) => events.push(event));
    const empty = { ok: false, tools: new Map(), prompts: [] };
    const tools = { ok: true, tools: new Map([["a", { name: "a" }]]), prompts: [] };
    emitIfCatalogAdvertisementChanged(empty, tools);
    emitIfCatalogAdvertisementChanged(tools, tools);
    emitIfCatalogAdvertisementChanged(tools, { ok: true, tools: new Map([["a", { name: "a" }]]), prompts: [{ name: "p" }] });
    expect(events).toEqual([
      { tools: true, prompts: false },
      { tools: false, prompts: true },
    ]);
  });

  it("unregisters a live server on close", () => {
    const server = { notification: vi.fn(async () => {}), onclose: undefined };
    registerLiveCatalogServer(server);
    server.onclose();
    emitCatalogListChanged({ tools: true });
    expect(server.notification).not.toHaveBeenCalled();
  });
});
