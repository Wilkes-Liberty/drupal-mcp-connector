/**
 * Decide whether the `summary` argument may be written onto `body`.
 *
 * Core `text_with_summary` stores a `summary` property. `text_long` and
 * sampled `text_formatted` do not — Drupal drops an unknown property, so a
 * silent write would lose the teaser. Fail closed when the sampled schema
 * cannot confirm the property exists (#163).
 */

/** Warning attached when `summary` is written onto a text_with_summary body. */
export const SUMMARY_DEPRECATED_WARNING = {
  code: "summary_parameter_deprecated",
  message:
    "The `summary` argument writes body.summary on core text_with_summary. " +
    "Prefer setting the site's dedicated deck/summary field via `fields`.",
};

/**
 * @param {object} backend Backend with `getEntitySchema`.
 * @param {string} bundle Node bundle machine name.
 * @param {string|undefined} summary Caller-supplied summary; undefined = omitted.
 * @returns {Promise<{deprecated: boolean}>} Whether a deprecation notice applies.
 * @throws {Error} When `summary` was supplied and the body field has no
 *   summary property, or the schema cannot be determined.
 */
export async function assertBodySummaryWritable(backend, bundle, summary) {
  if (summary === undefined) return { deprecated: false };

  let schema;
  try {
    schema = await backend.getEntitySchema("node", bundle);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot write \`summary\`: the body field schema for node.${bundle} could not be determined (${detail}). Set the site's dedicated deck field via \`fields\` instead.`,
    );
  }

  const bodyType = schema?.attributes?.body;
  if (bodyType === "text_with_summary") {
    return { deprecated: true };
  }

  const sampled = bodyType ? ` (sampled as ${bodyType})` : "";
  throw new Error(
    `This site's body field has no summary property${sampled}; set the site's deck field via \`fields\`. The \`summary\` argument is only valid for core text_with_summary body fields.`,
  );
}

/**
 * Attach the `summary` deprecation notice to a write (or dryRun) result.
 *
 * @param {object|null|undefined} result Tool response.
 * @returns {object|null|undefined} Result with `_warnings` when result is an object.
 */
export function attachSummaryDeprecation(result) {
  if (!result || typeof result !== "object") return result;
  const existing = Array.isArray(result._warnings) ? result._warnings : [];
  return { ...result, _warnings: [...existing, SUMMARY_DEPRECATED_WARNING] };
}
