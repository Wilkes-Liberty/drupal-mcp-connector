/**
 * Staging twins of the synthetic deny / allow cases (DEV-866 increment 3).
 *
 * Read-only HTTP against a real Sentinel + Paladin endpoint. Mutants do
 * not apply remotely; the synthetic pack already pins each deny to a
 * killed mutant. This file is loaded only by `npm run eval:http:staging`.
 */

import { defineCase } from "../../harness/case.js";
import { expectAllowed, expectEqual, expectRefused, expectTransportDenied } from "../../harness/assert.js";
import { modernPost } from "../../harness/requests.js";
import { buildStagingHarness } from "../../harness/staging.js";

const EVIL_ORIGIN = "https://evil.example";

/**
 * Staging cases share defineCase but replace the local harness. Mutants
 * stay empty: a remote Sentinel cannot be patched from this repo.
 *
 * @param {object} definition
 */
function defineStagingCase(definition) {
  const { run, ...rest } = definition;
  defineCase({
    ...rest,
    needsHarness: false,
    mutants: [],
    async run(h) {
      const remote = await buildStagingHarness();
      remote.assertions = h.assertions;
      try {
        await run(remote);
        h.assertions = remote.assertions;
      } finally {
        await remote.close();
      }
    },
  });
}

defineStagingCase({
  id: "T1",
  title: "staging: missing identity is 401",
  async run(h) {
    const res = await h.send(modernPost("tools/list"));
    expectRefused(h, "missing identity", res);
  },
});

defineStagingCase({
  id: "T2a",
  title: "staging: wrong-audience bearer is 401",
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: h.tokens.wrongAudience });
    expectRefused(h, "wrong audience", res, {
      error: "invalid_token",
      description: "Audience mismatch",
    });
  },
});

defineStagingCase({
  id: "T2e",
  title: "staging: expired bearer is 401",
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: h.tokens.expired });
    expectRefused(h, "expired token", res, {
      error: "invalid_token",
      description: "Token has expired",
    });
  },
});

defineStagingCase({
  id: "T2s",
  title: "staging: insufficient-scope bearer is 403",
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: h.tokens.insufficientScope });
    expectRefused(h, "insufficient scope", res, {
      status: 403,
      error: "insufficient_scope",
      description: "Required scope is missing",
      body: "Forbidden",
    });
  },
});

defineStagingCase({
  id: "T2m",
  title: "staging: non-member bearer is 403",
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: h.tokens.nonMember });
    expectEqual(h, "non-member: status", res.status, 403);
    expectEqual(h, "non-member: body", res.text, "Forbidden");
  },
});

defineStagingCase({
  id: "T11",
  title: "staging: disallowed Origin is 403",
  async run(h) {
    const request = modernPost("tools/list");
    request.headers.origin = EVIL_ORIGIN;
    const res = await h.send(request, { token: h.tokens.read });
    expectTransportDenied(h, "disallowed Origin", res, { status: 403 });
  },
});

defineStagingCase({
  id: "T7",
  title: "staging allow twin: legitimate mcp_read is served",
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: h.tokens.read });
    expectAllowed(h, "mcp_read tools/list", res);
  },
});
