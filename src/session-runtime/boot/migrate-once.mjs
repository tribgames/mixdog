// One-time profile migrations (each under its own cross-process lock, each a
// durable write) run at this process's first runtime start for a data dir.
// The daemon starts a runtime per session, so without this every session
// open re-ran them on the event loop. A failed one (a throw, or a result
// marked `failed`) stays due for the next start; config changes made later
// re-give connector identities themselves (boot/providers.mjs reconcileMcp).
// A daemon keeps one data dir for its life. A process that retargets
// MIXDOG_DATA_DIR between runs (the pristine-execution boundary) may remove
// and recreate a folder between them, so a start in another data dir than the
// last one forgets what ran: A→B→A migrates A again.
const migratedIn = new Map(); // name -> the data dir it last ran in

/** `migrate()`'s result at the first start in this data dir since `name` last
 *  ran in another one; undefined when it already ran here. */
export function migrateOncePerProcess(dataDir, name, migrate) {
  if (migratedIn.get(name) === dataDir) return undefined;
  migratedIn.delete(name);
  const result = migrate();
  if (result?.failed !== true) migratedIn.set(name, dataDir);
  return result;
}
