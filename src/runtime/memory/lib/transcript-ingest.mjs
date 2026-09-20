// Transcript ingest cluster: incremental JSONL ingestion of session
// transcripts plus the watcher that keeps them flowing. Everything that touched
// module-level state in index.mjs (db handle, offsets map, persist tail) is
// closed over here via injected accessors, so index.mjs keeps ownership of the
// live db/config lifecycle and this module stays a pure factory with no
// import-time side effects. Each step lives under ./ingest/:
//   transcript-rows      — timestamp coercion, cwd extraction, row shaping
//   transcript-offsets   — persisted per-file read positions
//   transcript-tail      — one incremental read + insert of new lines
//   transcript-discovery — which files are watchable / recently active
//   transcript-watcher   — change source per platform + safety sweep
import path from 'node:path';
import { createTranscriptOffsets } from './ingest/transcript-offsets.mjs';
import { cwdFromTranscriptPath, parseTsToMs } from './ingest/transcript-rows.mjs';
import { ingestTranscriptTail } from './ingest/transcript-tail.mjs';
import { startTranscriptWatcher } from './ingest/transcript-watcher.mjs';

export { cwdFromTranscriptPath, parseTsToMs };

// Factory. All live-state coupling is injected:
//   getDb()            -> current pg-shim db handle (or null pre-init)
//   loadMeta()         -> Promise<string> raw transcript-offsets meta value
//   persistMeta(json)  -> Promise<void> writes serialized offsets to meta
//   projectsRoot()     -> string, mixdogHome()/projects
//   resolveProjectId(cwd) -> project id | null
//   log(msg)           -> stderr logger
export function createTranscriptIngest({
  getDb,
  loadMeta,
  persistMeta,
  projectsRoot,
  resolveProjectId,
  log = () => {},
}) {
  const offsets = createTranscriptOffsets({ loadMeta, persistMeta, log });
  /** Per-file serialization: two ingests of one transcript never overlap.
   *  @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  function ingestTranscriptFile(transcriptPath, { cwd } = {}) {
    const key = path.resolve(transcriptPath);
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => ingestTranscriptTail({ db: getDb(), transcriptPath, cwd, offsets, resolveProjectId, log }));
    tails.set(
      key,
      run.catch(() => {})
    );
    return run;
  }

  return {
    loadTranscriptOffsets: offsets.load,
    persistTranscriptOffsets: offsets.persist,
    ingestTranscriptFile,
    cwdFromTranscriptPath,
    parseTsToMs,
    initTranscriptWatcher: () =>
      startTranscriptWatcher({ root: projectsRoot(), ingestTranscriptFile, getOffset: offsets.get, log }),
    getOffset: offsets.get,
    resetOffsets: offsets.reset,
  };
}
