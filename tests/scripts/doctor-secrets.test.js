import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../bin/drupal-mcp-doctor.js", import.meta.url));
const index = fileURLToPath(new URL("../../src/index.js", import.meta.url));
const credential = "synthetic-doctor-credential";
let dir;
let server;
let host;
let receivedSecrets;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "doctor-secrets-"));
  receivedSecrets = [];
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/oauth/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const secret = new URLSearchParams(body).get("client_secret");
      receivedSecrets.push(secret);
      res.statusCode = secret === credential ? 200 : 401;
      res.end(JSON.stringify(secret === credential
        ? { access_token: "synthetic-access-token", expires_in: 3600 }
        : { error: "invalid_client" }));
      return;
    }
    res.statusCode = req.headers.authorization === "Bearer synthetic-access-token" ? 200 : 401;
    res.end(JSON.stringify(req.url === "/drupal-mcp/readiness"
      ? { contract_ready: true }
      : { jsonapi: { version: "1.0" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `http://127.0.0.1:${server.address().port}`;
  // Intercept only the OS credential boundary, never the loader or doctor.
  writeFileSync(join(dir, "keychain.mjs"), `
    import cp from "node:child_process";
    import { appendFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    Object.defineProperty(process, "platform", { value: "darwin" });
    const original = cp.execFileSync;
    cp.execFileSync = (command, args, options) => {
      if (command !== "security") return original(command, args, options);
      appendFileSync(process.env.DOCTOR_LOOKUPS, args[2] + "\\n");
      if (args[2] !== "doctor-test-service" || process.env.DOCTOR_KEYCHAIN_MISSING) {
        throw new Error("Credential unavailable");
      }
      return ${JSON.stringify(credential + "\n")};
    };
    syncBuiltinESMExports();
  `);
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function fixture(configPath, item = "doctor-test-service") {
  const folder = dirname(configPath);
  mkdirSync(folder, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    defaultSite: "test",
    sites: {
      test: {
        baseUrl: host,
        requireGovernance: true,
        oauth: { clientId: "test-client", clientSecretEnv: "DOCTOR_TEST_SECRET", scopes: ["mcp_read"] },
      },
    },
  }));
  writeFileSync(join(folder, "secrets.map"), `DOCTOR_TEST_SECRET=${item}\n`);
}

async function run(entry, args = [], env = {}) {
  const childEnv = { ...process.env, DOCTOR_LOOKUPS: join(dir, "lookups"), ...env };
  delete childEnv.DRUPAL_BASE_URL;
  if (!Object.hasOwn(env, "DOCTOR_TEST_SECRET")) delete childEnv.DOCTOR_TEST_SECRET;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", join(dir, "keychain.mjs"), entry,
      ...(entry === index ? ["doctor"] : []), ...args,
    ], { cwd: dir, env: childEnv, timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function expectSafe(result) {
  expect(result.stdout + result.stderr).not.toContain(credential);
  expect(result.stdout + result.stderr).not.toContain("synthetic-access-token");
}

describe.each([["standalone", bin], ["server subcommand", index]])("doctor secret loading: %s", (_label, entry) => {
  it("authenticates using the normal cwd secret map", async () => {
    fixture(join(dir, "config", "config.json"));
    const result = await run(entry, ["--json"]);
    expectSafe(result);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(receivedSecrets).toEqual([credential]);
  });

  it("uses the map beside an explicit config, not the cwd map", async () => {
    fixture(join(dir, "config", "config.json"), "wrong-service");
    const config = join(dir, "other", "site.json");
    fixture(config);
    const result = await run(entry, ["--config", config, "--json"]);
    expectSafe(result);
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "lookups"), "utf8")).toBe("doctor-test-service\n");
    expect(receivedSecrets).toEqual([credential]);
  });

  it("preserves an exported secret without consulting Keychain", async () => {
    fixture(join(dir, "config", "config.json"), "wrong-service");
    const result = await run(entry, ["--json"], { DOCTOR_TEST_SECRET: credential });
    expectSafe(result);
    expect(result.status).toBe(0);
    expect(receivedSecrets).toEqual([credential]);
    expect(() => readFileSync(join(dir, "lookups"))).toThrow();
  });

  it("reports unavailable credentials without sending a token request", async () => {
    fixture(join(dir, "config", "config.json"));
    const result = await run(entry, ["--json"], { DOCTOR_KEYCHAIN_MISSING: "1" });
    expectSafe(result);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).primaryFailure.id).toBe("auth");
    expect(receivedSecrets).toEqual([]);
  });

  it("does not consult Keychain for help", async () => {
    fixture(join(dir, "config", "config.json"));
    const result = await run(entry, ["--help"]);
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(dir, "lookups"))).toThrow();
    expect(receivedSecrets).toEqual([]);
  });
});
