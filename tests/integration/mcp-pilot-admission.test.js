/**
 * Failure modes before implementation: valid but unapproved subject/client;
 * missing or ambiguous identity; accidental empty-policy bypass; malformed
 * policy; policy edits after startup; and admission bypassing live revocation.
 * Real loopback HTTP and SDK dispatch, synthetic issuer/upstream only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveInboundAuthConfig } from "../../src/lib/http-auth.js";
import { buildHarness } from "../evals/http/harness/build.js";
import {
  healthGet, legacyInitialize, modernPost, resourceMetadataGet, sessionRequest,
} from "../evals/http/harness/requests.js";

const APPROVED = [{ clientId: "client-a", sub: "client-a-subject" }];
let h;
afterEach(async () => { await h?.close(); h = undefined; });

describe("explicit principal admission over HTTP", () => {
  it("refuses unapproved identities before session allocation, dispatch or upstream access", async () => {
    h = await buildHarness({ allowedPrincipals: APPROVED });
    const identities = [
      { sub: "another-user" },
      { azp: "another-client" },
      { sub: undefined },
      { azp: undefined },
      { azp: ["client-a"] },
      { client_id: "conflicting-client" },
    ];
    let count = 0;
    for (const extra of identities) {
      const token = await h.tokenFor("A", undefined, extra);
      for (const request of [legacyInitialize(), modernPost("tools/list"), sessionRequest("DELETE")]) {
        const result = await h.send(request, { token });
        expect(result.status).toBe(403);
        expect(result.headers["mcp-session-id"]).toBeUndefined();
        expect(result.text).toBe("Forbidden");
        expect(JSON.stringify(result)).not.toContain(token);
        count++;
      }
    }
    await h.waitServerSide(count);
    expect(h.dispatchCounts()).toEqual({ ch: 0, ct: 0, cu: 0 });
    expect(h.tap.serverSide.every((entry) => !entry.bodyRead)).toBe(true);
    expect(h.auditRows).toHaveLength(count);
    expect(h.auditRows.every((row) => row.status === 403 && row.code === "forbidden")).toBe(true);
  });

  it("admits the exact pair, retains tool scope restrictions and accepts RFC7662 client_id", async () => {
    h = await buildHarness({ allowedPrincipals: APPROVED });
    const token = await h.tokenFor("A");
    const init = await h.send(legacyInitialize(), { token });
    expect(init.status).toBe(200);
    expect(init.headers["mcp-session-id"]).toBeTruthy();
    const listed = await h.send(modernPost("tools/list"), { token });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain("drupal_list_nodes");
    expect(listed.text).not.toContain("drupal_create_node");
    const read = await h.send(modernPost("tools/call", { name: "drupal_list_nodes", arguments: {} }, { name: "drupal_list_nodes" }), { token });
    expect(read.status).toBe(200);
    expect(h.dispatchCounts().cu).toBe(1);
    const write = await h.send(modernPost("tools/call", { name: "drupal_create_node", arguments: {} }, { name: "drupal_create_node" }), { token });
    expect(write.status).toBe(200);
    expect(JSON.parse(write.text).result.isError).toBe(true);
    expect(h.dispatchCounts().ct).toBe(1);
    expect(h.dispatchCounts().cu).toBe(1);
    const rfc7662 = await h.tokenFor("A", undefined, { azp: undefined, client_id: "client-a" });
    expect((await h.send(modernPost("tools/list"), { token: rfc7662 })).status).toBe(200);
  });

  it("an explicit empty list closes authenticated admission while metadata stays public", async () => {
    h = await buildHarness({ allowedPrincipals: [] });
    const token = await h.tokenFor("A");
    expect((await h.send(legacyInitialize(), { token })).status).toBe(403);
    expect((await h.send(healthGet())).status).toBe(200);
    expect((await h.send(resourceMetadataGet())).status).toBe(200);
    expect(h.dispatchCounts()).toEqual({ ch: 0, ct: 0, cu: 0 });
  });

  it("an absent policy preserves admission for authenticated identities", async () => {
    h = await buildHarness();
    for (const tenant of ["A", "B"]) {
      const token = await h.tokenFor(tenant);
      expect((await h.send(modernPost("tools/list"), { token })).status).toBe(200);
    }
  });

  it("cannot bypass issuer, audience, scope, revocation or issuer-outage checks", async () => {
    h = await buildHarness({ allowedPrincipals: APPROVED });
    for (const extra of [{ iss: "https://other.invalid" }, { aud: "other-resource" }]) {
      const token = await h.tokenFor("A", undefined, extra);
      expect((await h.send(legacyInitialize(), { token })).status).toBe(401);
    }
    const noScope = await h.tokenFor("A", []);
    expect((await h.send(legacyInitialize(), { token: noScope })).status).toBe(403);
    const token = await h.tokenFor("A");
    h.issuer.revoke(token);
    expect((await h.send(legacyInitialize(), { token })).status).toBe(401);
    h.issuer.setUnavailable(true);
    expect((await h.send(legacyInitialize(), { token })).status).toBe(503);
    expect(h.dispatchCounts()).toEqual({ ch: 0, ct: 0, cu: 0 });
  });

  it("takes a startup snapshot so caller mutation cannot widen admission", async () => {
    const policy = [{ ...APPROVED[0] }];
    h = await buildHarness({ allowedPrincipals: policy });
    policy[0].sub = "unapproved";
    policy.push({ clientId: "client-b", sub: "client-b-subject" });
    const first = await h.tokenFor("A", undefined, { sub: "unapproved" });
    const second = await h.tokenFor("B");
    expect((await h.send(legacyInitialize(), { token: first })).status).toBe(403);
    expect((await h.send(legacyInitialize(), { token: second })).status).toBe(403);
  });

  it.each([null, false, "client-a", {}, [null], [{}], [{ clientId: "client-a" }],
    [{ clientId: "", sub: "user" }], [{ clientId: "client-a", sub: " " }],
    [{ clientId: "client-a", sub: "user", wildcard: true }],
    [{ clientId: "*", sub: "user" }], [{ clientId: "client-a", sub: "*" }],
  ].map((policy) => [policy]))("rejects malformed admission policy %j before startup", (allowedPrincipals) => {
    expect(() => resolveInboundAuthConfig({ auth: { allowedPrincipals } }, {})).toThrow(/allowedPrincipals/);
  });
});
