import { describe, it, expect, vi, beforeEach } from "vitest";
import { SecurityError } from "../../src/lib/security.js";

const openSite = {
  _name: "dev",
  security: { preset: "development" },
  drushSsh: {
    host: "h", user: "u", keyPath: "~/.ssh/id_ed25519", drupalRoot: "/var/www/html/web",
    port: 22,
  },
};

const pinnedSite = {
  ...openSite,
  _name: "pinned",
  drushSsh: {
    ...openSite.drushSsh,
    allowedCommands: ["config:export", "config:status"],
  },
};

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((name) => (name === "pinned" ? pinnedSite : openSite)),
}));

vi.mock("fs", () => ({ readFileSync: vi.fn(() => Buffer.from("FAKE_KEY")) }));

let lastCommand = "";
let nextExit = { code: 0, stdout: "ok", stderr: "" };

vi.mock("ssh2", () => {
  class FakeClient {
    on(event, cb) { this._handlers = this._handlers || {}; this._handlers[event] = cb; return this; }
    connect() { queueMicrotask(() => this._handlers.ready && this._handlers.ready()); }
    exec(command, cb) {
      lastCommand = command;
      const { code, stdout, stderr } = nextExit;
      const stream = {
        stderr: { on(ev, h) { if (ev === "data" && stderr) queueMicrotask(() => h(Buffer.from(stderr))); } },
        on(ev, h) {
          if (ev === "data" && stdout) queueMicrotask(() => h(Buffer.from(stdout)));
          if (ev === "close") queueMicrotask(() => h(code));
          return stream;
        },
      };
      cb(null, stream);
    }
    end() {}
  }
  return { Client: FakeClient };
});

import { handlers, definitions } from "../../src/tools/codegen.js";

beforeEach(() => {
  lastCommand = "";
  nextExit = { code: 0, stdout: "scaffold", stderr: "" };
});

describe("drupal_codegen_*", () => {
  it("exposes inspect, diff, and generate", () => {
    expect(definitions.map((d) => d.name)).toEqual([
      "drupal_codegen_inspect",
      "drupal_codegen_diff",
      "drupal_codegen_generate",
    ]);
  });

  it("inspect calls graphql-compose-codegen:inspect and returns stdout", async () => {
    const out = await handlers.drupal_codegen_inspect({ site: "dev" });
    expect(lastCommand).toContain("graphql-compose-codegen:inspect");
    expect(lastCommand).not.toContain("output-dir");
    expect(out.output).toBe("scaffold");
    expect(out.wroteFiles).toBe(false);
  });

  it("diff calls graphql-compose-codegen:diff", async () => {
    await handlers.drupal_codegen_diff({ site: "dev" });
    expect(lastCommand).toContain("graphql-compose-codegen:diff");
  });

  it("generate is always --dry-run and never --output-dir", async () => {
    const out = await handlers.drupal_codegen_generate({ site: "dev" });
    expect(lastCommand).toContain("graphql-compose-codegen:generate");
    expect(lastCommand).toContain("--dry-run");
    expect(lastCommand).not.toContain("output-dir");
    expect(out.wroteFiles).toBe(false);
  });

  it("passes validated bundles and skipFields", async () => {
    await handlers.drupal_codegen_inspect({
      site: "dev",
      bundles: ["article", "page"],
      skipFields: ["field_components"],
    });
    expect(lastCommand).toContain("--bundles=article,page");
    expect(lastCommand).toContain("--skip-fields=field_components");
  });

  it("rejects an invalid bundle machine name", async () => {
    await expect(handlers.drupal_codegen_inspect({
      site: "dev",
      bundles: ["Article"],
    })).rejects.toThrow(/machine name/);
    expect(lastCommand).toBe("");
  });

  it("rewrites a missing-command failure as a capability error", async () => {
    nextExit = {
      code: 1,
      stdout: "",
      stderr: 'The command "graphql-compose-codegen:inspect" does not exist.',
    };
    await expect(handlers.drupal_codegen_inspect({ site: "dev" }))
      .rejects.toThrow(/graphql_compose_codegen is not available/);
  });

  it("does not rewrite an allowedCommands denial", async () => {
    await expect(handlers.drupal_codegen_inspect({ site: "pinned" }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(lastCommand).toBe("");
  });
});
