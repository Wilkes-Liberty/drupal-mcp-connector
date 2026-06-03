/**
 * Error utilities for consistent MCP tool error responses.
 */

/**
 * Wrap a thrown error into the MCP CallTool error response shape.
 * @param {Error|*} err The caught error (or any thrown value).
 * @returns {{content: Array<{type: string, text: string}>, isError: true}}
 */
export function toolError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a successful result into the MCP CallTool response shape (JSON-stringified).
 * @param {*} data Serializable result payload.
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Wrap a plain string message (for confirmations, warnings, etc.).
 * @param {string} text Message text.
 * @returns {{content: Array<{type: string, text: string}>}}
 */
export function toolMessage(text) {
  return {
    content: [{ type: "text", text }],
  };
}
