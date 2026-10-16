/**
 * JS twin of mcp_sentinel `McpPrincipalKey::fromClaims`.
 *
 * Principal is `iss|sub|actor`. Human is `iss|sub`.
 *
 * Actor is the top-level `act.sub` when a delegation claim is present
 * (RFC 8693 current actor; nested `act` entries are prior actors and
 * do not change the key), otherwise `azp`. `client_id` is never an
 * actor. Only `act.sub` is read — never `act.subject`.
 *
 * Each part is capped at MAX_PART_LENGTH (256) Unicode characters.
 * Unicode whitespace-only parts (including NBSP), control characters,
 * invalid UTF-8, and `|` are rejected.
 *
 * Language-neutral vectors: tests/fixtures/principal-key-vectors.json
 * (mirrored from mcp_sentinel). Rate limits, sessions, and data-flow
 * budgets import this formula (PR #455 key logic).
 */

export const PRINCIPAL_KEY_SEPARATOR = "|";

/** Maximum Unicode characters per iss, sub, or actor part. */
export const PRINCIPAL_KEY_MAX_PART_LENGTH = 256;

/** Path of the shared vector file, relative to the repo root. */
export const PRINCIPAL_KEY_VECTORS_FILE = "tests/fixtures/principal-key-vectors.json";

export const PRINCIPAL_KEY_ERRORS = Object.freeze({
  MISSING_ISS: "missing_iss",
  MISSING_SUB: "missing_sub",
  MISSING_AZP: "missing_azp",
  MISSING_ACT_SUB: "missing_act_sub",
  INVALID_SEPARATOR: "invalid_separator",
  INVALID_PART: "invalid_part",
  PART_TOO_LONG: "part_too_long",
  INVALID_UTF8: "invalid_utf8",
});

/**
 * Fail-closed principal-key refusal. `reasonCode` matches the shared
 * vector file so PHP and JS assert the same errors.
 */
