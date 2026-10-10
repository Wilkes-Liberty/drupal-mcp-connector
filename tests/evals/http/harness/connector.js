/**
 * The only door from the harness to connector code. Modules load from
 * `src/` by default; the runner may point `EVAL_HTTP_SRC` at a scratch copy of
 * `src/` (increment 2 applies mutant patches there). `src/` itself gains no
 * flag, variable, or branch: the override lives here, in `tests/`.
 */

import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SRC = fileURLToPath(new URL("../../../../src/", import.meta.url));

/** Directory the connector modules are loaded from. */
export const SRC_DIR = process.env.EVAL_HTTP_SRC ? resolve(process.env.EVAL_HTTP_SRC) : DEFAULT_SRC;

const load = (relative) => import(pathToFileURL(join(SRC_DIR, relative)).href);

export const httpAuth = await load("lib/http-auth.js");
export const httpHandler = await load("lib/http-handler.js");
export const mcpServer = await load("lib/mcp-server.js");
export const principal = await load("lib/principal.js");
export const rateLimit = await load("lib/rate-limit.js");
