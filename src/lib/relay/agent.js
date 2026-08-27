/**
 * Relay tenant agent (#232) — the DEV-294 AC4 slice, tenant side.
 *
 * Dials OUT to the edge's agent channel and serves the real connector server
 * (`createConnectorServerFactory`) over the framed tunnel. The agent never
 * listens: nothing tenant-side accepts an inbound connection, so southbound
 * site credentials exist only in this process.
 *
 * The channel is authenticated with the agent's own issued, revocable
 * credential — distinct from every northbound principal token and from every
 * site credential. Request frames carry the identity the edge validated;
 * a frame without one is refused rather than dispatched, because a null
 * principal downstream would mean "local operator".
 */

import { connect as netConnect } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createConnectorServerFactory } from "../mcp-server.js";
import { runWithIdentity } from "../principal.js";
import { attachFramer, forwardHeaders, writeFrame } from "./frames.js";

/**
 * Create the tenant agent.
 *
 * @param {object} options
 * @param {string} options.host Edge agent-channel host.
 * @param {number} options.port Edge agent-channel port.
 * @param {string} options.token Issued channel credential (raw; the edge
 *   stores only its digest).
 * @param {object} options.surface Connector surface for
 *   `createConnectorServerFactory` — the real tool/resource/prompt surface,
 *   holding the site config and credentials tenant-side.
 * @param {typeof netConnect} [options.connectFn] Injectable dialer (e.g. a
 *   TLS connect wrapper). The agent only ever dials; it never listens.
 * @param {?() => void} [options.onChannelClose] Called when an established
 *   channel is lost (not on deliberate `drop`/`close`), so an entry point
 *   can fail loudly instead of idling disconnected.
 * @param {?{recordConnect: Function}} [options.ledger]
 * @returns {object}
 */
export function createRelayAgent({
  host,
  port,
  token,
  surface,
  connectFn = netConnect,
  onChannelClose = null,
  ledger = null,
}) {
  if (!host || !port) {
    throw new Error("createRelayAgent requires the edge agent-channel host and port.");
  }
  if (!token) {
    throw new Error("createRelayAgent requires an issued channel credential.");
  }
  if (!surface) {
    throw new Error("createRelayAgent requires the connector surface.");
  }

  const handler = createMcpHandler(createConnectorServerFactory(surface), {
    legacy: "reject",
  });
  let socket = null;
  let agentInfo = null;

  async function serveFrame(activeSocket, frame) {
    if (frame.type !== "mcp-request") return;
    if (!frame.identity || typeof frame.identity !== "object" || Array.isArray(frame.identity)) {
      // Fail closed: without the validated identity there is no principal to
      // entitle, and dispatching as null would grant local-operator trust.
      writeFrame(activeSocket, {
        type: "mcp-response",
        id: frame.id,
        status: 403,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "missing_identity" }),
      });
      return;
    }

    let response;
    try {
      const headers = forwardHeaders(frame.headers);
      const body = frame.body === null || frame.body === undefined
        ? undefined
        : (typeof frame.body === "string" ? frame.body : JSON.stringify(frame.body));
      const request = new Request("http://127.0.0.1/mcp", {
        method: frame.method || "POST",
        headers,
        ...(body !== undefined ? { body } : {}),
      });
      response = await runWithIdentity(frame.identity, () => handler.fetch(request));
    } catch {
      writeFrame(activeSocket, {
        type: "mcp-response",
        id: frame.id,
        status: 500,
        headers: {},
        body: "",
      });
      return;
    }
    writeFrame(activeSocket, {
      type: "mcp-response",
      id: frame.id,
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  }

  return {
    get agent() {
      return agentInfo;
    },

    /**
     * Dial out to the edge. The edge never connects here.
     * @returns {Promise<{ok: boolean, reason?: string, agent?: object}>}
     */
    dial() {
      return new Promise((resolve, reject) => {
        ledger?.recordConnect("agent", { host, port });
        const next = connectFn({ host, port }, () => {
          writeFrame(next, { type: "hello", token });
        });
        socket = next;
        let established = false;
        attachFramer(next, (frame) => {
          if (frame.type === "hello-ok") {
            agentInfo = frame.agent ?? null;
            established = true;
            resolve({ ok: true, agent: agentInfo });
            return;
          }
          if (frame.type === "denied") {
            next.end();
            resolve({ ok: false, reason: frame.reason });
            return;
          }
          void serveFrame(next, frame);
        });
        next.on("error", reject);
        next.on("close", () => {
          if (socket === next) {
            socket = null;
            if (established) onChannelClose?.();
          }
        });
      });
    },

    /** Drop the outbound channel without destroying the agent. */
    drop() {
      socket?.destroy();
      socket = null;
    },

    async close() {
      this.drop();
      await handler.close();
    },
  };
}
