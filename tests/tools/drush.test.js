import { describe, it, expect, vi, beforeEach } from "vitest";

// Dev site: bridge present, whitelisted to config export/status only.
const devSite = {
  _name: "dev",
  security: { preset: "config-editor" },
  drushSsh: {
    host: "h", user: "u", keyPath: "~/.ssh/id_ed25519", drupalRoot: "/var/www/html/web",
    port: 22, allowedCommands: ["config:export", "config:status"],
  },
};

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn(() => devSite),
}));

// Avoid touching a real private key on disk.
vi.mock("fs", () => ({ readFileSync: vi.fn(() => Buffer.from("FAKE_KEY")) }));

// Minimal ssh2 fake: connect → ready → exec → stream closes with code 0.
let lastCommand = "";
vi.mock("ssh2", () => {
  class FakeClient {
    on(event, cb) { this._handlers = this._handlers || {}; this._handlers[event] = cb; return this; }
    connect() { queueMicrotask(() => this._handlers.ready && this._handlers.ready()); }
    exec(command, cb) {
      lastCommand = command;
      const stream = {
        stderr: { on: () => {} },
        on(ev, h) {
          if (ev === "data") { /* no stdout */ }
          if (ev === "close") { queueMicrotask(() => h(0)); }
          return stream;
        },
      };
      cb(null, stream);
    }
    end() {}
  }
  return { Client: FakeClient };
});

import { handlers, redactSecretArgs } from "../../src/tools/drush.js";
import { SecurityError } from "../../src/lib/security.js";

beforeEach(() => { lastCommand = ""; });

describe("redactSecretArgs", () => {
  it("masks password/token/secret flag values but keeps the rest", () => {
    expect(redactSecretArgs(["user:create", "alice", "--mail=a@b.com", "--password=hunter2"]))
      .toBe("user:create alice --mail=a@b.com --password=***");
    expect(redactSecretArgs(["config:get", "system.site"])).toBe("config:get system.site");
    expect(redactSecretArgs(["x", "--client-secret=abc", "--api_key=xyz"]))
      .toBe("x --client-secret=*** --api_key=***");
  });
});

describe("drushSsh.allowedCommands enforcement", () => {
  it("permits a whitelisted command (config:status)", async () => {
    const out = await handlers.drupal_drush_config_status({ site: "dev" });
    expect(out.status).toBe("in_sync");
    expect(lastCommand).toContain("config:status");
  });

  it("permits config:export", async () => {
    const out = await handlers.drupal_drush_config_export({ site: "dev" });
    expect(out.success).toBe(true);
    expect(lastCommand).toContain("config:export");
  });

  it("blocks a non-whitelisted command (cache:rebuild) with SecurityError", async () => {
    await expect(handlers.drupal_drush_cache_rebuild({ site: "dev" })).rejects.toBeInstanceOf(SecurityError);
  });

  it("blocks module:enable even though it is a valid drush tool", async () => {
    await expect(handlers.drupal_drush_module_enable({ site: "dev", moduleName: "devel" }))
      .rejects.toBeInstanceOf(SecurityError);
  });
});
