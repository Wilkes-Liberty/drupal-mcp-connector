import { describe, it, expect } from "vitest";
import {
  parseSecretMap,
  namedSecretEnvVars,
  loadLocalSecrets,
  secretLoadFatalMessage,
  secretTableMismatchMessage,
  DEFAULT_SECRET_PAIRS,
} from "../../src/lib/load-secrets.js";

describe("parseSecretMap", () => {
  it("ignores comments, blanks, and malformed lines", () => {
    expect(parseSecretMap("# hi\n\nMCP_AGENT_CLIENT_SECRET=drupal-mcp-agent-secret\n=no-var\nNO_ITEM=\nnot-a-pair\n")).toEqual([
      ["MCP_AGENT_CLIENT_SECRET", "drupal-mcp-agent-secret"],
    ]);
  });
});

describe("namedSecretEnvVars", () => {
  it("collects clientSecretEnv and apiTokenEnv, skipping documentation keys", () => {
    expect(namedSecretEnvVars({
      _comment: "MCP_IGNORED=nope",
      sites: {
        prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
        token: { apiTokenEnv: "DRUPAL_TOKEN_PRODUCTION" },
        dup: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
      },
    })).toEqual(["MCP_AGENT_CLIENT_SECRET", "DRUPAL_TOKEN_PRODUCTION"]);
  });
});

describe("loadLocalSecrets", () => {
  const files = (map) => (path) => {
    const text = map.get(path);
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  };

  it("applies the shipped example table when secrets.map is absent", () => {
    const env = {};
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env,
      readFile: files(new Map()),
      lookup: (item) => (item === "drupal-mcp-content-production" ? "from-keychain" : ""),
    });
    expect(loaded.pairs).toBe(DEFAULT_SECRET_PAIRS.length);
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBe("from-keychain");
    expect(loaded.resolved).toBe(1);
    expect(secretLoadFatalMessage(loaded)).toBeNull();
  });

  it("lets secrets.map replace the shipped table — the #180 estate-name case", () => {
    const env = {};
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env,
      readFile: files(new Map([
        ["/connector/config/secrets.map", "MCP_AGENT_CLIENT_SECRET=drupal-mcp-agent-secret\n"],
        ["/connector/config/config.json", JSON.stringify({
          sites: { prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } } },
        })],
      ])),
      lookup: (item) => (item === "drupal-mcp-agent-secret" ? "estate-secret" : ""),
    });
    expect(env.MCP_AGENT_CLIENT_SECRET).toBe("estate-secret");
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBeUndefined();
    expect(loaded.named).toEqual(["MCP_AGENT_CLIENT_SECRET"]);
    expect(loaded.unset).toEqual([]);
    expect(secretLoadFatalMessage(loaded)).toBeNull();
  });

  it("refuses boot when config.json names secrets and the shipped table matches none of them", () => {
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env: {},
      readFile: files(new Map([
        ["/connector/config/config.json", JSON.stringify({
          sites: {
            prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
            stg: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET_STG" } },
          },
        })],
      ])),
      lookup: () => "",
    });
    expect(loaded.unset).toEqual(["MCP_AGENT_CLIENT_SECRET", "MCP_AGENT_CLIENT_SECRET_STG"]);
    expect(loaded.source).toBe("default");
    expect(secretLoadFatalMessage(loaded)).toMatch(/MCP_AGENT_CLIENT_SECRET/);
    expect(secretLoadFatalMessage(loaded)).toMatch(/config\/secrets\.map is absent/);
    expect(secretLoadFatalMessage(loaded)).toMatch(/no secret-table entries match/);
  });

  it("does not refuse when at least one named secret is present (inert tiers stay silent)", () => {
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env: { MCP_AGENT_CLIENT_SECRET: "already" },
      readFile: files(new Map([
        ["/connector/config/config.json", JSON.stringify({
          sites: {
            prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
            admin: { oauth: { clientSecretEnv: "MCP_AGENT_ADMIN_SECRET" } },
          },
        })],
      ])),
      lookup: () => "",
    });
    expect(loaded.unset).toEqual(["MCP_AGENT_ADMIN_SECRET"]);
    expect(secretLoadFatalMessage(loaded)).toBeNull();
    expect(secretTableMismatchMessage(loaded)).toMatch(/MCP_AGENT_CLIENT_SECRET/);
    expect(secretTableMismatchMessage(loaded)).toMatch(/MCP_AGENT_ADMIN_SECRET/);
    expect(secretTableMismatchMessage(loaded)).toMatch(/config\/secrets\.map is absent/);
  });

  it("does not report a table mismatch when secrets.map names the config vars", () => {
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env: { MCP_AGENT_CLIENT_SECRET: "already" },
      readFile: files(new Map([
        ["/connector/config/secrets.map", "MCP_AGENT_CLIENT_SECRET=drupal-mcp-agent-secret\nMCP_AGENT_ADMIN_SECRET=drupal-mcp-admin-secret\n"],
        ["/connector/config/config.json", JSON.stringify({
          sites: {
            prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
            admin: { oauth: { clientSecretEnv: "MCP_AGENT_ADMIN_SECRET" } },
          },
        })],
      ])),
      lookup: () => "",
    });
    expect(loaded.source).toBe("map");
    expect(loaded.unset).toEqual(["MCP_AGENT_ADMIN_SECRET"]);
    expect(secretTableMismatchMessage(loaded)).toBeNull();
    expect(secretLoadFatalMessage(loaded)).toBeNull();
  });

  it("does not report a table mismatch when the shipped table overlaps config (inert Keychain items stay silent)", () => {
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env: { MCP_CONTENT_PRODUCTION_SECRET: "already" },
      readFile: files(new Map([
        ["/connector/config/config.json", JSON.stringify({
          sites: {
            prod: { oauth: { clientSecretEnv: "MCP_CONTENT_PRODUCTION_SECRET" } },
            admin: { oauth: { clientSecretEnv: "MCP_ADMIN_BREAKGLASS_SECRET" } },
          },
        })],
      ])),
      lookup: () => "",
    });
    expect(loaded.unset).toEqual(["MCP_ADMIN_BREAKGLASS_SECRET"]);
    expect(secretTableMismatchMessage(loaded)).toBeNull();
    expect(secretLoadFatalMessage(loaded)).toBeNull();
  });

  it("names secrets.map as the table source when it exists but matches nothing", () => {
    const loaded = loadLocalSecrets({
      cwd: "/connector",
      env: { MCP_AGENT_CLIENT_SECRET: "already" },
      readFile: files(new Map([
        ["/connector/config/secrets.map", "MCP_OTHER=drupal-mcp-other\n"],
        ["/connector/config/config.json", JSON.stringify({
          sites: { prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } } },
        })],
      ])),
      lookup: () => "",
    });
    expect(loaded.source).toBe("map");
    expect(secretTableMismatchMessage(loaded)).toMatch(/config\/secrets\.map does not name them/);
    expect(secretLoadFatalMessage(loaded)).toBeNull();
  });

  it("does not overwrite an env var that is already set", () => {
    const env = { MCP_CONTENT_PRODUCTION_SECRET: "from-parent" };
    loadLocalSecrets({
      cwd: "/connector",
      env,
      readFile: files(new Map()),
      lookup: () => "from-keychain",
    });
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBe("from-parent");
  });
});
