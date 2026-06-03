/**
 * Typed error classes for the backend abstraction layer.
 *
 * Single responsibility: give callers distinct, catchable error types for the
 * two backend-specific failure modes (unsupported operation vs. no usable
 * backend), separate from generic transport/HTTP errors.
 */

/**
 * Thrown when a resolved backend cannot perform a requested operation
 * (e.g. attempting a write through the read-only GraphQL backend).
 */
export class BackendCapabilityError extends Error {
  /** @param {string} message Human-readable explanation. */
  constructor(message) {
    super(message);
    this.name = "BackendCapabilityError";
  }
}

/**
 * Thrown when no usable backend can be resolved for a site (misconfigured
 * `api` setting, or no protocol reachable during the probe).
 */
export class BackendResolutionError extends Error {
  /** @param {string} message Human-readable explanation. */
  constructor(message) {
    super(message);
    this.name = "BackendResolutionError";
  }
}
