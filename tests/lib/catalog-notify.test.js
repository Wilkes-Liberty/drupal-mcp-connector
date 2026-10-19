import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addModernCatalogNotifier,
  CATALOG_NOTIFY_DEBOUNCE_MS,
  catalogChangeCanReachClient,
  clearCatalogNotifications,
  emitCatalogListChanged,
  emitIfCatalogAdvertisementChanged,
  flushCatalogListChanged,
  isLegacyUnsolicitedProtocol,
  noteInboundCatalogSessionMessage,
  observeStdioCatalogTransport,
  registerLiveCatalogServer,
  subscribeCatalogNotifications,
} from "../../src/lib/catalog-notify.js";
import { catalogListWaitMs, DEFAULT_UNNOTIFIED_LIST_WAIT_MS } from "../../src/lib/site-catalog.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  clearCatalogNotifications();
});

describe("catalog-notify", () => {
  it("notifies live servers and modern HTTP notifiers", async () => {
    const server = {
      notification: vi.fn(async () => {}),
      sendToolListChanged: vi.fn(async () => {}),
      sendPromptListChanged: vi.fn(async () => {}),
    };
    const modern = { toolsChanged: vi.fn(), promptsChanged: vi.fn() };
    const events = [];
    registerLiveCatalogServer(server);
    addModernCatalogNotifier(modern);
    subscribeCatalogNotifications((event) => events.push(event));

    emitCatalogListChanged({ tools: true, prompts: true });
    await delay(CATALOG_NOTIFY_DEBOUNCE_MS + 20);

    expect(events).toEqual([{ tools: true, prompts: true }]);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(server.sendPromptListChanged).toHaveBeenCalledTimes(1);
    expect(modern.toolsChanged).toHaveBeenCalledTimes(1);
    expect(modern.promptsChanged).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one notification per kind", async () => {
    const events = [];
    subscribeCatalogNotifications((event) => events.push(event));
    for (let i = 0; i < 13; i++) emitCatalogListChanged({ tools: true });
    for (let i = 0; i < 13; i++) emitCatalogListChanged({ prompts: true });
    expect(events).toEqual([]);
    await delay(CATALOG_NOTIFY_DEBOUNCE_MS + 20);
    expect(events).toEqual([{ tools: true, prompts: true }]);
  });

  it("emits only when the advertised set changes", async () => {
    const events = [];
    subscribeCatalogNotifications((event) => events.push(event));
    const empty = { ok: false, tools: new Map(), prompts: [] };
    const tools = { ok: true, tools: new Map([["a", { name: "a" }]]), prompts: [] };
    emitIfCatalogAdvertisementChanged(empty, tools);
    flushCatalogListChanged();
    emitIfCatalogAdvertisementChanged(tools, tools);
    emitIfCatalogAdvertisementChanged(tools, { ok: true, tools: new Map([["a", { name: "a" }]]), prompts: [{ name: "p" }] });
    flushCatalogListChanged();
    expect(events).toEqual([
      { tools: true, prompts: false },
      { tools: false, prompts: true },
    ]);
  });

  it("unregisters a live server on close", async () => {
    const server = { notification: vi.fn(async () => {}), onclose: undefined };
    registerLiveCatalogServer(server);
    server.onclose();
    emitCatalogListChanged({ tools: true });
    flushCatalogListChanged();
    expect(server.notification).not.toHaveBeenCalled();
  });

  it("unregisters a modern notifier when detach runs", () => {
    const modern = { toolsChanged: vi.fn(), promptsChanged: vi.fn() };
    const detach = addModernCatalogNotifier(modern);
    detach();
    emitCatalogListChanged({ tools: true, prompts: true });
    flushCatalogListChanged();
    expect(modern.toolsChanged).not.toHaveBeenCalled();
    expect(modern.promptsChanged).not.toHaveBeenCalled();
  });

  it("treats a 2025 session as unsolicited list_changed delivery for that session only", () => {
    const legacy = { getNegotiatedProtocolVersion: () => "2025-11-25" };
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    registerLiveCatalogServer(legacy);
    registerLiveCatalogServer(modern);
    noteInboundCatalogSessionMessage({
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
      id: 1,
    }, legacy);
    expect(isLegacyUnsolicitedProtocol("2025-11-25")).toBe(true);
    expect(catalogChangeCanReachClient(legacy)).toBe(true);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(legacy)).toBe(4000);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
  });

  it("does not treat 2026 initialize as unsolicited list_changed delivery", () => {
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    registerLiveCatalogServer(modern);
    noteInboundCatalogSessionMessage({
      method: "initialize",
      params: { protocolVersion: "2026-07-28" },
    }, modern);
    expect(isLegacyUnsolicitedProtocol("2026-07-28")).toBe(false);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogChangeCanReachClient()).toBe(false);
  });

  it("treats 2026 listen as delivery on that session and restores after cancel", () => {
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    registerLiveCatalogServer(modern);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    noteInboundCatalogSessionMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true, promptsListChanged: true } },
    }, modern);
    expect(catalogChangeCanReachClient(modern)).toBe(true);
    expect(catalogListWaitMs(modern)).toBe(4000);
    noteInboundCatalogSessionMessage({
      method: "notifications/cancelled",
      params: { requestId: 7 },
    }, modern);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
  });

  it("does not let a 2025 initialize flip a sibling 2026 session to the short wait", () => {
    const legacy = { getNegotiatedProtocolVersion: () => "2025-11-25" };
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    const unset = { getNegotiatedProtocolVersion: () => undefined };
    registerLiveCatalogServer(legacy);
    registerLiveCatalogServer(modern);
    registerLiveCatalogServer(unset);
    noteInboundCatalogSessionMessage({
      method: "initialize",
      params: { protocolVersion: "2026-07-28" },
    }, unset);
    noteInboundCatalogSessionMessage({
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    }, legacy);
    expect(catalogListWaitMs(legacy)).toBe(4000);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    expect(catalogChangeCanReachClient(unset)).toBe(false);
    expect(catalogListWaitMs(unset)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
  });

  it("does not treat a process-global HTTP listen bus as delivery for a 2026 session", () => {
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    const listeners = new Set();
    const handler = {
      notify: { toolsChanged: vi.fn(), promptsChanged: vi.fn() },
      bus: {
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        get listenerCount() {
          return listeners.size;
        },
      },
    };
    addModernCatalogNotifier(handler);
    registerLiveCatalogServer(modern);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const unsub = handler.bus.subscribe(() => {});
    expect(listeners.size).toBe(1);
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    unsub();
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
  });

  it("holds a stdio listen that arrives before the Server is registered", () => {
    const transport = {};
    observeStdioCatalogTransport(transport);
    transport.onmessage = () => {};
    transport.onmessage({
      jsonrpc: "2.0",
      id: 9,
      method: "subscriptions/listen",
      params: { notifications: { toolsListChanged: true, promptsListChanged: true } },
    });
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    expect(catalogChangeCanReachClient(modern)).toBe(false);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    registerLiveCatalogServer(modern);
    expect(catalogChangeCanReachClient(modern)).toBe(true);
    expect(catalogListWaitMs(modern)).toBe(4000);
  });

  it("runs shutdown when the observed stdio transport closes", () => {
    const server = { getNegotiatedProtocolVersion: () => "2025-11-25" };
    registerLiveCatalogServer(server);
    const transport = {};
    const shutdown = vi.fn();
    observeStdioCatalogTransport(transport, shutdown);
    let inbound = 0;
    transport.onmessage = () => {
      inbound += 1;
    };
    transport.onclose = () => {};
    transport.onmessage({ method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(inbound).toBe(1);
    expect(catalogChangeCanReachClient(server)).toBe(true);
    transport.onclose();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
