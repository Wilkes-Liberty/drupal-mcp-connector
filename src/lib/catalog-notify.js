/**
 * Advertise and emit tools/prompts list_changed for catalog snapshots.
 *
 * Delivery is per session, not process-global:
 *   stdio / legacy HTTP 2025-11-25
 *                    That session's `Server.notification` /
 *                    `sendToolListChanged` is unsolicited. A 2025
 *                    initialize only affects that session.
 *   stdio 2026-07-28
 *                    `subscriptions/listen` on that stdio connection,
 *                    held on the transport until the Server is
 *                    registered (listen can arrive first).
 *   modern HTTP 2026-07-28
 *                    Sessionless POST and per-request Servers cannot
 *                    be bound to a listen stream. Always the long
 *                    (unnotified) wait. One client's listen must not
 *                    shorten another client's first list.
 */

/** Debounce window so a cold-start burst coalesces to one emit per kind. */
export const CATALOG_NOTIFY_DEBOUNCE_MS = 50;

/** @type {Set<{notification?: Function, sendToolListChanged?: Function, sendPromptListChanged?: Function}>} */
const liveServers = new Set();

/** @type {Set<{toolsChanged?: Function, promptsChanged?: Function}>} */
const modernNotifiers = new Set();

/** @type {Set<(event: {tools: boolean, prompts: boolean}) => void>} */
const listeners = new Set();

/**
 * Per-server delivery: listen ids and whether this session negotiated
 * unsolicited 2025 list_changed.
 *
 * @type {WeakMap<object, {listenIds: Set<*>, legacyUnsolicited: boolean}>}
 */
const catalogSessions = new WeakMap();

/**
 * Stdio transport whose inbound messages are trapped before serveStdio
 * pins a Server. Listen ids live here until {@link registerLiveCatalogServer}.
 *
 * @type {{listenIds: Set<*>, legacyUnsolicited: boolean}|null}
 */
let stdioPending = null;

/** @type {object|null} */
let stdioBoundServer = null;

let pendingTools = false;
let pendingPrompts = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let debounceTimer = null;

/**
 * Whether `version` is a 2025-era protocol that delivers unsolicited list_changed.
 *
 * @param {string|null|undefined} version
 * @returns {boolean}
 */
export function isLegacyUnsolicitedProtocol(version) {
  return typeof version === "string" && version.startsWith("2025-");
}

/**
 * Delivery state for one MCP `Server` (stdio connection or HTTP session).
 *
 * @param {object} server
 * @returns {{listenIds: Set<*>, legacyUnsolicited: boolean}}
 */
function catalogSessionOf(server) {
  let session = catalogSessions.get(server);
  if (!session) {
    session = { listenIds: new Set(), legacyUnsolicited: false };
    catalogSessions.set(server, session);
  }
  return session;
}

/**
 * Whether this listen filter asked for tools or prompts list_changed.
 *
 * @param {object|null|undefined} notifications
 * @returns {boolean}
 */
function wantsCatalogListChanged(notifications) {
  return Boolean(notifications?.toolsListChanged || notifications?.promptsListChanged);
}

/**
 * Apply one inbound JSON-RPC message to a session's delivery tracking.
 *
 * @param {{listenIds: Set<*>, legacyUnsolicited: boolean}} session
 * @param {{method?: string, id?: *, params?: object}} message
 * @returns {void}
 */
function applyCatalogSessionMessage(session, message, server) {
  if (message.method === "initialize") {
    // 2026 initialize is not unsolicited delivery. StdioListenRouter drops
    // list_changed unless subscriptions/listen is open. A 2025 initialize
    // only marks this session; a sibling that already negotiated 2026 is
    // left on the long wait.
    if (isLegacyUnsolicitedProtocol(message.params?.protocolVersion)) {
      const version = typeof server?.getNegotiatedProtocolVersion === "function"
        ? server.getNegotiatedProtocolVersion()
        : undefined;
      if (!version || isLegacyUnsolicitedProtocol(version)) {
        session.legacyUnsolicited = true;
      }
    }
    return;
  }
  if (message.method === "subscriptions/listen") {
    if (wantsCatalogListChanged(message.params?.notifications)
        && message.id !== undefined && message.id !== null) {
      session.listenIds.add(message.id);
    }
    return;
  }
  if (message.method === "notifications/cancelled") {
    const id = message.params?.requestId;
    if (id !== undefined && id !== null) session.listenIds.delete(id);
  }
}

