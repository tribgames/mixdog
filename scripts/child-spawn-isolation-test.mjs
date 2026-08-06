import assert from 'node:assert/strict';
import test from 'node:test';

test('search and code-graph child lanes never queue behind each other', async (t) => {
  const priorSearch = process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT;
  const priorGraph = process.env.MIXDOG_CHILD_SPAWN_CODE_GRAPH_MAX_INFLIGHT;
  process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = '1';
  process.env.MIXDOG_CHILD_SPAWN_CODE_GRAPH_MAX_INFLIGHT = '1';
  t.after(() => {
    if (priorSearch === undefined) delete process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT;
    else process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = priorSearch;
    if (priorGraph === undefined) delete process.env.MIXDOG_CHILD_SPAWN_CODE_GRAPH_MAX_INFLIGHT;
    else process.env.MIXDOG_CHILD_SPAWN_CODE_GRAPH_MAX_INFLIGHT = priorGraph;
  });

  const gate = await import(`../src/runtime/shared/child-spawn-gate.mjs?isolation=${Date.now()}`);
  const releaseSearch = await gate.acquire(null, 'search');
  let secondSearchStarted = false;
  const secondSearch = gate.acquire(null, 'search').then((release) => {
    secondSearchStarted = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSearchStarted, false);

  const releaseGraph = await gate.acquire(null, 'code-graph');
  assert.equal(secondSearchStarted, false, 'graph work does not consume or release a search slot');
  assert.deepEqual(gate.snapshot().lanes, [
    { name: 'search', inflight: 1, queued: 1, limit: 1 },
    { name: 'code-graph', inflight: 1, queued: 0, limit: 1 },
  ]);

  releaseGraph();
  releaseSearch();
  const releaseSecondSearch = await secondSearch;
  releaseSecondSearch();
});
