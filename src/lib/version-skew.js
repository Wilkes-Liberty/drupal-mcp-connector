/**
 * Connector vs site version-skew detection (DEV-766).
 *
 * Used by doctor and the wizard when a readiness probe reports versions.
 * Never auto-upgrades. Skip (do not fail) when the site reports nothing.
 */

import { CLIENT_VERSION } from "./config.js";

/** Integration-contract 1.1 needs mcp_sentinel ≥ 2.9.0 when a version is visible. */
export const SENTINEL_MIN_FOR_CONTRACT = "2.9.0";

/**
 * Compare dotted numeric versions (`1.2.3`). Non-numeric suffixes are ignored.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a < b.
 */
export function compareSemver(a, b) {
  const parse = (value) => String(value).replace(/^v/i, "").split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length, 3);
  for (let i = 0; i < len; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

/**
 * Pull version fields from a readiness body / response headers when present.
 * @param {object|null} body
 * @param {{get?: function(string): string|null}|undefined} headers
 * @returns {{sentinelVersion: string|null, minConnectorVersion: string|null, siteConnectorVersion: string|null}}
 */
export function extractReportedVersions(body, headers) {
  const headerGet = typeof headers?.get === "function"
    ? (name) => headers.get(name)
    : () => null;
  const sentinelVersion = firstString(
    body?.sentinel_version,
    body?.versions?.sentinel,
    body?.mcp_sentinel,
    headerGet("x-mcp-sentinel-version"),
    headerGet("x-drupal-mcp-sentinel-version"),
  );
  const minConnectorVersion = firstString(
    body?.min_connector_version,
    body?.connector_min_version,
    body?.compatible_connector,
    body?.versions?.min_connector,
  );
  const siteConnectorVersion = firstString(
    body?.connector_version,
    body?.versions?.connector,
    headerGet("x-mcp-connector-version"),
  );
  return { sentinelVersion, minConnectorVersion, siteConnectorVersion };
}

/**
 * Detect connector vs site version skew when the site reports versions.
 * @param {object} [reported] extractReportedVersions() result.
 * @param {string} [connectorVersion]
 * @returns {{skew: boolean, detectable: boolean, detail: string, nextFix: string|null, youAreOn: string, siteNeeds: string|null}}
 */
export function detectVersionSkew(reported, connectorVersion = CLIENT_VERSION) {
  const youAreOn = `connector ${connectorVersion} (integration contract 1.1)`;
  const { sentinelVersion, minConnectorVersion, siteConnectorVersion } = reported ?? {};

  if (minConnectorVersion && compareSemver(connectorVersion, minConnectorVersion) < 0) {
    return {
      skew: true,
      detectable: true,
      youAreOn,
      siteNeeds: `connector >= ${minConnectorVersion}`,
      detail: `You are on ${youAreOn}; this site asks for connector >= ${minConnectorVersion}.`,
      nextFix:
        `Upgrade this package (npm i -g drupal-mcp-connector@${minConnectorVersion} or newer). ` +
        "Doctor/wizard never auto-upgrade.",
    };
  }

  if (sentinelVersion && compareSemver(sentinelVersion, SENTINEL_MIN_FOR_CONTRACT) < 0) {
    return {
      skew: true,
      detectable: true,
      youAreOn,
      siteNeeds: `mcp_sentinel >= ${SENTINEL_MIN_FOR_CONTRACT}`,
      detail:
        `You are on ${youAreOn}; site MCP Sentinel is ${sentinelVersion}, ` +
        `which is below ${SENTINEL_MIN_FOR_CONTRACT} required for contract 1.1.`,
      nextFix:
        "Upgrade mcp_sentinel on the Drupal site to " +
        `${SENTINEL_MIN_FOR_CONTRACT} or newer (composer require drupal/mcp_sentinel). ` +
        "Doctor/wizard never auto-upgrade.",
    };
  }

  if (siteConnectorVersion) {
    const youMajor = String(connectorVersion).split(".")[0];
    const siteMajor = String(siteConnectorVersion).split(".")[0];
    if (youMajor !== siteMajor) {
      return {
        skew: true,
        detectable: true,
        youAreOn,
        siteNeeds: `connector ${siteConnectorVersion} (same major)`,
        detail:
          `You are on ${youAreOn}; the site reported connector ${siteConnectorVersion} ` +
          "(different major — treat as skew).",
        nextFix:
          "Align connector and site majors before relying on new contract fields. " +
          "Doctor/wizard never auto-upgrade.",
      };
    }
  }

  if (sentinelVersion || minConnectorVersion || siteConnectorVersion) {
    const bits = [
      sentinelVersion ? `Sentinel ${sentinelVersion}` : null,
      siteConnectorVersion ? `site connector ${siteConnectorVersion}` : null,
      minConnectorVersion ? `min connector ${minConnectorVersion}` : null,
    ].filter(Boolean);
    return {
      skew: false,
      detectable: true,
      youAreOn,
      siteNeeds: bits.join(", ") || null,
      detail: `No skew detected. You are on ${youAreOn}; site reports ${bits.join(", ")}.`,
      nextFix: null,
    };
  }

  return {
    skew: false,
    detectable: false,
    youAreOn,
    siteNeeds: null,
    detail: `You are on ${youAreOn}. This site did not report a Sentinel/connector version, so skew was not checked.`,
    nextFix: null,
  };
}

/**
 * Doctor/wizard check row for a version-skew result.
 * @param {ReturnType<typeof detectVersionSkew>} report
 * @returns {{id: string, title: string, status: "pass"|"fail"|"skipped", detail: string, nextFix: string|null}}
 */
export function versionSkewCheck(report) {
  if (!report.detectable) {
    return {
      id: "version_skew",
      title: "Connector / site version skew",
      status: "skipped",
      detail: report.detail,
      nextFix: null,
    };
  }
  if (report.skew) {
    return {
      id: "version_skew",
      title: "Connector / site version skew",
      status: "fail",
      detail: report.detail,
      nextFix: report.nextFix,
    };
  }
  return {
    id: "version_skew",
    title: "Connector / site version skew",
    status: "pass",
    detail: report.detail,
    nextFix: null,
  };
}

/**
 * @param {...*} values
 * @returns {string|null}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
