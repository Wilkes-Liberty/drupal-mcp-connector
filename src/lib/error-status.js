/**
 * Read the HTTP status of a failed Drupal request from its error.
 *
 * `drupalFetch`, `drupalGraphqlFetch` and the upload helper set `status` on the
 * error they throw. Code that branches on the status reads it here instead of
 * testing the message for a number: the message also holds the request path and
 * Drupal's detail text, and either can contain "404" or "401" (#355).
 */

/**
 * The documented message shapes, anchored at the start:
 * `Drupal <status> on <method> <path>…`, `GraphQL request failed <status>…` and
 * `File upload failed <status>…`.
 */
const STATUS_PREFIX_RE = /^(?:Drupal|GraphQL request failed|File upload failed) (\d{3})(?!\w)/;

/**
 * HTTP status of a failed request.
 *
 * The `status` property decides when it is an integer from 100 to 599. An error
 * with no such property (one built from a message alone, or a plain string) is
 * read from the status token at the start of a documented message. A number
 * anywhere else in the text is never a status.
 * @param {unknown} err Error, or message string.
 * @returns {?number} The status, or null when the error carries none.
 */
export function httpStatusOf(err) {
  const status = err?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  const message = typeof err === "string" ? err : err?.message;
  if (typeof message !== "string") return null;
  const match = STATUS_PREFIX_RE.exec(message);
  return match ? Number(match[1]) : null;
}
