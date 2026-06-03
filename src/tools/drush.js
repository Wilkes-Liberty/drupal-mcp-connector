/**
 * Tool group: Drush bridge.
 *
 * Execute a curated set of Drush commands on a remote Drupal server over SSH.
 *
 * Security model:
 *   1. SSH key auth only — password-based SSH is deliberately unsupported.
 *   2. All command arguments are validated before being passed to SSH.
 *   3. Module names are validated as machine names (a-z, 0-9, _) only.
 *   4. SQL tool enforces SELECT-only allowlist — no DDL/DML permitted.
 *   5. Key path is validated against path traversal.
 *   6. All operations are logged to stderr with site name and command.
 *   7. Write operations assert non-readOnly via the security layer.
 *   8. No shell string interpolation of user-supplied values.
 *
 * Requires per-site "drushSsh" config block — tools fail gracefully if absent.
 */

import { Client }        from "ssh2";
import { readFileSync }  from "fs";
import { homedir }       from "os";
import { join, resolve, normalize } from "path";
import { getSiteConfig } from "../lib/config.js";
import { resolveSecurityConfig, assertNotReadOnly } from "../lib/security.js";
import { validateMachineName, validateSqlQuery, sanitizeSshArg } from "../lib/validate.js";

// ---------------------------------------------------------------------------
// SSH configuration helpers
// ---------------------------------------------------------------------------

function getDrushConfig(site) {
  if (!site.drushSsh) {
    throw new Error(
      `Drush bridge not configured for site "${site._name}". ` +
      "Add a \"drushSsh\" block to this site's config. See docs/getting-started.md."
    );
  }
  return site.drushSsh;
}

/**
 * Resolve and validate the SSH key path. Prevents path traversal.
 */
function resolveKeyPath(rawPath) {
  const expanded = rawPath.startsWith("~")
    ? join(homedir(), rawPath.slice(1))
    : rawPath;
  const resolved = resolve(expanded);
  // Ensure the key is within home directory or /etc/ssh (reasonable locations)
  const homeDir   = homedir();
  const allowed   = [homeDir, "/etc/ssh", "/run/secrets"];
  const permitted = allowed.some((dir) => resolved.startsWith(dir + "/") || resolved === dir);
  if (!permitted) {
    throw new Error(
      `SSH key path "${resolved}" is outside allowed directories. ` +
      "Keys must be under your home directory or /etc/ssh."
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Core SSH executor
// ---------------------------------------------------------------------------

/**
 * Run a Drush command via SSH.
 *
 * @param {object}   site       - resolved site config
 * @param {string[]} drushArgs  - Drush subcommand + flags as an array
 * @param {number}   timeoutMs  - max execution time
 * @returns {Promise<string>}   - stdout trimmed
 *
 * Security: args are individually shell-escaped via sanitizeSshArg().
 * No raw user input is ever interpolated directly into the command string.
 */
function sshDrush(site, drushArgs, timeoutMs = 30000) {
  const sshCfg  = getDrushConfig(site);
  const keyPath = resolveKeyPath(sshCfg.keyPath);

  // Validate drupalRoot is an absolute path with no traversal
  const drupalRoot = normalize(sshCfg.drupalRoot);
  if (!drupalRoot.startsWith("/")) {
    throw new Error("drushSsh.drupalRoot must be an absolute path.");
  }

  // Build the command: cd to Drupal root, then run vendor drush with escaped args
  const escapedArgs = drushArgs.map(sanitizeSshArg).join(" ");
  const drushBin    = `${drupalRoot}/vendor/bin/drush`;
  const command     = `cd ${sanitizeSshArg(drupalRoot)} && ${drushBin} ${escapedArgs} --yes`;

  console.error(`[drush-bridge] ${site._name}: drush ${drushArgs.join(" ")}`);

  return new Promise((resolve, reject) => {
    const conn  = new Client();
    let stdout  = "";
    let stderr  = "";
    let settled = false;

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      fn(val);
    }

    const timer = setTimeout(
      () => settle(reject, new Error(`Drush timed out after ${timeoutMs / 1000}s`)),
      timeoutMs
    );

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { settle(reject, err); return; }

        stream.on("data",        (chunk) => { stdout += chunk.toString("utf8"); });
        stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

        stream.on("close", (code) => {
          if (code !== 0) {
            settle(reject, new Error(
              `Drush exited ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 500)}`
            ));
          } else {
            settle(resolve, stdout.trim());
          }
        });
      });
    });

    conn.on("error", (err) => settle(reject, err));

    conn.connect({
      host:        sshCfg.host,
      port:        Number(sshCfg.port) || 22,
      username:    sshCfg.user,
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- SSH private-key path comes from operator-controlled site config
      privateKey:  readFileSync(keyPath),
      // Harden: never forward the local SSH agent to the remote host.
      agentForward: false,
      readyTimeout: timeoutMs,
    });
  });
}

