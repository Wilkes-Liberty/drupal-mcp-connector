/**
 * Frozen principal + tenant context from a verified access token.
 *
 * The connector proposes this context; Drupal (mcp_sentinel) disposes.
 * Fields come only from the validated token. The connector never widens,
 * rewrites, or invents principal fields, and never takes tenant from
 * headers or tool arguments (DEV-839).
 */

import { fromClaims, keyClaimsFromIdentity } from "./principal-key.js";
import { SecurityError } from "./security.js";
import { assertTestOnly } from "./test-only.js";

/**
 * Stdio (`null`) and the explicit loopback local-operator identity.
 * Inlined so this module does not import `principal.js`.
 *
 * @param {object|null|undefined} identity
 * @returns {boolean}
 */
function isLocal(identity) {
  return identity === null || identity === undefined || identity.localOperator === true;
}

/**
 * Caller-facing refusal used for a missing principal, a missing tenant,
 * an inactive token, and a kill (DEV-846). A killed principal must not
 * produce a distinct signal.
 */
export const GENERIC_PRINCIPAL_REFUSAL = "A verified principal context is required.";

/**
 * Identity and tenant keys that must never become authority from arguments.
 */
export const RESERVED_PRINCIPAL_ARG_KEYS = Object.freeze([
  "user", "uid", "principal", "tenant", "tenant_id", "tenantId",
  "act", "on_behalf_of", "onBehalfOf", "sub", "iss", "azp",
  "client_id", "user_id", "userId", "actor", "scope", "scopes", "subject",
]);

/** Header names that must never become tenant or principal. */
export const SPOOFABLE_TENANT_HEADERS = Object.freeze([
  "x-mcp-tenant",
  "x-mcp-tenant-id",
  "x-forwarded-tenant",
  "x-tenant",
  "tenant",
]);

/**
 * In-process tenant/principal guard (DEV-839 / DEV-844 follow-on).
 * Production leaves `required` true. Tests call
 * {@link setPrincipalContextGuard} for a red run.
 */
export const PRINCIPAL_CONTEXT_GUARD = { required: true };

/**
 * Flip {@link PRINCIPAL_CONTEXT_GUARD} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setPrincipalContextGuard(required) {
  assertTestOnly("setPrincipalContextGuard");
  PRINCIPAL_CONTEXT_GUARD.required = Boolean(required);
}

/**
 * Tenant claim from verified token claims only. Headers and arguments
 * are not inputs. Non-string values are not coerced.
 *
 * @param {object|null|undefined} claims
 * @returns {string}
 */
export function tenantFromClaims(claims) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return "";
  const value = new Map(Object.entries(claims)).get("tenant");
  return typeof value === "string" && value !== "" ? value : "";
}

/**
 * RFC 8693 act chain of `act.sub` values, outermost first.
 *
 * @param {unknown} act
 * @returns {string[]}
 */
function actChainFromClaim(act) {
  const chain = [];
  let current = act;
  while (current && typeof current === "object" && !Array.isArray(current)) {
    const sub = new Map(Object.entries(current)).get("sub");
    if (typeof sub === "string" && sub !== "") chain.push(sub);
    current = new Map(Object.entries(current)).get("act");
  }
  return Object.freeze(chain);
}

/**
 * Copy only the claims the key formula reads. Values are not rewritten.
 *
 * @param {object} claims
 * @returns {object}
 */
export function freezeKeyClaims(claims) {
  const out = {};
  for (const name of ["iss", "sub", "azp", "act"]) {
    if (Object.hasOwn(claims, name)) out[name] = claims[name];
  }
  return Object.freeze(out);
}

/**
 * Freeze a principal context from verified token claims. Caller headers
 * and tool arguments are not inputs.
 *
 * @param {object} claims Validated introspection claims.
 * @param {{network?: boolean}} [options]
 * @returns {Readonly<object>}
 */
export function freezePrincipalContext(claims, options = {}) {
  const bag = claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  const keyClaims = freezeKeyClaims(bag);
  const issuer = typeof bag.iss === "string" ? bag.iss : "";
  const subject = typeof bag.sub === "string" ? bag.sub : "";
  const azp = typeof bag.azp === "string" ? bag.azp : "";
  const clientId = azp;
  const scopes = Array.isArray(bag.scopes)
    ? bag.scopes.filter((item) => typeof item === "string" && item)
    : (typeof bag.scope === "string" ? bag.scope.split(/[\s,]+/).filter(Boolean) : []);
  return Object.freeze({
    issuer,
    subject,
    azp,
    clientId,
    scopes: Object.freeze([...scopes]),
    tenant: tenantFromClaims(bag),
    actChain: actChainFromClaim(bag.act),
    network: options.network === true,
    keyClaims,
  });
}

