/**
 * Media entity tools — backend-agnostic. File upload is JSON:API-only
 * (capability-gated on read-only/GraphQL backends).
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, redactCanonicalEntity } from "../lib/security.js";

async function listMediaTypes({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.listBundles("media");
}

async function listMedia({ site: siteName, type, status, name, limit = 20, offset = 0 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const filters = [];
  if (status !== undefined) filters.push({ field: "status", op: "eq", value: status });
  if (name) filters.push({ field: "name", op: "contains", value: name });
  const res = await backend.listEntities({ entityType: "media", bundle: type || "image", filters, sort: [{ field: "changed", dir: "desc" }], page: { limit, offset } });
  const items = res.entities.map((e) => redactCanonicalEntity(e, sec, "media"));
  return { total: res.page?.total ?? items.length, approximate: res.approximate ?? false, offset, nextOffset: offset + items.length, media: items };
}

async function getMedia({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "media", bundle: type, id });
  return entity ? redactCanonicalEntity(entity, sec, "media") : null;
}

async function createMedia({ site: siteName, type, name, status = true, fields = {} }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.createEntity({ entityType: "media", bundle: type, attributes: { name, status, ...fields } });
}

async function updateMedia({ site: siteName, type, id, name, status, fields = {} }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const attributes = { ...fields };
  if (name !== undefined) attributes.name = name;
  if (status !== undefined) attributes.status = status;
  return backend.updateEntity({ entityType: "media", bundle: type, id, attributes });
}

async function deleteMedia({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  await backend.deleteEntity({ entityType: "media", bundle: type, id });
  return { success: true, deletedId: id };
}

async function uploadFile({ site: siteName, filePath, entityType = "media", bundle, fieldName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.uploadFile({ entityType, bundle, fieldName, filePath });
}

async function uploadFileAndCreateMedia({ site: siteName, filePath, mediaType, mediaName, fieldName, altText, status = true }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const file = await backend.uploadFile({ entityType: "media", bundle: mediaType, fieldName, filePath });
  const fileData = altText
    ? { type: "file--file", id: file.id, meta: { alt: altText } }
    : { type: "file--file", id: file.id };
  const media = await backend.createEntity({
    entityType: "media", bundle: mediaType,
    attributes: { name: mediaName || file.filename, status },
    relationships: Object.fromEntries([[fieldName, { data: fileData }]]),
  });
  return { file: { id: file.id, filename: file.filename }, media };
}

async function findOrphanedMedia({ site: siteName, type, limit = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const bundle = type || "image";
  const map = (res, method, note) => ({
    method, ...(note ? { note } : {}), count: res.entities.length,
    media: res.entities.map((e) => redactCanonicalEntity(e, sec, "media")),
  });
  try {
    const res = await backend.listEntities({ entityType: "media", bundle, filters: [{ field: "field_usage_count", op: "eq", value: 0 }], sort: [{ field: "changed", dir: "desc" }], page: { limit } });
    return map(res, "usage_count_filter");
  } catch {
    const res = await backend.listEntities({ entityType: "media", bundle, sort: [{ field: "changed", dir: "desc" }], page: { limit } });
    return map(res, "all_media_no_usage_tracking", "Usage count tracking unavailable. Review manually or enable the Media module's usage tracking.");
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_media_types",
    description: "List all media types defined on this Drupal site (image, document, remote_video, audio, etc.).",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "drupal_list_media",
    description: "List media entities by type. Supports filtering by name substring and publish status.",
    inputSchema: {
      type: "object",
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Media type machine name, e.g. 'image', 'document', 'remote_video'" },
        status: { type: "boolean" },
        name:   { type: "string", description: "Filter by name substring" },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 },
      },
    },
  },
  {
    name: "drupal_get_media",
    description: "Fetch a single media entity by UUID and media type.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site: { type: "string" },
        type: { type: "string" },
        id:   { type: "string", description: "Media entity UUID" },
      },
    },
  },
  {
    name: "drupal_create_media",
    description: "Create a media entity. For remote video (YouTube/Vimeo), pass the URL via fields.field_media_oembed_video. For file-based media, use drupal_upload_file first to get a file UUID, then pass it in fields.",
    inputSchema: {
      type: "object", required: ["type", "name"],
      properties: {
        site:   { type: "string" },
        type:   { type: "string", description: "Media type machine name" },
        name:   { type: "string", description: "Media entity name / label" },
        status: { type: "boolean", default: true },
        fields: { type: "object", description: "Additional field values — include the source field (e.g. field_media_oembed_video: 'https://youtu.be/...')" },
      },
    },
  },
  {
    name: "drupal_update_media",
    description: "Update a media entity's name, status, or field values.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:   { type: "string" },
        type:   { type: "string" },
        id:     { type: "string" },
        name:   { type: "string" },
        status: { type: "boolean" },
        fields: { type: "object" },
      },
    },
  },
  {
    name: "drupal_delete_media",
    description: "Delete a media entity. Does not delete the underlying File entity. Confirm with the user before calling.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site: { type: "string" },
        type: { type: "string" },
        id:   { type: "string" },
      },
    },
  },
  {
    name: "drupal_upload_file",
    description: "Upload a local file to Drupal and create a File entity. Returns the file UUID to use when creating a Media entity. For images, the typical flow is: drupal_upload_file → drupal_create_media.",
    inputSchema: {
      type: "object", required: ["filePath", "bundle", "fieldName"],
      properties: {
        site:       { type: "string" },
        filePath:   { type: "string", description: "Absolute local path to the file to upload" },
        entityType: { type: "string", default: "media", description: "Drupal entity type (usually 'media' or 'node')" },
        bundle:     { type: "string", description: "Bundle machine name, e.g. 'image', 'article'" },
        fieldName:  { type: "string", description: "Field machine name, e.g. 'field_media_image', 'field_image'" },
      },
    },
  },
  {
    name: "drupal_upload_file_and_create_media",
    description: "Convenience tool: upload a local file and immediately create a Media entity in one step. Best for the common 'add an image' workflow.",
    inputSchema: {
      type: "object", required: ["filePath", "mediaType", "fieldName"],
      properties: {
        site:      { type: "string" },
        filePath:  { type: "string", description: "Absolute local path to the file" },
        mediaType: { type: "string", description: "Media type machine name, e.g. 'image'" },
        mediaName: { type: "string", description: "Name for the media entity (defaults to filename)" },
        fieldName: { type: "string", description: "Source field machine name, e.g. 'field_media_image'" },
        altText:   { type: "string", description: "Alt text for image media" },
        status:    { type: "boolean", default: true },
      },
    },
  },
  {
    name: "drupal_find_orphaned_media",
    description: "Find media entities not referenced by any content. Useful for storage cleanup audits.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Media type to check (default: image)" },
        limit: { type: "number", default: 50 },
      },
    },
  },
];

export const handlers = {
  drupal_list_media_types:             listMediaTypes,
  drupal_list_media:                   listMedia,
  drupal_get_media:                    getMedia,
  drupal_create_media:                 createMedia,
  drupal_update_media:                 updateMedia,
  drupal_delete_media:                 deleteMedia,
  drupal_upload_file:                  uploadFile,
  drupal_upload_file_and_create_media: uploadFileAndCreateMedia,
  drupal_find_orphaned_media:          findOrphanedMedia,
};
