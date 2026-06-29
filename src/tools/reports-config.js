/**
 * Tool group: Configuration & site-health audits.
 *
 * Read-only audits of a site's configuration posture: config drift, a
 * best-practice / security config linter, enabled-module review, role/permission
 * review, the Drupal "status report" requirements, text-format safety, and cache
 * posture. These read privileged data (config objects, the module list, the
 * requirements report) through the governed Sentinel server-tool first, falling
 * back to the drush bridge where one exists, and returning a `gatedReport`
 * payload (never throwing) when neither source is available.
 *
 * The config-inspection audits additionally assert connector-side config-read
 * access, mirroring the governed config tools — so they run under the auditor /
 * config-editor / development presets and require an explicit opt-in under
 * production-strict.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveSecurityConfig, assertConfigReadAllowed } from "../lib/security.js";
import { gatedReport } from "../lib/reports-support.js";
import { callServerTool, SERVER_TOOLS, toolResultData } from "../lib/server-tools.js";
import { runPrivileged } from "../lib/audit-sources.js";
import { sshDrush, parseDrush } from "./drush.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a nested value from a config object by dotted path.
 * @param {object} obj A config object.
 * @param {string} path Dotted key path, e.g. "cache.page.max_age".
 * @returns {*} The value, or undefined when any segment is missing.
 */
function dig(obj, path) {
  let acc = obj;
  for (const k of path.split(".")) {
    if (acc === undefined || acc === null || typeof acc !== "object") return undefined;
    acc = new Map(Object.entries(acc)).get(k);
  }
  return acc;
}

/**
 * Fetch and parse a single config object via the governed server tool.
 * @param {object} site Resolved site config.
 * @param {string} name Config object name.
 * @returns {Promise<*>} Parsed config object (or null/text).
 */
async function getConfig(site, name) {
  return toolResultData(await callServerTool(site, SERVER_TOOLS.configGet, { name }));
}

/**
 * Build a finding record.
 * @param {string} severity "high" | "medium" | "low" | "info".
 * @param {string} id Stable finding id.
 * @param {string} message Human-readable description.
 * @param {object} [extra] Extra fields to merge.
 * @returns {object} Finding.
 */
function finding(severity, id, message, extra = {}) {
  return { severity, id, message, ...extra };
}

// ---------------------------------------------------------------------------
// drupal_report_config_drift
// ---------------------------------------------------------------------------

/**
 * Report whether active configuration matches the sync directory, as a
 * structured added/changed/deleted breakdown. Uses the Sentinel server-tool when
 * configured, else `drush config:status`; gated when neither is available.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Drift summary, or a gated payload.
 */
