import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collidingVectorNames,
  checkPrincipalKeyVectors,
  diffVectorPayloads,
} from "../../scripts/check-principal-key-vectors.js";
import {
  PRINCIPAL_KEY_VECTORS_EXTRA_FILE,
  PRINCIPAL_KEY_VECTORS_FILE,
} from "../../src/lib/principal-key.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-principal-key-vectors", () => {
  it("treats identical payloads as equal regardless of key order", () => {
    expect(diffVectorPayloads(
      '[{"name":"a","expected":{"humanKey":"h","principalKey":"p"}}]',
      '[{"expected":{"principalKey":"p","humanKey":"h"},"name":"a"}]',
    )).toBe("");
  });

  it("reports a content drift", () => {
    expect(diffVectorPayloads(
      '[{"name":"a"}]',
      '[{"name":"b"}]',
    )).toMatch(/differs/);
  });

  it("rejects extra names that collide with the mirror", () => {
    expect(collidingVectorNames([{ name: "a" }], [{ name: "a" }, { name: "b" }])).toEqual(["a"]);
  });

  it("passes when fetch returns the local mirror", async () => {
    const body = readFileSync(join(root, PRINCIPAL_KEY_VECTORS_FILE), "utf8");
    const extra = JSON.parse(readFileSync(join(root, PRINCIPAL_KEY_VECTORS_EXTRA_FILE), "utf8"));
    expect(Array.isArray(extra)).toBe(true);
    const result = await checkPrincipalKeyVectors({
      root,
      fetchFn: async () => new Response(body, { status: 200 }),
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails when upstream drifted (red evidence)", async () => {
    const result = await checkPrincipalKeyVectors({
      root,
      fetchFn: async () => new Response("[]", { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/differs/);
  });
});
