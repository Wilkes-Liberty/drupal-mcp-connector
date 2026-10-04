/**
 * Tool: governed nested-paragraph draft (#421).
 *
 * Direct component attributes stay on drupal_update_node `components`.
 * A nested child is a new unpublished paragraph, pinned only by the host
 * draft. This tool never calls updateEntity on a paragraph.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertWriteAllowed, assertPublishAllowed } from "../lib/security.js";
import { draftNestedComponents } from "../lib/nested-draft.js";

/**
 * @param {object} args
 * @returns {Promise<object>}
 */
async function draftNestedComponentsTool({
  site: siteName, bundle, id, field, parentId, childField, children,
  liveRevisionId, resumeParentId, dryRun = false,
}) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "node", bundle);
  assertPublishAllowed(sec, { moderation_state: "draft" });
  const backend = await resolveBackend(site);
  return draftNestedComponents(backend, {
    entityType: "node", bundle, id, field, parentId, childField, children,
    liveRevisionId, resumeParentId,
  }, {
    dryRun,
    assertParagraphCreate(paragraphBundle) {
      assertWriteAllowed(sec, "create", "paragraph", paragraphBundle);
    },
  });
}

export const definitions = [
  {
    name: "drupal_draft_nested_components",
    description:
      "Replace nested paragraphs on a node by creating new unpublished paragraphs and pinning a new direct parent from the node's unpublished draft. children is the full new list: { op: 'keep', id } copies an existing child pin, { op: 'replace', id, type, attributes, translations? } or { op: 'insert', type, attributes, translations? } creates a new child. Omitting a child leaves it off the draft only; it is not deleted. The published host and every paragraph it already pins stay unchanged. Never edits a live child and never sends nested UUIDs as mcp_components (use drupal_update_node components for a direct paragraph's attributes). Reusable library items and from_library children are refused; update the library item with drupal_entity_update. The first host draft requires MCP Sentinel 2.29.0 (open_draft). An existing working copy continues through /mcp-draft. When the host inventory advertises nested_replacement, one /mcp-draft carries meta.mcp_nested_replacement (parent is the parentId input), the connector creates no paragraphs, and it does not also send the host paragraph field. dryRun then uses that non-saving preflight (serverPreflight sentinel_draft). Hosts that do not advertise nested_replacement keep this sequence, including resumeParentId, and dryRun leaves serverPreflight none. New paragraphs are created in the host's default language. The new parent keeps the published parent's other references and replaces only the child field. Non-default translations on the component must be supplied on each replace or insert; they are created on the new paragraphs, and the component's own translations are copied onto the new parent. dryRun checks paragraph-create permission, creates nothing, and does not evaluate the host payload. If paragraph creates succeed and the host pin fails, the error lists the prepared UUIDs. When a parent was prepared, retry with resumeParentId and the same children list; that retry checks the prepared paragraph's fields, other references, and child revision pins before any host write. A failure before a parent exists says to delete the prepared paragraphs and does not offer a host retry. A lost response is uncertain until a re-read proves the prepared revision is pinned; the same UUID at another revision is not success. A second call after success is refused while the forward draft no longer pins the published component. Governed by the site security policy. Nothing is published.",
    inputSchema: {
      type: "object",
      required: ["bundle", "id", "field", "parentId", "childField", "children"],
      properties: {
        site: { type: "string", description: "Named site (omit for default)" },
        bundle: { type: "string", description: "Node bundle machine name, e.g. 'page'" },
        id: { type: "string", description: "Node UUID" },
        field: { type: "string", description: "Host entity-reference-revisions field that pins the direct parent, e.g. 'field_components'" },
        parentId: { type: "string", description: "UUID of the direct paragraph the published host pins. Not a nested child." },
        childField: { type: "string", description: "Entity-reference-revisions field on that direct paragraph, e.g. 'field_items'" },
        children: {
          type: "array",
          description: "Full new child list, in order. keep: { op, id }. replace: { op, id, type, attributes, translations? }. insert: { op, type, attributes, translations? }. translations is [{ langcode, attributes }] for each non-default language the component already has. Relationships inside a child are refused.",
          items: { type: "object" },
        },
        liveRevisionId: { type: "string", description: "Optional published revision id. Refused before any create when it is not the current live revision." },
        resumeParentId: { type: "string", description: "Prepared parent UUID from a previous attempt whose host pin did not finish. Retries only the host pin. Must not be a paragraph the published host already pins." },
        dryRun: { type: "boolean", default: false, description: "When nested_replacement is advertised, run that non-saving /mcp-draft preflight and create nothing (checks.serverPreflight is sentinel_draft). Otherwise read the host and component, then return without creating paragraphs or evaluating the host draft payload (checks.serverPreflight is none)." },
      },
    },
  },
];

export const handlers = {
  drupal_draft_nested_components: draftNestedComponentsTool,
};
