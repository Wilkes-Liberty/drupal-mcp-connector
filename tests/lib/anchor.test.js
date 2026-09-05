/**
 * Independent evidence notary (#261) — pure rules.
 *
 * The private key never leaves the notary. Verification uses only the pinned
 * public key. Tamper, a foreign key, and a digest swap all fail. Every deny
 * here was watched failing before the notary existed.
 */

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAnchorClient,
  createNotary,
  generateNotaryKeys,
  pinPublicKey,
  startAnchorServer,
  verifyInclusion,
} from "../../src/lib/anchor.js";

const DIGEST_A = "ab".repeat(32);
const DIGEST_B = "cd".repeat(32);

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

describe("createNotary / verifyInclusion", () => {
  it("issues an inclusion another process can verify with only the public pin", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const inclusion = notary.include(DIGEST_A);
    expect(inclusion.receiptDigest).toBe(DIGEST_A);
    expect(inclusion.algorithm).toBe("Ed25519");
    expect(inclusion.keyId).toBe(keys.keyId);
    expect(verifyInclusion(keys.publicPin, inclusion)).toEqual({ ok: true });
    expect(verifyInclusion(keys.publicKey, inclusion)).toEqual({ ok: true });
  });

  it("rejects a tampered digest, a swapped signature, and a foreign key", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const inclusion = notary.include(DIGEST_A);
    expect(verifyInclusion(keys.publicPin, { ...inclusion, receiptDigest: DIGEST_B }))
      .toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyInclusion(keys.publicPin, { ...inclusion, signature: "AAAA" }))
      .toEqual({ ok: false, reason: "bad_signature" });
    const stranger = generateNotaryKeys();
    expect(verifyInclusion(stranger.publicPin, inclusion))
      .toEqual({ ok: false, reason: "key_mismatch" });
    const forged = createNotary(stranger).include(DIGEST_A);
    expect(verifyInclusion(keys.publicPin, forged))
      .toEqual({ ok: false, reason: "key_mismatch" });
  });

  it("an RSA key the edge already holds cannot mint a valid inclusion", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const inclusion = notary.include(DIGEST_A);
    const edgeKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => pinPublicKey(edgeKey.publicKey)).not.toThrow();
    expect(verifyInclusion(pinPublicKey(edgeKey.publicKey), inclusion))
      .toEqual({ ok: false, reason: "key_mismatch" });
  });
});

describe("createAnchorClient", () => {
  it("accepts a notary inclusion and refuses one the pin cannot verify", async () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const client = createAnchorClient({
      publicKey: keys.publicPin,
      submit: (digest) => notary.include(digest),
    });
    const ok = await client.submit(DIGEST_A);
    expect(ok.ok).toBe(true);
    expect(ok.inclusion.receiptDigest).toBe(DIGEST_A);

    const stranger = createNotary(generateNotaryKeys());
    const hostile = createAnchorClient({
      publicKey: keys.publicPin,
      submit: (digest) => stranger.include(digest),
    });
    const denied = await hostile.submit(DIGEST_A);
    expect(denied).toEqual({ ok: false, reason: "key_mismatch" });
  });

  it("posts to a loopback notary and verifies against the pin, not the response host", async () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const server = await startAnchorServer({ notary });
    closers.push(() => server.close());
    const client = createAnchorClient({
      url: server.url,
      publicKey: keys.publicPin,
    });
    const ok = await client.submit(DIGEST_A);
    expect(ok.ok).toBe(true);
    expect(ok.inclusion.anchorId).toBeTruthy();
    expect(verifyInclusion(keys.publicPin, ok.inclusion)).toEqual({ ok: true });
  });
});
