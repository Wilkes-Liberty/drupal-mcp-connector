/**
 * drupal_drush_module_disable refuses the modules the connector's controls
 * depend on (#346).
 *
 * A separate file from drush.test.js because these cases need a per-test site
 * and a fake SSH client that can return stdout, stderr and an exit code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ commands: [], stdout: "", stderr: "", exitCode: 0, site: null }));

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn(() => state.site),
}));

vi.mock("fs", () => ({ readFileSync: vi.fn(() => Buffer.from("FAKE_KEY")) }));

// Stands in for ssh2's Client; nothing here spawns a local process.
vi.mock("ssh2", () => {
  class FakeClient {
    on(event, cb) { this._handlers = this._handlers || {}; this._handlers[event] = cb; return this; }
    connect() { queueMicrotask(() => this._handlers.ready && this._handlers.ready()); }

    runRemote = (remoteCommand, cb) => {
      state.commands.push(remoteCommand);
      const stream = {
        stderr: { on: (ev, h) => { if (ev === "data" && state.stderr) queueMicrotask(() => h(Buffer.from(state.stderr))); } },
        on(ev, h) {
          if (ev === "data" && state.stdout) queueMicrotask(() => h(Buffer.from(state.stdout)));
          if (ev === "close") setTimeout(() => h(state.exitCode), 0);
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
import { SecurityError, DEFAULT_PROTECTED_MODULES } from "../../src/lib/security.js";

/** A site where the tool is otherwise reachable: writes and deletes allowed. */
function site(security = {}, drushSsh = {}) {
  return {
    _name: "dev",
    security: { preset: "development", ...security },
    drushSsh: { host: "h", user: "u", keyPath: "~/.ssh/id_ed25519", drupalRoot: "/var/www/html/web", port: 22, ...drushSsh },
  };
}

const disable = (moduleName) => handlers.drupal_drush_module_disable({ site: "dev", moduleName });

beforeEach(() => {
  state.commands = [];
  state.stdout = "";
  state.stderr = "";
  state.exitCode = 0;
  state.site = site();
});

