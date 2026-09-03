/**
 * Relay frame codec (#232) — promoted from the outbound-relay lab harness.
 *
 * The codec is mechanism only: length-prefixed JSON frames with a hard size
 * bound, teardown on malformed or unknown-type frames, and a request broker
 * for mcp-request/mcp-response correlation. Every deny here is watched:
 * oversize, malformed, unknown type, and timeout all end the channel or the
 * wait — they never pass garbage through.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FRAME_TYPES,
  MAX_FRAME_BYTES,
  attachFramer,
  createRequestBroker,
  forwardHeaders,
  writeFrame,
} from "../../src/lib/relay/frames.js";

function channel() {
  const socket = new PassThrough();
  const frames = [];
  attachFramer(socket, (frame) => frames.push(frame));
  return { socket, frames };
}

function encode(object) {
  const payload = Buffer.from(JSON.stringify(object), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

describe("relay frame codec", () => {
  it("names the protocol frame types", () => {
    expect([...FRAME_TYPES]).toEqual([
      "hello",
      "hello-ok",
      "denied",
      "mcp-request",
      "mcp-response",
      "policy-bundle",
      "policy-bundle-ack",
    ]);
    expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it("reassembles a frame delivered one byte at a time (backpressure)", () => {
    const { socket, frames } = channel();
    const wire = encode({ type: "hello", token: "channel-token-1" });
    for (const byte of wire) {
      socket.write(Buffer.from([byte]));
      if (byte !== wire[wire.length - 1]) expect(frames.length).toBeLessThanOrEqual(0);
    }
    expect(frames).toEqual([{ type: "hello", token: "channel-token-1" }]);
    expect(socket.destroyed).toBe(false);
  });

  it("delivers coalesced frames from a single chunk and holds a trailing partial", () => {
    const { socket, frames } = channel();
    const first = encode({ type: "mcp-request", id: "a" });
    const second = encode({ type: "mcp-response", id: "a", status: 200 });
    const third = encode({ type: "denied", reason: "unauthenticated" });
    // Two whole frames plus the first half of a third, in one data event.
    socket.write(Buffer.concat([first, second, third.subarray(0, 5)]));
    expect(frames).toEqual([
      { type: "mcp-request", id: "a" },
      { type: "mcp-response", id: "a", status: 200 },
    ]);
    // The partial completes on the next chunk.
    socket.write(third.subarray(5));
    expect(frames).toHaveLength(3);
    expect(frames[2]).toEqual({ type: "denied", reason: "unauthenticated" });
  });

  it("tears the channel down when a declared frame exceeds the size bound", () => {
    const { socket, frames } = channel();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    socket.write(header);
    expect(socket.destroyed).toBe(true);
    expect(frames).toEqual([]);
  });

  it("tears the channel down on a malformed JSON frame instead of throwing", () => {
    const { socket, frames } = channel();
    const payload = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
    expect(socket.destroyed).toBe(true);
    expect(frames).toEqual([]);
  });

  it("tears the channel down on an unknown frame type", () => {
    const { socket, frames } = channel();
    socket.write(encode({ type: "not-a-protocol-frame" }));
    expect(socket.destroyed).toBe(true);
    expect(frames).toEqual([]);
  });

  it("tears the channel down on a non-object frame", () => {
    const { socket, frames } = channel();
    socket.write(encode(["hello"]));
    expect(socket.destroyed).toBe(true);
    expect(frames).toEqual([]);
  });

  it("stops delivering after teardown even when valid frames follow", () => {
    const { socket, frames } = channel();
    socket.write(Buffer.concat([
      encode({ type: "not-a-protocol-frame" }),
      encode({ type: "hello", token: "t" }),
    ]));
    expect(socket.destroyed).toBe(true);
    expect(frames).toEqual([]);
  });
});

describe("writeFrame", () => {
  it("round-trips a frame through attachFramer", () => {
    const { socket, frames } = channel();
    expect(writeFrame(socket, { type: "hello-ok", agent: { agentId: "a1" } })).toBe(true);
    expect(frames).toEqual([{ type: "hello-ok", agent: { agentId: "a1" } }]);
  });

  it("refuses to write a frame with an unknown type", () => {
    const { socket, frames } = channel();
    expect(() => writeFrame(socket, { type: "smuggle" })).toThrow(/unknown frame type/i);
    expect(frames).toEqual([]);
  });

  it("refuses to write an oversize frame", () => {
    const { socket, frames } = channel();
    const big = { type: "mcp-response", id: "x", body: "y".repeat(MAX_FRAME_BYTES) };
    expect(() => writeFrame(socket, big)).toThrow(/size bound/i);
    expect(frames).toEqual([]);
  });

  it("is a no-op on a socket that is no longer writable", () => {
    const socket = new PassThrough();
    socket.end();
    expect(writeFrame(socket, { type: "denied", reason: "revoked" })).toBe(false);
  });
});

describe("createRequestBroker", () => {
  it("resolves a tracked id when its response frame arrives", async () => {
    const broker = createRequestBroker({ timeoutMs: 1000 });
    const waited = broker.track("req-1");
    expect(broker.size).toBe(1);
    expect(broker.settle({ type: "mcp-response", id: "req-1", status: 200 })).toBe(true);
    await expect(waited).resolves.toMatchObject({ id: "req-1", status: 200 });
    expect(broker.size).toBe(0);
  });

  it("ignores a response for an unknown id", () => {
    const broker = createRequestBroker({ timeoutMs: 1000 });
    expect(broker.settle({ type: "mcp-response", id: "never-tracked" })).toBe(false);
  });

  it("times out a tracked request", async () => {
    const broker = createRequestBroker({ timeoutMs: 10 });
    await expect(broker.track("req-slow")).rejects.toThrow(/timeout/i);
    expect(broker.size).toBe(0);
  });

  it("rejects every pending request when the channel closes", async () => {
    const broker = createRequestBroker({ timeoutMs: 1000 });
    const one = broker.track("req-1");
    const two = broker.track("req-2");
    broker.rejectAll(new Error("relay channel closed"));
    await expect(one).rejects.toThrow(/channel closed/);
    await expect(two).rejects.toThrow(/channel closed/);
    expect(broker.size).toBe(0);
  });

  it("ignores a response whose owner is not the tracked tenant", async () => {
    const broker = createRequestBroker({ timeoutMs: 1000 });
    const waited = broker.track("req-1", { owner: "tenant-a" });
    expect(broker.settle(
      { type: "mcp-response", id: "req-1", status: 200 },
      { owner: "tenant-b" },
    )).toBe(false);
    expect(broker.settle({ type: "mcp-response", id: "req-1", status: 200 })).toBe(false);
    expect(broker.size).toBe(1);
    expect(broker.settle(
      { type: "mcp-response", id: "req-1", status: 201 },
      { owner: "tenant-a" },
    )).toBe(true);
    await expect(waited).resolves.toMatchObject({ id: "req-1", status: 201 });
    expect(broker.size).toBe(0);
  });

  it("rejects only one owner's pending ids when that tenant disconnects", async () => {
    const broker = createRequestBroker({ timeoutMs: 1000 });
    const a = broker.track("req-a", { owner: "tenant-a" });
    const b = broker.track("req-b", { owner: "tenant-b" });
    broker.rejectByOwner("tenant-a", new Error("tenant-a channel closed"));
    await expect(a).rejects.toThrow(/tenant-a channel closed/);
    expect(broker.size).toBe(1);
    expect(broker.settle(
      { type: "mcp-response", id: "req-b", status: 200 },
      { owner: "tenant-b" },
    )).toBe(true);
    await expect(b).resolves.toMatchObject({ id: "req-b", status: 200 });
  });
});

describe("forwardHeaders", () => {
  it("strips hop-by-hop headers and normalizes values", () => {
    const out = forwardHeaders({
      "Content-Type": "application/json",
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      te: "trailers",
      trailers: "x",
      "transfer-encoding": "chunked",
      upgrade: "h2c",
      "content-length": "42",
      host: "edge.example",
      accept: ["application/json", "text/event-stream"],
      "x-empty": null,
    });
    expect(out).toEqual({
      "Content-Type": "application/json",
      accept: "application/json, text/event-stream",
    });
  });
});