async function configDrift({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const res = await runPrivileged(site, {
    serverTool: () => callServerTool(site, SERVER_TOOLS.configStatus, {}).then(toolResultData),
    drush: async () => {
      const out = await sshDrush(site, ["config:status", "--format=json"]);
      return parseDrush(out);
    },
  });
  if (!res.source) return gatedReport("report_config_drift", "server-tool/drush", res.attempts.join("; "));

  const rows = normalizeRows(res.data);
  if (!rows.length) {
    return { site: site._name, source: res.source, inSync: true, summary: { added: 0, changed: 0, removed: 0 }, changes: [] };
  }
  const changes = rows.map((r) => ({
    name: r.name ?? r.config ?? r.key ?? null,
    state: normalizeState(r.state ?? r.status ?? r.operation),
  }));
  const summary = { added: 0, changed: 0, removed: 0 };
  for (const c of changes) {
    if (c.state === "added") summary.added++;
    else if (c.state === "removed") summary.removed++;
    else summary.changed++;
  }
  return { site: site._name, source: res.source, inSync: false, summary, changes };
}

/**
 * Normalize a config:status state string into added/removed/changed.
 * @param {?string} state Raw drush/Sentinel state.
 * @returns {"added"|"removed"|"changed"} Canonical state.
 */
function normalizeState(state) {
  const s = String(state || "").toLowerCase();
  if (s.includes("create") || s.includes("add") || s.includes("only in active")) return "added";
  if (s.includes("delete") || s.includes("remov") || s.includes("only in sync")) return "removed";
  return "changed";
}

/**
 * Coerce a privileged result into an array of rows.
 * @param {*} data Result payload.
 * @returns {object[]} Rows.
 */
function normalizeRows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.changes && Array.isArray(data.changes)) return data.changes;
  if (typeof data === "object") {
    // drush config:status may return { "config.name": "Different", ... }.
    return Object.entries(data).map(([name, state]) => ({ name, state }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// drupal_audit_config_best_practices
// ---------------------------------------------------------------------------

/**
 * Curated config checks: each reads one config object and evaluates one risky
 * setting. Grouped here so the audit fetches each config object only once.
 */
const BEST_PRACTICE_CHECKS = [
  {
    config: "system.logging",
    evaluate: (c) => {
      const level = dig(c, "error_level");
      if (level === "all" || level === "verbose") {
        return finding("high", "error_display", `On-screen error display is "${level}" — leaks errors to visitors. Set to "hide" in production.`, { config: "system.logging", value: level });
      }
      return null;
    },
  },
  {
    config: "system.performance",
    evaluate: (c) => {
      const out = [];
      if (dig(c, "css.preprocess") === false) out.push(finding("medium", "css_aggregation", "CSS aggregation is off — hurts front-end performance in production.", { config: "system.performance" }));
      if (dig(c, "js.preprocess") === false) out.push(finding("medium", "js_aggregation", "JS aggregation is off — hurts front-end performance in production.", { config: "system.performance" }));
      const maxAge = dig(c, "cache.page.max_age");
      if (maxAge === 0 || maxAge === "0") out.push(finding("medium", "page_cache", "Anonymous page cache max-age is 0 — pages are not cached for anonymous users.", { config: "system.performance" }));
      return out;
    },
  },
  {
    config: "user.settings",
    evaluate: (c) => {
      const register = dig(c, "register");
      if (register === "visitors") {
        return finding("high", "open_registration", "Anyone can register an account without approval (user.settings.register = visitors).", { config: "user.settings", value: register });
      }
      return null;
    },
  },
  {
    config: "system.site",
    evaluate: (c) => {
      const out = [];
      if (!dig(c, "page.404")) out.push(finding("low", "missing_404_page", "No custom 404 page is configured (system.site.page.404).", { config: "system.site" }));
      if (!dig(c, "page.403")) out.push(finding("low", "missing_403_page", "No custom 403 page is configured (system.site.page.403).", { config: "system.site" }));
      return out;
    },
  },
  {
    config: "system.file",
    evaluate: (c) => {
      if (dig(c, "allow_insecure_uploads") === true) {
        return finding("high", "insecure_uploads", "Insecure file uploads are allowed (system.file.allow_insecure_uploads = true).", { config: "system.file" });
      }
      return null;
    },
  },
];

/**
 * Lint key configuration objects for production-readiness and security and
 * return severity-ranked findings. Reads each config object via the governed
 * server tool; requires config-read access and a configured server-tools bridge.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Findings, or a gated payload when the bridge is absent.
 * @throws {SecurityError} When config reads are disabled for the site.
 */
async function configBestPractices({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertConfigReadAllowed(resolveSecurityConfig(site));
  if (!site.serverTools?.url) {
    return gatedReport("audit_config_best_practices", "server-tool", "serverTools.url not configured for this site");
  }

  const findings = [];
  const checked = [];
  const errors = [];
  for (const check of BEST_PRACTICE_CHECKS) {
    try {
      const cfg = await getConfig(site, check.config);
      checked.push(check.config);
      const result = check.evaluate(cfg || {});
      if (Array.isArray(result)) findings.push(...result.filter(Boolean));
      else if (result) findings.push(result);
    } catch (err) {
      errors.push({ config: check.config, error: err?.message || String(err) });
    }
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return {
    site: site._name,
    checked,
    counts: {
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    },
    findings,
    errors,
  };
}

// ---------------------------------------------------------------------------
// drupal_report_module_audit
// ---------------------------------------------------------------------------

/** Development/debug modules that should not be enabled in production. */
const DEV_MODULES = new Set([
  "devel", "devel_generate", "kint", "webprofiler", "stage_file_proxy",
  "views_ui", "field_ui", "config_inspector", "masquerade", "rest_ui",
]);

/**
 * Audit enabled modules: development/debug modules that should be off in
 * production, plus modules with known security advisories. Uses the Sentinel
 * server-tool when configured, else `drush pm:list` + `pm:security`.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Module findings, or a gated payload.
 */
async function moduleAudit({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const res = await runPrivileged(site, {
    serverTool: () => callServerTool(site, SERVER_TOOLS.moduleList, {}).then(toolResultData),
    drush: async () => {
      const list = parseDrush(await sshDrush(site, ["pm:list", "--format=json", "--status=enabled"]));
      let security = null;
      try { security = parseDrush(await sshDrush(site, ["pm:security", "--format=json"])); }
      catch { /* pm:security unavailable; report modules without advisories */ }
      return { list, security };
    },
  });
  if (!res.source) return gatedReport("report_module_audit", "server-tool/drush", res.attempts.join("; "));

  const modules = normalizeModules(res.data);
  const enabledDevModules = modules
    .filter((m) => m.enabled && DEV_MODULES.has(m.name))
    .map((m) => ({ name: m.name, severity: "medium", reason: "development/debug module enabled" }));

  const securityModules = normalizeSecurity(res.data);

  return {
    site: site._name,
    source: res.source,
    totalEnabled: modules.filter((m) => m.enabled).length,
    summary: { devModulesEnabled: enabledDevModules.length, securityAdvisories: securityModules.length },
    findings: { enabledDevModules, securityAdvisories: securityModules },
  };
}

/**
 * Normalize a module-list payload (server-tool or `drush pm:list`) into a flat
 * array of `{ name, enabled, version }`.
 * @param {*} data Result payload.
 * @returns {Array<{name: string, enabled: boolean, version: ?string}>}
 */
function normalizeModules(data) {
  const list = data?.list ?? data?.modules ?? data;
  if (!list) return [];
  const entries = Array.isArray(list) ? list.map((m) => [m.name ?? m.machine_name, m]) : Object.entries(list);
  return entries.map(([name, m]) => ({
    name: name ?? m?.name,
    enabled: isEnabled(m),
    version: m?.version ?? null,
  })).filter((m) => m.name);
}

/**
 * Determine whether a module entry is enabled across the differing shapes drush
 * and the server-tool use.
 * @param {*} m Module entry.
 * @returns {boolean}
 */
function isEnabled(m) {
  if (typeof m !== "object" || m === null) return false;
  if (typeof m.enabled === "boolean") return m.enabled;
  const status = String(m.status ?? m.state ?? "").toLowerCase();
  return status === "enabled" || status === "1" || status === "true";
}

/**
 * Normalize the security-advisory portion of a module payload.
 * @param {*} data Result payload.
 * @returns {Array<{name: string, severity: string}>}
 */
function normalizeSecurity(data) {
  const sec = data?.security ?? data?.securityAdvisories ?? null;
  if (!sec || (typeof sec === "object" && sec.status === "secure")) return [];
  const list = Array.isArray(sec) ? sec : (sec.modules ? Object.entries(sec.modules) : Object.entries(sec));
  return list.map((entry) => {
    const [name, info] = Array.isArray(entry) ? entry : [entry.name, entry];
    return { name: name ?? info?.name, severity: "high", reason: "known security advisory" };
  }).filter((m) => m.name);
}

// ---------------------------------------------------------------------------
// drupal_report_permission_audit
// ---------------------------------------------------------------------------

/** Permissions that are dangerous to grant to anonymous or authenticated users. */
const DANGEROUS_PERMS = [
  "administer users", "administer permissions", "administer site configuration",
  "administer modules", "administer software updates", "administer account settings",
  "access administration pages", "administer content types", "administer nodes",
  "bypass node access", "administer views", "administer filters", "use PHP for settings",
  "administer themes", "administer menu",
];
/** Roles whose elevated permissions are expected and therefore not flagged. */
const PRIVILEGED_ROLES = new Set(["administrator", "admin"]);

/**
 * Audit role permissions for dangerous grants to the anonymous/authenticated
 * roles and for non-admin roles holding administrative permissions. Uses the
 * Sentinel server-tool when configured, else `drush role:list`.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Permission findings, or a gated payload.
 */
async function permissionAudit({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const res = await runPrivileged(site, {
    serverTool: () => callServerTool(site, SERVER_TOOLS.permissionList, {}).then(toolResultData),
    drush: async () => parseDrush(await sshDrush(site, ["role:list", "--format=json"])),
  });
  if (!res.source) return gatedReport("report_permission_audit", "server-tool/drush", res.attempts.join("; "));

  const roles = normalizeRoles(res.data);
  const dangerous = new Set(DANGEROUS_PERMS.map((p) => p.toLowerCase()));
  const findings = [];
  for (const role of roles) {
    const perms = role.permissions.map((p) => String(p).toLowerCase());
    if (role.id === "anonymous" || role.id === "authenticated") {
      const hits = perms.filter((p) => dangerous.has(p));
      if (hits.length) findings.push(finding("high", `dangerous_perm_${role.id}`, `Role "${role.id}" holds dangerous permission(s): ${hits.join(", ")}.`, { role: role.id, permissions: hits }));
    } else if (!PRIVILEGED_ROLES.has(role.id)) {
      const admin = perms.filter((p) => dangerous.has(p));
      if (admin.length) findings.push(finding("medium", `admin_perm_${role.id}`, `Non-admin role "${role.id}" holds administrative permission(s): ${admin.join(", ")}.`, { role: role.id, permissions: admin }));
    }
  }

  return {
    site: site._name,
    source: res.source,
    rolesAudited: roles.length,
    counts: { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length },
    findings,
  };
}

/**
 * Normalize a role/permission payload into `{ id, permissions[] }`.
 * @param {*} data Result payload.
 * @returns {Array<{id: string, permissions: string[]}>}
 */
function normalizeRoles(data) {
  if (!data) return [];
  const entries = Array.isArray(data) ? data.map((r) => [r.id ?? r.machineName ?? r.name, r]) : Object.entries(data);
  return entries.map(([id, r]) => ({
    id,
    permissions: Array.isArray(r) ? r : (r?.permissions ?? r?.perms ?? []),
  })).filter((r) => r.id);
}

// ---------------------------------------------------------------------------
// drupal_report_status_report
// ---------------------------------------------------------------------------

/**
 * Surface the Drupal "status report" (system requirements) entries at warning or
 * error severity — pending updates, overdue cron, missing dependencies, writable
 * settings, etc. Uses the Sentinel server-tool when configured, else
 * `drush core:requirements`.
 *
 * @param {object} args - { site?, minSeverity? } where minSeverity is "warning"|"error".
 * @returns {Promise<object>} Requirement findings, or a gated payload.
 */
async function statusReport({ site: siteName, minSeverity = "warning" }) {
  const site = getSiteConfig(siteName);
  const res = await runPrivileged(site, {
    serverTool: () => callServerTool(site, SERVER_TOOLS.requirements, {}).then(toolResultData),
    drush: async () => parseDrush(await sshDrush(site, ["core:requirements", "--format=json"])),
  });
  if (!res.source) return gatedReport("report_status_report", "server-tool/drush", res.attempts.join("; "));

  const wantError = minSeverity === "error";
  const rows = normalizeRows(res.data).map((r) => ({
    title: r.title ?? r.name ?? null,
    severity: normalizeSeverity(r.severity ?? r.sid ?? r.status),
    value: r.value ?? null,
    description: r.description ?? null,
  }));
  const findings = rows.filter((r) => r.severity === "error" || (!wantError && r.severity === "warning"));

  return {
    site: site._name,
    source: res.source,
    counts: { error: rows.filter((r) => r.severity === "error").length, warning: rows.filter((r) => r.severity === "warning").length },
    findings,
  };
}

/**
 * Normalize a requirements severity (drush uses Error/Warning/OK or 0/1/2).
 * @param {*} sev Raw severity.
 * @returns {"error"|"warning"|"ok"|"info"}
 */
function normalizeSeverity(sev) {
  const s = String(sev ?? "").toLowerCase();
  if (s === "2" || s === "error") return "error";
  if (s === "1" || s === "warning") return "warning";
  if (s === "0" || s === "ok") return "ok";
  return "info";
}

// ---------------------------------------------------------------------------
// drupal_report_text_format_audit
// ---------------------------------------------------------------------------

/**
 * Audit text formats for ones that permit unfiltered HTML (no `filter_html`
 * restriction enabled), which are dangerous if exposed to untrusted roles. Reads
 * `filter.format.*` via the governed server tool; server-tool only.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Text-format findings, or a gated payload.
 * @throws {SecurityError} When config reads are disabled for the site.
 */
async function textFormatAudit({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertConfigReadAllowed(resolveSecurityConfig(site));
  if (!site.serverTools?.url) {
    return gatedReport("report_text_format_audit", "server-tool", "serverTools.url not configured for this site");
  }

  const names = pickConfigNames(toolResultData(await callServerTool(site, SERVER_TOOLS.configList, { prefix: "filter.format." })));
  const findings = [];
  for (const name of names) {
    const cfg = await getConfig(site, name);
    if (!cfg || dig(cfg, "status") === false) continue;
    const filters = cfg.filters ?? {};
    const htmlFilter = filters.filter_html;
    const restricted = htmlFilter && (htmlFilter.status === true || htmlFilter.status === 1);
    if (!restricted) {
      findings.push(finding("high", `unfiltered_html_${cfg.format ?? name}`, `Text format "${cfg.name ?? cfg.format ?? name}" allows unfiltered HTML (filter_html not enabled). Review which roles may use it.`, { format: cfg.format ?? name }));
    }
  }

  return { site: site._name, formatsAudited: names.length, counts: { high: findings.length }, findings };
}

/**
 * Coerce a config:list result into an array of config object names.
 * @param {*} data Result payload.
 * @returns {string[]} Config names.
 */
function pickConfigNames(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.map((x) => (typeof x === "string" ? x : x?.name)).filter(Boolean);
  if (Array.isArray(data.names)) return data.names;
  if (typeof data === "object") return Object.keys(data);
  return [];
}

// ---------------------------------------------------------------------------
// drupal_report_cache_config
// ---------------------------------------------------------------------------

/**
 * Report the site's cache posture from `system.performance`: CSS/JS aggregation
 * and the anonymous page-cache max-age, with plain recommendations. Reads config
 * via the governed server tool; server-tool only.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Cache posture, or a gated payload.
 * @throws {SecurityError} When config reads are disabled for the site.
 */
async function cacheConfig({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertConfigReadAllowed(resolveSecurityConfig(site));
  if (!site.serverTools?.url) {
    return gatedReport("report_cache_config", "server-tool", "serverTools.url not configured for this site");
  }

  const perf = await getConfig(site, "system.performance") || {};
  const cssAgg = dig(perf, "css.preprocess");
  const jsAgg = dig(perf, "js.preprocess");
  const pageMaxAge = dig(perf, "cache.page.max_age");
  const recommendations = [];
  if (cssAgg === false) recommendations.push("Enable CSS aggregation (system.performance.css.preprocess).");
  if (jsAgg === false) recommendations.push("Enable JS aggregation (system.performance.js.preprocess).");
  if (pageMaxAge === 0 || pageMaxAge === "0") recommendations.push("Set a non-zero anonymous page cache max-age (system.performance.cache.page.max_age).");

  return {
    site: site._name,
    posture: { cssAggregation: cssAgg ?? null, jsAggregation: jsAgg ?? null, pageCacheMaxAge: pageMaxAge ?? null },
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_report_config_drift",
    description: "Report whether active configuration matches the sync directory, as an added/changed/removed breakdown. Uses the governed Sentinel server-tool when configured, else drush config:status; returns 'unavailable' when neither is configured.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_audit_config_best_practices",
    description: "Lint key configuration for production-readiness and security: on-screen error display, CSS/JS aggregation, anonymous page cache, open user registration, missing 404/403 pages, and insecure file uploads. Severity-ranked. Requires config-read access and the server-tool bridge.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_report_module_audit",
    description: "Audit enabled modules: development/debug modules that should be off in production, plus modules with known security advisories. Uses the Sentinel server-tool when configured, else drush pm:list + pm:security.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_report_permission_audit",
    description: "Audit role permissions: dangerous grants to the anonymous/authenticated roles and administrative permissions held by non-admin roles. Uses the Sentinel server-tool when configured, else drush role:list.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_report_status_report",
    description: "Surface the Drupal status report (system requirements) entries at warning/error severity — pending updates, overdue cron, missing dependencies, writable settings. Uses the Sentinel server-tool when configured, else drush core:requirements.",
    inputSchema: {
      type: "object",
      properties: {
        site:        { type: "string" },
        minSeverity: { type: "string", enum: ["warning", "error"], default: "warning", description: "Lowest severity to include" },
      },
    },
  },
  {
    name: "drupal_report_text_format_audit",
    description: "Audit text formats for ones that permit unfiltered HTML (filter_html not enabled), which are dangerous if exposed to untrusted roles. Reads filter.format.* via the governed server-tool; requires config-read access.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
  {
    name: "drupal_report_cache_config",
    description: "Report the site's cache posture (CSS/JS aggregation, anonymous page-cache max-age) from system.performance with plain recommendations. Reads config via the governed server-tool; requires config-read access.",
    inputSchema: { type: "object", properties: { site: { type: "string" } } },
  },
];

export const handlers = {
  drupal_report_config_drift:          configDrift,
  drupal_audit_config_best_practices:  configBestPractices,
  drupal_report_module_audit:          moduleAudit,
  drupal_report_permission_audit:      permissionAudit,
  drupal_report_status_report:         statusReport,
  drupal_report_text_format_audit:     textFormatAudit,
  drupal_report_cache_config:          cacheConfig,
};