/**
 * Parse Drush JSON output; fall back to raw string if not JSON.
 */
function parseDrush(raw) {
  if (!raw) return null;
  try   { return JSON.parse(raw); }
  catch { return raw; }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

// Max watchdog rows fetchable in one call (mirrors the tool input maximum).
const WATCHDOG_MAX_COUNT = 200;
// Drupal log severity levels accepted by `drush watchdog:show --severity`.
const VALID_SEVERITIES = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];

/**
 * Rebuild all Drupal caches (`drush cache:rebuild`).
 * @param {object} args - { site? }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 */
async function cacheRebuild({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "drush cache:rebuild");
  await sshDrush(site, ["cache:rebuild"]);
  return { success: true, message: "Cache rebuild complete." };
}

/**
 * Run Drupal cron (`drush cron`).
 * @param {object} args - { site? }.
 * @returns {Promise<{success: boolean, output: *}>}
 * @throws {SecurityError} If the site is read-only.
 */
async function runCron({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "drush cron");
  const out = await sshDrush(site, ["cron"]);
  return { success: true, output: parseDrush(out) };
}

/**
 * Report site status (`drush status`): version, DB, paths, active config.
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Parsed status, or { raw } if not JSON.
 */
async function siteStatus({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const out  = await sshDrush(site, ["status", "--format=json"]);
  const data = parseDrush(out);
  return typeof data === "object" ? data : { raw: data };
}

/**
 * Check whether active config matches the sync directory (`drush config:status`).
 * @param {object} args - { site? }.
 * @returns {Promise<object>} { status: "in_sync" } or { status: "out_of_sync", changes }.
 */
async function configStatus({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const out  = await sshDrush(site, ["config:status", "--format=json"]);
  const data = parseDrush(out);
  if (!data || (Array.isArray(data) && !data.length)) {
    return { status: "in_sync", message: "Configuration is in sync." };
  }
  return { status: "out_of_sync", changes: data };
}

/**
 * Export active config to the sync directory (`drush config:export`).
 * @param {object} args - { site? }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 */
async function configExport({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "drush config:export");
  await sshDrush(site, ["config:export"]);
  return { success: true, message: "Configuration exported to sync directory." };
}

/**
 * Import config from the sync directory into the DB (`drush config:import`).
 * @param {object} args - { site? }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 */
async function configImport({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "drush config:import");
  await sshDrush(site, ["config:import"]);
  return { success: true, message: "Configuration imported from sync directory." };
}

/**
 * Run pending database updates (`drush updatedb`).
 * @param {object} args - { site? }.
 * @returns {Promise<{success: boolean, updates: *}>}
 * @throws {SecurityError} If the site is read-only.
 */
async function updateDb({ site: siteName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "drush updatedb");
  const out = await sshDrush(site, ["updatedb", "--format=json"]);
  return { success: true, updates: parseDrush(out) };
}

/**
 * List modules (`drush pm:list`), optionally filtered by status.
 * @param {object} args - { site?, status? } where status is "enabled"|"disabled".
 * @returns {Promise<{modules: *}>}
 */
async function listModules({ site: siteName, status }) {
  const site = getSiteConfig(siteName);
  const args = ["pm:list", "--format=json"];
  if (status === "enabled")  args.push("--status=enabled");
  if (status === "disabled") args.push("--status=disabled");
  const out = await sshDrush(site, args);
  return { modules: parseDrush(out) };
}

/**
 * List modules with known security advisories (`drush pm:security`).
 * @param {object} args - { site? }.
 * @returns {Promise<object>} { status: "secure" } or { status: "updates_available", modules }.
 */
async function securityUpdates({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const out  = await sshDrush(site, ["pm:security", "--format=json"]);
  const data = parseDrush(out);
  if (!data || (typeof data === "object" && !Object.keys(data).length)) {
    return { status: "secure", message: "No known security updates." };
  }
  return { status: "updates_available", modules: data };
}

/**
 * Enable a module (`drush pm:enable`). The name is validated as a machine name
 * before reaching SSH, since it is interpolated into the command.
 * @param {object} args - { site?, moduleName }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 * @throws {Error} If moduleName is not a valid machine name.
 */
async function enableModule({ site: siteName, moduleName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), `pm:enable ${moduleName}`);
  validateMachineName(moduleName, "moduleName"); // throws if invalid
  await sshDrush(site, ["pm:enable", moduleName]);
  return { success: true, message: `Module "${moduleName}" enabled.` };
}

/**
 * Uninstall a module (`drush pm:uninstall`). Name is validated as a machine name.
 * @param {object} args - { site?, moduleName }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 * @throws {Error} If moduleName is not a valid machine name.
 */
async function disableModule({ site: siteName, moduleName }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), `pm:uninstall ${moduleName}`);
  validateMachineName(moduleName, "moduleName");
  await sshDrush(site, ["pm:uninstall", moduleName]);
  return { success: true, message: `Module "${moduleName}" uninstalled.` };
}

