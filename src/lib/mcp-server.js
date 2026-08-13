/**
 * Transport-neutral MCP server construction.
 *
 * The returned factory creates one low-level SDK server for each serving unit:
 * one request on modern HTTP and one connection on legacy HTTP or stdio.
 */

import { Server } from "@modelcontextprotocol/server";

/**
 * Create the server factory shared by HTTP and stdio transports.
 *
 * @param {object} surface
 * @param {{name: string, version: string}} surface.serverInfo
 * @param {{definitions: Array<object>, call: (name: string, args: object, context: object) => Promise<object>}} surface.tools
 * @param {{definitions: Array<object>, read: (uri: string) => Promise<object>}} surface.resources
 * @param {{definitions: Array<object>, get: (name: string, args: object) => Array<object>}} surface.prompts
 * @returns {(context: import("@modelcontextprotocol/server").McpRequestContext) => Server}
 */
export function createConnectorServerFactory({ serverInfo, tools, resources, prompts }) {
  const toolDefinitions = new Map(tools.definitions.map((definition) => [definition.name, definition]));

  return function buildConnectorServer(_context) {
    const server = new Server(
      serverInfo,
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );

    server.setRequestHandler("tools/list", async () => ({ tools: tools.definitions }));
    server.setRequestHandler("tools/call", async (request, context) => {
      const { name, arguments: args } = request.params;
      const result = await tools.call(name, args ?? {}, context);
      return server.projectCallToolResult(result, toolDefinitions.get(name)?.outputSchema);
    });

    server.setRequestHandler("resources/list", async () => ({ resources: resources.definitions }));
    server.setRequestHandler("resources/read", async (request) => {
      const { uri } = request.params;
      try {
        const data = await resources.read(uri);
        return {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
        };
      } catch {
        throw new Error(`Resource read failed (${uri})`);
      }
    });

    server.setRequestHandler("prompts/list", async () => ({ prompts: prompts.definitions }));
    server.setRequestHandler("prompts/get", async (request) => {
      const { name, arguments: args } = request.params;
      const known = prompts.definitions.find((prompt) => prompt.name === name);
      if (!known) throw new Error(`Unknown prompt: "${name}"`);
      return { description: known.description, messages: prompts.get(name, args ?? {}) };
    });

    return server;
  };
}
