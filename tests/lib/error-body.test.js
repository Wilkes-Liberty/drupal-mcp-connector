import { describe, it, expect } from "vitest";
import { describeErrorBody, cleanErrorText, ERROR_DETAIL_MAX_CHARS, ERROR_DOCUMENT_MAX_CHARS } from "../../src/lib/error-body.js";

describe("cleanErrorText", () => {
  it("strips markup, control characters and terminal escapes, and collapses whitespace", () => {
    expect(cleanErrorText("a <b>b</b>\r\n\tc\u0000 \u001b[31md")).toBe("a b c d");
  });

  it("drops a stray angle bracket so no tag can be rebuilt", () => {
    expect(cleanErrorText("<<script>script>alert(1)<</script>/script>")).not.toMatch(/[<>]/);
  });

  it("redacts absolute paths and stream-wrapper URIs but leaves URLs and words alone", () => {
    expect(cleanErrorText("failed at /var/www/html/web/index.php, see https://example.org/docs/upload and/or retry"))
      .toBe("failed at [path], see https://example.org/docs/upload and/or retry");
    expect(cleanErrorText("cannot move public://2026-09/report final.pdf")).toBe("cannot move public://[path] final.pdf");
  });

  // Real Drupal, PHP and Composer messages. A site-relative URL path is what
  // the caller sent and has to read back; a filesystem path is not (#357).
  it.each([
    ["alias conflict",
      "The alias /about/team is already in use in this language.",
      "The alias /about/team is already in use in this language."],
    ["redirect source conflict",
      "The source path /old/page is already being redirected. Do you want to edit the existing redirect?",
      "The source path /old/page is already being redirected. Do you want to edit the existing redirect?"],
    ["invalid internal path",
      "Either the path /node/12/edit is invalid or you do not have access to it.",
      "Either the path /node/12/edit is invalid or you do not have access to it."],
    ["path with a query string",
      "The path /node/12/edit?destination=/admin/content is not routed.",
      "The path /node/12/edit?destination=/admin/content is not routed."],
    ["JSON:API resource path",
      "The resource /jsonapi/node/article/6f1c does not exist.",
      "The resource /jsonapi/node/article/6f1c does not exist."],
    ["PHP warning",
      "Warning: Undefined array key \"x\" in /var/www/html/web/core/lib/Drupal/Core/Entity/EntityBase.php on line 12",
      "Warning: Undefined array key \"x\" in [path] on line 12"],
    ["temp upload path",
      "File upload error. Could not move uploaded file /tmp/phpA1b2C3 to destination.",
      "File upload error. Could not move uploaded file [path] to destination."],
    ["private file path",
      "The file /mnt/storage/private/2026-09/contract.pdf could not be read.",
      "The file [path] could not be read."],
    ["private file path outside a known root",
      "The file /drupal/private/2026-09/contract.pdf could not be read.",
      "The file [path] could not be read."],
    ["composer vendor path",
      "Class not found in /project/vendor/symfony/http-kernel/HttpKernel.php:83",
      "Class not found in [path]:83"],
    ["code tree with no known root or extension",
      "Cannot scan /project/web/modules/custom/example",
      "Cannot scan [path]"],
    ["server-side file outside a known root",
      "Unable to parse /project/config/sync/system.site.yml.",
      "Unable to parse [path]"],
    ["environment file",
      "Could not read /project/.env.local",
      "Could not read [path]"],
    ["public file URL with a query string",
      "Could not derive /sites/default/files/styles/large/public/a.jpg?itok=abc",
      "Could not derive [path]?itok=abc"],
    ["home directory, any case",
      "No such file: /users/jane/Sites/example/notes.txt",
      "No such file: [path]"],
    ["Windows drive path",
      "failed to open stream: C:\\inetpub\\wwwroot\\web\\index.php on line 3",
      "failed to open stream: [path] on line 3"],
    ["Windows drive path with forward slashes",
      "failed to open stream: C:/xampp/htdocs/web/index.php on line 3",
      "failed to open stream: [path] on line 3"],
    ["Windows drive path with doubled backslashes",
      "failed to open stream: D:\\\\sites\\\\web\\\\index.php on line 3",
      "failed to open stream: [path] on line 3"],
    ["filesystem path straight after a colon",
      "Failed opening 'x.php' for inclusion (include_path='.:/usr/share/php')",
      "Failed opening 'x.php' for inclusion (include_path='.:[path]')"],
    ["Drupal link URI",
      "link.0.uri: The path 'internal:/about/team' is inaccessible.",
      "link.0.uri: The path 'internal:/about/team' is inaccessible."],
    ["shared memory and mounted volume",
      "cannot write /dev/shm/php_a1 or /Volumes/Data/site/page.html",
      "cannot write [path] or [path]"],
    ["Windows UNC path",
      "cannot read \\\\fileserver\\share\\private\\a.pdf now",
      "cannot read [path] now"],
    ["file URI",
      "cannot open file:///var/www/html/web/sites/default/settings.php for reading",
      "cannot open file://[path] for reading"],
    ["phar URI",
      "error in phar:///usr/local/bin/drush.phar/src/Drush.php:12",
      "error in phar://[path]"],
    ["web URL is not a file URI or a drive path",
      "see https://example.org/about/team and http://example.org/node/12/edit",
      "see https://example.org/about/team and http://example.org/node/12/edit"],
    ["single segment",
      "The path /contact is reserved; and/or retry",
      "The path /contact is reserved; and/or retry"],
  ])("path redaction: %s", (_name, input, expected) => {
    expect(cleanErrorText(input)).toBe(expected);
  });

  it("removes nested tag fragments and stays fast on a run of unclosed brackets", () => {
    const nested = cleanErrorText("<scr<b>ipt>alert(1)</scr</b>ipt> <<i>script>x<</i>/script>");
    // The word may survive as plain text; no bracket may, so no tag can.
    expect(nested).not.toMatch(/[<>]/);
    expect(nested).toBe("iptalert(1)ipt scriptx/script");
    const started = Date.now();
    expect(cleanErrorText("<a".repeat(200000))).not.toMatch(/[<>]/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("bounds the length", () => {
    const out = cleanErrorText("z".repeat(5000));
    expect(out.length).toBe(ERROR_DETAIL_MAX_CHARS + "… [truncated]".length);
  });

  it("returns an empty string for a non-string", () => {
    for (const v of [undefined, null, 5, {}, []]) expect(cleanErrorText(v)).toBe("");
  });
});

describe("describeErrorBody", () => {
  it("returns an empty string for an empty body", () => {
    for (const v of ["", "   ", undefined, null]) expect(describeErrorBody(v)).toBe("");
  });

  it("joins JSON:API details and falls back to the title", () => {
    expect(describeErrorBody(JSON.stringify({ errors: [{ detail: "file extension not allowed" }, { title: "Forbidden" }] })))
      .toBe("file extension not allowed; Forbidden");
  });

  it("ignores non-string details", () => {
    expect(describeErrorBody(JSON.stringify({ errors: [{ detail: { trace: "/var/www/x/y.php" } }] })))
      .toBe("the server returned JSON with no error detail, not shown");
  });

  it("does not echo a JSON scalar or array of unknown shape", () => {
    expect(describeErrorBody(JSON.stringify([{ secret: "s" }]))).toBe("the server returned JSON with no error detail, not shown");
  });

  it("treats an XML or HTML content type as a page even when the body does not start with a tag", () => {
    expect(describeErrorBody("Fatal error in /var/www/html/index.php <br/> on line 3", "text/html"))
      .toBe("the server returned an HTML page, not shown");
  });

  it("cleans the HTML title like any other text", () => {
    expect(describeErrorBody("<html><head><title>Error at /var/www/html/web/x.php <b>now</b></title></head></html>"))
      .toBe("the server returned an HTML page, not shown (title: Error at [path] now)");
  });

  it("treats a body that opens with any tag as a page (PHP html_errors dump)", () => {
    expect(describeErrorBody("<br />\n<b>Fatal error</b>: Uncaught Exception in /var/www/html/x/y.php:3\nStack trace:\n#0 {main}"))
      .toBe("the server returned an HTML page, not shown");
  });

  it("cuts a backtrace out of a detail or a plain-text body", () => {
    expect(describeErrorBody(JSON.stringify({ errors: [{ detail: "Upload failed. Stack trace:\n#0 secret_function('pw')" }] })))
      .toBe("Upload failed. [stack trace removed]");
    expect(describeErrorBody("PDOException: gone away\nStack trace:\n#0 Database->query('SELECT pass')", "text/plain"))
      .toBe("PDOException: gone away [stack trace removed]");
  });

  it("passes short plain text through", () => {
    expect(describeErrorBody("Request Entity Too Large", "text/plain")).toBe("Request Entity Too Large");
  });

  it("reads errors[].message from a GraphQL error document and ignores extensions", () => {
    const body = JSON.stringify({ errors: [{ message: "Cannot query field \"x\".", extensions: { trace: "#0 /var/www/html/x.php" } }] });
    expect(describeErrorBody(body, "application/json")).toBe("Cannot query field \"x\".");
  });

  it("reads an OAuth error document and never its hint", () => {
    expect(describeErrorBody(JSON.stringify({ error: "invalid_token", error_description: "The token expired.", hint: "/var/www/keys/public.key", message: "ignored" })))
      .toBe("invalid_token: The token expired.");
    expect(describeErrorBody(JSON.stringify({ error: "access_denied", message: "Denied." }))).toBe("access_denied: Denied.");
    expect(describeErrorBody(JSON.stringify({ error: "server_error" }))).toBe("server_error");
    expect(describeErrorBody(JSON.stringify({ error: { code: 1 } }))).toBe("the server returned JSON with no error detail, not shown");
  });

  it("cleans each detail on its own, so a backtrace does not remove the next error", () => {
    const body = JSON.stringify({ errors: [{ detail: "First. Stack trace: #0 /var/www/html/a.php" }, { detail: "Second." }] });
    expect(describeErrorBody(body)).toBe("First. [stack trace removed]; Second.");
  });

  it("bounds the joined details to the default, or to maxChars when given", () => {
    const body = JSON.stringify({ errors: Array.from({ length: 50 }, (_, i) => ({ detail: `e${i} ${"x".repeat(100)}` })) });
    const byDefault = describeErrorBody(body);
    expect(byDefault.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
    expect(byDefault).toMatch(/… \[truncated\]$/);

    const wider = describeErrorBody(body, null, { maxChars: ERROR_DOCUMENT_MAX_CHARS });
    expect(wider.length).toBeGreaterThan(ERROR_DETAIL_MAX_CHARS);
    expect(wider.length).toBeLessThanOrEqual(ERROR_DOCUMENT_MAX_CHARS + 20);
    expect(wider).toContain("e9 ");
  });

  it("never bounds below one detail, and ignores a malformed maxChars", () => {
    const body = JSON.stringify({ errors: [{ detail: "y".repeat(300) }, { detail: "z".repeat(300) }] });
    expect(describeErrorBody(body, null, { maxChars: 5 }).length).toBeGreaterThan(300);
    expect(describeErrorBody(body, null, { maxChars: "lots" })).toBe(describeErrorBody(body));
    expect(describeErrorBody(body, null, { maxChars: Infinity })).toBe(describeErrorBody(body));
  });

  it("does not widen the bound of a single detail or of plain text", () => {
    const one = describeErrorBody(JSON.stringify({ errors: [{ detail: "x".repeat(5000) }] }), null, { maxChars: ERROR_DOCUMENT_MAX_CHARS });
    expect(one.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
    expect(one.match(/truncated/g)).toHaveLength(1);
    const plain = describeErrorBody("p".repeat(5000), "text/plain", { maxChars: ERROR_DOCUMENT_MAX_CHARS });
    expect(plain.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
  });

  it("reads a bounded number of details from a very long errors array", () => {
    const body = JSON.stringify({ errors: Array.from({ length: 5000 }, (_, i) => ({ detail: i < 4999 ? "<b></b>" : "last" })) });
    expect(describeErrorBody(body)).toBe("the server returned JSON with no error detail, not shown");
    const short = JSON.stringify({ errors: Array.from({ length: 80 }, (_, i) => ({ detail: `e${i}` })) });
    const described = describeErrorBody(short, null, { maxChars: ERROR_DOCUMENT_MAX_CHARS });
    expect(described).toContain("e49");
    expect(described).not.toContain("e50");
    expect(described).toMatch(/… \[truncated\]$/);
  });
});
