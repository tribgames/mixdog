// Staged dynamic import of a large module graph. Loading a graph (file reads,
// compilation, evaluation) runs synchronously inside one import() call, so the
// daemon's session-runtime warm-up held the event loop for ~0.5 s in one
// piece right after `daemon-ready`. Importing the graph's top-level stages one
// loop turn apart splits that block without changing what is loaded. Used for
// the session-runtime graph and the agent loop's.
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * import(url), after importing each module of `stages` (URLs the caller
 * declares: the static imports of the module that owns the graph, in its
 * source order) one loop turn apart. Evaluation order is the one a single
 * import gives — dependencies depth-first in source order — as long as
 * `stages` lists those imports in order and no module of a stage's graph
 * imports `url` or an importer of it back. A stage that fails rejects with its
 * own error, straight from its import(), and no later stage or `url`
 * evaluates: importing `url` again after a failed link would, on Node 22.20
 * and older, report "request for '<first import>' is not in cache" instead.
 */
export async function importInStages(url, stages) {
  for (const stage of stages) {
    await import(stage);
    await nextTurn();
  }
  return import(url);
}
