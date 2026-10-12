/**
 * T9 (DEV-840): an unsupported MCP-Protocol-Version is 400 before dispatch.
 *
 * Mutant: protocolVersionSupportedFn always returns true, so the request
 * reaches the modern handler (Ch increments) even though the SDK may still
 * refuse the version.
 */

import { defineCase } from "../harness/case.js";
import { expectNoDispatch, expectTransportDenied } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T9",
  title: "unsupported protocol version is 400 before dispatch",
  async run(h) {
    const token = await h.tokenFor("A");
    const request = modernPost("tools/list");
    request.headers["mcp-protocol-version"] = "2099-01-01";
    const body = JSON.parse(request.body);
    body.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    request.body = JSON.stringify(body);
    const res = await h.send(request, { token });
    expectTransportDenied(h, "unsupported protocol version", res, { status: 400, code: -32022 });
    expectNoDispatch(h, "unsupported protocol version");
  },
});
