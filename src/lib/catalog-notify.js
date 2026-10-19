/**
 * Advertise and emit tools/prompts list_changed for catalog snapshots.
 *
 * Transports:
 *   stdio            Live `Server` from serveStdio — `Server.notification`.
 *   legacy HTTP      Sessionful `Server` from openSession — same path.
 *   modern HTTP      `createMcpHandler.notify` reaches clients that opened
 *                    `subscriptions/listen`. A sessionless POST has no stream,
 *                    so the client sees the new catalog on the next list.
 */

/** @type {Set<{notification?: Function}>} */
const liveServers = new Set();

/** @type {Set<{toolsChanged?: Function, promptsChanged?: Function}>} */
const modernNotifiers = new Set();

/** @type {Set<(event: {tools: boolean, prompts: boolean}) => void>} */
const listeners = new Set();

/**
 * Register a connected MCP `Server` (stdio or legacy HTTP session).
 *
 * @param {{notification?: Function, onclose?: Function}} server
 * @returns {() => void}
 */
export function registerLiveCatalogServer(server) {
  if (!server) return () => {};
  liveServers.add(server);
  const previous = server.onclose;
  server.onclose = () => {
    liveServers.delete(server);
    if (typeof previous === "function") previous.call(server);
  };
  return () => liveServers.delete(server);
}

/**
 * Register the modern HTTP `createMcpHandler` notifier.
 *
 * @param {{toolsChanged?: Function, promptsChanged?: Function}|null|undefined} notify
 * @returns {() => void}
 */
export function addModernCatalogNotifier(notify) {
  if (!notify) return () => {};
  modernNotifiers.add(notify);
  return () => modernNotifiers.delete(notify);
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
 * Drop live servers, modern notifiers, and subscribers (tests).
 *
 * @returns {void}
 */
export function clearCatalogNotifications() {
  liveServers.clear();
  modernNotifiers.clear();
  listeners.clear();
}

/**
 * Emit list_changed on every registered transport that can carry it.
 *
 * @param {{tools?: boolean, prompts?: boolean}} [change]
 * @returns {void}
 */
export function emitCatalogListChanged({ tools = false, prompts = false } = {}) {
  if (!tools && !prompts) return;
  const event = { tools: Boolean(tools), prompts: Boolean(prompts) };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A subscriber must not block the others.
    }
  }
  if (tools) {
    for (const server of liveServers) {
      Promise.resolve(server.notification?.({ method: "notifications/tools/list_changed" })).catch(() => {});
    }
    for (const notify of modernNotifiers) {
      try {
        notify.toolsChanged?.();
      } catch {
        // A closed handler must not block the others.
      }
    }
  }
  if (prompts) {
    for (const server of liveServers) {
      Promise.resolve(server.notification?.({ method: "notifications/prompts/list_changed" })).catch(() => {});
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
