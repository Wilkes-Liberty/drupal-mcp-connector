import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { setWriteReintrospectGuard } from "../../src/lib/write-introspect.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("assertTestOnly", () => {
  it("allows guard setters under Vitest", () => {
    expect(() => setWriteReintrospectGuard(true)).not.toThrow();
  });

  it("throws when a guard setter runs outside tests", () => {
    const script = `
      process.env.VITEST = "";
      process.env.NODE_ENV = "production";
      const { setWriteReintrospectGuard } = await import(${JSON.stringify(new URL("../../src/lib/write-introspect.js", import.meta.url).href)});
      setWriteReintrospectGuard(false);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env: { ...process.env, VITEST: "", NODE_ENV: "production" },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/setWriteReintrospectGuard is test-only/);
  });
});
