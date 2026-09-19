import { describe, it, expect } from "vitest";
import { describeErrorBody, cleanErrorText, ERROR_DETAIL_MAX_CHARS } from "../../src/lib/error-body.js";

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
});
