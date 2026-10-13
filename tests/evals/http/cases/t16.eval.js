/**
 * T16: unauthenticated allow twins for `/health` and RFC 9728 metadata.
 * Deny twin: T1 (those paths are the only unauthenticated routes).
 *
 * Mutant: isUnauthenticatedRouteFn always false, so both become 401.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual } from "../harness/assert.js";
import { healthGet, resourceMetadataGet } from "../harness/requests.js";

defineCase({
  id: "T16",
  title: "health and resource metadata stay reachable without a token",
  mutants: [
    { id: "T16", expectedLabel: "GET /health: status" },
  ],
  async run(h) {
    const health = await h.send(healthGet());
    expectAllowed(h, "GET /health", health);
    expectEqual(h, "GET /health body", JSON.parse(health.text), { status: "ok" });

    // Probe the path the 401 challenges advertise (`…/oauth-protected-resource/mcp`
    // for the `/mcp` resource), not the bare root, so a regression in the
    // advertised URL cannot leave this case green.
    const metadataPath = h.resourceMetadataUrl
      ? new URL(h.resourceMetadataUrl).pathname
      : "/.well-known/oauth-protected-resource";
    expectEqual(h, "advertised metadata path is resource-specific", metadataPath.startsWith("/.well-known/oauth-protected-resource/"), true);
    const metadata = await h.send(resourceMetadataGet(metadataPath));
    expectAllowed(h, "GET resource metadata", metadata);
    expectEqual(h, "GET resource metadata has resource", typeof JSON.parse(metadata.text).resource, "string");
  },
});
