/**
 * Combine abort signals without dropping the timeout when
 * `AbortSignal.any` is missing.
 *
 * @param {...AbortSignal|null|undefined} signals
 * @returns {AbortSignal|undefined}
 */
export function combineAbortSignals(...signals) {
  const live = signals.filter((signal) => signal && typeof signal === "object");
  if (!live.length) return undefined;
  if (live.length === 1) return live[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const controller = new AbortController();
  for (const signal of live) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    }, { once: true });
  }
  return controller.signal;
}
