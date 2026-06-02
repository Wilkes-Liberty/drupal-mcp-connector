/**
 * Error utilities for consistent MCP tool error responses.
 */

/**
 * Wrap a thrown error into the MCP CallTool error response shape.
 */
export function toolError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a successful result into the MCP CallTool response shape.
 */
export function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Wrap a plain string message (for confirmations, warnings, etc.).
 */
export function toolMessage(text) {
  return {
    content: [{ type: "text", text }],
  };
}
