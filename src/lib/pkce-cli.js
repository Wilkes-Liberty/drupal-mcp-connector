/** Explicit local browser launcher; stdout remains reserved for MCP. */
import { execFile } from "node:child_process";
import { authorizePkce, installPkceSession } from "./pkce-login.js";

/** Refuse principal sessions in network transports, including direct startup. */
export function assertLocalPkce(config, transport) {
  if (transport !== "stdio" && Object.values(config.sites || {}).some(site => site.pkce)) {
    throw new Error("Browser sign-in requires the local stdio transport.");
  }
}

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 10000 }, error => error ? reject(new Error("Browser sign-in launcher failed.")) : resolve()));
}

/** Sign in each configured PKCE site before starting the connector in this process. */
export async function signInSites(config, resolveSite, options = {}) {
  assertLocalPkce(config, process.env.MCP_TRANSPORT || "stdio");
  const names = Object.entries(config.sites).filter(([, site]) => site.pkce).map(([name]) => name);
  if (!names.length) throw new Error("No browser sign-in sites configured.");
  for (const name of names) {
    const site = resolveSite(name);
    console.error("[drupal-mcp-connector] Complete browser sign-in to continue.");
    const entry = await authorizePkce(site.pkce, { openBrowser, ...options });
    installPkceSession(site, entry);
  }
}
