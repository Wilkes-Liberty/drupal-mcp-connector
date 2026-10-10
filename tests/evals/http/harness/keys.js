/**
 * Synthetic signing keys, generated at test time and held in memory only.
 * Nothing here is written to disk or derived from a real credential.
 */

import { exportJWK, generateKeyPair } from "jose";

/**
 * @param {string} [alg] JOSE algorithm (ES256 or RS256).
 * @param {string} [kid]
 * @returns {Promise<{alg: string, kid: string, privateKey: CryptoKey, publicJwk: object}>}
 */
export async function generateSigningKey(alg = "ES256", kid = `eval-${alg.toLowerCase()}-1`) {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { alg, kid, privateKey, publicJwk };
}
