/**
 * Errors thrown by the backend abstraction layer.
 */

/** Thrown when a backend cannot perform a requested operation (e.g. GraphQL writes). */
export class BackendCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackendCapabilityError";
  }
}

/** Thrown when no usable backend can be resolved for a site. */
export class BackendResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackendResolutionError";
  }
}
