/**
 * Turn a Drupal error response body into a short, safe detail string.
 *
 * An error body is untrusted text. It can be a JSON:API error document, an
 * HTML error page from Drupal, PHP or a proxy, or plain text of any length. It
 * can carry a server file path, a filename another user supplied, or a stack
 * fragment. Only the part meant for the caller is surfaced (#343, #345).
 */

/** Longest single detail string surfaced to the caller, in characters. */
export const ERROR_DETAIL_MAX_CHARS = 400;

/**
 * Longest joined detail for an error document that lists several errors, in
 * characters. A JSON:API 422 names one violation per error, and a caller needs
 * the whole list to correct its payload, so the request paths allow more than
 * one detail's worth. Each detail is still cut to {@link ERROR_DETAIL_MAX_CHARS}.
 */
export const ERROR_DOCUMENT_MAX_CHARS = 1200;

/** Longest HTML `<title>` surfaced to the caller, in characters. */
const HTML_TITLE_MAX_CHARS = 80;

/**
 * Text is cut to this many characters before any pattern runs over it. The
 * tag pattern is quadratic on a run of `<` with no `>`, so the bound also caps
 * the work a hostile body can cause.
 */
const BODY_SCAN_MAX_CHARS = 16384;

const TRUNCATED_SUFFIX = "… [truncated]";

/**
 * Remove markup. Tags are removed until none is left, so a tag cannot be
 * rebuilt from the pieces around a removed one (`<scr<b>ipt>`), and any angle
 * bracket that remains is dropped.
 * @param {string} text Untrusted text.
 * @returns {string} Text with no `<` or `>`.
 */
function stripTags(text) {
  let out = text;
  let previous;
  do {
    previous = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== previous);
  return out.replace(/[<>]/g, "");
}

/**
 * Strip markup and control characters, cut a backtrace, redact server paths,
 * collapse whitespace, and bound the length.
 * @param {*} text Untrusted text.
 * @param {number} [max] Character bound.
 * @returns {string} Cleaned text, or "" when nothing is left.
 */
export function cleanErrorText(text, max = ERROR_DETAIL_MAX_CHARS) {
  if (typeof text !== "string") return "";
  const cleaned = stripTags(text.slice(0, BODY_SCAN_MAX_CHARS))
    // A PHP or Drupal backtrace is never for the caller: cut from its marker on.
    .replace(/(?:stack trace|backtrace|call stack):[\s\S]*$/i, "[stack trace removed]")
    // ANSI colour sequences.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // Drupal stream-wrapper URIs name files other users uploaded.
    .replace(/\b(public|private|temporary|s3|assets):\/\/[^\s"'),;]+/gi, "$1://[path]")
    // Absolute filesystem paths of two or more segments. A URL path is left
    // alone: its slash follows a word character, a colon or another slash.
    .replace(/(?<![\w:/.\]])\/[\w.@%+~/-]+/g, (match) => (match.indexOf("/", 1) === -1 ? match : "[path]"))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return boundText(cleaned, max);
}

/**
 * Cut already-cleaned text to a length, marking the cut.
 * @param {string} text Cleaned text.
 * @param {number} max Character bound.
 * @returns {string}
 */
function boundText(text, max) {
  if (text.length <= max) return text;
  if (text.endsWith(TRUNCATED_SUFFIX) && text.length <= max + TRUNCATED_SUFFIX.length) return text;
  return text.slice(0, max).trimEnd() + TRUNCATED_SUFFIX;
}

/**
 * Whether a body is an HTML (or XML) page rather than a message.
 * @param {string} body Response body.
 * @param {?string} contentType Response Content-Type header.
 * @returns {boolean}
 */
function looksLikeMarkupPage(body, contentType) {
  if (typeof contentType === "string" && /\b(html|xml)\b/i.test(contentType) && !/json/i.test(contentType)) return true;
  const head = body.slice(0, 1024).trimStart().toLowerCase();
  // Any body that opens with a tag is a page or a PHP html_errors dump
  // (`<br />\n<b>Fatal error</b>: …`), never a message meant for the caller.
  return head.startsWith("<");
}

/**
 * Read the detail strings of a parsed JSON error body.
 * @param {*} parsed Parsed JSON.
 * @returns {?string[]} Detail strings, or null when the JSON is not an error document.
 */
function jsonErrorDetails(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    // Drupal JSON:API surfaces errors in errors[].detail, GraphQL in
    // errors[].message. `source`, `meta`, `links`, `locations` and `extensions`
    // are never read: with verbose errors on they hold a backtrace.
    return parsed.errors
      .map((e) => [e?.detail, e?.title, e?.message].find((value) => typeof value === "string" && value) || "")
      .filter(Boolean);
  }
  const message = typeof parsed.message === "string" && parsed.message ? parsed.message : "";
  // OAuth 2.0 error document (RFC 6749 §5.2): { "error": "<code>", "error_description": "…" }.
  // `hint` is never read: it can name a key file on the server.
  if (typeof parsed.error === "string" && parsed.error) {
    const description = typeof parsed.error_description === "string" && parsed.error_description
      ? parsed.error_description
      : message;
    return [description ? `${parsed.error}: ${description}` : parsed.error];
  }
  // Drupal's non-JSON:API JSON errors: { "message": "…" }.
  if (message) return [message];
  return null;
}

