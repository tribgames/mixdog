/** Lazy per-dataDir PG handle: one in-flight init, bootstrap lock, retry after failure. */
export function createPgSchemaDb({ schema, ddl, defaultDataDir, ensurePg, withLock }) {
  const ready = new Map();
  return async function getDb(dataDir = defaultDataDir()) {
    if (ready.has(dataDir)) return ready.get(dataDir);
    const p = (async () => {
      const { db, pool } = await ensurePg(dataDir, { schema });
      // Serialize CREATE TABLE across concurrent first-boot processes on the
      // same cluster-global advisory lock the adapter uses for schema bootstrap.
      await withLock(pool, () => db.exec(ddl));
      return db;
    })();
    ready.set(dataDir, p);
    try {
      return await p;
    } catch (err) {
      ready.delete(dataDir); // let the next call retry after a transient failure
      throw err;
    }
  };
}
