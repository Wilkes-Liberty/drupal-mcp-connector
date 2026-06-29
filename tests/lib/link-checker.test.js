import { describe, it, expect, vi } from "vitest";
import { isSafeUrl, checkLinks } from "../../src/lib/link-checker.js";

describe("link-checker", () => {
  describe("isSafeUrl (SSRF guard)", () => {
    it("allows public http(s) hosts", () => {
      expect(isSafeUrl("https://example.com/x").safe).toBe(true);
      expect(isSafeUrl("http://1.2.3.4/x").safe).toBe(true);
    });
    it("refuses non-http protocols", () => {
      expect(isSafeUrl("ftp://example.com").safe).toBe(false);
      expect(isSafeUrl("file:///etc/passwd").safe).toBe(false);
    });
    it("refuses loopback and metadata hosts", () => {
      expect(isSafeUrl("http://localhost/x").safe).toBe(false);
      expect(isSafeUrl("http://127.0.0.1/x").safe).toBe(false);
      expect(isSafeUrl("http://[::1]/x").safe).toBe(false);
      expect(isSafeUrl("http://169.254.169.254/latest/meta-data").safe).toBe(false);
    });
    it("refuses private IPv4 ranges", () => {
      expect(isSafeUrl("http://10.0.0.5/x").safe).toBe(false);
      expect(isSafeUrl("http://172.16.4.4/x").safe).toBe(false);
      expect(isSafeUrl("http://192.168.1.1/x").safe).toBe(false);
    });
  });

  describe("checkLinks", () => {
    it("skips blocked and non-allowlisted hosts without fetching", async () => {
      const fetchImpl = vi.fn();
      const { results } = await checkLinks(
        ["http://127.0.0.1/a", "https://external.org/b"],
        { internalHost: "example.com", fetchImpl }
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(results.find((r) => r.url.includes("127.0.0.1")).reason).toMatch(/private|loopback/);
      expect(results.find((r) => r.url.includes("external.org")).reason).toMatch(/allowlist/);
    });

    it("checks allowlisted hosts and reports ok for 2xx/3xx", async () => {
      const fetchImpl = vi.fn(async () => ({ status: 200 }));
      const { results } = await checkLinks(["https://example.com/a"], {
        internalHost: "example.com",
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(results[0]).toMatchObject({ ok: true, status: 200, skipped: false });
    });

    it("flags 4xx as not ok and retries HEAD->GET on 405", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ status: 405 }) // HEAD rejected
        .mockResolvedValueOnce({ status: 404 }); // GET 404
      const { results } = await checkLinks(["https://allowed.org/x"], {
        allowedHosts: ["allowed.org"],
        fetchImpl,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(results[0]).toMatchObject({ ok: false, status: 404 });
    });

    it("honors maxLinks and flags truncated", async () => {
      const fetchImpl = vi.fn(async () => ({ status: 200 }));
      const urls = ["https://a.org/1", "https://a.org/2", "https://a.org/3"];
      const { checked, truncated } = await checkLinks(urls, {
        allowedHosts: ["a.org"],
        maxLinks: 2,
        fetchImpl,
      });
      expect(checked).toBe(2);
      expect(truncated).toBe(true);
    });
  });
});
