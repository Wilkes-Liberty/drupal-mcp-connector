/**
 * Authenticated HTTP wrappers for Drupal JSON:API and file uploads.
 */

import fetch from "node-fetch";
import { createReadStream, statSync } from "fs";
import { basename } from "path";
import { authHeaders, clientHeaders } from "./config.js";

const JSON_API_CONTENT_TYPE = "application/vnd.api+json";

/**
 * Standard JSON:API request.
 */
export async function drupalFetch(site, path, options = {}) {
  const url = `${site.baseUrl}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": JSON_API_CONTENT_TYPE,
      Accept: JSON_API_CONTENT_TYPE,
      ...clientHeaders(),
      ...authHeaders(site),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      // Drupal JSON:API surfaces errors in errors[].detail
      if (parsed.errors?.length) {
        detail = parsed.errors.map((e) => e.detail || e.title).join("; ");
      }
    } catch { /* use raw body */ }
    throw new Error(`Drupal ${res.status} on ${options.method || "GET"} ${path}: ${detail}`);
  }

  if (res.status === 204) return null; // No Content (e.g. DELETE success)
  return res.json();
}

/**
 * GraphQL request — posts JSON to the GraphQL endpoint.
 */
export async function drupalGraphqlFetch(site, body) {
  const endpoint = site.graphqlEndpoint || "/graphql";
  const url = `${site.baseUrl}${endpoint}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...clientHeaders(),
      ...authHeaders(site),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL request failed ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * File upload via Drupal's JSON:API file upload endpoint.
 *
 * Endpoint pattern:
 *   POST /jsonapi/{entity_type}/{bundle}/{field_name}
 *
 * With headers:
 *   Content-Type: application/octet-stream
 *   Content-Disposition: file; filename="foo.jpg"
 *
 * Returns a File entity (not a Media entity — call createMedia next).
 */
export async function drupalUploadFile(site, entityType, bundle, fieldName, filePath) {
  const filename = basename(filePath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a caller-supplied local upload path (validated upstream); fs access is the intended behavior
  const stat = statSync(filePath);
  const url = `${site.baseUrl}/jsonapi/${entityType}/${bundle}/${fieldName}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `file; filename="${filename}"`,
      Accept: JSON_API_CONTENT_TYPE,
      ...clientHeaders(),
      ...authHeaders(site),
    },
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is a caller-supplied local upload path (validated upstream); fs access is the intended behavior
    body: createReadStream(filePath),
    // node-fetch requires explicit size for streams to set Content-Length
    size: stat.size,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`File upload failed ${res.status}: ${body}`);
  }

  return res.json();
}
