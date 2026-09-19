/**
 * Turn a Drupal error response body into a short, safe detail string.
 *
 * An error body is untrusted text. It can be a JSON:API error document, an
 * HTML error page from Drupal, PHP or a proxy, or plain text of any length. It
 * can carry a server file path, a filename another user supplied, or a stack
 * fragment. Only the part meant for the caller is surfaced (#343).
 */

/** Longest detail string surfaced to the caller, in characters. */
export const ERROR_DETAIL_MAX_CHARS = 400;

/** Longest HTML `<title>` surfaced to the caller, in characters. */
const HTML_TITLE_MAX_CHARS = 80;

/** Bodies are cut to this many characters before any parsing or matching. */
const BODY_SCAN_MAX_CHARS = 65536;

const TRUNCATED_SUFFIX = "… [truncated]";

/**
 * Strip markup and control characters, cut a backtrace, redact server paths,
 * collapse whitespace, and bound the length.
 * @param {*} text Untrusted text.
 * @param {number} [max] Character bound.
 * @returns {string} Cleaned text, or "" when nothing is left.
 */
export function cleanErrorText(text, max = ERROR_DETAIL_MAX_CHARS) {
  if (typeof text !== "string") return "";
  const cleaned = text
    .slice(0, BODY_SCAN_MAX_CHARS)
    // A PHP or Drupal backtrace is never for the caller: cut from its marker on.
    .replace(/(?:stack trace|backtrace|call stack):[\s\S]*$/i, "[stack trace removed]")
    // ANSI colour sequences, then markup.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    // Drupal stream-wrapper URIs name files other users uploaded.
    .replace(/\b(public|private|temporary|s3|assets):\/\/[^\s"'),;]+/gi, "$1://[path]")
    // Absolute filesystem paths of two or more segments. A URL path is left
    // alone: its slash follows a word character, a colon or another slash.
    .replace(/(?<![\w:/.\]])\/[\w.@%+~/-]+/g, (match) => (match.indexOf("/", 1) === -1 ? match : "[path]"))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max).trimEnd() + TRUNCATED_SUFFIX;
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
    // Drupal JSON:API surfaces errors in errors[].detail. `source`, `meta` and
    // `links` are never read: with verbose errors on they hold a backtrace.
    return parsed.errors
      .map((e) => (typeof e?.detail === "string" && e.detail) || (typeof e?.title === "string" && e.title) || "")
      .filter(Boolean);
  }
  // Drupal's non-JSON:API JSON errors: { "message": "…" }.
  if (typeof parsed.message === "string" && parsed.message) return [parsed.message];
  return null;
}

/**
 * Describe an error response body for the caller.
 *
 * - JSON:API error document: `errors[].detail` (or `title`), joined with "; ".
 * - `{ message }` JSON: the message.
 * - Other JSON: a fixed sentence. The body is not shown.
 * - HTML or XML page: a fixed sentence plus the page `<title>`. The body is
 *   never shown.
 * - Plain text: the text.
 *
 * Every surfaced string has markup and control characters stripped, server
 * paths redacted, and is cut to {@link ERROR_DETAIL_MAX_CHARS}.
 *
 * @param {*} body Response body text.
 * @param {?string} [contentType] Response Content-Type header, when known.
 * @returns {string} Detail for the caller, or "" for an empty body.
 */
export function describeErrorBody(body, contentType = null) {
  if (typeof body !== "string" || !body.trim()) return "";

  let parsed;
  let isJson = false;
  try {
    parsed = JSON.parse(body);
    isJson = parsed !== null && typeof parsed === "object";
  } catch { /* not JSON */ }

  if (isJson) {
    const details = jsonErrorDetails(parsed);
    const text = details ? cleanErrorText(details.join("; ")) : "";
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
