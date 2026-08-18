/**
 * Resolved-target disclosure and the multi-site write guard (#167).
 *
 * A silent default that returns plausible content from the wrong environment
 * is the failure class: the response looks like success and every field a
 * caller would sanity-check (id, title, url) is correct. `_target` uses the
 * same `{ name, baseUrl, source }` block as `drupal_mcp_whoami` so there is
 * one vocabulary. `source` is load-bearing — `hint` when the caller named a
 * target, `default` when `defaultSite` was used, `grant` when a principal
 * had exactly one entitled site.
 *
 * Reads may still default. Writes (and GraphQL mutations) may not when more
 * than one site is configured: a write on the wrong site is not recoverable.
 */

import { describeTarget } from "./principal.js";
import { isWriteLikeCall } from "./operations.js";
import { SecurityError } from "./security.js";

/** Shared `site` argument schema. Injected onto every tool that accepts `site`. */
export const SITE_PARAM = {
  type: "string",
  description:
    "Named site from connector config. Omit only on reads: multi-site configs " +
    "fall back to defaultSite (often local/dev, not production). Writes require " +
    "an explicit site when more than one site is configured. Every response " +
    "includes `_target` { name, baseUrl, source } (`hint` when you passed site, " +
    "`default` when you did not).",
};

/**
 * Attach the resolved target to a tool payload so JSON.stringify keeps it.
 *
 * Object results get `_target` as a sibling. Arrays are wrapped as
 * `{ items, _target }` because extra properties on an array are dropped by
 * JSON.stringify. Tools that do not address a single site pass `resolved` as
 * null and are returned unchanged.
 *
 * @param {*} result Handler return value.
 * @param {?{site: object, source: string}} resolved
 * @returns {*}
 */
export function withResolvedTarget(result, resolved) {
  if (!resolved?.site) return result;
  const _target = describeTarget(resolved.site, resolved.source);
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, _target };
  }
  if (Array.isArray(result)) {
    return { items: result, _target };
  }
  if (result === undefined || result === null) {
    return { _target };
  }
  return { result, _target };
}

/**
 * Refuse a write that would silently land on defaultSite when more than one
 * site is configured. Resolution behaviour for reads is unchanged.
 *
 * @param {string} toolName
 * @param {object} args Raw caller arguments (before any default rewrite).
 * @param {?{site: object, source: string, name: string}} resolved
 * @param {string[]} siteNames Configured site names.
 * @returns {void}
 * @throws {SecurityError}
 */
export function assertExplicitSiteForWrite(toolName, args, resolved, siteNames) {
  if (!resolved || resolved.source !== "default") return;
  if (!Array.isArray(siteNames) || siteNames.length < 2) return;
  if (!isWriteLikeCall(toolName, args)) return;
  throw new SecurityError(
    "Write tools require an explicit site when more than one site is configured. " +
    "Omitted site would default to \"" + resolved.name + "\" (" + resolved.site.baseUrl + "). " +
    "Pass site explicitly. Configured sites: " + siteNames.join(", ") + ".",
  );
}