/**
 * Describe an error response body for the caller.
 *
 * - JSON:API or GraphQL error document: `errors[].detail` (or `title`, or
 *   `message`), each cleaned on its own, joined with "; ".
 * - OAuth error document: `error` and `error_description`.
 * - `{ message }` JSON: the message.
 * - Other JSON: a fixed sentence. The body is not shown.
 * - HTML or XML page: a fixed sentence plus the page `<title>`. The body is
 *   never shown.
 * - Plain text: the text.
 *
 * Every surfaced string has markup and control characters stripped, server
 * paths redacted, and is cut to {@link ERROR_DETAIL_MAX_CHARS}. The joined
 * details of an error document are cut to `options.maxChars`.
 *
 * @param {*} body Response body text.
 * @param {?string} [contentType] Response Content-Type header, when known.
 * @param {object} [options]
 * @param {number} [options.maxChars] Bound for the joined details of an error
 *   document. Defaults to {@link ERROR_DETAIL_MAX_CHARS}; never below it.
 * @returns {string} Detail for the caller, or "" for an empty body.
 */
export function describeErrorBody(body, contentType = null, options = {}) {
  if (typeof body !== "string" || !body.trim()) return "";

  let parsed;
  let isJson = false;
  try {
    parsed = JSON.parse(body);
    isJson = parsed !== null && typeof parsed === "object";
  } catch { /* not JSON */ }

  if (isJson) {
    const details = jsonErrorDetails(parsed);
    const maxChars = Number.isFinite(options.maxChars)
      ? Math.max(ERROR_DETAIL_MAX_CHARS, Math.floor(options.maxChars))
      : ERROR_DETAIL_MAX_CHARS;
    // Each detail is cleaned on its own, so a backtrace or an oversized string
    // in one error does not remove the errors after it.
    const text = details
      ? boundText(details.map((detail) => cleanErrorText(detail)).filter(Boolean).join("; "), maxChars)
      : "";
    return text || "the server returned JSON with no error detail, not shown";
  }

  if (looksLikeMarkupPage(body, contentType)) {
    const scan = body.slice(0, BODY_SCAN_MAX_CHARS);
    const open = scan.search(/<title[^>]*>/i);
    const close = open === -1 ? -1 : scan.toLowerCase().indexOf("</title", open);
    const title = close === -1 ? "" : cleanErrorText(scan.slice(open, close), HTML_TITLE_MAX_CHARS);
    return "the server returned an HTML page, not shown" + (title ? ` (title: ${title})` : "");
  }

  return cleanErrorText(body) || "the server returned a body with no readable text, not shown";
}
