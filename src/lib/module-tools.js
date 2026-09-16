/** Module-owned schemas and behavior, exposed only by explicit local tool policy. */
import { createHash } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { listServerTools, callServerTool, toolResultData } from "./server-tools.js";
import { listResolvableSiteConfigs, securityMiddleware } from "./dispatch.js";
import { getRequestIdentity, principalHasScope, resolveGrantedSites } from "./principal.js";
import { resolveSecurityConfig, SecurityError } from "./security.js";
import { assertSourceGovernance, GovernanceError } from "./governance.js";
import { DataFlowBudgetError } from "./data-flow.js";
import { toolError } from "./errors.js";
import { withResolvedTarget } from "./site-target.js";

const PREFIX = "drupal_module_";
const OPERATIONS = new Set(["read", "write", "delete"]);
const CAPABILITIES = new Map([
  ["publish", "allowPublish"], ["configRead", "allowConfigRead"],
  ["configWrite", "allowConfigWrite"], ["graphql", "allowGraphql"],
]);
const MAX_BYTES = 262144;
const MAX_TOOLS = 256;

function bounded(value, limit = MAX_BYTES) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > limit) {
    throw new SecurityError("Module tool payload exceeds the protocol ceiling.");
  }
}

function entries(sites) {
  const result = new Map();
  for (const site of sites) {
    const config = site.serverTools?.modules;
    if (!config) continue;
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(config.namespace ?? "")) {
      throw new SecurityError("Module tools require a stable namespace.");
    }
    for (const [alias, policy] of Object.entries(config.tools ?? {})) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(alias) || !policy ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(policy.name ?? "") ||
          !/^[a-z][a-z0-9_:-]{0,63}$/.test(policy.scope ?? "") ||
          !OPERATIONS.has(policy.operation) || !Array.isArray(policy.capabilities) ||
          policy.capabilities.some((cap) => !CAPABILITIES.has(cap) && cap !== "rawSql")) {
        throw new SecurityError("Invalid module tool policy.");
      }
      const name = `${PREFIX}${policy.operation}_${config.namespace}__${alias}`;
      if (result.has(name) || result.size >= MAX_TOOLS) {
        throw new SecurityError("Duplicate module namespace or excessive tool policy entries.");
      }
      result.set(name, { name, site, policy });
    }
  }
  return result;
}

function allowed(entry, identity, sites, grants) {
  const { site, policy } = entry;
  if (identity && (!principalHasScope(identity, policy.scope) ||
      !resolveGrantedSites(identity, sites, grants).some((s) => s._name === site._name))) return false;
  const sec = resolveSecurityConfig(site);
  if (policy.operation !== "read" && sec.readOnly) return false;
  if (policy.operation === "delete" && !sec.allowDestructive) return false;
  return policy.capabilities.every((cap) => cap === "rawSql"
    ? site.drushSsh?.rawSql === "governed"
    : Boolean(new Map(Object.entries(sec)).get(CAPABILITIES.get(cap))));
}

function validator(schema) {
  if (!schema || schema.type !== "object") throw new Error("Object schema required.");
  bounded(schema, 65536);
  const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true });
  addFormats(ajv);
  const check = ajv.compile(schema);
  if (check.$async) throw new Error("Async schemas are unavailable.");
  return check;
}

async function catalog(site, list) {
  // Extensions always require source governance, including development sites.
  await assertSourceGovernance({ ...site, requireGovernance: true });
  const found = new Map();
  const seen = new Set();
  let cursor;
  let bytes = 0;
  for (let page = 0; page < 16; page++) {
    const result = await list(site, cursor);
    bounded(result);
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX_BYTES || !Array.isArray(result?.tools)) throw new Error("Invalid module catalog.");
    for (const tool of result.tools) {
      if (typeof tool?.name !== "string" || found.has(tool.name) || found.size >= MAX_TOOLS) {
        throw new Error("Invalid or duplicate module tool.");
      }
      found.set(tool.name, tool);
    }
    if (result.nextCursor === undefined || result.nextCursor === null) return found;
    if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) throw new Error("Invalid catalog cursor.");
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error("Module catalog page limit exceeded.");
}

