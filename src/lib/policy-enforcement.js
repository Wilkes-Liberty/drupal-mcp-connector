/**
 * Tenant-side local policy enforcement (#253).
 *
 * Loopback stand-in for mcp_sentinel `McpPolicyBundleRegistry`: mint / verify
 * / activate / simulate / revoke / rollback / emergency deny. The relay edge
 * never receives the signing key and never calls mint. A missing key cannot
 * mint, verify, or activate — emergency deny still arms a deny floor without
 * minting new authority.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SEAL_PREFIX } from "./policy-promotion.js";

export const POLICY_BUNDLE_VERSION = 1;

export const DEFAULT_BUNDLE_TTL = 86400 * 30;

export const EMERGENCY_DENY = "*";

export const EMERGENCY_DIGEST = "emergency-deny";

function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "number"
    || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const source = new Map(Object.entries(value));
    const bag = new Map();
    for (const key of [...source.keys()].sort()) {
      bag.set(key, normalize(source.get(key)));
    }
    return Object.fromEntries(bag);
  }
  throw new TypeError("Policy bundle claims may only contain scalars, lists and maps.");
}

/**
 * Canonical JSON of claims (HMAC / digest input). Maps are key-sorted;
 * lists keep caller order. Matches mcp_sentinel `McpPolicyBundle::canonicalJson`.
 *
 * @param {object} claims
 * @returns {string}
 */
export function canonicalJson(claims) {
  return JSON.stringify(normalize(claims));
}

/**
 * Hex SHA-256 of the canonical claims.
 *
 * @param {object} claims
 * @returns {string}
 */
