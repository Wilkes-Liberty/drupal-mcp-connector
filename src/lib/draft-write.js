/**
 * Sentinel's governed draft-continuation contract (d.o #3621022).
 * Core JSON:API revision selectors support reads, not PATCH requests.
 */

/**
 * Validate or continue a draft, using the same payload and revision precondition.
 * No canonical fallback: an absent endpoint or refused precondition stops work.
 * @param {object} backend JSON:API backend.
 * @param {object} input Canonical update input plus draftRevision.
 * @param {boolean} preflight Validate without saving.
 * @returns {Promise<object>} Preflight metadata or the written canonical entity.
 */
export async function writeDraft(backend, input, preflight = false) {
  const { entityType, bundle, id, attributes = {}, relationships, draftRevision } = input;
  const live = String(draftRevision?.liveVid ?? "");
  const working = String(draftRevision?.workingVid ?? "");
  if (entityType !== "node" || !/^[1-9]\d*$/.test(live)
    || !/^[1-9]\d*$/.test(working) || live === working) {
    throw new Error("Draft continuation requires distinct, verified live and working node revision IDs.");
  }
  if (typeof backend.rawQuery !== "function" || typeof backend.resourcePath !== "function") {
    throw new Error("This backend does not support governed draft continuation.");
  }
  const data = { type: `${entityType}--${bundle}`, id, attributes };
  if (relationships) data.relationships = relationships;
  let result;
  try {
    result = await backend.rawQuery({
      path: `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}/mcp-draft`,
      options: {
        method: "PATCH",
        headers: {
          "If-Match": `"${live}:${working}"`,
          "X-MCP-Draft-Preflight": preflight ? "1" : "0",
        },
        body: JSON.stringify({ data }),
      },
    });
  } catch (error) {
    if (/Drupal (404|405)\b/.test(String(error?.message))) {
      throw new Error("The site does not provide Sentinel's governed draft endpoint (d.o #3621022). Update the server-side module; the draft was not discarded and no canonical fallback was attempted.", { cause: error });
    }
    throw error;
  }
  if (preflight) {
    if (result?.meta?.draft_preflight !== true
      || String(result.meta.live) !== live || String(result.meta.working) !== working) {
      throw new Error("The site did not confirm a non-saving draft preflight. Refusing to continue.");
    }
    return result;
  }
  if (!result?.data || result.data.id !== id || result.data.type !== data.type) {
    throw new Error("Draft write response did not identify the requested entity. The write outcome is uncertain; re-read before retrying.");
  }
  return backend.toCanonical(result.data);
}
