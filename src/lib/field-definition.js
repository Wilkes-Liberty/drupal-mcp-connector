/**
 * Authoritative text-format resolution for node writes (#168).
 *
 * `backend.getEntitySchema` is sampling-only: it can label a field
 * `text_formatted` / `text_with_summary` but does NOT expose Field API
 * `allowed_formats`. Never invent that list from `defaultTextFormat` or
 * `FALLBACK_TEXT_FORMAT` (`full_html`).
 *
 * Resolution chain for a field definition:
 *   1. `backend.getFieldDefinition` — JSON:API `field_config`, then
 *      `base_field_override` (node body is a base field; its allowed_formats
 *      are not on `field_config`). Internal adapter fetch, not
 *      `drupal_entity_get` (`field_config` is on the agent deny list).
 *   2. Drush `config:get field.field.{entityType}.{bundle}.{field}`, then
 *      `core.base_field_override.{entityType}.{bundle}.{field}`, when a Drush
 *      bridge is configured.
 *   3. If the definition cannot be resolved: return null. Creates keep the
 *      historical default chain only while the list is unknown. Updates reuse
 *      the format already stored on that field (#327) so a dry run cannot
 *      preview a fallback the save will reject. Once the list is known, never
 *      persist a format outside it.
 */

import { drushConfigured } from "./audit-sources.js";
import { validateMachineName } from "./validate.js";
import { parseDrush, sshDrush } from "../tools/drush.js";

/** Last-resort body format when the Field API list cannot be resolved. */
export const FALLBACK_TEXT_FORMAT = "full_html";

const FORMATTED_FIELD_TYPES = new Set(["text", "text_long", "text_with_summary"]);

const SKIP_FORMAT_FIELDS = new Set([
  "title", "status", "moderation_state", "path", "promote", "sticky",
  "created", "changed", "langcode",
]);

/**
 * Normalize a Field API `allowed_formats` value to a string list.
 * @param {*} raw settings.allowed_formats from field_config / Drush.
 * @returns {string[]}
 */
function isEnabledFormatId(value) {
  // Field UI checkboxes store a disabled format as 0 or "0", and an enabled
  // format as its machine name. "0" is a non-empty string but not a format.
  return typeof value === "string" && value !== "" && value !== "0";
}

export function asFormatList(raw) {
  if (Array.isArray(raw)) return raw.filter(isEnabledFormatId);
  if (raw && typeof raw === "object") {
    return [...new Map(Object.entries(raw)).values()].filter(isEnabledFormatId);
  }
  return [];
}

/**
 * Parse a field_config resource or `field.field.*` config object.
 * @param {object} obj Config / JSON:API attributes.
 * @param {string} [fallbackName] Field name when the object omits `field_name`.
 * @returns {?{fieldName: string, fieldType: ?string, allowedFormats: string[]}}
 */
export function parseFieldConfigObject(obj, fallbackName) {
  if (!obj || typeof obj !== "object") return null;
  const attrs = new Map(Object.entries(obj));
  const fieldName = attrs.get("field_name") || fallbackName;
  if (typeof fieldName !== "string" || !fieldName) return null;
  const settings = attrs.get("settings");
  const settingsMap = settings && typeof settings === "object" && !Array.isArray(settings)
    ? new Map(Object.entries(settings))
    : new Map();
  const fieldType = attrs.get("field_type");
  return {
    fieldName,
    fieldType: typeof fieldType === "string" ? fieldType : null,
    allowedFormats: asFormatList(settingsMap.get("allowed_formats")),
  };
}

/**
 * Pick the config object out of a Drush `config:get --format=json` payload.
 * @param {*} raw Parsed Drush JSON.
 * @param {string} configName `field.field.{type}.{bundle}.{field}`.
 * @returns {?object}
 */
function unwrapDrushConfig(raw, configName) {
  if (!raw || typeof raw !== "object") return null;
  const map = new Map(Object.entries(raw));
  if (map.has("field_type") || map.has("settings")) return raw;
  const named = map.get(configName);
  if (named && typeof named === "object") return named;
  if (map.size === 1) {
    const only = [...map.values()][0];
    if (only && typeof only === "object") return only;
  }
  return raw;
}

