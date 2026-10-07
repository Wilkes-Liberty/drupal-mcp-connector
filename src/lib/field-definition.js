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
 *      A row whose `field_name` is not the requested field is a miss.
 *   2. Cached Sentinel `GET /drupal-mcp/context`, for node bundles, when the
 *      field entry includes `allowed_formats` (#429). A content-tier token
 *      cannot read `field_config`. Dispatch fills this cache before a tool
 *      that resolves text formats.
 *   3. Drush `config:get field.field.{entityType}.{bundle}.{field}`, then
 *      `core.base_field_override.{entityType}.{bundle}.{field}`, when a Drush
 *      bridge is configured.
 *   4. If the definition cannot be resolved: return null. Creates keep the
 *      historical default chain only while the list is unknown. Updates reuse
 *      the format already stored on that field (#327) so a dry run cannot
 *      preview a fallback the save will reject. Once the list is known, never
 *      persist a format outside it.
 */

import { drushConfigured } from "./audit-sources.js";
import { textFormatDefinitionFromContext } from "./text-format-context.js";
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
      if (def?.fieldName === fieldName) {
        return parseFieldConfigObject({
          field_name: def.fieldName,
          field_type: def.fieldType,
          settings: { allowed_formats: def.allowedFormats },
        }, fieldName) ?? def;
      }
    } catch {
      // JSON:API field_config is optional; try the next source.
    }
  }
  const fromContext = textFormatDefinitionFromContext(site, entityType, bundle, fieldName);
  if (fromContext) return fromContext;
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
 * @param {*} value
 * @returns {string|undefined}
 */
function storedFormatName(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const format = new Map(Object.entries(value)).get("format");
  return typeof format === "string" && format && format !== "0" ? format : undefined;
}

/**
 * Format Drupal already stored for a field, if the canonical entity has one.
 * A one-element list is the JSON:API shape of a single-value text field.
 * @param {?object} entity
 * @param {string} fieldName
 * @returns {string|undefined}
 */
function storedTextFormat(entity, fieldName) {
  const fields = entity?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return undefined;
  const value = new Map(Object.entries(fields)).get(fieldName);
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    return storedFormatName(value.at(0));
  }
  return storedFormatName(value);
}

/**
 * A one-element JSON:API list omits its format when the only item is a
 * string or a `{ value }` object without `format`. A longer list of bare
 * strings is a list field, not an omitted text format. A formatted item
 * inside a longer list still counts.
 * @param {unknown[]} value
 * @returns {boolean}
 */
function arrayOmitsTextFormat(value) {
  if (value.length === 1) {
    const item = value.at(0);
    if (typeof item === "string") return true;
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const hasValue = Object.prototype.hasOwnProperty.call(item, "value");
    const hasFormat = Object.prototype.hasOwnProperty.call(item, "format") && item.format;
    return hasValue && !hasFormat;
  }
  return value.some((item) => isFormattedShape(item) && !requestedFormatOf(item));
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
    if (Array.isArray(value)) {
      if (arrayOmitsTextFormat(value)) return true;
      continue;
    }
    if (typeof value === "string") return true;
    if (typeof value === "object") {
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
 * Resolve one formatted value, or return it unchanged when it is not text.
 * @param {string} fieldName
 * @param {*} value
 * @param {?object} def
 * @param {boolean} treatAsBody
 * @param {object} site
 * @param {?object} existingEntity
 * @returns {*}
 */
function resolveFormattedItem(fieldName, value, def, treatAsBody, site, existingEntity) {
  const formattedType = Boolean(def?.fieldType && FORMATTED_FIELD_TYPES.has(def.fieldType));
  const restricted = Boolean(def?.allowedFormats?.length);
  const shaped = isFormattedShape(value);
  if (typeof value !== "string" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return value;
  }
  if (def && !formattedType && !restricted && !treatAsBody) return value;
  if (!def && !shaped && !treatAsBody) return value;

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
    defaultWhenUnknown: treatAsBody,
  });
  if (format === undefined && !formattedType && !treatAsBody && !shaped) return value;
  return normalizeFormattedValue(value, format);
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
 * `defaultBodyFormat` is true for the node tools, which keep the historical
 * body fallback when the list is unknown. Other write tools pass false so a
 * string body is not rewritten to `full_html`.
 *
 * A one-element array is checked too (#429). Callers sometimes send the
 * JSON:API list shape for a single-value text field; skipping the array let
 * a disallowed format through. An update that omits the format on that
 * one-element shape reuses the stored format when the allowed list is unknown.
 *
 * @param {{backend: object, site: object, entityType: string, bundle: string, attributes: object, existingEntity?: ?object, defaultBodyFormat?: boolean}} input
 * @returns {Promise<object>} The same attributes object, with formats resolved.
 */
export async function applyAllowedFormatsToAttributes({
  backend, site, entityType, bundle, attributes, existingEntity = null,
  defaultBodyFormat = true,
}) {
  const names = Object.keys(attributes).filter((name) => !SKIP_FORMAT_FIELDS.has(name));
  for (const fieldName of names) {
    const value = new Map(Object.entries(attributes)).get(fieldName);
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) && typeof value !== "string" && typeof value !== "object") continue;
    const treatAsBody = defaultBodyFormat && fieldName === "body";
    const def = await resolveFieldDefinition(backend, site, entityType, bundle, fieldName);
    if (Array.isArray(value)) {
      const formattedType = Boolean(def?.fieldType && FORMATTED_FIELD_TYPES.has(def.fieldType));
      const restricted = Boolean(def?.allowedFormats?.length);
      const anyShaped = value.some((item) => isFormattedShape(item));
      if (!formattedType && !restricted && !treatAsBody && !anyShaped) continue;
      const next = value.map((item) => resolveFormattedItem(
        fieldName, item, def, treatAsBody, site, existingEntity,
      ));
      Object.assign(attributes, Object.fromEntries([[fieldName, next]]));
      continue;
    }
    if (typeof value !== "string" && typeof value !== "object") continue;
    const next = resolveFormattedItem(fieldName, value, def, treatAsBody, site, existingEntity);
    if (next !== value) {
      Object.assign(attributes, Object.fromEntries([[fieldName, next]]));
    }
  }
  return attributes;
}

/**
 * Validate text formats on caller-supplied paragraph attributes.
 * Paragraph writes do not invent `full_html`. Do not pass attributes copied
 * from an existing paragraph: those already have the stored format.
 * @param {object} backend
 * @param {object} site
 * @param {string} bundle Paragraph bundle machine name.
 * @param {object} attributes Mutated in place.
 * @returns {Promise<object>}
 */
export function applyParagraphTextFormats(backend, site, bundle, attributes) {
  return applyAllowedFormatsToAttributes({
    backend,
    site,
    entityType: "paragraph",
    bundle,
    attributes,
    defaultBodyFormat: false,
  });
}
