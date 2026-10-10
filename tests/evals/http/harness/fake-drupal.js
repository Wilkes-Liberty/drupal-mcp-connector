/**
 * Fake loopback Drupal upstream.
 *
 * A `node:http` server on 127.0.0.1 (port 0) that answers canned JSON:API-shaped
 * reads per site, with one synthetic canary per tenant planted in every
 * response. It records every request per tenant (Cu) and keeps only the
 * presence of a credential header, never its value. It opens no other socket.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** Fixed seed so canaries are reproducible and obviously synthetic. */
const CANARY_SEED = "dev-866-http-eval-harness";

/**
 * Deterministic per-tenant canary: a fake secret and a fake internal hostname.
 * @param {string} tenant
 * @returns {{secret: string, host: string}}
 */
export function canaryFor(tenant) {
  const digest = createHash("sha256").update(`${CANARY_SEED}:${tenant}`).digest("hex").slice(0, 10);
  return {
    secret: `CANARY-SECRET-${tenant}-${digest}`,
    host: `internal-${tenant.toLowerCase()}-${digest}.canary.invalid`,
  };
}

/**
 * @param {Array<{tenant: string, site: string}>} tenants One site per tenant.
 * @returns {Promise<{baseUrl: (site: string) => string, log: object[], count: (tenant?: string) => number, canaries: Record<string, {secret: string, host: string}>, close: () => Promise<void>}>}
 */
export async function createFakeDrupal(tenants) {
  const bySite = new Map(tenants.map((entry) => [entry.site, entry.tenant]));
  const canaries = Object.fromEntries(tenants.map((entry) => [entry.tenant, canaryFor(entry.tenant)]));
  const log = [];

  const server = createServer((req, res) => {
    const [, site, ...rest] = String(req.url || "").split("?")[0].split("/");
    const tenant = bySite.get(site);
    log.push({
      tenant: tenant ?? null,
      site,
      method: req.method,
      path: `/${rest.join("/")}`,
      hasCredential: Boolean(req.headers.authorization),
    });
    if (!tenant || req.method !== "GET" || rest.join("/") !== "jsonapi/node/article") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ errors: [{ status: "404" }] }));
      return;
    }
    const canary = canaries[tenant];
    res.writeHead(200, { "content-type": "application/vnd.api+json" }).end(JSON.stringify({
      data: [{
        type: "node--article",
        id: `${tenant.toLowerCase()}-article-1`,
        attributes: { title: `Draft notes ${canary.secret}`, source_host: canary.host },
      }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    canaries,
    log,
    baseUrl: (site) => `http://127.0.0.1:${port}/${site}`,
    /** Requests that reached the upstream, for one tenant or all (Cu). */
    count: (tenant) => log.filter((entry) => tenant === undefined || entry.tenant === tenant).length,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