/**
 * Load a field definition via Drush `config:get` (chain step 2).
 * @param {object} site Site config with `drushSsh`.
 * @param {string} entityType
 * @param {string} bundle
 * @param {string} fieldName
 * @returns {Promise<?{fieldName: string, fieldType: ?string, allowedFormats: string[]}>}
 */
export async function fieldDefinitionFromDrush(site, entityType, bundle, fieldName) {
  validateMachineName(entityType, "entityType");
  validateMachineName(bundle, "bundle");
  validateMachineName(fieldName, "fieldName");
  const configNames = [
    `field.field.${entityType}.${bundle}.${fieldName}`,
    `core.base_field_override.${entityType}.${bundle}.${fieldName}`,
  ];
  for (const configName of configNames) {
    try {
      const raw = parseDrush(await sshDrush(site, ["config:get", configName, "--format=json"]));
      const parsed = parseFieldConfigObject(unwrapDrushConfig(raw, configName), fieldName);
      if (parsed) return parsed;
    } catch {
      // A missing `field.field.*` row is how Drush reports a base field.
    }
  }
  return null;
}

/**
 * Resolve Field API metadata. See the file header for the chain.
 * @param {object} backend Resolved backend.
 * @param {object} site Site config.
 * @param {string} entityType
 * @param {string} bundle
 * @param {string} fieldName
 * @returns {Promise<?{fieldName: string, fieldType: ?string, allowedFormats: string[]}>}
 */
export async function resolveFieldDefinition(backend, site, entityType, bundle, fieldName) {
  if (typeof backend?.getFieldDefinition === "function") {
    try {
      const def = await backend.getFieldDefinition({ entityType, bundle, fieldName });
      if (def) return parseFieldConfigObject({
        field_name: def.fieldName,
        field_type: def.fieldType,
        settings: { allowed_formats: def.allowedFormats },
      }, fieldName) ?? def;
    } catch {
      // JSON:API field_config is optional; try Drush next.
    }
  }
  if (drushConfigured(site)) {
    const def = await fieldDefinitionFromDrush(site, entityType, bundle, fieldName);
    if (def) return def;
  }
  return null;
}

/**
 * Choose the format to persist, or throw before mutation.
 *
 * Known list + exactly one entry → that format when the caller omits one.
 * Known list + caller format outside it → refuse.
 * Known list + several entries + omitted format → site `defaultTextFormat`
 * only if it is in the list; otherwise refuse (never `full_html` when it
 * is not allowed).
 * Unknown list (`allowedFormats` is null): historical default chain only
 * when `defaultWhenUnknown` is true (body); otherwise leave format omitted.
 *
 * @param {{fieldName: string, requested: ?string, allowedFormats: ?string[],
 *   site?: object, defaultWhenUnknown?: boolean}} input
 * @returns {string|undefined}
 */
export function resolveTextFormat({
  fieldName, requested, allowedFormats, site, defaultWhenUnknown = false,
}) {
  const asked = requested === undefined || requested === null || requested === ""
    ? undefined
    : String(requested);

  if (!Array.isArray(allowedFormats)) {
    if (asked !== undefined) return asked;
    if (!defaultWhenUnknown) return undefined;
    return site?.defaultTextFormat ?? FALLBACK_TEXT_FORMAT;
  }

  if (allowedFormats.length === 0) {
    if (asked !== undefined) return asked;
    if (!defaultWhenUnknown) return undefined;
    return site?.defaultTextFormat ?? FALLBACK_TEXT_FORMAT;
  }

  if (asked !== undefined) {
    if (!allowedFormats.includes(asked)) {
      throw textFormatError(fieldName, asked, allowedFormats);
    }
    return asked;
  }

  if (allowedFormats.length === 1) {
    return allowedFormats[0];
  }

  const siteDefault = site?.defaultTextFormat;
  if (siteDefault && allowedFormats.includes(siteDefault)) {
    return siteDefault;
  }

  throw textFormatError(fieldName, siteDefault ?? FALLBACK_TEXT_FORMAT, allowedFormats);
}

/**
 * @param {string} fieldName
 * @param {string} requested
 * @param {string[]} allowed
 * @returns {Error}
 */
function textFormatError(fieldName, requested, allowed) {
  return new Error(
    `Field "${fieldName}" does not allow format "${requested}" ` +
    `(allowed: ${allowed.join(", ")}).`
  );
}

/**
 * Whether a payload value is already a formatted-text object.
 * @param {*} value
 * @returns {boolean}
 */
function isFormattedShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "value")) return false;
  return ["format", "summary", "processed"].some((k) => Object.prototype.hasOwnProperty.call(value, k));
}

/**
 * @param {*} value
 * @returns {string|undefined}
 */
function requestedFormatOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, "format")) {
    return value.format;
  }
  return undefined;
}

/**
 * Format Drupal already stored for a field, if the canonical entity has one.
 * @param {?object} entity
 * @param {string} fieldName
 * @returns {string|undefined}
 */
function storedTextFormat(entity, fieldName) {
  const fields = entity?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return undefined;
  const value = new Map(Object.entries(fields)).get(fieldName);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const format = new Map(Object.entries(value)).get("format");
  return typeof format === "string" && format && format !== "0" ? format : undefined;
}

/**
 * Whether a write attribute map omits a text format the resolver may have to
 * supply. Used to decide whether an update must read the stored entity first.
 * @param {?object} attributes
 * @returns {boolean}
 */
export function attributesOmitTextFormat(attributes) {
  if (!attributes || typeof attributes !== "object") return false;
  for (const [name, value] of Object.entries(attributes)) {
    if (SKIP_FORMAT_FIELDS.has(name) || value === undefined || value === null) continue;
    if (typeof value === "string") return true;
    if (typeof value === "object" && !Array.isArray(value)) {
      const hasValue = Object.prototype.hasOwnProperty.call(value, "value");
      const hasFormat = Object.prototype.hasOwnProperty.call(value, "format") && value.format;
      if ((name === "body" || hasValue) && !hasFormat) return true;
    }
  }
  return false;
}

/**
 * @param {*} raw
 * @param {string|undefined} format
 * @returns {{value: *, format?: string, summary?: *}}
 */
function normalizeFormattedValue(raw, format) {
  if (typeof raw === "string") {
    const out = { value: raw };
    if (format !== undefined) out.format = format;
    return out;
  }
  const out = { value: raw.value };
  if (format !== undefined) out.format = format;
  if (Object.prototype.hasOwnProperty.call(raw, "summary")) out.summary = raw.summary;
  return out;
}

/**
 * Default and validate text formats on a write attribute map (mutates it).
 * Same checks run for dry-run and real writes so a disallowed format never
 * reaches create/update.
 *
 * On update, pass `existingEntity`. When the allowed list is unknown and the
 * caller omitted a format, the format already stored on that field is reused.
 * The same choice is what dryRun previews and what the save sends (#327).
 *
 * @param {{backend: object, site: object, entityType: string, bundle: string, attributes: object, existingEntity?: ?object}} input
 * @returns {Promise<object>} The same attributes object, with formats resolved.
 */
export async function applyAllowedFormatsToAttributes({
  backend, site, entityType, bundle, attributes, existingEntity = null,
}) {
  const names = Object.keys(attributes).filter((name) => !SKIP_FORMAT_FIELDS.has(name));
  for (const fieldName of names) {
    const value = new Map(Object.entries(attributes)).get(fieldName);
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && (typeof value !== "object" || Array.isArray(value))) continue;

    const def = await resolveFieldDefinition(backend, site, entityType, bundle, fieldName);
    const formattedType = Boolean(def?.fieldType && FORMATTED_FIELD_TYPES.has(def.fieldType));
    const restricted = Boolean(def?.allowedFormats?.length);
    const isBody = fieldName === "body";
    const shaped = isFormattedShape(value);

    if (def && !formattedType && !restricted && !isBody) continue;
    if (!def && !shaped && !isBody) continue;

    const allowedFormats = def ? def.allowedFormats : null;
    const listUnknown = !Array.isArray(allowedFormats) || allowedFormats.length === 0;
    let requested = requestedFormatOf(value);
    if ((requested === undefined || requested === null || requested === "") && listUnknown) {
      const stored = storedTextFormat(existingEntity, fieldName);
      if (stored) requested = stored;
    }
    const format = resolveTextFormat({
      fieldName,
      requested,
      allowedFormats,
      site,
      defaultWhenUnknown: isBody,
    });

    if (format === undefined && !formattedType && !isBody && !shaped) continue;
    Object.assign(attributes, Object.fromEntries([
      [fieldName, normalizeFormattedValue(value, format)],
    ]));
  }
  return attributes;
}
