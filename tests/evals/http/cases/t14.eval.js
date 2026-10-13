/**
 * T14 (DEV-840): a JSON-RPC batch array is 400 before classification.
 * Allow twin: T7's single-request POST tools/list.
 *
 * Mutant: isJsonRpcBatchFn always false, so the batch reaches a handler.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectTransportDenied } from "../harness/assert.js";
import { jsonRpcBatch } from "../harness/requests.js";

defineCase({
  id: "T14",
  title: "JSON-RPC batch is 400 before dispatch",
  mutants: [
    { id: "T14", expectedLabel: "JSON-RPC batch: JSON-RPC code" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const res = await h.send(jsonRpcBatch(), { token });
    expectTransportDenied(h, "JSON-RPC batch", res, { status: 400, code: -32600 });
    expectHandlerUnreached(h, "JSON-RPC batch");
    expectNoDispatch(h, "JSON-RPC batch");
  },
});
