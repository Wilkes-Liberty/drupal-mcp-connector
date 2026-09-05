/**
 * Independent evidence notary (#261).
 *
 * Ed25519 inclusions over a receipt digest. The private key never lives on
 * the relay edge; verification needs only the pinned public key and the
 * inclusion. This is not Audit Chain, not a Drupal table, and not a
 * hosted-service claim. A shared-host lab process is a named residual —
 * production placement on a separately administered host is not chosen here.
 */

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { createServer as createHttpServer } from "node:http";

const DIGEST = /^[0-9a-f]{64}$/i;
const SCHEMA = "sentinel-anchor-v1";
const ALGORITHM = "Ed25519";

/**
 * @param {import("node:crypto").KeyObject} publicKey
 * @returns {string} SPKI DER, standard base64.
 */
export function pinPublicKey(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/**
 * @param {string} pin
 * @returns {import("node:crypto").KeyObject}
 */
export function loadPinnedPublicKey(pin) {
  if (typeof pin !== "string" || !pin.trim()) {
    throw new TypeError("Pinned public key is required.");
  }
  return createPublicKey({
    key: Buffer.from(pin.trim(), "base64"),
    type: "spki",
    format: "der",
  });
}

/**
 * @param {import("node:crypto").KeyObject} publicKey
 * @returns {string}
 */
export function keyIdOf(publicKey) {
  return createHash("sha256").update(pinPublicKey(publicKey)).digest("hex").slice(0, 16);
}

/**
 * Mint a notary keypair. The private key is for the notary process only.
 * @returns {{publicKey: import("node:crypto").KeyObject, privateKey: import("node:crypto").KeyObject, keyId: string, publicPin: string}}
 */
export function generateNotaryKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    privateKey,
    keyId: keyIdOf(publicKey),
    publicPin: pinPublicKey(publicKey),
  };
}

/**
 * Canonical bytes the signature covers. Signature itself is excluded.
 * @param {{anchorId: string, receiptDigest: string, signedAt: string, keyId: string}} inclusion
 * @returns {Buffer}
 */
export function canonicalInclusion(inclusion) {
  return Buffer.from(
    `v1\n${inclusion.anchorId}\n${inclusion.receiptDigest}\n${inclusion.signedAt}\n${inclusion.keyId}`,
    "utf8",
  );
}

/**
 * @param {import("node:crypto").KeyObject|string} publicKeyOrPin
 * @param {object} inclusion
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function verifyInclusion(publicKeyOrPin, inclusion) {
  if (!inclusion || typeof inclusion !== "object" || Array.isArray(inclusion)) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  if (inclusion.schema !== SCHEMA || inclusion.algorithm !== ALGORITHM) {
    return { ok: false, reason: "unsupported_inclusion" };
  }
  if (typeof inclusion.anchorId !== "string" || !inclusion.anchorId) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  if (typeof inclusion.receiptDigest !== "string" || !DIGEST.test(inclusion.receiptDigest)) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  if (typeof inclusion.signedAt !== "string" || !inclusion.signedAt) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  if (typeof inclusion.keyId !== "string" || !inclusion.keyId) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  if (typeof inclusion.signature !== "string" || !inclusion.signature) {
    return { ok: false, reason: "malformed_inclusion" };
  }
  let key;
  try {
    key = typeof publicKeyOrPin === "string" ? loadPinnedPublicKey(publicKeyOrPin) : publicKeyOrPin;
  } catch {
    return { ok: false, reason: "unpinned_key" };
  }
  if (keyIdOf(key) !== inclusion.keyId) {
    return { ok: false, reason: "key_mismatch" };
  }
  let signature;
  try {
    signature = Buffer.from(inclusion.signature, "base64");
  } catch {
    return { ok: false, reason: "malformed_inclusion" };
  }
  try {
    if (!verify(null, canonicalInclusion(inclusion), key, signature)) {
      return { ok: false, reason: "bad_signature" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * In-process notary. Holds the private key. The edge must never receive it.
 *
 * @param {object} [options]
 * @param {import("node:crypto").KeyObject} [options.privateKey]
 * @param {import("node:crypto").KeyObject} [options.publicKey]
 * @param {string} [options.keyId]
 * @param {() => Date} [options.now]
 * @returns {object}
 */
