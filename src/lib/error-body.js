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
 * First segments that mark a filesystem path. Several are also plausible URL
 * prefixes (`/home`, `/data`, `/web`); a match is redacted either way, so the
 * rule errs towards hiding a path.
 */
const FILESYSTEM_ROOTS = new Set([
  "var", "home", "srv", "usr", "opt", "tmp", "etc", "app", "mnt", "private", "users", "data", "code",
  "workspace", "builds", "run", "proc", "sys", "lib", "bin", "root", "www", "sites", "vendor", "web",
  "docroot", "html",
]);

/** Segments, at any depth, that mark a code tree, a web root or a file directory. */
const SERVER_TREE_SEGMENTS = new Set([
  "vendor", "node_modules", "core", "modules", "themes", "profiles", "sites", "src", "lib", "docroot",
  "public_html", "htdocs", "files", "private", "tmp",
]);

/** File extensions that mark a server-side file rather than a page. */
const SERVER_FILE_EXTENSIONS = new Set([
  "php", "inc", "module", "install", "theme", "engine", "yml", "yaml", "twig", "log", "sql", "sh", "env",
  "ini", "conf", "json", "lock", "phar",
]);

/**
 * Whether a slash-led path names something on the server's filesystem rather
 * than a site-relative URL. A path is a filesystem path when it has two or
 * more segments and
 * - its first segment is a known filesystem root (`/var/...`, `/tmp/...`), or
 * - any segment marks a code or server tree (`vendor`, `modules`, `files`), or
 * - any segment carries a server-side file extension (`settings.php`,
 *   `.env.local`, `dump.sql.gz`).
 * Segments compare case-insensitively. Everything else (`/about/team`,
 * `/node/12/edit`) is a URL path.
 * @param {string} path Slash-led path, as matched in an error text.
 * @returns {boolean}
 */
function isFilesystemPath(path) {
  const segments = path.toLowerCase().split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (FILESYSTEM_ROOTS.has(segments[0])) return true;
  return segments.some((segment) => SERVER_TREE_SEGMENTS.has(segment)
    || segment.split(".").slice(1).some((part) => SERVER_FILE_EXTENSIONS.has(part)));
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
    // Local-file URIs.
    .replace(/\b(file|phar):\/\/[^\s"'),;]+/gi, "$1://[path]")
    // Windows drive paths (`C:\dir`, `C:/dir`) and UNC paths (`\\host\share`).
    .replace(/(?<!\w)[A-Za-z]:[\\/](?![\\/])[^\s"'),;|*?]*/g, "[path]")
    .replace(/(?<![\w\\])\\\\[\w.$-]+\\[^\s"'),;|*?]*/g, "[path]")
    // Slash-led paths. A filesystem path is redacted; a site-relative URL path
    // is kept, because the caller sent it and has to read it back (#357). The
    // path part of an absolute URL never matches: its slash follows a word
    // character, a colon or another slash.
    .replace(/(?<![\w:/.\]])\/[\w.@%+~/-]+/g, (match) => (isFilesystemPath(match) ? "[path]" : match))
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

/** Most details of one error document that are cleaned, whatever the bound. */
const ERROR_DETAILS_MAX_COUNT = 50;

/**
 * Clean each detail on its own and join them, so a backtrace or an oversized
 * string in one error does not remove the errors after it. Cleaning stops once
 * the bound is reached or {@link ERROR_DETAILS_MAX_COUNT} details were read, so
 * a document with a very long `errors` array costs a bounded amount of work.
 * @param {string[]} details Untrusted detail strings.
 * @param {number} maxChars Bound for the joined text.
 * @returns {string} Joined, bounded text, or "" when nothing is left.
 */
function joinCleanDetails(details, maxChars) {
  const cleaned = [];
  let length = 0;
  for (const detail of details.slice(0, ERROR_DETAILS_MAX_COUNT)) {
    const text = cleanErrorText(detail);
    if (!text) continue;
    cleaned.push(text);
    length += text.length + 2;
    if (length > maxChars) break;
  }
  if (!cleaned.length) return "";
  const joined = boundText(cleaned.join("; "), maxChars);
  const dropped = details.length > ERROR_DETAILS_MAX_COUNT && !joined.endsWith(TRUNCATED_SUFFIX);
  return dropped ? joined + TRUNCATED_SUFFIX : joined;
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
    const text = details ? joinCleanDetails(details, maxChars) : "";
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
