/**
 * src/session-runtime/lifecycle/memory-ingest.mjs - best-effort persist of a
 * closing session's conversation into the memory DB.
 */
const INGEST_DEADLINE_MS = 2500;

// Sessions that never compacted had NO session-sourced rows (ingest_session
// previously ran only inside compaction), so recall could not reconstruct
// the most recent conversations. Deadline-capped: the row inserts are fast
// and committed even if the bounded wait elapses during the trailing
// embedding flush (the raw-embedding backlog sweep embeds them later). Never
// loads the memory runtime just for this — a null module promise means
// memory was never used this run, so skip.
export function createMemoryIngest({ getMemoryModPromise, getCurrentCwd, withTeardownDeadline }) {
  return async function ingestSessionIntoMemory(session) {
    if (process.env.MIXDOG_DISABLE_MEMORY_INGEST === '1') return;
    try {
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      if (!session?.id || messages.length === 0) return;
      const modPromise = getMemoryModPromise();
      if (!modPromise) return;
      await withTeardownDeadline(
        Promise.resolve(modPromise)
          .then((mod) =>
            typeof mod?.handleToolCall === 'function'
              ? mod.handleToolCall('memory', {
                  action: 'ingest_session',
                  sessionId: session.id,
                  cwd: session.cwd || getCurrentCwd(),
                  messages,
                })
              : null
          )
          .catch(() => {}),
        INGEST_DEADLINE_MS,
        undefined
      );
    } catch {
      /* best-effort: memory ingest must never break lifecycle paths */
    }
  };
}
