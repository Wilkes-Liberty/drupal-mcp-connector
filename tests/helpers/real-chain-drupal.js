/**
 * Loopback Drupal stand-in for DEV-1019 stdio catalog tests.
 * Token, readiness, then initialize / initialized / tools/list, plus prompts.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Shared with the catalog-chain test so both fixtures stay on the same delays.
export const TOKEN_MS = 500;
export const READY_MS = 200;
export const MCP_MS = 2_500;

const SCHEMA = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * @param {number} siteCount
 * @returns {Promise<{
 *   baseUrl: string,
 *   close: () => Promise<void>,
 *   counts: { token: number, readiness: number, mcp: object },
 * }>}
 */
export async function startRealChainDrupal(siteCount = 13) {
  const counts = {
    token: 0,
    readiness: 0,
    mcp: { initialize: 0, initialized: 0, toolsList: 0, promptsList: 0, promptsGet: 0 },
  };
  const server = createServer(async (req, res) => {
    const url = String(req.url || "");
    try {
      if (url.includes("/oauth/token")) {
        counts.token += 1;
        await delay(TOKEN_MS);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "tok-x", expires_in: 3600 }));
        return;
      }
      if (url.includes("/drupal-mcp/readiness")) {
        counts.readiness += 1;
        await delay(READY_MS);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ contract_ready: true }));
        return;
      }
      if (url.includes("/mcp")) {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        await delay(MCP_MS);
        if (body.method === "initialize") {
          counts.mcp.initialize += 1;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${counts.mcp.initialize}`,
          });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }));
          return;
        }
        if (body.method === "notifications/initialized") {
          counts.mcp.initialized += 1;
          res.writeHead(202);
          res.end();
          return;
        }
        if (body.method === "tools/list") {
          counts.mcp.toolsList += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "tool_api.item", inputSchema: SCHEMA, outputSchema: SCHEMA }] },
          }));
          return;
        }
        if (body.method === "prompts/list") {
          counts.mcp.promptsList += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { prompts: [{ name: "review", description: "Remote." }] },
          }));
          return;
        }
        if (body.method === "prompts/get") {
          counts.mcp.promptsGet += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { messages: [{ role: "user", content: { type: "text", text: "Call {tool:item}." } }] },
          }));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counts,
    siteCount,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/**
 * In-process site configs for `siteCount` module sites on `baseUrl`.
 *
 * @param {string} baseUrl
 * @param {number} [siteCount]
 * @returns {object[]}
 */
export function catalogSiteConfigs(baseUrl, siteCount = 13) {
  const sites = [];
  for (let i = 0; i < siteCount; i++) {
    sites.push({
      _name: `estate${i}`,
      baseUrl,
      requireGovernance: true,
      security: { preset: "development", readOnly: false },
      oauth: {
        tokenUrl: "/oauth/token",
        clientId: "c",
        clientSecret: "s",
        grant: "client_credentials",
        scopes: ["mcp_config"],
      },
      serverTools: {
        url: "/mcp",
        modules: {
          namespace: `ns${i}`,
          tools: {
            item: {
              name: "tool_api.item",
              operation: "read",
              scope: "module_access",
              capabilities: [],
            },
          },
          workflows: {
            review: {
              description: "Review.",
              readOnly: true,
              tools: ["item"],
              instructions: "Call {tool:item}.",
            },
          },
        },
      },
    });
  }
  return sites;
}

/**
 * Network principal with module scopes for every named site.
 *
 * @param {string[]} siteNames
 * @returns {object}
 */
export function catalogListingIdentity(siteNames) {
  return {
    iss: "https://idp.example/realms/agents",
    sub: "catalog-operator",
    azp: "catalog-agent",
    clientId: "catalog-agent",
    scopes: ["module_access"],
    sites: siteNames,
  };
}

/**
 * Write a temp connector config for `siteCount` module sites on `baseUrl`.
 *
 * @param {string} root
 * @param {string} baseUrl
 * @param {number} [siteCount]
 * @returns {void}
 */
export function writeCatalogConfig(root, baseUrl, siteCount = 13) {
  const sites = {};
  for (const site of catalogSiteConfigs(baseUrl, siteCount)) {
    const { _name, ...rest } = site;
    sites[_name] = rest;
  }
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "config.json"), JSON.stringify({
    defaultSite: "estate0",
    catalogDiscovery: {
      siteDeadlineMs: 4000,
      unnotifiedListWaitMs: 20000,
      cacheTtlMs: 600000,
      negativeTtlMs: 5000,
      concurrency: 16,
    },
    sites,
  }, null, 2));
}

/**
 * HTTP server that accepts connections and never answers.
 *
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
export async function startHangingDrupal() {
  const server = createServer(() => {
    // Leave the request hanging so catalog warmup stays in flight.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
