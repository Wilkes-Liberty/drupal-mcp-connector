/**
 * Relay frame codec (#232).
 *
 * Length-prefixed JSON frames for the edge/agent channel, promoted from the
 * DEV-293 lab harness (`lab/outbound-relay/harness.js`). Mechanism only — no
 * authentication, entitlement, or header policy lives here.
 *
 * Wire format: 4-byte big-endian payload length, then UTF-8 JSON. A frame
 * must be an object whose `type` is one of `FRAME_TYPES`. Anything else —
 * oversize, malformed JSON, unknown type — tears the channel down rather
 * than passing garbage through.
 */

/** Hard bound on a single frame's JSON payload. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** The only frame types that may cross the channel. */
export const FRAME_TYPES = Object.freeze([
  "hello",
  "hello-ok",
  "denied",
  "mcp-request",
  "mcp-response",
]);

const FRAME_TYPE_SET = new Set(FRAME_TYPES);

/**
 * RFC 9110 hop-by-hop and transport-scoped headers. They describe one TCP
 * connection and are meaningless (or harmful) across the tunnel.
 */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/**
 * Attach the length-prefixed frame reader to a socket.
 *
 * Oversize declarations, malformed JSON, non-object payloads, and unknown
 * frame types destroy the socket; buffered bytes are dropped and no further
 * frames are delivered.
 *
 * @param {import("node:stream").Duplex} socket
 * @param {(frame: object) => void} onFrame
 */
export function attachFramer(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  let dead = false;

  function teardown() {
    dead = true;
    buffer = Buffer.alloc(0);
    socket.destroy();
  }

  socket.on("data", (chunk) => {
    if (dead) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) {
        teardown();
        return;
      }
      if (buffer.length < 4 + size) break;
      const json = buffer.subarray(4, 4 + size).toString("utf8");
      buffer = buffer.subarray(4 + size);
      let frame;
      try {
        frame = JSON.parse(json);
      } catch {
        teardown();
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)
        || !FRAME_TYPE_SET.has(frame.type)) {
        teardown();
        return;
      }
      onFrame(frame);
      if (dead) return;
    }
  });
}

/**
 * Write one frame. Refuses unknown types and oversize payloads by throwing;
 * returns false without writing when the socket is no longer writable.
 *
 * @param {import("node:stream").Duplex} socket
 * @param {object} frame
 * @returns {boolean} True when the frame was written.
 */
export function writeFrame(socket, frame) {
  if (!frame || typeof frame !== "object" || !FRAME_TYPE_SET.has(frame.type)) {
    throw new RangeError("Refusing to write an unknown frame type.");
  }
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new RangeError("Refusing to write a frame beyond the size bound.");
  }
  if (!socket.writable) return false;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
  return true;
}

/**
 * Correlate mcp-request ids with their mcp-response frames.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Per-request wait bound.
 * @returns {{size: number, track: (id: string) => Promise<object>, settle: (frame: {id?: string}) => boolean, rejectAll: (error: Error) => void}}
 */
export function createRequestBroker({ timeoutMs = 10_000 } = {}) {
  const pending = new Map();

  return {
    get size() {
      return pending.size;
    },

    /**
     * @param {string} id
     * @returns {Promise<object>} Resolves with the matching response frame.
     */
    track(id) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Relay fan-down timeout for request ${id}.`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve(frame) {
            clearTimeout(timer);
            resolve(frame);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },

    /**
     * @param {{id?: string}} frame
     * @returns {boolean} True when a tracked request was resolved.
     */
    settle(frame) {
      if (typeof frame?.id !== "string") return false;
      const waiter = pending.get(frame.id);
      if (!waiter) return false;
      pending.delete(frame.id);
      waiter.resolve(frame);
      return true;
    },

    /**
     * @param {Error} error
     */
    rejectAll(error) {
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(error);
      }
    },
  };
}

/**
 * Headers that may cross the tunnel at the transport level: hop-by-hop names
 * are dropped, list values joined. Credential policy (what the edge strips
 * beyond this) lives in edge.js, not here.
 *
 * @param {Record<string, string|string[]|null|undefined>} [headers]
 * @returns {Record<string, string>}
 */
export function forwardHeaders(headers = {}) {
  const entries = [];
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(String(name).toLowerCase())) continue;
    if (value === null || value === undefined) continue;
    entries.push([name, Array.isArray(value) ? value.join(", ") : String(value)]);
  }
  return Object.fromEntries(entries);
}
