/**
 * Northbound data-flow budgets (#179).
 *
 * Binds the same finite budget classes mcp_sentinel already enforces
 * (rows, bytes, pages, requests, chained actions) to the inbound principal
 * and the authoritative target. Budget counters are keyed by those two
 * values — never by MCP session, client IP, or a caller-supplied field —
 * so pagination, retries, batching, and a new chain id cannot reset them.
 *
 * Classification and destination travel on the governed request as the
 * source's narrow-only wire contract (X-MCP-Declared-Ceiling /
 * X-MCP-Declared-Destination). Denials name a stable reason and a
 * correlation id and never echo restricted payload.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { SecurityError } from "./security.js";

/** Wire header: narrow-only classification ceiling (mcp_sentinel 2.9.0). */
export const HEADER_DECLARED_CEILING = "X-MCP-Declared-Ceiling";

/** Wire header: declared destination, recorded in source evidence. */
export const HEADER_DECLARED_DESTINATION = "X-MCP-Declared-Destination";

/** Stable source / connector reason codes — do not invent a second set. */
export const REASON_READ = "read_budget_exceeded";
export const REASON_PAGE = "page_budget_exceeded";
export const REASON_RESPONSE_SIZE = "response_size_cap_exceeded";
export const REASON_CHAINED_ACTION = "chained_action_budget_exceeded";
export const REASON_BUDGET_CONTEXT_MISSING = "budget_context_missing";

/** Codes the source already emits; remapped onto a connector correlation id. */
export const SOURCE_BUDGET_REASONS = Object.freeze([
  REASON_READ,
  REASON_PAGE,
  REASON_RESPONSE_SIZE,
  REASON_CHAINED_ACTION,
  "classification_egress_denied",
]);

/**
 * Built-in defaults — identical to mcp_sentinel McpReadBudgetResolver.
 * A second model is out of scope; these numbers are the shared floor.
 */
export const DEFAULT_BUDGETS = Object.freeze({
  results: 500,
  bytes: 8388608,
  requests: 600,
  requestWindowSec: 60,
  pages: 120,
  pageWindowSec: 60,
  chainedActions: 600,
  chainedActionWindowSec: 60,
});

const DECLARATION_MAX_LENGTH = 128;
const DECLARATION_PATTERN = /^[A-Za-z0-9._:-]+$/;

const store = new AsyncLocalStorage();

/** @type {Map<string, {count: number, resetAt: number}>} */
const windows = new Map();

const WINDOW_KINDS = new Set(["request", "page", "chained_action"]);

/**
 * Denial for a data-flow budget or missing request-scoped context.
 * Extends SecurityError so tools/call already wraps it as Access denied.
 */
export class DataFlowBudgetError extends SecurityError {
  /**
   * @param {string} reason Stable reason code.
   * @param {string} correlationId Request-scoped correlation id.
   * @param {string} [budget] Budget class (requests, pages, rows, bytes, chained_actions).
   */
  constructor(reason, correlationId, budget) {
    super(`${reason} (correlation ${correlationId})`);
    this.name = "DataFlowBudgetError";
    this.reason = reason;
    this.correlationId = correlationId;
    this.budget = budget;
  }
}

/**
 * Process-global budget key for an inbound identity. Session ids are never used.
 * @param {object|null} identity
 * @returns {string}
 */
export function principalBudgetKey(identity) {
  if (!identity) return "local-operator";
  const sub = typeof identity.sub === "string" && identity.sub.trim()
    ? identity.sub.trim()
    : "-";
  const clientId = typeof identity.clientId === "string" && identity.clientId.trim()
    ? identity.clientId.trim()
    : "-";
  return `${sub}:${clientId}`;
}

/**
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function sanitizeDeclaration(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DECLARATION_MAX_LENGTH) return undefined;
  return DECLARATION_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * @param {object} [raw]
 * @returns {typeof DEFAULT_BUDGETS}
 */
export function resolveBudgetLimits(raw = {}) {
  const merged = new Map(Object.entries(DEFAULT_BUDGETS));
  const supplied = new Map(Object.entries(raw));
  for (const [key, fallback] of Object.entries(DEFAULT_BUDGETS)) {
    const value = supplied.get(key);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged.set(key, value);
    } else {
      merged.set(key, fallback);
    }
  }
  return Object.fromEntries(merged);
}

