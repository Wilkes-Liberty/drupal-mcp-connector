/**
 * Privileged-source resolution for the audit tool groups.
 *
 * Single responsibility: run an audit that needs privileged log/config/module
 * data through the best available source, in priority order — an optional
 * governed server-tool first (when a callback is supplied), the connector's own
 * drush SSH bridge otherwise — and report a clean "unavailable" outcome (never
 * throw) when no source is configured or all fail. The drush bridge makes the
 * audits self-sufficient against stock Drupal; no companion module is required.
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
 * Tries the optional governed server-tool (when a `serverTool` callback is given
 * and `serverTools` is configured), then the connector's own drush bridge (when a
 * `drush` callback is given and `drushSsh` is configured). Either callback may be
 * omitted when that source can't serve the audit. Failures are accumulated, not
 * thrown, so the caller can surface them in a gated payload.
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
