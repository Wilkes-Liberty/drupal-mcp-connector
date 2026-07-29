/**
 * Raw SQL is governed server-side, or it does not run.
 *
 * Before this, `drupal_drush_sql_query` shelled out to `drush sql:query`, which
 * executes below Drupal's entity API — the site's policy profile, its denied
 * entity types, its redacted fields and its audit log all had no effect on it.
 * These tests pin the replacement: the tool is off unless the site opts in, and
 * when it is on it goes through mcp_sentinel's governed command, never
 * `sql:query`.
 *
 * A separate file from drush.test.js because these cases need a fake SSH client
 * that can return stdout, which the shared one deliberately does not.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ lastCommand: "", stdout: "", site: null }));

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn(() => state.site),
}));

vi.mock("fs", () => ({ readFileSync: vi.fn(() => Buffer.from("FAKE_KEY")) }));

// Stands in for ssh2's Client. `runRemote` is bound to the name ssh2 calls so
// the shape matches the real client; nothing here spawns a local process.
vi.mock("ssh2", () => {
  class FakeClient {
    on(event, cb) { this._handlers = this._handlers || {}; this._handlers[event] = cb; return this; }

    connect() { queueMicrotask(() => this._handlers.ready && this._handlers.ready()); }

    runRemote = (remoteCommand, cb) => {
      state.lastCommand = remoteCommand;
      const stream = {
        stderr: { on: () => {} },
        on(ev, h) {
          if (ev === "data" && state.stdout) queueMicrotask(() => h(Buffer.from(state.stdout)));
          if (ev === "close") queueMicrotask(() => h(0));
          return stream;
        },
      };
      cb(null, stream);
    };

    constructor() { this.exec = this.runRemote; }

    end() {}
  }
  return { Client: FakeClient };
});

import { handlers } from "../../src/tools/drush.js";
import { SecurityError } from "../../src/lib/security.js";

/** Builds a site whose drushSsh block carries the given overrides. */
function site(drushSsh = {}) {
  return {
    _name: "dev",
    security: { preset: "development" },
    drushSsh: {
      host: "h",
      user: "u",
      keyPath: "~/.ssh/id_ed25519",
      drupalRoot: "/var/www/html/web",
      port: 22,
      ...drushSsh,
    },
  };
}

const GOVERNED_REPLY = JSON.stringify({
  rows: [{ nid: "1", title: "First" }],
  row_count: 1,
  truncated: false,
  profile: "default",
});

beforeEach(() => {
  state.lastCommand = "";
  state.stdout = "";
  state.site = site();
});

describe("raw SQL opt-in", () => {
  it("refuses when the site has not opted in, without opening a connection", async () => {
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "SELECT nid FROM node_field_data" }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(state.lastCommand).toBe("");
  });

  it("names what to enable, on both sides, in the refusal", async () => {
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "SELECT nid FROM node_field_data" }))
      .rejects.toThrow(/allow_raw_sql[\s\S]*rawSql|rawSql[\s\S]*allow_raw_sql/);
  });

  it("has no ungoverned mode — an arbitrary rawSql value is still refused", async () => {
    state.site = site({ rawSql: "raw" });
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "SELECT nid FROM node_field_data" }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(state.lastCommand).toBe("");
  });
});

describe("governed raw SQL", () => {
  beforeEach(() => {
    state.site = site({ rawSql: "governed" });
    state.stdout = GOVERNED_REPLY;
  });

  it("routes through mcp-sentinel:sql-query and never through sql:query", async () => {
    const out = await handlers.drupal_drush_sql_query({
      site: "dev",
      query: "SELECT nid, title FROM node_field_data",
    });

    expect(state.lastCommand).toContain("mcp-sentinel:sql-query");
    expect(state.lastCommand).not.toMatch(/\bsql:query\b/);
    expect(out.rows).toHaveLength(1);
  });

  it("passes the server's governance metadata through to the caller", async () => {
    const out = await handlers.drupal_drush_sql_query({
      site: "dev",
      query: "SELECT nid FROM node_field_data",
    });

    // The caller must be able to see which profile decided, and whether the
    // result was capped — a silently truncated result set reads as the whole
    // answer.
    expect(out.profile).toBe("default");
    expect(out.truncated).toBe(false);
    expect(out.row_count).toBe(1);
  });

  it("fails loudly when the governed command is absent, rather than returning no rows", async () => {
    // What a site without mcp_sentinel (or with an older release) replies:
    // Drush's own "command not found" text, not JSON.
    state.stdout = "Command mcp-sentinel:sql-query was not found.";
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "SELECT nid FROM node_field_data" }))
      .rejects.toThrow(/mcp_sentinel/);
  });

  it("still rejects a non-SELECT locally, before the round trip", async () => {
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "DELETE FROM node_field_data" }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(state.lastCommand).toBe("");
  });

  it("is subject to allowedCommands like every other bridged command", async () => {
    state.site = site({ rawSql: "governed", allowedCommands: ["config:status"] });
    await expect(handlers.drupal_drush_sql_query({ site: "dev", query: "SELECT nid FROM node_field_data" }))
      .rejects.toBeInstanceOf(SecurityError);
  });
});
