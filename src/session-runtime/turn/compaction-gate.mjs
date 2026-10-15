/**
 * src/session-runtime/turn/compaction-gate.mjs - serializes a model-scheduled
 * compaction (session tool) with everything that follows its turn. The
 * compaction is chained, never left dangling: `after(fn)` wraps a command so it
 * waits for the compaction in flight, and the compaction itself only runs if
 * the session it was scheduled for is still the live one.
 */
export function createCompactionGate({ getSessionId, compact }) {
  let tail = Promise.resolve();
  const run = (sessionId) => {
    tail = tail
      .then(() => (getSessionId() === sessionId ? compact() : null))
      .catch(() => {
        /* best-effort: a scheduled compaction must never break teardown */
      });
    return tail;
  };
  const after =
    (fn) =>
    async (...args) => {
      await tail;
      return fn(...args);
    };
  return { run, after };
}
