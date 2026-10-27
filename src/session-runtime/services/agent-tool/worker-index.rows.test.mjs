import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { flushAllIndexWritesSync } from './index-write-queue.mjs';
import { createWorkerIndex } from './worker-index.mjs';
import { isActiveWorkerRow } from './worker-index/row-liveness.mjs';
import { isActiveWorkerRow as isActiveAgentListRow } from './job-views/agent-list.mjs';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
// The worker index as its callers see it: a session upsert projects into the
// tag maps and the file, deferred upserts batch into one write, removals and
// reads honour the caller context, lead-pool projections are purged from the
// tag maps, and the parse cache follows the file.

function workerIndex(root, runtimeStage = 'streaming') {
  const tags = new Map();
  const tagAgents = new Map();
  const tagCwds = new Map();
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => ({ stage: runtimeStage }) },
    tags,
    tagAgents,
    tagCwds,
  });
  return { index, tags, tagAgents, tagCwds };
}

const stored = (root) => {
  flushAllIndexWritesSync(); // the index persists through an async writer queue
  return JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a worker row records Auto effort off from the session or an explicit spawn descriptor', () => {
  const root = makeTempDirSync('worker-rows-auto-effort');
  try {
    const { index } = workerIndex(root);
    index.upsertWorkerSession({ id: 'sess-off', agentTag: 'off', agent: 'worker', autoEffort: false }, '', {});
    index.upsertWorkerSession({ id: 'sess-spawn', agentTag: 'spawn', agent: 'worker' }, '', { autoEffort: false });
    index.upsertWorkerSession({ id: 'sess-on', agentTag: 'on', agent: 'worker', autoEffort: false }, '', {
      autoEffort: true,
    });
    const rows = Object.fromEntries(Object.values(stored(root).workers).map((row) => [row.tag, row]));
    assert.equal(rows.off.autoEffort, false);
    assert.equal(rows.spawn.autoEffort, false);
    assert.equal(Object.hasOwn(rows.on, 'autoEffort'), false);
    assert.equal(
      index.readWorkerRows().find((row) => row.tag === 'off').autoEffort,
      false,
      'the stored row reads back with the flag'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a session upsert projects into the tag maps and the file; deferred upserts land in one batched write', async () => {
  const root = makeTempDirSync('worker-rows');
  try {
    const { index, tags, tagAgents, tagCwds } = workerIndex(root);
    const session = {
      id: 'sess-alpha',
      agentTag: 'alpha',
      agent: 'worker',
      cwd: '/work/alpha',
      provider: 'openai',
      model: 'gpt-5',
      parentSessionId: 'lead-1',
      messages: [1, 2, 3],
      tools: [1],
    };
    assert.equal(index.upsertWorkerSession(session, '', { status: 'running' }), true);
    assert.equal(tags.get('alpha'), 'sess-alpha');
    assert.equal(tagAgents.get('alpha'), 'worker');
    assert.equal(tagCwds.get('alpha'), '/work/alpha');
    const row = Object.values(stored(root).workers)[0];
    assert.equal(row.tag, 'alpha');
    assert.equal(row.sessionId, 'sess-alpha');
    assert.equal(row.ownerSessionId, 'lead-1');
    assert.equal(row.status, 'running');
    assert.equal(row.stage, 'streaming');
    assert.equal(row.runtimePid, process.pid);
    assert.equal(row.messages, 3);
    assert.equal(row.tools, 1);
    assert.equal(row.fast, null);
    assert.equal(Object.hasOwn(row, 'autoEffort'), false, 'Auto effort on is the absent default');

    index.upsertWorkerSessionDeferred({ id: 'sess-beta' }, 'beta', { status: 'idle' });
    index.upsertWorkerSessionDeferred({ id: 'sess-gamma' }, 'gamma', { status: 'idle' });
    assert.equal(Object.keys(stored(root).workers).length, 1, 'deferred rows wait for the batch');
    assert.equal(tags.get('beta'), 'sess-beta', 'tag maps update immediately');
    await settle();
    assert.deepEqual(
      Object.values(stored(root).workers)
        .map((r) => r.tag)
        .sort(),
      ['alpha', 'beta', 'gamma']
    );
    assert.deepEqual(
      index.readWorkerRows({ callerSessionId: 'lead-1' }).map((r) => r.tag),
      ['alpha']
    );
    assert.equal(index.readWorkerRows().length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a working status never stores an idle/done/error runtime phase as its stage; the status decides liveness', () => {
  const root = makeTempDirSync('worker-rows-phase');
  try {
    for (const phase of ['idle', 'done', 'error']) {
      const { index } = workerIndex(root, phase);
      index.upsertWorkerSession({ id: `sess-${phase}`, agentTag: phase, agent: 'worker' }, '', { status: 'running' });
    }
    const rows = Object.values(stored(root).workers);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, 'running');
      assert.equal(row.stage, 'running', `runtime phase of ${row.tag}`);
      assert.equal(isActiveWorkerRow(row), true);
    }
    // A settled status keeps the phase it was written with.
    const { index } = workerIndex(root, 'done');
    index.upsertWorkerSession({ id: 'sess-settled', agentTag: 'settled', agent: 'worker' }, '', { status: 'idle' });
    assert.equal(Object.values(stored(root).workers).find((row) => row.tag === 'settled').stage, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker liveness predicates follow the status; the stage decides only without one; a cancel is never work', () => {
  for (const isActive of [isActiveWorkerRow, isActiveAgentListRow]) {
    for (const stage of ['idle', 'done', 'error']) assert.equal(isActive({ status: 'running', stage }), true, stage);
    assert.equal(isActive({ status: 'idle', stage: 'streaming' }), false);
    assert.equal(isActive({ status: 'running', stage: 'cancelled' }), false);
    assert.equal(isActive({ status: 'cancelled', stage: 'running' }), false);
    assert.equal(isActive({ stage: 'streaming' }), true);
    assert.equal(isActive({ stage: 'idle' }), false);
    assert.equal(isActive({ status: 'running', stage: 'cancelling' }), true);
  }
});

test('removeWorkerRow commits the queue first and drops by tag or session', async () => {
  const root = makeTempDirSync('worker-rows');
  try {
    const { index } = workerIndex(root);
    index.upsertWorkerSessionDeferred({ id: 's1' }, 'one', { status: 'idle' });
    index.upsertWorkerSessionDeferred({ id: 's2' }, 'two', { status: 'idle' });
    index.upsertWorkerSessionDeferred({ id: 's3' }, 'three', { status: 'idle' });
    index.removeWorkerRow({ tag: 'one' });
    assert.deepEqual(
      Object.values(stored(root).workers)
        .map((r) => r.tag)
        .sort(),
      ['three', 'two']
    );
    index.removeWorkerRow({ sessionId: 's3' });
    assert.deepEqual(
      Object.values(stored(root).workers).map((r) => r.tag),
      ['two']
    );
    await settle();
    assert.deepEqual(
      Object.values(stored(root).workers).map((r) => r.tag),
      ['two']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refreshTagsFromIndex binds worker rows; lead-pool projections and tagless rows never reach the maps', () => {
  const root = makeTempDirSync('worker-rows');
  try {
    const { index, tags, tagAgents, tagCwds } = workerIndex(root);
    writeFileSync(
      join(root, 'agent-workers.json'),
      JSON.stringify({
        workers: {
          w: { tag: 'w', sessionId: 'sess-w', agent: 'worker', cwd: '/w', ownerSessionId: 'lead-1' },
          lead: { tag: 'lead:lead-1', sessionId: 'lead-1', agent: 'lead', ownerSessionId: 'lead-1' },
          broken: { tag: '', sessionId: 'no-tag' },
        },
      })
    );
    index.invalidateWorkerRowsCache();
    const rows = index.refreshTagsFromIndex();
    assert.deepEqual(
      rows.map((r) => r.tag),
      ['w']
    );
    assert.deepEqual([...tags], [['w', 'sess-w']]);
    assert.deepEqual([...tagAgents], [['w', 'worker']]);
    assert.deepEqual([...tagCwds], [['w', '/w']]);
    assert.deepEqual(index.readAllTagTombstones(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the parse cache serves repeated reads and refreshes after an external rewrite', () => {
  const root = makeTempDirSync('worker-rows');
  try {
    const { index } = workerIndex(root);
    index.upsertWorkerSession({ id: 's1' }, 'one', { status: 'idle' });
    const first = index.readAllWorkerRows();
    assert.equal(index.readAllWorkerRows(), first, 'same array while the file is unchanged');
    const file = join(root, 'agent-workers.json');
    flushAllIndexWritesSync(); // land this process's write before an external rewrite
    const current = JSON.parse(readFileSync(file, 'utf8'));
    current.workers.extra = { tag: 'two', sessionId: 's2', status: 'idle' };
    writeFileSync(file, `${JSON.stringify(current)}\n`);
    assert.deepEqual(
      index
        .readAllWorkerRows()
        .map((r) => r.tag)
        .sort(),
      ['one', 'two']
    );
    rmSync(file);
    assert.deepEqual(index.readAllWorkerRows(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
