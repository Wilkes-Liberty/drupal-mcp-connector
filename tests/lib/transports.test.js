import { describe, it, expect } from "vitest";
import {
  listTransportPresetIds,
  getTransportPreset,
  resolveTransportPreset,
  formatTransportPresetHelp,
  isReservedDocumentationHost,
  isTailscaleMagicDnsHost,
} from "../../src/lib/transports.js";

describe("transport presets (DEV-763)", () => {
  it("exposes the three honest presets", () => {
    expect(listTransportPresetIds()).toEqual(["local-stdio", "tailscale", "public-https"]);
    expect(getTransportPreset("local-stdio").transport).toBe("stdio");
    expect(getTransportPreset("tailscale").transport).toBe("stdio");
    expect(getTransportPreset("tailscale").notes).toMatch(/VPN-required/);
    expect(getTransportPreset("public-https").transport).toBe("https");
    expect(getTransportPreset("public-https").gated).toBe(true);
    expect(getTransportPreset("public-https").notes).toMatch(/Gated|later/i);
    expect(getTransportPreset("public-https").notes).not.toMatch(/hosted SaaS endpoint is ready/i);
  });

  it("maps --preset onto --transport", () => {
    expect(resolveTransportPreset("tailscale").transport).toBe("stdio");
    expect(resolveTransportPreset("public-https").preset.gated).toBe(true);
    expect(() => resolveTransportPreset("ftp")).toThrow(/local-stdio\|tailscale\|public-https/);
  });

  it("prints preset help used by wizard/doctor", () => {
    const help = formatTransportPresetHelp();
    expect(help).toMatch(/local-stdio/);
    expect(help).toMatch(/tailscale/);
    expect(help).toMatch(/public-https/);
    expect(help).toMatch(/gated\/later/);
  });

  it("recognises documentation-reserved hosts", () => {
    expect(isReservedDocumentationHost("https://drupal.example.com")).toBe(true);
    expect(isReservedDocumentationHost("https://foo.example.test/jsonapi")).toBe(true);
    expect(isReservedDocumentationHost("https://drupal.tailnet.ts.net")).toBe(false);
  });
});

describe("isTailscaleMagicDnsHost", () => {
  it("matches MagicDNS hostnames only", () => {
    expect(isTailscaleMagicDnsHost("https://drupal.tailnet.ts.net")).toBe(true);
    expect(isTailscaleMagicDnsHost("https://drupal.tailnet.ts.net/jsonapi")).toBe(true);
    expect(isTailscaleMagicDnsHost("https://evil.example.com/.ts.net/path")).toBe(false);
    expect(isTailscaleMagicDnsHost("https://notts.net.example.com")).toBe(false);
    expect(isTailscaleMagicDnsHost("https://example.com")).toBe(false);
  });
});
