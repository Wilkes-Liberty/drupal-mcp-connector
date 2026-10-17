/**
 * Kill-cancel through a real fetch. This file must not mock node-fetch.
 */

import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { drupalFetch } from "../../src/lib/drupal-fetch.js";
import {
  createInFlightRegistry,
  inFlightKeysFromIdentity,
  setInFlightRegistry,
} from "../../src/lib/in-flight.js";
import { GENERIC_PRINCIPAL_REFUSAL } from "../../src/lib/principal-context.js";
import { runWithIdentity } from "../../src/lib/principal.js";
import { SecurityError } from "../../src/lib/security.js";

const identity = {
  iss: "https://idp.example/realms/agents",
  sub: "human-1",
  azp: "agent-client",
  tenant: "tenant-a",
  scopes: ["mcp_write"],
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

describe("kill-cancel through a real fetch", () => {
  afterEach(() => {
    setInFlightRegistry(null);
  });

  it("aborts a hanging JSON:API write with the generic deny", async () => {
    const registry = createInFlightRegistry({ maxEntries: 8 });
    setInFlightRegistry(registry);
    const keys = inFlightKeysFromIdentity(identity);
    const flight = registry.begin(keys);
    const server = createServer(() => {
      // Never respond: the cancel signal must win.
    });
    const port = await listen(server);
    try {
      const pending = runWithIdentity(identity, () => drupalFetch(
        { _name: "t", baseUrl: `http://127.0.0.1:${port}` },
        "/jsonapi/node/article",
        { method: "POST", body: "{}" },
      ), {
        surface: "network",
        bearer: "tok-live",
        introspect: async () => ({ active: true }),
        abortSignal: flight.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(registry.cancel(keys)).toBe(1);
      await expect(pending).rejects.toThrow(SecurityError);
      try {
        await pending;
      } catch (err) {
        expect(err.message).toBe(GENERIC_PRINCIPAL_REFUSAL);
        expect(err.message).not.toMatch(/human-1|agent-client|tok-live/);
      }
    } finally {
      server.close();
    }
  });

  it("maps a kill during the JSON:API body read to the generic deny", async () => {
    const registry = createInFlightRegistry({ maxEntries: 8 });
    setInFlightRegistry(registry);
    const keys = inFlightKeysFromIdentity(identity);
    const flight = registry.begin(keys);
    let headersSent = () => {};
    const headers = new Promise((resolve) => { headersSent = resolve; });
    const server = createServer((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/vnd.api+json" });
      headersSent();
      // Headers only: the body stream stays open until the kill aborts it.
    });
    const port = await listen(server);
    try {
      const pending = runWithIdentity(identity, () => drupalFetch(
        { _name: "t", baseUrl: `http://127.0.0.1:${port}` },
        "/jsonapi/node/article",
        { method: "POST", body: "{}" },
      ), {
        surface: "network",
        bearer: "tok-live",
        introspect: async () => ({ active: true }),
        abortSignal: flight.signal,
      });
      await headers;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(registry.cancel(keys)).toBe(1);
      await expect(pending).rejects.toThrow(GENERIC_PRINCIPAL_REFUSAL);
    } finally {
      server.close();
    }
  });

  it("keeps the kill signal when a caller signal is also supplied", async () => {
    const registry = createInFlightRegistry({ maxEntries: 8 });
    setInFlightRegistry(registry);
    const keys = inFlightKeysFromIdentity(identity);
    const flight = registry.begin(keys);
    const caller = new AbortController();
    const server = createServer(() => {
      // Never respond: the kill signal must win over the caller signal.
    });
    const port = await listen(server);
    try {
      const pending = runWithIdentity(identity, () => drupalFetch(
        { _name: "t", baseUrl: `http://127.0.0.1:${port}` },
        "/jsonapi/node/article",
        { method: "POST", body: "{}", signal: caller.signal },
      ), {
        surface: "network",
        bearer: "tok-live",
        introspect: async () => ({ active: true }),
        abortSignal: flight.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(registry.cancel(keys)).toBe(1);
      await expect(pending).rejects.toThrow(GENERIC_PRINCIPAL_REFUSAL);
      expect(caller.signal.aborted).toBe(false);
    } finally {
      server.close();
    }
  });
});
