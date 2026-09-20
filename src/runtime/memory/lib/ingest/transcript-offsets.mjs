// ingest/transcript-offsets.mjs
// Per-file transcript read positions ({ bytes, lineIndex, generation }),
// persisted as one JSON blob in the meta kv. Persists are serialized on one
// tail so concurrent file ingests never interleave writes of the blob.
export function createTranscriptOffsets({ loadMeta, persistMeta, log }) {
  let offsets = new Map();
  let persistTail = Promise.resolve();

  async function load() {
    try {
      offsets = new Map(Object.entries(JSON.parse(await loadMeta())));
    } catch {
      offsets = new Map();
    }
  }

  async function persist() {
    const run = persistTail
      .catch(() => {})
      .then(async () => {
        try {
          await persistMeta(JSON.stringify(Object.fromEntries(offsets)));
        } catch (e) {
          log(`[memory] persist transcript offsets failed: ${e.message}\n`);
        }
      });
    persistTail = run.catch(() => {});
    return run;
  }

  /** Read position for one file; a missing entry starts at zero. */
  function snapshot(transcriptPath) {
    const stored = offsets.get(transcriptPath);
    if (!stored) return { bytes: 0, lineIndex: 0, generation: 0 };
    return {
      bytes: Number(stored.bytes) || 0,
      lineIndex: Number(stored.lineIndex) || 0,
      generation: Number(stored.generation) || 0,
    };
  }

  return {
    load,
    persist,
    snapshot,
    get: (transcriptPath) => offsets.get(transcriptPath),
    set: (transcriptPath, position) => {
      offsets.set(transcriptPath, position);
    },
    reset: () => {
      offsets = new Map();
    },
  };
}