/**
 * Build request-scoped enforcement context. Target is required; identity may
 * be null (local operator). Caller-supplied session fields are ignored.
 *
 * @param {object} params
 * @param {object|null} [params.identity]
 * @param {?{name?: string, baseUrl?: string, source?: string}} params.target
 * @param {object} [params.site]
 * @param {object} [params.limits]
 * @param {() => number} [params.now]
 * @param {string} [params.correlationId]
 * @returns {object}
 * @throws {DataFlowBudgetError}
 */
export function buildDataFlowContext({
  identity = null,
  target,
  site,
  limits,
  now = () => Date.now(),
  correlationId,
} = {}) {
  const id = correlationId || randomUUID();
  const targetName = typeof target?.name === "string" ? target.name.trim() : "";
  if (!targetName) {
    throw new DataFlowBudgetError(REASON_BUDGET_CONTEXT_MISSING, id, "context");
  }

  const sec = site?.security ?? {};
  const clientId = typeof identity?.clientId === "string" && identity.clientId.trim()
    ? identity.clientId.trim()
    : "local-operator";
  const destination = sanitizeDeclaration(`${clientId}:${targetName}`);
  const ceiling = sanitizeDeclaration(sec.declaredCeiling) ?? "internal";
  const declaredCeiling = sanitizeDeclaration(sec.declaredCeiling);

  return {
    principalKey: principalBudgetKey(identity),
    targetName,
    destination,
    ceiling: declaredCeiling ?? ceiling,
    declaredCeiling,
    correlationId: id,
    limits: resolveBudgetLimits(limits ?? sec.readBudgets),
    now,
    currentRequest: { rows: 0, bytes: 0, counted: false },
    // Connector-side counters bind to an authenticated inbound principal.
    // Stdio / local operator still send declared headers; source uid budgets
    // remain the floor there (see #178).
    enforce: Boolean(identity),
  };
}

/**
 * @param {object} context
 * @param {Function} fn
 * @returns {*}
 */
export function runWithDataFlow(context, fn) {
  return store.run(context, fn);
}

/**
 * @returns {object|null}
 */
export function getDataFlowContext() {
  return store.getStore() ?? null;
}

/**
 * Headers for one northbound Drupal request. Empty when no context is bound.
 * @param {object} [context]
 * @returns {Object<string,string>}
 */
export function northboundHeaders(context) {
  const ctx = context ?? getDataFlowContext();
  if (!ctx?.targetName || !ctx.principalKey) return {};
  const headers = new Map();
  const ceiling = sanitizeDeclaration(ctx.declaredCeiling);
  if (ceiling) headers.set(HEADER_DECLARED_CEILING, ceiling);
  const destination = sanitizeDeclaration(ctx.destination);
  if (destination) headers.set(HEADER_DECLARED_DESTINATION, destination);
  return Object.fromEntries(headers);
}

/**
 * @param {object|null} ctx
 * @returns {object}
 * @throws {DataFlowBudgetError}
 */
function requireBoundContext(ctx) {
  if (!ctx?.principalKey || !ctx.targetName) {
    throw new DataFlowBudgetError(
      REASON_BUDGET_CONTEXT_MISSING,
      ctx?.correlationId || randomUUID(),
      "context",
    );
  }
  return ctx;
}

/**
 * @param {string} kind
 * @returns {string}
 */
function reasonFor(kind) {
  switch (kind) {
    case "page":
      return REASON_PAGE;
    case "bytes":
      return REASON_RESPONSE_SIZE;
    case "chained_action":
      return REASON_CHAINED_ACTION;
    case "request":
    case "rows":
      return REASON_READ;
    default: {
      const _exhaustive = kind;
      return _exhaustive && REASON_READ;
    }
  }
}

/**
 * @param {string} kind
 * @returns {string}
 */
function budgetClass(kind) {
  switch (kind) {
    case "chained_action":
      return "chained_actions";
    case "rows":
      return "rows";
    case "bytes":
      return "bytes";
    case "page":
      return "pages";
    case "request":
      return "requests";
    default: {
      const _exhaustive = kind;
      return _exhaustive || "requests";
    }
  }
}

/**
 * Consume a budget class only when an inbound principal is bound.
 * @param {"request"|"page"|"rows"|"bytes"|"chained_action"} kind
 * @param {number} [amount]
 * @param {{retry?: boolean}} [options]
 * @returns {void}
 */
export function consumeBudgetIfEnforced(kind, amount = 1, options = {}) {
  if (!getDataFlowContext()?.enforce) return;
  consumeBudget(kind, amount, options);
}