/**
 * Frozen context from a request identity (already built from the token).
 *
 * @param {object|null|undefined} identity
 * @param {{network?: boolean}} [options]
 * @returns {Readonly<object>|null}
 */
export function principalContextFromIdentity(identity, options = {}) {
  if (isLocal(identity)) return null;
  if (!identity || typeof identity !== "object") return null;
  const claims = {
    ...keyClaimsFromIdentity(identity),
    ...(typeof identity.tenant === "string" ? { tenant: identity.tenant } : {}),
    ...(Array.isArray(identity.scopes) ? { scopes: identity.scopes } : {}),
  };
  return freezePrincipalContext(claims, options);
}

/**
 * Generic deny used on every principal/tenant/kill refusal.
 *
 * @returns {SecurityError}
 */
export function principalDenied() {
  return new SecurityError(GENERIC_PRINCIPAL_REFUSAL);
}

/**
 * Remap a node-fetch AbortError whose parent signal was a principal
 * deny. node-fetch 3 drops `signal.reason` on the rejection.
 * Production leaves `enabled` true. Tests call
 * {@link setPrincipalAbortRemapGuard} for a red run of one branch.
 */
const PRINCIPAL_ABORT_REMAP = { enabled: true };

/**
 * Flip {@link PRINCIPAL_ABORT_REMAP} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} enabled
 * @returns {void}
 */
export function setPrincipalAbortRemapGuard(enabled) {
  assertTestOnly("setPrincipalAbortRemapGuard");
  PRINCIPAL_ABORT_REMAP.enabled = Boolean(enabled);
}

/**
 * True when an aborted fetch is a principal deny, including when
 * node-fetch replaced the rejection with a bare AbortError.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {*} err
 * @returns {boolean}
 */
function isPrincipalAbort(signal, err) {
  const reason = signal?.reason ?? err?.cause ?? err;
  if (reason instanceof Error && reason.message === GENERIC_PRINCIPAL_REFUSAL) return true;
  if (reason === GENERIC_PRINCIPAL_REFUSAL) return true;
  if (err?.message === GENERIC_PRINCIPAL_REFUSAL) return true;
  return false;
}

/**
 * Re-throw {@link principalDenied} when `err` is a kill abort.
 *
 * @param {AbortSignal|null|undefined} signal
 * @param {*} err
 * @returns {void}
 * @throws {SecurityError}
 */
export function throwIfPrincipalAbort(signal, err) {
  if (PRINCIPAL_ABORT_REMAP.enabled && isPrincipalAbort(signal, err)) {
    throw principalDenied();
  }
}

/**
 * Run `work` and remap a kill abort (including a node-fetch body
 * AbortError that dropped `signal.reason`) to {@link principalDenied}.
 *
 * @template T
 * @param {AbortSignal|null|undefined} signal
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function mapPrincipalAbort(signal, work) {
  try {
    return await work();
  } catch (err) {
    throwIfPrincipalAbort(signal, err);
    throw err;
  }
}

/**
 * Network JWT principals need a string `tenant` claim and a composable
 * principal key. Arguments and headers never supply those fields.
 *
 * @param {object} params
 * @param {object|null} params.identity
 * @param {"network"|null} [params.surface]
 * @param {object} [params.args]
 * @param {object} [params.headers]
 * @param {object|null} [params.principalContext]
 * @returns {object|null} Frozen context, or null for a local operator.
 * @throws {SecurityError}
 */
export function assertFrozenPrincipal({
  identity,
  surface = null,
  principalContext = null,
} = {}) {
  if (isLocal(identity)) return null;
  const network = surface === "network";
  const ctx = principalContextFromIdentity(identity, { network });
  if (principalContext) {
    if (!ctx || principalContext.tenant !== ctx.tenant) throw principalDenied();
    try {
      const supplied = fromClaims(principalContext.keyClaims);
      const expected = fromClaims(ctx.keyClaims);
      if (supplied.principalKey !== expected.principalKey) throw principalDenied();
    } catch (err) {
      if (err instanceof SecurityError && err.message === GENERIC_PRINCIPAL_REFUSAL) throw err;
      throw principalDenied();
    }
  }
  if (!network) return ctx;
  if (!ctx) throw principalDenied();
  try {
    fromClaims(ctx.keyClaims);
  } catch {
    throw principalDenied();
  }
  if (ctx.tenant === "") {
    if (!PRINCIPAL_CONTEXT_GUARD.required) return ctx;
    throw principalDenied();
  }
  return ctx;
}