export function digestOf(claims) {
  return createHash("sha256").update(canonicalJson(claims)).digest("hex");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deniedOperationsOf(claims) {
  const denials = new Map(Object.entries(claims ?? {})).get("denials");
  if (!denials || typeof denials !== "object" || Array.isArray(denials)) return [];
  const ops = new Map(Object.entries(denials)).get("operations");
  if (!Array.isArray(ops)) return [];
  return ops.map(String);
}

function bundleFrom(claims, digest, seal) {
  return Object.freeze({
    claims,
    digest,
    seal,
    version: () => Number(new Map(Object.entries(claims)).get("v") ?? 0),
    expires: () => Number(new Map(Object.entries(claims)).get("expires") ?? 0),
    deniedOperations: () => deniedOperationsOf(claims),
    denies: (operation) => deniedOperationsOf(claims).includes(operation),
    isExpired: (now) => {
      const expires = Number(new Map(Object.entries(claims)).get("expires") ?? 0);
      return expires > 0 && now >= expires;
    },
    toArray: () => ({ ...claims, digest, seal }),
  });
}

/**
 * In-process local enforcement used by the tenant agent in the loopback lab.
 *
 * @param {object} [options]
 * @param {string|null} [options.signingKey] HMAC material. Null = disconnected.
 * @param {() => number} [options.now] Unix seconds.
 * @returns {object}
 */
export function createLocalPolicyEnforcement({
  signingKey = null,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  let active = null;
  let lastGood = null;
  const revoked = new Map();

  function canSeal() {
    return typeof signingKey === "string" && signingKey.length > 0;
  }

  function isRevoked(digest) {
    return revoked.has(digest);
  }

  function mint(deniedOperations = [], ttl = DEFAULT_BUNDLE_TTL) {
    if (!canSeal()) return null;
    const issued = now();
    const unique = [...new Set((Array.isArray(deniedOperations) ? deniedOperations : [])
      .map(String))];
    const claims = {
      denials: { operations: unique },
      expires: issued + (ttl ?? DEFAULT_BUNDLE_TTL),
      id: randomUUID(),
      issued,
      v: POLICY_BUNDLE_VERSION,
    };
    const digest = digestOf(claims);
    const seal = SEAL_PREFIX + createHmac("sha256", signingKey).update(digest).digest("hex");
    return bundleFrom(claims, digest, seal);
  }

  function verify(document) {
    if (!canSeal()) return null;
    if (!document || typeof document !== "object" || Array.isArray(document)) return null;
    const bag = new Map(Object.entries(document));
    const seal = bag.get("seal");
    const claimedDigest = bag.get("digest");
    bag.delete("seal");
    bag.delete("digest");
    const claims = Object.fromEntries(bag);
    if (typeof seal !== "string" || !seal.startsWith(SEAL_PREFIX)) return null;
    if (Number(new Map(Object.entries(claims)).get("v") ?? 0) !== POLICY_BUNDLE_VERSION) {
      return null;
    }
    const digest = digestOf(claims);
    if (!safeEqual(digest, typeof claimedDigest === "string" ? claimedDigest : "")) return null;
    const expected = SEAL_PREFIX
      + createHmac("sha256", signingKey).update(digest).digest("hex");
    if (!safeEqual(expected, seal)) return null;
    const bundle = bundleFrom(claims, digest, seal);
    if (bundle.isExpired(now())) return null;
    if (isRevoked(digest)) return null;
    return bundle;
  }

  function attestation() {
    return active;
  }

  function activeDigest() {
    const digest = active && typeof active.digest === "string" ? active.digest : null;
    return digest || null;
  }

  function emergencyDeny() {
    if (active && typeof active.digest === "string") lastGood = active;
    active = {
      digest: EMERGENCY_DIGEST,
      activated_at: now(),
      previous: active && typeof active.digest === "string" ? active.digest : null,
      emergency: true,
      bundle: {
        v: POLICY_BUNDLE_VERSION,
        denials: { operations: [EMERGENCY_DENY] },
        expires: 0,
        id: EMERGENCY_DIGEST,
        issued: now(),
      },
    };
  }

  function activateBundle(bundle) {
    if (!canSeal() || !bundle) return null;
    if (active && typeof active.digest === "string") lastGood = active;
    const previous = active && typeof active.digest === "string" ? active.digest : null;
    active = {
      digest: bundle.digest,
      activated_at: now(),
      previous,
      bundle: bundle.toArray(),
    };
    return {
      digest: bundle.digest,
      activated_at: active.activated_at,
      previous,
    };
  }

  /**
   * Verify then activate a portable document. This is the agent hook.
   *
   * @param {object} document
   * @returns {{ok: boolean, digest?: string, attested?: boolean, reason?: string}}
   */
  function activate(document) {
    const bundle = verify(document);
    if (!bundle) return { ok: false, reason: "unverified" };
    const result = activateBundle(bundle);
    if (!result) return { ok: false, reason: "cannot_activate" };
    return { ok: true, digest: result.digest, attested: true };
  }

  function simulate(operation, localDenies, candidate = null) {
    const digest = candidate?.digest ?? activeDigest();
    if (localDenies) {
      return { allow: false, reason: "local_deny", digest };
    }
    if (candidate === null && active && active.emergency) {
      return {
        allow: false,
        reason: "emergency_deny",
        digest: digest ?? EMERGENCY_DIGEST,
      };
    }
    let bundle = candidate;
    if (bundle === null) {
      const document = active?.bundle ?? null;
      bundle = document ? verify(document) : null;
      if (bundle === null && digest) {
        return { allow: false, reason: "bundle_unverified", digest };
      }
    }
    if (bundle && (bundle.denies(operation) || bundle.denies(EMERGENCY_DENY))) {
      return { allow: false, reason: "bundle_deny", digest: bundle.digest };
    }
    return { allow: true, reason: "allow", digest };
  }

  function revoke(digest) {
    if (typeof digest !== "string" || !digest) return;
    revoked.set(digest, now());
    if (activeDigest() === digest) emergencyDeny();
  }

  function rollback() {
    if (!lastGood || typeof lastGood.digest !== "string") return null;
    if (isRevoked(lastGood.digest)) return null;
    active = lastGood;
    return lastGood;
  }

  return {
    canSeal,
    mint,
    verify,
    activate,
    activateBundle,
    attestation,
    activeDigest,
    simulate,
    revoke,
    rollback,
    emergencyDeny,
    isRevoked,
  };
}