export class PrincipalKeyError extends Error {
  /**
   * @param {string} reasonCode Stable machine reason.
   * @param {string} message Operator-facing text. Must not contain secrets.
   */
  constructor(reasonCode, message) {
    super(message);
    this.name = "PrincipalKeyError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Whether `value` is a valid UTF-8 Unicode scalar-value string.
 * Unpaired surrogates are the JS analog of PHP `mb_check_encoding` failure.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidUtf8String(value) {
  if (typeof value !== "string") return false;
  // Unpaired surrogates are the JS analog of PHP `mb_check_encoding` failure.
  return !/\p{Cs}/u.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value;
}

/**
 * Top-level `act.sub` only. Nested `act` and `act.subject` are ignored.
 * A list or non-object `act` is not a delegation.
 *
 * @param {unknown} act
 * @returns {string}
 */
export function topLevelActSub(act) {
  if (act === null || typeof act !== "object" || Array.isArray(act)) return "";
  const sub = new Map(Object.entries(act)).get("sub");
  return typeof sub === "string" ? sub : "";
}

/**
 * Claims used to compose a principal key from a verified identity.
 * Copies `iss` / `sub` / `azp` / `act` only. Never invents `azp` from
 * `clientId` / `client_id`.
 *
 * @param {object|null|undefined} identity
 * @returns {object}
 */
export function keyClaimsFromIdentity(identity) {
  if (!identity || typeof identity !== "object") return {};
  if (identity.keyClaims && typeof identity.keyClaims === "object" && !Array.isArray(identity.keyClaims)) {
    return identity.keyClaims;
  }
  const claims = {};
  if (Object.hasOwn(identity, "iss")) claims.iss = identity.iss;
  if (Object.hasOwn(identity, "sub")) claims.sub = identity.sub;
  if (Object.hasOwn(identity, "azp")) claims.azp = identity.azp;
  if (Object.hasOwn(identity, "act")) claims.act = identity.act;
  else if (typeof identity.actSub === "string") claims.act = { sub: identity.actSub };
  return claims;
}

/**
 * Composes keys from JWT-shaped claims, or fails closed.
 *
 * @param {object} claims Validated token claims (iss, sub, azp, act).
 * @returns {{principalKey: string, humanKey: string}}
 * @throws {PrincipalKeyError}
 */
export function fromClaims(claims) {
  const bag = claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  const iss = requirePart(bag, "iss", PRINCIPAL_KEY_ERRORS.MISSING_ISS);
  const sub = requirePart(bag, "sub", PRINCIPAL_KEY_ERRORS.MISSING_SUB);
  const actor = actorFromClaims(bag);
  for (const part of [iss, sub, actor]) assertSafePart(part);
  return {
    principalKey: `${iss}${PRINCIPAL_KEY_SEPARATOR}${sub}${PRINCIPAL_KEY_SEPARATOR}${actor}`,
    humanKey: `${iss}${PRINCIPAL_KEY_SEPARATOR}${sub}`,
  };
}

/**
 * @param {object} claims
 * @returns {string}
 * @throws {PrincipalKeyError}
 */
function actorFromClaims(claims) {
  if (Object.hasOwn(claims, "act") && claims.act !== null && claims.act !== undefined) {
    const actor = topLevelActSub(claims.act);
    if (actor === "") {
      throw new PrincipalKeyError(
        PRINCIPAL_KEY_ERRORS.MISSING_ACT_SUB,
        "A delegation (act) claim requires a top-level act.sub.",
      );
    }
    return actor;
  }
  return requirePart(claims, "azp", PRINCIPAL_KEY_ERRORS.MISSING_AZP);
}

/**
 * @param {object} claims
 * @param {string} name
 * @param {string} missing
 * @returns {string}
 * @throws {PrincipalKeyError}
 */
function requirePart(claims, name, missing) {
  const value = new Map(Object.entries(claims)).get(name);
  if (typeof value !== "string" || value === "") {
    throw new PrincipalKeyError(missing, `Principal key requires a ${name} claim.`);
  }
  return value;
}

/**
 * Canonical iss|sub|actor from an operator-supplied principal key.
 *
 * @param {string} key
 * @returns {string}
 * @throws {PrincipalKeyError}
 */
export function parsePrincipalKey(key) {
  const parts = splitKey(key, 2);
  const missing = [
    PRINCIPAL_KEY_ERRORS.MISSING_ISS,
    PRINCIPAL_KEY_ERRORS.MISSING_SUB,
    PRINCIPAL_KEY_ERRORS.MISSING_AZP,
  ];
  const names = ["iss", "sub", "actor"];
  parts.forEach((part, i) => {
    if (part === "") {
      throw new PrincipalKeyError(missing[i], `Principal key requires a ${names[i]} claim.`);
    }
    assertSafePart(part);
  });
  return parts.join(PRINCIPAL_KEY_SEPARATOR);
}

/**
 * Canonical iss|sub from an operator-supplied human key.
 *
 * @param {string} key
 * @returns {string}
 * @throws {PrincipalKeyError}
 */
export function parseHumanKey(key) {
  const parts = splitKey(key, 1);
  const missing = [PRINCIPAL_KEY_ERRORS.MISSING_ISS, PRINCIPAL_KEY_ERRORS.MISSING_SUB];
  const names = ["iss", "sub"];
  parts.forEach((part, i) => {
    if (part === "") {
      throw new PrincipalKeyError(missing[i], `Principal key requires a ${names[i]} claim.`);
    }
    assertSafePart(part);
  });
  return parts.join(PRINCIPAL_KEY_SEPARATOR);
}

/**
 * @param {string} key
 * @param {number} separators
 * @returns {string[]}
 * @throws {PrincipalKeyError}
 */
function splitKey(key, separators) {
  if (typeof key !== "string" || !isValidUtf8String(key)) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_UTF8,
      "Principal-key claims must be valid UTF-8.",
    );
  }
  const found = key.split(PRINCIPAL_KEY_SEPARATOR).length - 1;
  if (found > separators) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_SEPARATOR,
      "Principal-key claims must not contain \"|\".",
    );
  }
  if (found < separators) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_PART,
      "The kill selector does not match the principal-key shape.",
    );
  }
  return key.split(PRINCIPAL_KEY_SEPARATOR);
}

/**
 * Rejects `|`, control characters, whitespace-only, and over-long parts.
 *
 * @param {string} part
 * @returns {void}
 * @throws {PrincipalKeyError}
 */
export function assertSafePart(part) {
  if (typeof part !== "string" || !isValidUtf8String(part)) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_UTF8,
      "Principal-key claims must be valid UTF-8.",
    );
  }
  if (part.includes(PRINCIPAL_KEY_SEPARATOR)) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_SEPARATOR,
      "Principal-key claims must not contain \"|\".",
    );
  }
  if (/^[\s\p{Z}]*$/u.test(part)) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_PART,
      "Principal-key claims must not be whitespace-only.",
    );
  }
  if (/\p{C}/u.test(part)) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.INVALID_PART,
      "Principal-key claims must not contain control characters.",
    );
  }
  if (Array.from(part).length > PRINCIPAL_KEY_MAX_PART_LENGTH) {
    throw new PrincipalKeyError(
      PRINCIPAL_KEY_ERRORS.PART_TOO_LONG,
      `Principal-key claims must be at most ${PRINCIPAL_KEY_MAX_PART_LENGTH} characters per part.`,
    );
  }
}

/**
 * Compose keys from a verified identity, or fail closed.
 *
 * @param {object|null|undefined} identity
 * @returns {{principalKey: string, humanKey: string}}
 * @throws {PrincipalKeyError}
 */
export function fromIdentity(identity) {
  return fromClaims(keyClaimsFromIdentity(identity));
}
