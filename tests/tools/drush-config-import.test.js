/**
 * drupal_drush_config_import refuses an import that would change
 * core.extension, because such an import can uninstall a protected module and
 * the connector cannot see which ones (#349).
 *
 * A separate file from drush.test.js because these cases need a per-test site
 * and a fake SSH client that answers each Drush subcommand differently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ commands: [], replies: {}, site: null }));

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn(() => state.site),
}));

vi.mock("fs", () => ({ readFileSync: vi.fn(() => Buffer.from("FAKE_KEY")) }));

// Stands in for ssh2's Client; nothing here spawns a local process. The reply
// is chosen by the Drush subcommand named in the remote command line.
vi.mock("ssh2", () => {
  class FakeClient {
    on(event, cb) { this._handlers = this._handlers || {}; this._handlers[event] = cb; return this; }
    connect() { queueMicrotask(() => this._handlers.ready && this._handlers.ready()); }

    runRemote = (remoteCommand, cb) => {
      state.commands.push(remoteCommand);
      const key = Object.keys(state.replies).find((name) => remoteCommand.includes(`'${name}'`));
      const reply = { stdout: "", stderr: "", exitCode: 0, ...(key ? state.replies[key] : {}) };
      const stream = {
        stderr: { on: (ev, h) => { if (ev === "data" && reply.stderr) queueMicrotask(() => h(Buffer.from(reply.stderr))); } },
        on(ev, h) {
          if (ev === "data" && reply.stdout) queueMicrotask(() => h(Buffer.from(reply.stdout)));
          if (ev === "close") setTimeout(() => h(reply.exitCode), 0);
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

import { handlers, definitions } from "../../src/tools/drush.js";
import { SecurityError, getSecuritySummary } from "../../src/lib/security.js";

function site(security = {}, drushSsh = {}) {
  return {
    _name: "dev",
    security: { preset: "development", ...security },
    drushSsh: { host: "h", user: "u", keyPath: "~/.ssh/id_ed25519", drupalRoot: "/var/www/html/web", port: 22, ...drushSsh },
  };
}

const runImport = () => handlers.drupal_drush_config_import({ site: "dev" });
const status = (rows) => ({ stdout: JSON.stringify(rows) });
const ran = (subcommand) => state.commands.filter((command) => command.includes(`'${subcommand}'`)).length;

beforeEach(() => {
  state.commands = [];
  state.replies = {};
  state.site = site();
});

describe("drupal_drush_config_import core.extension guard (#349)", () => {
  it("reads config:status first and imports when core.extension is unchanged", async () => {
    state.replies["config:status"] = status({
      "system.site": { name: "system.site", state: "Different" },
      "views.view.frontpage": { name: "views.view.frontpage", state: "Only in sync dir" },
    });
    await expect(runImport()).resolves.toEqual({ success: true, message: "Configuration imported from sync directory." });
    expect(state.commands).toHaveLength(2);
    expect(state.commands[0]).toContain("'config:status' '--format=json'");
    expect(state.commands[1]).toContain("'config:import'");
  });

  it("imports when Drush reports no differences", async () => {
    for (const stdout of ["", "[]", "{}"]) {
      state.commands = [];
      state.replies["config:status"] = { stdout };
      await expect(runImport()).resolves.toMatchObject({ success: true });
      expect(ran("config:import")).toBe(1);
    }
  });

  it.each([
    ["an object keyed by name", { "core.extension": { name: "core.extension", state: "Different" }, "system.site": { name: "system.site", state: "Different" } }],
    ["an object of name to state", { "core.extension": "Different" }],
    ["a list of rows", [{ name: "system.site", state: "Different" }, { name: "core.extension", state: "Different" }]],
    ["a row that says only in sync dir", [{ name: "core.extension", state: "Only in sync dir" }]],
    ["a row with a padded name", [{ name: " core.extension ", state: "Different" }]],
    ["an object keyed by row index", { 0: { name: "system.site", state: "Different" }, 1: { name: "core.extension", state: "Different" } }],
  ])("refuses the import when core.extension differs (%s)", async (_label, rows) => {
    state.replies["config:status"] = status(rows);
    await expect(runImport()).rejects.toBeInstanceOf(SecurityError);
    expect(ran("config:import")).toBe(0);
  });

  it("says why, names the module tools and the opt-in key, and does not claim to know which modules", async () => {
    state.replies["config:status"] = status({ "core.extension": { name: "core.extension", state: "Different" } });
    const message = await runImport().then(() => "", (err) => err.message);
    expect(message).toMatch(/core\.extension differs/);
    expect(message).toMatch(/cannot read the sync directory/);
    expect(message).toMatch(/drupal_drush_module_enable/);
    expect(message).toMatch(/drupal_drush_module_disable/);
    expect(message).toMatch(/security\.allowCoreExtensionChange/);
    expect(message).toMatch(/Nothing was imported/);
  });

  it("fails closed when config:status cannot be read", async () => {
    state.replies["config:status"] = { exitCode: 1, stderr: "Bootstrap failed in /var/www/html/web" };
    const message = await runImport().then(() => "", (err) => err.message);
    expect(message).toMatch(/could not be checked/);
    expect(message).toMatch(/Nothing was imported/);
    expect(ran("config:import")).toBe(0);
  });

  it.each([
    ["text that is not JSON", "Configuration differs"],
    ["a JSON scalar", "true"],
    ["a JSON number", "3"],
    ["rows with no name", JSON.stringify([{ state: "Different" }])],
    ["a list of scalars", JSON.stringify(["core.extension"])],
  ])("fails closed when config:status output is %s", async (_label, stdout) => {
    state.replies["config:status"] = { stdout };
    await expect(runImport()).rejects.toBeInstanceOf(SecurityError);
    expect(ran("config:import")).toBe(0);
  });

  it("fails closed when the allowlist has config:import but not config:status", async () => {
    state.site = site({}, { allowedCommands: ["config:import"] });
    const message = await runImport().then(() => "", (err) => err.message);
    expect(message).toMatch(/config:status/);
    expect(message).toMatch(/allowedCommands/);
    expect(state.commands).toEqual([]);
  });

  it("runs with an allowlist that has both commands", async () => {
    state.site = site({}, { allowedCommands: ["config:import", "config:status"] });
    state.replies["config:status"] = status({ "system.site": { name: "system.site", state: "Different" } });
    await expect(runImport()).resolves.toMatchObject({ success: true });
  });

  it("is strict on every preset that can reach the tool", async () => {
    for (const preset of ["development", "content-editor", "config-editor", "write-plane"]) {
      state.commands = [];
      state.site = site({ preset, readOnly: false });
      state.replies["config:status"] = status({ "core.extension": { name: "core.extension", state: "Different" } });
      await expect(runImport()).rejects.toBeInstanceOf(SecurityError);
      expect(ran("config:import")).toBe(0);
    }
  });

  it("with the opt-in, imports without the status read, as before", async () => {
    state.site = site({ allowCoreExtensionChange: true }, { allowedCommands: ["config:import"] });
    await expect(runImport()).resolves.toEqual({ success: true, message: "Configuration imported from sync directory." });
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toContain("'config:import'");
  });

  it("treats a malformed opt-in as not opted in, and says so when it refuses", async () => {
    for (const bad of ["true", 1, [], {}]) {
      state.commands = [];
      state.site = site({ allowCoreExtensionChange: bad });
      state.replies["config:status"] = status({ "core.extension": { name: "core.extension", state: "Different" } });
      await expect(runImport()).rejects.toThrow(/allowCoreExtensionChange must be true or false/);
      expect(ran("config:import")).toBe(0);
    }
  });

  it("with a malformed opt-in, an import that leaves core.extension alone still runs", async () => {
    state.site = site({ allowCoreExtensionChange: "true" });
    state.replies["config:status"] = status({ "system.site": { name: "system.site", state: "Different" } });
    await expect(runImport()).resolves.toMatchObject({ success: true });
  });

  it("keeps the read-only gate first", async () => {
    state.site = site({ preset: "production-strict" });
    await expect(runImport()).rejects.toThrow(/read-only/i);
    expect(state.commands).toEqual([]);
  });

  it("drupal_security_info reports the same policy the tool enforces", () => {
    expect(getSecuritySummary(site()).allowCoreExtensionChange).toBe(false);
    expect(getSecuritySummary(site({ allowCoreExtensionChange: true })).allowCoreExtensionChange).toBe(true);
    const malformed = getSecuritySummary(site({ allowCoreExtensionChange: "true" }));
    expect(malformed.allowCoreExtensionChange).toBe(false);
    expect(malformed.coreExtensionChangeError).toMatch(/must be true or false/);
    for (const preset of ["production-strict", "content-editor", "config-editor", "write-plane", "development"]) {
      expect(getSecuritySummary(site({ preset })).allowCoreExtensionChange).toBe(false);
    }
  });

  it("says in the tool description that a core.extension change is refused", () => {
    const definition = definitions.find((d) => d.name === "drupal_drush_config_import");
    expect(definition.description).toMatch(/core\.extension/);
  });
});
