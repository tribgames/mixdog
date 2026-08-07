import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveDefaultChildSpawnLaneMaxInflight,
  resolveDefaultChildSpawnMaxInflight,
} from '../src/runtime/shared/child-spawn-gate.mjs';

test('child spawn default serializes each Windows lane while preserving explicit overrides', () => {
  assert.equal(resolveDefaultChildSpawnMaxInflight({}, 'win32'), 1);
  assert.equal(resolveDefaultChildSpawnMaxInflight({}, 'linux'), Infinity);
  assert.equal(
    resolveDefaultChildSpawnMaxInflight({ MIXDOG_CHILD_SPAWN_MAX_INFLIGHT: '3' }, 'win32'),
    3,
  );
  assert.equal(
    resolveDefaultChildSpawnMaxInflight({ MIXDOG_CHILD_SPAWN_MAX_INFLIGHT: '3' }, 'linux'),
    3,
  );
});

test('Windows search lane scales conservatively with CPU while graph remains isolated at one', () => {
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('search', {}, 'win32', 4), 1);
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('search', {}, 'win32', 8), 2);
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('search', {}, 'win32', 16), 4);
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('search', {}, 'win32', 64), 4);
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('code-graph', {}, 'win32', 64), 1);
  assert.equal(resolveDefaultChildSpawnLaneMaxInflight('search', {}, 'linux', 4), Infinity);
});

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
  assert.deepEqual(
    gate.snapshot().lanes.map(({ name, inflight, queued, limit }) => ({ name, inflight, queued, limit })),
    [
      { name: 'search', inflight: 1, queued: 1, limit: 1 },
      { name: 'code-graph', inflight: 1, queued: 0, limit: 1 },
    ],
  );

  releaseGraph();
  releaseSearch();
  const releaseSecondSearch = await secondSearch;
  releaseSecondSearch();
});

test('search admission rotates contending session owners instead of draining one fan-out', async (t) => {
  const prior = process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT;
  process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT;
    else process.env.MIXDOG_CHILD_SPAWN_SEARCH_MAX_INFLIGHT = prior;
  });
  const gate = await import(`../src/runtime/shared/child-spawn-gate.mjs?fair=${Date.now()}`);
  const first = await gate.acquire(null, 'search', { ownerKey: 'session-a' });
  const order = [];
  const a1 = gate.acquire(null, 'search', { ownerKey: 'session-a' }).then((release) => {
    order.push('a');
    return release;
  });
  const a2 = gate.acquire(null, 'search', { ownerKey: 'session-a' }).then((release) => {
    order.push('a');
    return release;
  });
  const b1 = gate.acquire(null, 'search', { ownerKey: 'session-b' }).then((release) => {
    order.push('b');
    return release;
  });
  first();
  const next = await Promise.race([a1, b1]);
  next();
  const second = await (order[0] === 'a' ? b1 : a1);
  second();
  const last = await a2;
  last();
  assert.ok(order.indexOf('b') <= 1, `session-b starved behind owner fan-out: ${order}`);
});
