import { createSharedAbortable } from './abort-race.mjs';

/** Lazy per-dataDir PG handle: one in-flight init, bootstrap lock, retry after
 *  failure. `signal` withdraws a caller; the init (a PG runtime install
 *  included) is cancelled once every caller has (createSharedAbortable). */
export function createPgSchemaDb({ schema, ddl, defaultDataDir, ensurePg, withLock }) {
  const ready = new Map();
  return function getDb(dataDir = defaultDataDir(), { signal = null } = {}) {
    let shared = ready.get(dataDir);
    if (!shared) {
      const entry = createSharedAbortable(
        async (initSignal) => {
          const { db, pool } = await ensurePg(dataDir, { schema, signal: initSignal });
          initSignal.throwIfAborted();
          // Serialize CREATE TABLE across concurrent first-boot processes on the
          // same cluster-global advisory lock the adapter uses for schema bootstrap.
          await withLock(pool, () => db.exec(ddl));
          return db;
        },
        {
          // Let the next call retry after a transient failure or a cancellation.
          onSettled: (failed) => {
            if (failed && ready.get(dataDir) === entry) ready.delete(dataDir);
          },
        }
      );
      shared = entry;
      ready.set(dataDir, entry);
    }
    return shared.join(signal);
  };
}