/**
 * List users via Drush (`drush user:list`), filtered by status and/or role.
 * Drush may return an object keyed by uid; it is normalized to an array and
 * sliced to `limit`.
 * @param {object} args - { site?, status?, role?, limit? }.
 * @returns {Promise<{users: object[]}>}
 * @throws {Error} If role is supplied and not a valid machine name.
 */
async function drushUserList({ site: siteName, status, role, limit = 20 }) {
  const site = getSiteConfig(siteName);
  if (role) validateMachineName(role, "role");
  const args = ["user:list", "--format=json"];
  if (status === "active")  args.push("--status=1");
  if (status === "blocked") args.push("--status=0");
  if (role)                 args.push(`--roles=${role}`);
  const out   = await sshDrush(site, args);
  const data  = parseDrush(out);
  const users = (typeof data === "object" && !Array.isArray(data))
    ? Object.values(data) : (data ?? []);
  return { users: users.slice(0, limit) };
}

/**
 * Create a user (`drush user:create`) and assign roles via follow-up
 * `user:role:add` calls. Each role is validated as a machine name first.
 * @param {object} args - { site?, name, mail, password, roles? }.
 * @returns {Promise<{success: boolean, message: string}>}
 * @throws {SecurityError} If the site is read-only.
 * @throws {Error} If any role is not a valid machine name.
 */
async function drushCreateUser({ site: siteName, name, mail, password, roles = [] }) {
  const site = getSiteConfig(siteName);
  assertNotReadOnly(resolveSecurityConfig(site), "user:create");
  // Validate roles are machine names
  for (const role of roles) validateMachineName(role, "role");
  await sshDrush(site, ["user:create", name, `--mail=${mail}`, `--password=${password}`]);
  for (const role of roles) {
    await sshDrush(site, ["user:role:add", role, name]);
  }
  return { success: true, message: `User "${name}" created.` };
}

/**
 * Run a read-only SQL query (`drush sql:query`). The query is validated against
 * a SELECT-only allowlist before execution.
 * @param {object} args - { site?, query }.
 * @returns {Promise<{rows: *}>}
 * @throws {SecurityError} If the query is not read-only.
 */
async function sqlQuery({ site: siteName, query }) {
  const site = getSiteConfig(siteName);
  // Throws SecurityError if query is not read-only
  validateSqlQuery(query);
  const out = await sshDrush(site, ["sql:query", query]);
  return { rows: parseDrush(out) };
}

/**
 * Fetch recent watchdog/dblog entries (`drush watchdog:show`), filtered by type
 * and/or severity. Count is clamped to WATCHDOG_MAX_COUNT.
 * @param {object} args - { site?, type?, severity?, limit? }.
 * @returns {Promise<{entries: object[]}>}
 * @throws {Error} If type is invalid, or severity is not a recognized level.
 */
