import { describe, expect, it } from "vitest";
import { PRODUCTION_STARTUP_SEAM_KEYS, usedProductionSeamKeys } from "../../../../src/lib/https-startup.js";
import {
  productionOptionsForScan,
  requestForRoute,
  SCANNER_SEAMS,
  splitRoute,
} from "./scanner.js";
import { liveRoutes, liveTools } from "./coverage.js";

describe("X1 scanner inventory", () => {
  it("derives routes and tools from the live tables, never a hand-copied pair", () => {
    expect(liveRoutes()).toEqual(expect.arrayContaining([
      "POST /mcp",
      "GET /health",
      "DELETE /mcp",
    ]));
    expect(liveTools().length).toBeGreaterThan(10);
    expect(liveTools()).toEqual([...liveTools()].sort());
  });

  it("builds a request for every live route", () => {
    for (const route of liveRoutes()) {
      const { method, path } = splitRoute(route);
      const request = requestForRoute(route);
      expect(request.method).toBe(method);
      if (request.path) expect(request.path).toBe(path);
    }
  });

  it("production options omit seams until the X1-seams mutant injects one", () => {
    expect(usedProductionSeamKeys(productionOptionsForScan(null))).toEqual([]);
    const injected = productionOptionsForScan(SCANNER_SEAMS);
    expect(usedProductionSeamKeys(injected)).toEqual(["checkAuth"]);
    expect(PRODUCTION_STARTUP_SEAM_KEYS).toContain("checkAuth");
  });
});
