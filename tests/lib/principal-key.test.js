/**
 * JS twin of mcp_sentinel McpPrincipalKey::fromClaims, asserted against
 * the shared language-neutral vectors (mirrored from mcp_sentinel).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRINCIPAL_KEY_ERRORS,
  PRINCIPAL_KEY_VECTORS_FILE,
  PrincipalKeyError,
  fromClaims,
  fromIdentity,
  isValidUtf8String,
  parseHumanKey,
  parsePrincipalKey,
  topLevelActSub,
} from "../../src/lib/principal-key.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function loadVectors() {
  const raw = readFileSync(join(REPO_ROOT, PRINCIPAL_KEY_VECTORS_FILE), "utf8");
  const decoded = JSON.parse(raw);
  if (!Array.isArray(decoded)) throw new Error("Vector file must be a JSON array.");
  return decoded.filter((item) => item && typeof item === "object");
}

describe("principal-key vectors (mcp_sentinel twin)", () => {
  const vectors = loadVectors();

  it("loads a non-empty named fixture", () => {
    expect(vectors.length).toBeGreaterThan(0);
    const names = vectors.map((vector) => vector.name);
    expect(names).toEqual(expect.arrayContaining([
      "no-act-azp-present",
      "single-act",
      "nested-act-chain-top-level-actor",
      "no-act-missing-azp",
      "no-act-missing-azp-client-id-ignored",
      "missing-sub",
      "missing-iss",
      "act-present-missing-act-sub",
      "pipe-in-sub-rejected",
      "act-as-string",
      "act-as-list",
      "act-as-empty-object",
      "empty-act-sub",
      "integer-sub",
      "whitespace-only-sub",
      "unicode-sub-valid",
      "zero-width-sub",
      "part-too-long-sub",
      "nbsp-only-sub",
      "part-too-long-iss",
      "part-too-long-actor",
    ]));
    expect(names).toEqual([...new Set(names)]);
  });

  it.each(loadVectors().map((vector) => [vector.name, vector]))(
    "matches Sentinel fromClaims for %s",
    (_name, vector) => {
      const expected = vector.expected;
      if (expected.error) {
        expect(() => fromClaims(vector.claims)).toThrow(PrincipalKeyError);
        try {
          fromClaims(vector.claims);
        } catch (err) {
          expect(err.reasonCode).toBe(expected.error);
        }
        return;
      }
      expect(fromClaims(vector.claims)).toEqual({
        principalKey: expected.principalKey,
        humanKey: expected.humanKey,
      });
    },
  );

  it("rejects invalid UTF-8 (not representable in the JSON vectors)", () => {
    // Unpaired surrogates are the JS analog of PHP mb_check_encoding failure.
    const sub = "human\uD800";
    expect(isValidUtf8String(sub)).toBe(false);
    try {
      fromClaims({
        iss: "https://idp.example/realms/agents",
        sub,
        azp: "agent-client",
      });
      throw new Error("Invalid UTF-8 must fail closed.");
    } catch (err) {
      expect(err).toBeInstanceOf(PrincipalKeyError);
      expect(err.reasonCode).toBe(PRINCIPAL_KEY_ERRORS.INVALID_UTF8);
    }
  });

  it("never uses clientId as an actor (fromIdentity)", () => {
    expect(() => fromIdentity({
      iss: "https://idp.example/realms/agents",
      sub: "human-1",
      clientId: "must-not-be-actor",
    })).toThrow(/missing_azp|Principal key requires a azp/);
    try {
      fromIdentity({
        iss: "https://idp.example/realms/agents",
        sub: "human-1",
        clientId: "must-not-be-actor",
      });
    } catch (err) {
      expect(err.reasonCode).toBe(PRINCIPAL_KEY_ERRORS.MISSING_AZP);
    }
  });

  it("reads only top-level act.sub", () => {
    expect(topLevelActSub({ sub: "A", act: { sub: "B" } })).toBe("A");
    expect(topLevelActSub({ subject: "nope" })).toBe("");
    expect(topLevelActSub(["agent-1"])).toBe("");
  });

  it("parses operator keys with the same error codes", () => {
    expect(parsePrincipalKey("https://idp.example/realms/agents|human-1|agent-client"))
      .toBe("https://idp.example/realms/agents|human-1|agent-client");
    expect(parseHumanKey("https://idp.example/realms/agents|human-1"))
      .toBe("https://idp.example/realms/agents|human-1");
    try {
      parsePrincipalKey("https://idp.example/realms/agents|human-1|a|b");
      throw new Error("extra pipe");
    } catch (err) {
      expect(err.reasonCode).toBe(PRINCIPAL_KEY_ERRORS.INVALID_SEPARATOR);
    }
    try {
      parseHumanKey("https://idp.example/realms/agents");
      throw new Error("missing sub");
    } catch (err) {
      expect(err.reasonCode).toBe(PRINCIPAL_KEY_ERRORS.INVALID_PART);
    }
  });
});