async function watchdog({ site: siteName, type, severity, limit = 20 }) {
  const site = getSiteConfig(siteName);
  if (type) validateMachineName(type, "type");
  if (severity && !VALID_SEVERITIES.includes(severity)) {
    throw new Error(`Invalid severity "${severity}". Must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }
  const args = ["watchdog:show", "--format=json", `--count=${Math.min(Number(limit), WATCHDOG_MAX_COUNT)}`];
  if (type)     args.push(`--type=${type}`);
  if (severity) args.push(`--severity=${severity}`);
  const out    = await sshDrush(site, args);
  const data   = parseDrush(out);
  const entries = (typeof data === "object" && !Array.isArray(data))
    ? Object.values(data) : (data ?? []);
  return { entries };
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  { name: "drupal_drush_cache_rebuild",    description: "Run `drush cache:rebuild` via SSH. Clears all Drupal caches. Requires drushSsh config and write access.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_cron",             description: "Run Drupal cron via `drush cron`.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_status",           description: "Get Drupal site status via `drush status` — version, DB, file paths, active config.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_config_status",    description: "Check if active config is in sync with the sync directory. Returns out-of-sync items if any.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_config_export",    description: "Export active configuration to the sync directory. Requires write access.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_config_import",    description: "Import configuration from the sync directory into the database. Requires write access. Confirm with user before running on production.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_updatedb",         description: "Run pending database updates via `drush updatedb`. Always run after deploying module updates.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  { name: "drupal_drush_security_updates", description: "List modules with known security advisories via `drush pm:security`.", inputSchema: { type: "object", properties: { site: { type: "string" } } } },
  {
    name: "drupal_drush_module_list",
    description: "List Drupal modules. Filter by enabled or disabled status.",
    inputSchema: { type: "object", properties: { site: { type: "string" }, status: { type: "string", enum: ["enabled", "disabled"] } } },
  },
  {
    name: "drupal_drush_module_enable",
    description: "Enable a Drupal module. Module name validated as machine name. Requires write access.",
    inputSchema: { type: "object", required: ["moduleName"], properties: { site: { type: "string" }, moduleName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" } } },
  },
  {
    name: "drupal_drush_module_disable",
    description: "Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user.",
    inputSchema: { type: "object", required: ["moduleName"], properties: { site: { type: "string" }, moduleName: { type: "string", pattern: "^[a-z][a-z0-9_]*$" } } },
  },
  {
    name: "drupal_drush_user_list",
    description: "List Drupal users via Drush. Filter by active/blocked status or role.",
    inputSchema: { type: "object", properties: { site: { type: "string" }, status: { type: "string", enum: ["active", "blocked"] }, role: { type: "string" }, limit: { type: "number", default: 20 } } },
  },
  {
    name: "drupal_drush_user_create",
    description: "Create a Drupal user and optionally assign roles. Requires write access.",
    inputSchema: { type: "object", required: ["name", "mail", "password"], properties: { site: { type: "string" }, name: { type: "string" }, mail: { type: "string", format: "email" }, password: { type: "string", minLength: 12 }, roles: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "drupal_drush_sql_query",
    description: "Run a read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN only) via Drush. Write queries are blocked by the security layer.",
    inputSchema: { type: "object", required: ["query"], properties: { site: { type: "string" }, query: { type: "string" } } },
  },
  {
    name: "drupal_drush_watchdog",
    description: "Fetch recent Drupal watchdog/dblog entries. Filter by type or severity level.",
    inputSchema: { type: "object", properties: { site: { type: "string" }, type: { type: "string" }, severity: { type: "string", enum: ["emergency","alert","critical","error","warning","notice","info","debug"] }, limit: { type: "number", default: 20, maximum: 200 } } },
  },
];

export const handlers = {
  drupal_drush_cache_rebuild:    cacheRebuild,
  drupal_drush_cron:             runCron,
  drupal_drush_status:           siteStatus,
  drupal_drush_config_status:    configStatus,
  drupal_drush_config_export:    configExport,
  drupal_drush_config_import:    configImport,
  drupal_drush_updatedb:         updateDb,
  drupal_drush_module_list:      listModules,
  drupal_drush_security_updates: securityUpdates,
  drupal_drush_module_enable:    enableModule,
  drupal_drush_module_disable:   disableModule,
  drupal_drush_user_list:        drushUserList,
  drupal_drush_user_create:      drushCreateUser,
  drupal_drush_sql_query:        sqlQuery,
  drupal_drush_watchdog:         watchdog,
};
