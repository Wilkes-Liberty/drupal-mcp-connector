/**
 * Grant-layer denial for a valid mcp_read token with no site grants.
 *
 * Covers prod-realm users who are not staff: the grant table names staff
 * clients only, the bearer verifies, and tools/call is still refused
 * after identity resolution (DEV-848). Distinct from T4b (no grant table).
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildHarness } from "../evals/http/harness/build.js";
import { modernPost } from "../evals/http/harness/requests.js";

let h;
afterEach(async () => { await h?.close(); h = undefined; });

describe("grant layer over HTTP", () => {
  it("denies a valid mcp_read token when the principal has no site grants", async () => {
    h = await buildHarness();
    const token = await h.issuer.mint({
      sub: "prod-realm-user",
      azp: "client-ungranted",
      scope: "mcp_connect mcp_read",
      jti: "grant-layer-ungranted-1",
    });

    const list = await h.send(modernPost("tools/list"), { token });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).result.tools.map((tool) => tool.name)).toEqual([]);

    const call = await h.send(modernPost(
      "tools/call",
      { name: "drupal_list_nodes", arguments: {} },
      { name: "drupal_list_nodes" },
    ), { token });
    expect(call.status).toBe(200);
    expect(call.headers["www-authenticate"]).toBeUndefined();
    const body = JSON.parse(call.text);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toMatch(/Access denied:.*[Nn]ot entitled/);
    expect(body.result?.content?.[0]?.text).not.toMatch(/site-a|site-b/i);

    expect(h.fake.count("A")).toBe(0);
    expect(h.fake.count("B")).toBe(0);
    expect(h.dispatchCounts().ct).toBe(0);
    expect(h.dispatchCounts().cu).toBe(0);
  });
});