/**
 * Account a successful northbound body against row and byte caps.
 * @param {object|null} json
 * @param {string} [text]
 * @returns {void}
 */
export function accountNorthboundBody(json, text = "") {
  if (!getDataFlowContext()?.enforce) return;
  if (text) consumeBudget("bytes", Buffer.byteLength(text));
  const rows = Array.isArray(json?.data) ? json.data.length : (json?.data ? 1 : 0);
  if (rows) consumeBudget("rows", rows);
}

/**
 * Consume one budget class against the request-scoped principal+target key.
 *
 * @param {"request"|"page"|"rows"|"bytes"|"chained_action"} kind
 * @param {number} [amount]
 * @param {{retry?: boolean}} [options]
 * @returns {void}
 * @throws {DataFlowBudgetError}
 */
export function consumeBudget(kind, amount = 1, options = {}) {
  const ctx = requireBoundContext(getDataFlowContext());
  const qty = typeof amount === "number" && amount > 0 ? amount : 1;

  if (options.retry && (kind === "request" || kind === "page")) {
    if (!ctx.currentRequest.counted) {
      throw deny(ctx, kind);
    }
    return;
  }

  if (kind === "rows" || kind === "bytes") {
    const cap = kind === "rows" ? ctx.limits.results : ctx.limits.bytes;
    const used = kind === "rows" ? ctx.currentRequest.rows : ctx.currentRequest.bytes;
    if (used + qty > cap) {
      throw deny(ctx, kind);
    }
    if (kind === "rows") ctx.currentRequest.rows += qty;
    else ctx.currentRequest.bytes += qty;
    return;
  }

  if (!WINDOW_KINDS.has(kind)) {
    throw deny(ctx, kind);
  }

  if (!windowConsume(ctx, kind, qty)) {
    throw deny(ctx, kind);
  }

  if (kind === "request") {
    ctx.currentRequest = { rows: 0, bytes: 0, counted: true };
  } else {
    ctx.currentRequest.counted = true;
  }
}

/**
 * @param {object} ctx
 * @param {string} kind
 * @returns {DataFlowBudgetError}
 */
function deny(ctx, kind) {
  return new DataFlowBudgetError(reasonFor(kind), ctx.correlationId, budgetClass(kind));
}

/**
 * @param {object} ctx
 * @param {string} kind
 * @returns {{limit: number, windowMs: number}}
 */
function windowSpec(ctx, kind) {
  if (kind === "page") {
    return { limit: ctx.limits.pages, windowMs: ctx.limits.pageWindowSec * 1000 };
  }
  if (kind === "chained_action") {
    return {
      limit: ctx.limits.chainedActions,
      windowMs: ctx.limits.chainedActionWindowSec * 1000,
    };
  }
  return { limit: ctx.limits.requests, windowMs: ctx.limits.requestWindowSec * 1000 };
}

/**
 * @param {object} ctx
 * @param {string} kind
 * @returns {string}
 */
function windowKey(ctx, kind) {
  return `${ctx.principalKey}::${ctx.targetName}::${kind}`;
}

/**
 * @param {object} ctx
 * @param {string} kind
 * @param {number} qty
 * @returns {boolean}
 */
function windowConsume(ctx, kind, qty) {
  const { limit, windowMs } = windowSpec(ctx, kind);
  const now = ctx.now();
  const key = windowKey(ctx, kind);
  let bucket = windows.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    windows.set(key, bucket);
  }
  if (bucket.count + qty > limit) return false;
  bucket.count += qty;
  return true;
}

/**
 * Map a source-side refusal body onto a connector denial that carries our
 * correlation id and none of the upstream payload.
 *
 * @param {string} detail
 * @param {string} [correlationId]
 * @returns {DataFlowBudgetError|null}
 */
export function sourceBudgetDenial(detail, correlationId) {
  const text = String(detail ?? "");
  const reason = SOURCE_BUDGET_REASONS.find((code) => text.includes(code));
  if (!reason) return null;
  const id = correlationId || getDataFlowContext()?.correlationId || randomUUID();
  return new DataFlowBudgetError(reason, id, reason);
}

/**
 * Drop in-memory windows. Tests only.
 * @returns {void}
 */
export function resetDataFlowBudgets() {
  windows.clear();
}

/**
 * JSON:API collection paths are type/bundle with no uuid segment.
 * @param {string} path
 * @returns {boolean}
 */
export function isCollectionJsonApiPath(path) {
  const pathname = String(path ?? "").split("?")[0];
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "jsonapi" && parts.length === 3;
}
