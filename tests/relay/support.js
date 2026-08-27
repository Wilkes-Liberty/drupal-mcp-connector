/**
 * Shared fixtures for the relay edge/agent battery (#232).
 *
 * Hostnames are RFC 2606/6761 reserved names only. The issuer fixture serves
 * RFC 8414 discovery and JWKS entirely through an injected fetch — no real
 * network. Channel credentials live in a temp file exercising the product
 * store, including its mtime-based hot reload.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const ISSUER = "https://idp.test";
export const AUDIENCE = "https://edge.test/mcp";

/** JWKS + discovery served through an injected fetch; signer for test JWTs. */
export async function createIssuerFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "relay-test";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const routes = new Map([
    [`${ISSUER}/.well-known/oauth-authorization-server`,
      { issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }],
    [`${ISSUER}/jwks`, { keys: [jwk] }],
  ]);

  async function fetchFn(input) {
    const url = String(input instanceof Request ? input.url : input);
    const body = routes.get(url.split("?")[0]);
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async function signToken({
    clientId = "client-a",
    scope = "mcp_read",
    sub = "northbound-agent",
    jti,
    issuer = ISSUER,
    audience = AUDIENCE,
    exp = "5m",
    claims = {},
  } = {}) {
    return new SignJWT({ scope, azp: clientId, ...(jti ? { jti } : {}), ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "relay-test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(exp)
      .setSubject(sub)
      .sign(privateKey);
  }

  return { fetchFn, signToken };
}

export function sha256hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Temp-file channel credential fixture. `write` bumps mtime deterministically
 * so the store's hot reload always observes the change.
 */
export function createChannelFile() {
  const dir = mkdtempSync(join(tmpdir(), "relay-232-"));
  const filePath = join(dir, "channel-credentials.json");
  let clock = 1_700_000_000;
  return {
    dir,
    filePath,
    write(agents) {
      writeFileSync(filePath, JSON.stringify({ agents }));
      clock += 10;
      utimesSync(filePath, clock, clock);
    },
  };
}

/** Lab-pattern connection ledger (DEV-293) for outbound-only assertions. */
export function createConnectionLedger() {
  const listens = [];
  const connects = [];
  return {
    listens,
    connects,
    recordListen(role, address) {
      listens.push({ role, host: address.host, port: address.port });
    },
    recordConnect(role, address) {
      connects.push({ role, host: address.host, port: address.port });
    },
  };
}

/** Loopback recording stub standing in for the tenant's private Drupal. */
export async function startRecordingStub() {
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
