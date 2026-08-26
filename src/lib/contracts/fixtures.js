/**
 * In-process contract fixtures (#181).
 *
 * These implement relay / approval / evidence-sink / backend roles for the
 * Drupal conformance kit. They are not a second system-of-record adapter.
 */

import { randomUUID } from "node:crypto";
import { createMemoryApproval } from "./approval.js";
import { createMemoryEvidenceSink } from "./evidence-sink.js";
import { createLocalRelay } from "./relay.js";

export { createMemoryApproval, createMemoryEvidenceSink, createLocalRelay };

/**
 * In-memory backend used by the Drupal adapter during conformance.
 *
 * @param {object} [options]
 * @param {object[]} [options.entities]
 * @param {object} [options.mismatch] Forced observed fields after write.
 * @returns {object}
 */
export function createMemoryBackend({ entities = [], mismatch } = {}) {
  const store = new Map();
  for (const entity of entities) {
    store.set(entity.id, { ...entity });
  }

  return Object.freeze({
    store,
    /**
     * @param {{id: string}} ref
     * @returns {Promise<object|null>}
     */
    async getEntity(ref) {
      return store.get(ref.id) ?? null;
    },

    /**
     * @param {object} input
     * @returns {Promise<object>}
     */
    async createEntity(input) {
      const id = input.id || randomUUID();
      const attributes = { ...(input.attributes ?? {}) };
      const entity = applyMismatch({
        id,
        entityType: input.entityType,
        bundle: input.bundle,
        status: attributes.status,
        attributes,
      }, mismatch);
      store.set(id, entity);
      return entity;
    },

    /**
     * @param {object} input
     * @returns {Promise<object>}
     */
    async updateEntity(input) {
      const prev = store.get(input.id) ?? { id: input.id };
      const attributes = { ...(prev.attributes ?? {}), ...(input.attributes ?? {}) };
      const entity = applyMismatch({
        ...prev,
        entityType: input.entityType ?? prev.entityType,
        bundle: input.bundle ?? prev.bundle,
        status: attributes.status ?? prev.status,
        attributes,
      }, mismatch);
      store.set(input.id, entity);
      return entity;
    },

    /**
     * @param {{id: string}} ref
     * @returns {Promise<void>}
     */
    async deleteEntity(ref) {
      store.delete(ref.id);
    },
  });
}

/**
 * @param {object} entity
 * @param {object|undefined} mismatch
 * @returns {object}
 */
function applyMismatch(entity, mismatch) {
  if (!mismatch) return entity;
  const next = { ...entity, ...mismatch };
  if (mismatch.status !== undefined) {
    next.attributes = { ...(entity.attributes ?? {}), status: mismatch.status };
  }
  return next;
}
