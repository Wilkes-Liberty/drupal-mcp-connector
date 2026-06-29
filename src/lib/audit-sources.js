/**
 * Privileged-source resolution for the audit tool groups.
 *
 * Single responsibility: run an audit that needs privileged log/config/module
 * data through the best available source, in priority order — the governed
 * Sentinel server-tool first, the drush SSH bridge as a fallback — and report a
 * clean "unavailable" outcome (never throw) when neither is configured or both
 * fail. This keeps the connector shippable before the companion mcp_sentinel
 * methods land: the tools degrade to a gated payload instead of erroring.
 */

/**
 * Whether the governed server-tool bridge is configured for a site.
 * @param {object} site Resolved site config.
 * @returns {boolean}
 */
export function serverToolsConfigured(site) {
  return Boolean(site?.serverTools?.url);
}

/**
 * Whether the drush SSH bridge is configured for a site.
 * @param {object} site Resolved site config.
 * @returns {boolean}
 */
export function drushConfigured(site) {
  return Boolean(site?.drushSsh);
}

/**
 * Run a privileged audit through the first source that succeeds.
 *
 * Tries the Sentinel server-tool (when `serverTools` is configured), then the
 * drush bridge (when `drushSsh` is configured). Either callback may be omitted
 * when that source can't serve the audit. Failures are accumulated, not thrown,
 * so the caller can surface them in a gated payload.
 *
 * @param {object} site Resolved site config.
 * @param {object} sources
 * @param {(() => Promise<*>)} [sources.serverTool] Server-tool attempt.
 * @param {(() => Promise<*>)} [sources.drush] Drush attempt.
 * @returns {Promise<{source: ("server-tool"|"drush"|null), data?: *, attempts: string[]}>}
 *   On success, `source` names the winning path and `data` is its result. On
 *   failure, `source` is null and `attempts` explains why each path was skipped
 *   or failed.
 */
export async function runPrivileged(site, { serverTool, drush } = {}) {
  const attempts = [];

  if (serverTool && serverToolsConfigured(site)) {
    try { return { source: "server-tool", data: await serverTool(), attempts }; }
    catch (err) { attempts.push(`server-tool: ${err?.message || err}`); }
  } else if (serverTool) {
    attempts.push("server-tool: serverTools.url not configured for this site");
  }

  if (drush && drushConfigured(site)) {
    try { return { source: "drush", data: await drush(), attempts }; }
    catch (err) { attempts.push(`drush: ${err?.message || err}`); }
  } else if (drush) {
    attempts.push("drush: drushSsh not configured for this site");
  }

  return { source: null, attempts };
}