function describe(entry, remote) {
  const input = validator(remote.inputSchema);
  const output = remote.outputSchema ? validator(remote.outputSchema) : null;
  const revision = createHash("sha256").update(JSON.stringify({
    input: remote.inputSchema, output: remote.outputSchema ?? null, policy: entry.policy,
  })).digest("hex");
  return { input, output, revision, definition: {
    name: entry.name,
    description: `${String(remote.description ?? remote.name).slice(0, 4096)} [${entry.site._name}]`,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["catalogRevision", "arguments"],
      properties: {
        catalogRevision: { type: "string", const: revision },
        arguments: { ...remote.inputSchema, $id: remote.inputSchema.$id ?? `urn:module:input:${revision}` },
      },
    },
    annotations: {
      readOnlyHint: entry.policy.operation === "read",
      destructiveHint: entry.policy.operation !== "read",
      idempotentHint: false, openWorldHint: true,
    },
    ...(remote.outputSchema ? { outputSchema: {
      type: "object", required: ["result", "_target"],
      properties: {
        result: { ...remote.outputSchema, $id: remote.outputSchema.$id ?? `urn:module:output:${revision}` },
        _target: { type: "object" },
      },
    } } : {}),
  } };
}

/** Reserved module names never fall back to built-in handlers. */
export function isModuleTool(name) {
  return typeof name === "string" && name.startsWith(PREFIX);
}

/**
 * Build a registry without cross-request catalog or authorization caches.
 * Transport injection lets unrelated fixture providers prove generic dispatch.
 */
export function createModuleToolRegistry({ list = listServerTools, call = callServerTool } = {}) {
  return {
    async list(context = {}) {
      const sites = context.sites ?? listResolvableSiteConfigs();
      const identity = context.identity === undefined ? getRequestIdentity() : context.identity;
      const enabled = [...entries(sites).values()].filter((entry) => allowed(entry, identity, sites, context.grants));
      const catalogs = new Map();
      const definitions = [];
      for (const entry of enabled) {
        try {
          if (!catalogs.has(entry.site._name)) {
            const found = await securityMiddleware(entry.name, { site: entry.site._name },
              () => catalog(entry.site, list), { ...context, sites, identity, moduleTool: entry.policy });
            catalogs.set(entry.site._name, found);
          }
          const remote = catalogs.get(entry.site._name).get(entry.policy.name);
          if (remote) definitions.push(describe(entry, remote).definition);
        } catch {
          // Never retain a stale catalog when a provider is unavailable.
          catalogs.set(entry.site._name, new Map());
        }
      }
      return definitions.sort((a, b) => a.name.localeCompare(b.name));
    },
    async call(name, args, context = {}) {
      try {
        const sites = context.sites ?? listResolvableSiteConfigs();
        const identity = context.identity === undefined ? getRequestIdentity() : context.identity;
        const entry = entries(sites).get(name);
        if (!entry || !allowed(entry, identity, sites, context.grants)) throw new SecurityError("Module tool is not enabled for this caller.");
        bounded(args);
        if (!args || Object.keys(args).some((key) => !["arguments", "catalogRevision"].includes(key))) {
          throw new SecurityError("Invalid module tool arguments.");
        }
        const invokeContext = { ...context, sites, identity, moduleTool: entry.policy };
        return await securityMiddleware(name, { site: entry.site._name }, async () => {
          const remote = (await catalog(entry.site, list)).get(entry.policy.name);
          if (!remote) throw new SecurityError("Module tool is no longer available.");
          const spec = describe(entry, remote);
          if (args.catalogRevision !== spec.revision || !spec.input(args.arguments)) {
            throw new SecurityError("Module tool schema changed or arguments are invalid. Refresh tools/list.");
          }
          const result = await call(entry.site, entry.policy.name, args.arguments, {
            maxBytes: MAX_BYTES, preserveErrors: true, retryRejected: entry.policy.operation === "read",
          });
          bounded(result);
          if (!Array.isArray(result?.content) || result.content.some((item) => item.type !== "text")) {
            throw new Error("Unsupported module result content.");
          }
          const data = toolResultData(result);
          const failed = result.isError === true || data?.success === false;
          if (!failed && spec.output && !spec.output(data)) throw new Error("Invalid module output schema.");
          const structuredContent = withResolvedTarget({ result: data }, invokeContext.resolvedTarget);
          return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: failed };
        }, invokeContext);
      } catch (error) {
        const safe = error instanceof SecurityError || error instanceof GovernanceError || error instanceof DataFlowBudgetError;
        return toolError(safe ? error : new Error("Module tool unavailable or returned an invalid response. No fallback was attempted."));
      }
    },
  };
}