/**
 * Record an inbound JSON-RPC message for catalog delivery tracking.
 * When `server` is omitted (stdio transport trap), the message is held on
 * the stdio pending state and copied onto the Server that
 * {@link registerLiveCatalogServer} binds after `observeStdio`. Listen can
 * arrive before that Server exists. Never applied to a sibling HTTP session.
 *
 * @param {{method?: string, id?: *, params?: object}|null|undefined} message
 * @param {object|null|undefined} [server]
 * @returns {void}
 */
export function noteInboundCatalogSessionMessage(message, server) {
  if (!message || typeof message !== "object") return;
  if (server) {
    applyCatalogSessionMessage(catalogSessionOf(server), message, server);
    return;
  }
  if (stdioPending) applyCatalogSessionMessage(stdioPending, message);
  if (stdioBoundServer) {
    applyCatalogSessionMessage(catalogSessionOf(stdioBoundServer), message, stdioBoundServer);
  }
}

/**
 * Copy stdio transport-held listen state onto a newly registered Server.
 *
 * @param {object} server
 * @returns {void}
 */
function bindStdioPendingToServer(server) {
  if (!stdioPending || stdioBoundServer) return;
  stdioBoundServer = server;
  const session = catalogSessionOf(server);
  for (const id of stdioPending.listenIds) session.listenIds.add(id);
  if (stdioPending.legacyUnsolicited) session.legacyUnsolicited = true;
}

/**
 * Whether list_changed can reach this session. A 2025 session only
 * affects itself. Modern HTTP has no per-session listen binding (the
 * handler bus is process-global), so 2026 HTTP always takes the long wait.
 *
 * @param {{getNegotiatedProtocolVersion?: Function}|null|undefined} [server]
 * @returns {boolean}
 */
export function catalogChangeCanReachClient(server) {
  if (!server) return false;
  const version = typeof server.getNegotiatedProtocolVersion === "function"
    ? server.getNegotiatedProtocolVersion()
    : undefined;
  if (isLegacyUnsolicitedProtocol(version)) return true;
  const session = catalogSessions.get(server);
  if (session?.legacyUnsolicited) return true;
  if (session?.listenIds.size > 0) return true;
  if (server === stdioBoundServer && stdioPending?.listenIds.size > 0) return true;
  return false;
}

/**
 * Watch a stdio transport for initialize / listen and run `onShutdown` when
 * stdin or the transport closes. `serveStdio` assigns `onmessage` / `onclose`
 * after this trap is installed.
 *
 * @param {object} transport
 * @param {() => void} [onShutdown]
 * @returns {void}
 */
export function observeStdioCatalogTransport(transport, onShutdown) {
  if (!transport || typeof transport !== "object") return;
  stdioPending = { listenIds: new Set(), legacyUnsolicited: false };
  stdioBoundServer = null;
  let onmessage;
  let onclose;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get() {
      return onmessage;
    },
    set(fn) {
      onmessage = (message, extra) => {
        noteInboundCatalogSessionMessage(message);
        return fn?.(message, extra);
      };
    },
  });
  Object.defineProperty(transport, "onclose", {
    configurable: true,
    enumerable: true,
    get() {
      return onclose;
    },
    set(fn) {
      onclose = () => {
        try {
          onShutdown?.();
        } catch {
          // Shutdown must not throw back into the transport.
        }
        fn?.();
      };
    },
  });
}

/**
 * Register a connected MCP `Server` (stdio or legacy HTTP session).
 *
 * @param {{notification?: Function, onclose?: Function}} server
 * @returns {() => void}
 */
export function registerLiveCatalogServer(server) {
  if (!server) return () => {};
  liveServers.add(server);
  bindStdioPendingToServer(server);
  const previous = server.onclose;
  server.onclose = () => {
    liveServers.delete(server);
    if (stdioBoundServer === server) stdioBoundServer = null;
    if (typeof previous === "function") previous.call(server);
  };
  return () => {
    liveServers.delete(server);
    if (stdioBoundServer === server) stdioBoundServer = null;
  };
}

/**
 * Register the modern HTTP `createMcpHandler` notifier (or a notify-only stub).
 * Listen streams on the handler bus are not used for the listing wait:
 * they are process-global and would shorten a sibling 2026 client's first list.
 *
 * @param {{toolsChanged?: Function, promptsChanged?: Function, notify?: object}|null|undefined} notifyOrHandler
 * @returns {() => void}
 */
