/**
 * Input validation and sanitization utilities.
 *
 * All user-supplied values that reach a shell command, file path,
 * or SQL query MUST pass through the appropriate validator here first.
 *
 * Validators throw with descriptive messages on failure — never silently
 * coerce values in ways that could hide injection attempts.
 */

import { SecurityError } from "./security.js";

// ---------------------------------------------------------------------------
// Machine name validation (Drupal entity types, bundles, module names, roles)
// Valid: lowercase letters, digits, underscores. Must start with a letter.
// ---------------------------------------------------------------------------

const MACHINE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a Drupal machine name.
 * @param {string} value     - The value to validate.
 * @param {string} fieldName - Human-readable name for error messages.
 * @throws {Error} if the value is not a valid machine name.
 */
export function validateMachineName(value, fieldName = "value") {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (!MACHINE_NAME_RE.test(value)) {
    throw new Error(
      `${fieldName} "${value}" is not a valid Drupal machine name. ` +
      "Must match /^[a-z][a-z0-9_]*$/ (lowercase, digits, underscores only)."
    );
  }
  if (value.length > 128) {
    throw new Error(`${fieldName} exceeds maximum length of 128 characters.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// UUID validation (all JSON:API IDs are UUIDs)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a UUID (all Drupal JSON:API entity IDs are UUIDs).
 */
export function validateUuid(value, fieldName = "id") {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(
      `${fieldName} "${value}" is not a valid UUID. ` +
      "Drupal JSON:API IDs follow the format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx."
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// SQL query validation (read-only enforcement for Drush bridge)
// ---------------------------------------------------------------------------

const SAFE_SQL_PREFIXES = ["select ", "show ", "describe ", "explain ", "desc "];

// Patterns that indicate write operations even within SELECT contexts
const DANGEROUS_SQL_PATTERNS = [
  /;\s*(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke)\b/i,
  /\binto\s+outfile\b/i,
  /\bload_file\s*\(/i,
  /\bsleep\s*\(/i,        // time-based blind injection
  /\bbenchmark\s*\(/i,    // timing attack
  /\bload\s+data\b/i,
];

/**
 * Validate that a SQL query is read-only.
 * Checks both the query prefix AND secondary injection patterns.
 * @throws {SecurityError} if the query contains write operations.
 */
export function validateSqlQuery(query) {
  if (typeof query !== "string" || !query.trim().length) {
    throw new Error("SQL query must be a non-empty string.");
  }

  const normalised = query.trim().toLowerCase();

  if (!SAFE_SQL_PREFIXES.some((prefix) => normalised.startsWith(prefix))) {
    throw new SecurityError(
      "drupal_drush_sql_query only permits SELECT, SHOW, DESCRIBE, and EXPLAIN statements. " +
      "Use the JSON:API tools for write operations."
    );
  }

  for (const pattern of DANGEROUS_SQL_PATTERNS) {
    if (pattern.test(query)) {
      throw new SecurityError(
        `SQL query contains a disallowed pattern: ${pattern}. ` +
        "Only pure read queries are permitted."
      );
    }
  }

  if (query.length > 4096) {
    throw new Error("SQL query exceeds maximum length of 4096 characters.");
  }

  return query;
}

// ---------------------------------------------------------------------------
// SSH argument escaping
// Prevents command injection when building SSH commands programmatically.
// Uses single-quote escaping: wrap value in single quotes, escape internal
// single quotes as '\'' (end quote, escaped quote, start quote).
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe inclusion as a shell argument.
 * Output is wrapped in single quotes with internal single quotes escaped.
 * @param {string} value
 * @returns {string} Shell-safe single-quoted argument.
 */
export function sanitizeSshArg(value) {
  if (typeof value !== "string") {
    throw new TypeError(`sanitizeSshArg expected a string, got ${typeof value}`);
  }
  // Single-quote escaping: 'value' with internal ' → '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// URL / baseUrl validation
// Enforces HTTPS for non-localhost targets.
// ---------------------------------------------------------------------------

const LOCALHOST_PATTERNS = ["localhost", "127.0.0.1", "::1", ".lndo.site", ".ddev.site", ".local"];

/**
 * Validate a Drupal site baseUrl.
 * Warns (but does not throw) for localhost HTTP.
 * Throws for non-localhost HTTP URLs.
 * @param {string} url
 * @param {string} siteName
 */
export function validateBaseUrl(url, siteName = "site") {
  if (typeof url !== "string" || !url.startsWith("http")) {
    throw new Error(`Site "${siteName}": baseUrl must be a valid HTTP/HTTPS URL.`);
  }

  const isLocalhost = LOCALHOST_PATTERNS.some((p) => url.includes(p));
  const isHttps     = url.startsWith("https://");

  if (!isHttps && !isLocalhost) {
    throw new SecurityError(
      `Site "${siteName}": baseUrl "${url}" uses plain HTTP on a non-localhost host. ` +
      "All non-local Drupal connections must use HTTPS. " +
      "Update baseUrl to https:// to proceed."
    );
  }

  if (!isHttps && isLocalhost) {
    console.warn(
      `[drupal-mcp-connector] Warning: site "${siteName}" is using plain HTTP (${url}). ` +
      "This is only acceptable for local development."
    );
  }

  // Strip trailing slash for consistency
  return url.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Pagination limit guard
// Prevents accidentally requesting thousands of records in a single call.
// ---------------------------------------------------------------------------

const MAX_PAGE_LIMIT = 200;

/**
 * Clamp a page limit to a safe maximum.
 */
export function clampLimit(value, defaultVal = 20) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, MAX_PAGE_LIMIT);
}

// ---------------------------------------------------------------------------
// Field name sanitization (prevent crafted field names in JSON:API filters)
// ---------------------------------------------------------------------------

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/**
 * Validate a Drupal field machine name used in JSON:API filter parameters.
 */
export function validateFieldName(value, fieldName = "field") {
  if (typeof value !== "string" || !FIELD_NAME_RE.test(value)) {
    throw new Error(
      `${fieldName} "${value}" is not a valid field name. ` +
      "Expected format: field_example or field.subfield"
    );
  }
  return value;
}
