// ingest/ingest-embed-flush.mjs
// Always-on post-ingest raw embedding: freshly ingested rows become
// dense-searchable immediately (autoclear/fresh-context hydration, recall
// empty-fallback), without waiting for cycle1 chunking or the ~60s background
// tick. Local ONNX only — no LLM cost, so it runs regardless of the recap
// toggle.
//
// Two-tier flush so ingest never synchronously inherits OTHER calls'/sessions'
// raw-embedding backlog:
//  1) AWAITED (bounded) — scoped to exactly THIS call's insertedIds, so
//     ingest_session resolves once its own rows are embedded and an
//     immediately following recall sees them in the dense leg. A 15s cap keeps
//     a cold ONNX warmup from wedging ingest. Id-scoped, so concurrent ingests
//     embed disjoint row sets (SKIP LOCKED) without stacking redundant work.
//  2) BACKGROUND (not awaited) — an unscoped sweep of any PRE-EXISTING backlog
//     (rows left by earlier calls / other sessions / the flush cap). Serialized
//     on one chain so bursts don't stack full backlog scans; the ~60s tick
//     still sweeps whatever this misses. (The old boolean guard silently
//     SKIPPED bursts, leaving rows embedding-less until the tick.)
import { flushRawEmbeddings } from '../memory-cycle.mjs';

const INGEST_EMBED_WAIT_MS = 15_000;

export function createPostIngestFlush({ log }) {
  let chain = Promise.resolve();

  return async function flushAfterIngest(db, insertedIds, { embedWait } = {}) {
    if (insertedIds.length > 0) {
      const runOwnFlush = () =>
        flushRawEmbeddings(db, { limit: 200, ids: insertedIds })
          .then((r) => {
            if (r.attempted > 0)
              log(`[embed] post-ingest raw flush (own) attempted=${r.attempted} embedded=${r.embedded}\n`);
            return r;
          })
          .catch((err) => log(`[embed] post-ingest raw flush failed: ${err?.message || err}\n`));
      // Clear/manual-compact path opts out (embedWait:false): those rows are
      // about to be summarized away, so dense-search immediacy is pointless and
      // the bounded wait would only delay compaction. Enqueue the flush onto
      // the chain (append, don't await) so clear-path ingest bursts stay
      // serialized like the backlog sweep — never running concurrent raw
      // flushes. All other callers keep the awaited (bounded) wait so a
      // following recall sees the rows.
      if (embedWait === false) {
        chain = chain
          .catch(() => {})
          .then(runOwnFlush)
          .catch(() => {});
      } else {
        let timer;
        await Promise.race([
          runOwnFlush(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, INGEST_EMBED_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
      }
    }
    // Background backlog sweep — kicked, never awaited. Runs even when THIS
    // call inserted 0 rows, so pre-existing backlog is not left waiting for
    // the next scheduler tick.
    chain = chain
      .catch(() => {}) // never let a previous flush failure poison the chain
      .then(() => flushRawEmbeddings(db, { limit: 200 }))
      .then((r) => {
        if (r.attempted > 0)
          log(`[embed] post-ingest raw flush (backlog) attempted=${r.attempted} embedded=${r.embedded}\n`);
        return r;
      })
      .catch((err) => log(`[embed] post-ingest raw backlog flush failed: ${err?.message || err}\n`));
  };
}