export function addModernCatalogNotifier(notifyOrHandler) {
  if (!notifyOrHandler) return () => {};
  const notify = notifyOrHandler.notify && typeof notifyOrHandler.notify.toolsChanged === "function"
    ? notifyOrHandler.notify
    : notifyOrHandler;
  if (typeof notify?.toolsChanged !== "function" && typeof notify?.promptsChanged !== "function") {
    return () => {};
  }
  modernNotifiers.add(notify);
  return () => {
    modernNotifiers.delete(notify);
  };
}

/**
 * Test / operator hook for catalog change events.
 *
 * @param {(event: {tools: boolean, prompts: boolean}) => void} fn
 * @returns {() => void}
 */
export function subscribeCatalogNotifications(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Drop live servers, modern notifiers, subscribers, and delivery tracking (tests).
 *
 * @returns {void}
 */
export function clearCatalogNotifications() {
  liveServers.clear();
  modernNotifiers.clear();
  listeners.clear();
  stdioPending = null;
  stdioBoundServer = null;
  pendingTools = false;
  pendingPrompts = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Dispatch coalesced list_changed to every registered transport.
 *
 * @param {{tools: boolean, prompts: boolean}} event
 * @returns {void}
 */
function dispatchCatalogListChanged(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A subscriber must not block the others.
    }
  }
  if (event.tools) {
    for (const server of liveServers) {
      if (typeof server.sendToolListChanged === "function") {
        Promise.resolve(server.sendToolListChanged()).catch(() => {});
      } else {
        Promise.resolve(server.notification?.({ method: "notifications/tools/list_changed" })).catch(() => {});
      }
    }
    for (const notify of modernNotifiers) {
      try {
        notify.toolsChanged?.();
      } catch {
        // A closed handler must not block the others.
      }
    }
  }
  if (event.prompts) {
    for (const server of liveServers) {
      if (typeof server.sendPromptListChanged === "function") {
        Promise.resolve(server.sendPromptListChanged()).catch(() => {});
      } else {
        Promise.resolve(server.notification?.({ method: "notifications/prompts/list_changed" })).catch(() => {});
      }
    }
    for (const notify of modernNotifiers) {
      try {
        notify.promptsChanged?.();
      } catch {
        // A closed handler must not block the others.
      }
    }
  }
}

/**
 * Flush a pending debounce immediately (tests, shutdown).
 *
 * @returns {void}
 */
export function flushCatalogListChanged() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!pendingTools && !pendingPrompts) return;
  const event = { tools: pendingTools, prompts: pendingPrompts };
  pendingTools = false;
  pendingPrompts = false;
  dispatchCatalogListChanged(event);
}

/**
 * Emit list_changed on every registered transport that can carry it.
 * A burst of site completions coalesces to about one notification per kind.
 *
 * @param {{tools?: boolean, prompts?: boolean}} [change]
 * @returns {void}
 */
export function emitCatalogListChanged({ tools = false, prompts = false } = {}) {
  if (!tools && !prompts) return;
  pendingTools = pendingTools || Boolean(tools);
  pendingPrompts = pendingPrompts || Boolean(prompts);
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushCatalogListChanged();
  }, CATALOG_NOTIFY_DEBOUNCE_MS);
  if (typeof debounceTimer.unref === "function") debounceTimer.unref();
}

/**
 * Compare two snapshots and emit when the advertised tool or prompt set changes.
 *
 * @param {{ok?: boolean, tools?: Map<string, object>, prompts?: object[]}|null|undefined} previous
 * @param {{ok?: boolean, tools?: Map<string, object>, prompts?: object[]}|null|undefined} next
 * @returns {void}
 */
export function emitIfCatalogAdvertisementChanged(previous, next) {
  const before = advertisementSignature(previous);
  const after = advertisementSignature(next);
  const tools = before.tools !== after.tools;
  const prompts = before.prompts !== after.prompts;
  if (tools || prompts) emitCatalogListChanged({ tools, prompts });
}

/**
 * Stable advertised-name signature. An omitted or unverified snapshot is empty.
 *
 * @param {{ok?: boolean, tools?: Map<string, object>, prompts?: object[]}|null|undefined} snapshot
 * @returns {{tools: string, prompts: string}}
 */
function advertisementSignature(snapshot) {
  if (!snapshot?.ok) return { tools: "", prompts: "" };
  const tools = snapshot.tools instanceof Map
    ? [...snapshot.tools.keys()].sort().join("\0")
    : "";
  const prompts = Array.isArray(snapshot.prompts)
    ? snapshot.prompts.map((prompt) => prompt?.name).filter(Boolean).sort().join("\0")
    : "";
  return { tools, prompts };
}