export function createNotary({
  privateKey,
  publicKey,
  keyId,
  now = () => new Date(),
} = generateNotaryKeys()) {
  if (!privateKey || !publicKey) {
    throw new TypeError("createNotary requires an Ed25519 keypair.");
  }
  const id = keyId || keyIdOf(publicKey);
  const publicPin = pinPublicKey(publicKey);
  const records = [];

  return Object.freeze({
    keyId: id,
    publicPin,
    /**
     * @param {string} digest sha256 hex of the minimized execution.
     * @returns {object}
     */
    include(digest) {
      const receiptDigest = typeof digest === "string" ? digest.trim().toLowerCase() : "";
      if (!DIGEST.test(receiptDigest)) {
        throw new TypeError("Notary include() requires a SHA-256 hex digest.");
      }
      const unsigned = {
        schema: SCHEMA,
        anchorId: randomUUID(),
        receiptDigest,
        signedAt: now().toISOString(),
        keyId: id,
        algorithm: ALGORITHM,
      };
      const signature = sign(null, canonicalInclusion(unsigned), privateKey).toString("base64");
      const inclusion = Object.freeze({ ...unsigned, signature });
      records.push(inclusion);
      return inclusion;
    },
    /** @returns {object[]} */
    records() {
      return records.slice();
    },
  });
}

function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  }).end(payload);
}

/**
 * Loopback HTTP notary. POST /anchor {digest} → inclusion. GET /keys → pin.
 *
 * @param {object} options
 * @param {ReturnType<typeof createNotary>} options.notary
 * @param {string} [options.bindHost]
 * @param {number} [options.port]
 * @returns {Promise<{url: string, port: number, close: Function}>}
 */
export function startAnchorServer({ notary, bindHost = "127.0.0.1", port = 0 }) {
  if (!notary || typeof notary.include !== "function") {
    throw new TypeError("startAnchorServer requires a notary.");
  }
  const server = createHttpServer((req, res) => {
    const path = String(req.url || "/").split("?")[0];
    if (req.method === "GET" && path === "/keys") {
      jsonResponse(res, 200, {
        algorithm: ALGORITHM,
        keyId: notary.keyId,
        publicKey: notary.publicPin,
      });
      return;
    }
    if (req.method === "POST" && path === "/anchor") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          jsonResponse(res, 400, { error: "malformed" });
          return;
        }
        try {
          jsonResponse(res, 200, notary.include(body?.digest));
        } catch {
          jsonResponse(res, 400, { error: "invalid_digest" });
        }
      });
      return;
    }
    res.writeHead(404).end("Not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      const address = server.address();
      resolve({
        url: `http://${address.address}:${address.port}`,
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Edge-side client. Verifies every inclusion against the pinned public key.
 * Never learns or holds the notary private key.
 *
 * @param {object} options
 * @param {string} [options.url]
 * @param {string} options.publicKey Pinned SPKI base64.
 * @param {(digest: string) => object|Promise<object>} [options.submit]
 * @param {typeof fetch} [options.fetchFn]
 * @param {number} [options.timeoutMs]
 * @returns {{submit: Function, publicPin: string}}
 */
export function createAnchorClient({
  url = "",
  publicKey,
  submit = null,
  fetchFn = fetch,
  timeoutMs = 2000,
} = {}) {
  const key = loadPinnedPublicKey(publicKey);
  const publicPin = pinPublicKey(key);
  const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000;

  async function post(digest) {
    if (typeof submit === "function") {
      return submit(digest);
    }
    const base = String(url || "").replace(/\/+$/, "");
    if (!base) {
      return { ok: false, reason: "anchor_unavailable" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchFn(`${base}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: "anchor_unavailable" };
      return await response.json();
    } catch {
      return { ok: false, reason: "anchor_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    publicPin,
    /**
     * @param {string} digest
     * @returns {Promise<{ok: true, inclusion: object}|{ok: false, reason: string}>}
     */
    async submit(digest) {
      const receiptDigest = typeof digest === "string" ? digest.trim().toLowerCase() : "";
      if (!DIGEST.test(receiptDigest)) {
        return { ok: false, reason: "invalid_digest" };
      }
      const raw = await post(receiptDigest);
      if (raw && raw.ok === false && raw.reason) return raw;
      const checked = verifyInclusion(key, raw);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      if (raw.receiptDigest !== receiptDigest) {
        return { ok: false, reason: "digest_mismatch" };
      }
      return { ok: true, inclusion: raw };
    },
  });
}