describe("drupal_drush_module_disable protected modules (#346)", () => {
  it("names the governance, secrets, auth and API modules in the default list", () => {
    for (const name of ["mcp_sentinel", "audit_chain", "field_guard", "file_gate", "key", "encrypt",
      "simple_oauth", "consumers", "jsonapi", "mcp_server", "mcp_server_tool_bridge", "tool"]) {
      expect(DEFAULT_PROTECTED_MODULES).toContain(name);
    }
  });

  it.each([...DEFAULT_PROTECTED_MODULES])("refuses %s by default, before any SSH call", async (name) => {
    await expect(disable(name)).rejects.toThrow(SecurityError);
    await expect(disable(name)).rejects.toThrow(new RegExp(`"${name}" is protected`));
    await expect(disable(name)).rejects.toThrow(/allowProtectedModuleUninstall/);
    expect(state.commands).toEqual([]);
  });

  it("refuses a protected module on every preset that can reach the tool", async () => {
    for (const preset of ["development", "content-editor", "config-editor", "write-plane"]) {
      state.site = site({ preset, readOnly: false, allowDestructive: true });
      await expect(disable("mcp_sentinel")).rejects.toThrow(/is protected/);
    }
    expect(state.commands).toEqual([]);
  });

  it("still uninstalls an unlisted module", async () => {
    const out = await disable("devel");
    expect(out).toEqual({ success: true, message: "Module \"devel\" uninstalled." });
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toContain("'pm:uninstall' 'devel'");
  });

  it("refuses a module the operator added with security.protectedModules", async () => {
    state.site = site({ protectedModules: ["my_audit"] });
    await expect(disable("my_audit")).rejects.toThrow(/"my_audit" is protected/);
    await expect(disable("jsonapi")).rejects.toThrow(/is protected/);
    expect(state.commands).toEqual([]);
  });

  it("allows a default module only through the explicit opt-out key", async () => {
    state.site = site({ allowProtectedModuleUninstall: ["tool"] });
    await expect(disable("tool")).resolves.toMatchObject({ success: true });
    // The opt-out is per module: the rest of the list stays protected.
    await expect(disable("key")).rejects.toThrow(/is protected/);
  });

  it("does not let protectedModules shrink the default list", async () => {
    state.site = site({ protectedModules: [] });
    await expect(disable("audit_chain")).rejects.toThrow(/is protected/);
    state.site = site({ protectedModules: ["only_this"] });
    await expect(disable("audit_chain")).rejects.toThrow(/is protected/);
  });

  it.each([
    ["protectedModules", "jsonapi"],
    ["protectedModules", ["ok_module", "Bad-Name"]],
    ["protectedModules", [42]],
    ["allowProtectedModuleUninstall", "tool"],
    ["allowProtectedModuleUninstall", ["tool", "*"]],
    ["allowProtectedModuleUninstall", { tool: true }],
  ])("refuses every uninstall when security.%s is malformed (%j)", async (key, value) => {
    state.site = site({ [key]: value });
    await expect(disable("devel")).rejects.toThrow(SecurityError);
    await expect(disable("devel")).rejects.toThrow(new RegExp(`security\\.${key}`));
    await expect(disable("tool")).rejects.toThrow(SecurityError);
    expect(state.commands).toEqual([]);
  });

  it.each(["", "Devel", "devel; rm -rf /", "devel,jsonapi", "devel jsonapi", "../x", "1abc", "jsonapi\n", "a".repeat(129), null, 7, ["jsonapi"]])(
    "refuses the malformed module name %j", async (name) => {
      await expect(disable(name)).rejects.toThrow(/moduleName/);
      expect(state.commands).toEqual([]);
    });

  it("validates the name before it is used in any message", async () => {
    state.site = site({ readOnly: true });
    await expect(disable("x\u001b[31m; evil")).rejects.toThrow(/not a valid Drupal machine name|moduleName/);
    await expect(disable("x\u001b[31m; evil")).rejects.not.toThrow(/read-only/);
  });

  it("keeps the existing gates: read-only, allowDestructive, allowedCommands", async () => {
    state.site = site({ readOnly: true });
    await expect(disable("devel")).rejects.toThrow(/read-only/);
    state.site = site({ allowDestructive: false });
    await expect(disable("devel")).rejects.toThrow(SecurityError);
    state.site = site({}, { allowedCommands: ["config:status"] });
    await expect(disable("devel")).rejects.toThrow(/not permitted on this site/);
    // production-strict (the default preset) is read-only: refused as before.
    state.site = { ...site(), security: {} };
    await expect(disable("devel")).rejects.toThrow(SecurityError);
    // The opt-out key does not open any of those gates.
    state.site = { ...site(), security: { allowProtectedModuleUninstall: ["tool"] } };
    await expect(disable("tool")).rejects.toThrow(/read-only/);
    expect(state.commands).toEqual([]);
  });

  it("answers no to Drush's cascade prompt instead of yes", async () => {
    await disable("devel");
    expect(state.commands[0]).toMatch(/ --no$/);
    expect(state.commands[0]).not.toContain("--yes");
  });

  it("refuses a cascading uninstall and names the dependents", async () => {
    state.exitCode = 75;
    state.stdout = " The following extensions will be uninstalled: shared_lib, jsonapi, rest\n";
    state.stderr = " [warning] Do you want to continue?: no.\n [error] Cancelled.\n";
    await expect(disable("shared_lib")).rejects.toThrow(SecurityError);
    await expect(disable("shared_lib")).rejects.toThrow(/would also uninstall: jsonapi, rest/);
    await expect(disable("shared_lib")).rejects.toThrow(/Protected: jsonapi/);
    await expect(disable("shared_lib")).rejects.toThrow(/Nothing was uninstalled/);
  });

  it("reads the cascade list from stderr too", async () => {
    state.exitCode = 75;
    state.stderr = " The following extensions will be uninstalled: devel, devel_generate\n [error] Cancelled.\n";
    await expect(disable("devel")).rejects.toThrow(/would also uninstall: devel_generate/);
  });

  it("reports dependents honestly if Drush ran the cascade anyway", async () => {
    state.stdout = " The following extensions will be uninstalled: devel, devel_generate\n [success] Successfully uninstalled: devel, devel_generate\n";
    const out = await disable("devel");
    expect(out.alsoUninstalled).toEqual(["devel_generate"]);
    expect(out.warning).toMatch(/did not cancel/);
  });

  it("passes through any other Drush failure", async () => {
    state.exitCode = 1;
    state.stderr = "Unable to uninstall modules: devel is not installed.";
    await expect(disable("devel")).rejects.toThrow(/Drush exited 1: Unable to uninstall/);
  });

  it("other drush tools still answer yes", async () => {
    await handlers.drupal_drush_module_enable({ site: "dev", moduleName: "devel" });
    expect(state.commands[0]).toMatch(/ --yes$/);
  });

  it("says so in the tool description", () => {
    const def = definitions.find((d) => d.name === "drupal_drush_module_disable");
    expect(def.description).toMatch(/protected/i);
    expect(def.description).toMatch(/dependents/i);
  });
});
