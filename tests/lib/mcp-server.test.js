import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

function surface() {
  return {
    serverInfo: { name: "connector-test", version: "1.0.0" },
    tools: {
      definitions: [{
        name: "drupal_test",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
      }],
      call: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    },
    resources: {
      definitions: [{ uri: "drupal://test", name: "Test", mimeType: "application/json" }],
      read: vi.fn(async (uri) => ({ uri, ok: true })),
    },
    prompts: {
      definitions: [{ name: "drupal-test", description: "Test prompt" }],
      get: vi.fn(() => [{ role: "user", content: { type: "text", text: "test" } }]),
    },
  };
}

describe("createConnectorServerFactory", () => {
  it("returns a fresh server with the same tool, resource, and prompt capabilities", () => {
    const buildConnectorServer = createConnectorServerFactory(surface());
    const first = buildConnectorServer({ era: "modern" });
    const second = buildConnectorServer({ era: "modern" });

    expect(first).not.toBe(second);
    expect(first.getCapabilities()).toEqual({ tools: {}, resources: {}, prompts: {} });
    expect(second.getCapabilities()).toEqual(first.getCapabilities());
  });

  it("serves the registered surface over the public MCP client interface", async () => {
    const current = surface();
    const server = createConnectorServerFactory(current)({ era: "legacy" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["drupal_test"]);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual(["drupal://test"]);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["drupal-test"]);
    expect(await client.callTool({ name: "drupal_test", arguments: {} })).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(current.tools.call).toHaveBeenCalledWith(
      "drupal_test",
      {},
      expect.objectContaining({ mcpReq: expect.any(Object) })
    );

    await client.close();
    await server.close();
  });

  it("returns a stable non-secret error when resource reads throw non-Error values", async () => {
    const current = surface();
    current.resources.read.mockRejectedValue("resource-backend-secret");
    const server = createConnectorServerFactory(current)({ era: "legacy" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const error = await client.readResource({ uri: "drupal://test" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Resource read failed (drupal://test)");

    await client.close();
    await server.close();
  });
});
