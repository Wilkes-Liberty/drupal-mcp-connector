/**
 * The only door from the harness to connector code. Modules load from
 * `src/` by default; `npm run eval:mutants` points `EVAL_HTTP_SRC` at a
 * scratch copy of `src/` after applying a declared source patch. `src/`
 * itself gains no flag, variable, or branch: the override lives here, in
 * `tests/`.
 */

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SRC = fileURLToPath(new URL("../../../../src/", import.meta.url));

/** Directory the connector modules are loaded from. */
export const SRC_DIR = process.env.EVAL_HTTP_SRC ? resolve(process.env.EVAL_HTTP_SRC) : DEFAULT_SRC;

const load = (relative) => import(pathToFileURL(join(SRC_DIR, relative)).href);

export const httpAuth = await load("lib/http-auth.js");
export const httpAudit = await load("lib/http-audit.js");
export const httpHandler = await load("lib/http-handler.js");
export const httpsStartup = await load("lib/https-startup.js");
export const mcpServer = await load("lib/mcp-server.js");
export const principal = await load("lib/principal.js");
export const rateLimit = await load("lib/rate-limit.js");
export const toolScopes = await load("lib/tool-scopes.js");
export const relayEdge = await load("lib/relay/edge.js");
export const usage = await load("lib/usage.js");
export const evidence = await load("lib/evidence.js");
export const anchor = await load("lib/anchor.js");
export const tools = await load("tools/index.js");
