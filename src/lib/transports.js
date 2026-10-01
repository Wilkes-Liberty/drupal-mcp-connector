/**
 * Honest MCP transport presets (DEV-763).
 *
 * Wizard `--transport` stays `stdio` | `https`. These named presets are the
 * operator-facing labels so nobody invents a public SaaS URL.
 */

/** @typedef {"local-stdio" | "tailscale" | "public-https"} TransportPresetId */

/**
 * @typedef {object} TransportPreset
 * @property {TransportPresetId} id
 * @property {string} label
 * @property {"stdio" | "https"} transport Connector MCP transport.
 * @property {string} exampleHost Example URL shape.
 * @property {string} notes Operator-facing constraints. No secrets.
 * @property {boolean} gated True when this path is not a supported product claim.
 */

/** Named presets in display order. */
export const TRANSPORT_PRESETS = {
  "local-stdio": {
    id: "local-stdio",
    label: "Local stdio",
    transport: "stdio",
    exampleHost: "https://drupal.ddev.site",
    notes:
      "The MCP client launches this connector as a local subprocess. Drupal must " +
      "be reachable from this machine (localhost, DDEV/Lando, or a routable LAN).",
    gated: false,
  },
  tailscale: {
    id: "tailscale",
    label: "Tailscale VPN",
    transport: "stdio",
    exampleHost: "https://drupal.tailnet-name.ts.net",
    notes:
      "VPN-required. The machine running Cursor / Claude Code must be on the same " +
      "Tailscale tailnet as Drupal (typical host: https://<machine>.<tailnet>.ts.net). " +
      "This is not a public internet path and not a hosted SaaS endpoint.",
    gated: false,
  },
  "public-https": {
    id: "public-https",
    label: "Public HTTPS",
    transport: "https",
    exampleHost: "https://mcp.example.com/mcp",
    notes:
      "Gated / later. An operator-run connector with MCP_TRANSPORT=https, TLS, and " +
      "inbound OAuth (auth.issuer + auth.audience). There is no public hosted " +
      "Wilkes & Liberty MCP URL. Do not invent a marketplace remote until Path B exists.",
    gated: true,
  },
};

/**
 * Look up a transport preset by id.
 * @param {string} id
 * @returns {TransportPreset|null}
 */
export function getTransportPreset(id) {
  switch (id) {
    case "local-stdio":
      return TRANSPORT_PRESETS["local-stdio"];
    case "tailscale":
      return TRANSPORT_PRESETS.tailscale;
    case "public-https":
      return TRANSPORT_PRESETS["public-https"];
    default:
      return null;
  }
}

/**
 * Preset ids in display order.
 * @returns {TransportPresetId[]}
 */
export function listTransportPresetIds() {
  return ["local-stdio", "tailscale", "public-https"];
}

/**
 * Help text for wizard / doctor --help.
 * @returns {string}
 */
export function formatTransportPresetHelp() {
  return listTransportPresetIds().map((id) => {
    const preset = getTransportPreset(id);
    const gate = preset.gated ? " [gated/later]" : "";
    return `  ${preset.id}${gate}  ${preset.label} — ${preset.exampleHost}\n    ${preset.notes}`;
  }).join("\n");
}

/**
 * Map a wizard `--preset` onto the existing `--transport` pair.
 * @param {string} id
 * @returns {{preset: TransportPreset, transport: "stdio"|"https"}}
 * @throws {Error} when the id is unknown.
 */
export function resolveTransportPreset(id) {
  const preset = getTransportPreset(String(id || "").trim().toLowerCase());
  if (!preset) {
    throw new Error("--preset must be local-stdio|tailscale|public-https.");
  }
  return { preset, transport: preset.transport };
}

/**
 * RFC 2606 / 6761 documentation and reserved names — not a live Drupal.
 * Shared by the wizard (DEV-758) and doctor (DEV-759).
 * @param {string} url
 * @returns {boolean}
 */
export function isReservedDocumentationHost(url) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  host = String(host).toLowerCase();
  return (
    host === "example.com"
    || host === "example.net"
    || host === "example.org"
    || host.endsWith(".example.com")
    || host.endsWith(".example.net")
    || host.endsWith(".example.org")
    || host.endsWith(".example.test")
    || host.endsWith(".invalid")
    || host.endsWith(".test")
    || host.endsWith(".example")
  );
}
