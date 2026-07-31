import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  assertUploadPathAllowed,
  sanitizeUploadFilename,
  getUploadRoots,
} from "../../src/lib/validate.js";
import { SecurityError } from "../../src/lib/security.js";

const FIXTURE_DIR = join(process.cwd(), ".tmp-upload-fixture");
const FIXTURE_FILE = join(FIXTURE_DIR, "ok.png");

describe("upload path allowlist (#137)", () => {
  afterEach(() => {
    delete process.env.MCP_UPLOAD_ROOT;
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("sanitizeUploadFilename strips quotes and control chars", () => {
    expect(sanitizeUploadFilename('evil"\r\n.jpg')).toBe("evil.jpg");
    expect(sanitizeUploadFilename("../../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadFilename("")).toBe("upload");
  });

  it("defaults roots to process.cwd()", () => {
    const roots = getUploadRoots();
    expect(roots.some((r) => r === process.cwd() || process.cwd().startsWith(r) || r.startsWith(process.cwd()))).toBe(true);
  });

  it("allows a file under the working directory", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE_FILE, "x");
    const real = assertUploadPathAllowed(FIXTURE_FILE);
    expect(real).toContain("ok.png");
  });

  it("rejects a path outside allowed roots", () => {
    // /etc/hosts is almost always present and outside cwd.
    expect(() => assertUploadPathAllowed("/etc/hosts")).toThrow(SecurityError);
  });

  it("rejects sensitive basenames even under an allowed root", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const envPath = join(FIXTURE_DIR, ".env");
    writeFileSync(envPath, "SECRET=1");
    expect(() => assertUploadPathAllowed(envPath)).toThrow(SecurityError);
  });
});
