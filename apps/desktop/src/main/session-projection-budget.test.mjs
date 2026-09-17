import assert from 'node:assert/strict';
import test from 'node:test';
import { viewSyncHost } from './test-support/view-sync-host.mjs';

test('oversized cold reads, visible re-entry, and multi-session replay never deliver empty history', async (t) => {
  const f = await viewSyncHost();
  t.after(() => f.close());
  const text = 'history '.repeat(1_200_000);
  for (const id of ['large_a', 'large_b']) {
    f.records.set(id, {
      id, revision: 1,
      snapshot: { sessionId: id, items: [{ id: 'answer', kind: 'assistant', text }], queued: [], busy: false },
    });
  }
  const updates = [];
  f.host.subscribeSessionStates((update) => updates.push(update));
  await f.host.prefetchSession('large_a');
  assert.equal(updates.at(-1).snapshot.items[0].text, text);
  await f.host.setVisibleSessions(['large_a']);
  assert.equal(updates.at(-1).snapshot.items[0].text, text);
  let replay;
  await f.host.replaySessionStates(['large_a', 'large_b'], (values) => { replay = values; });
  assert.deepEqual(replay.map((row) => row.sessionId), ['large_a', 'large_b']);
  assert.ok(replay.every((row) => row.snapshot.items[0].text === text));
  await f.host.setVisibleSessions([]);
  const before = f.state.reads;
  await f.host.prefetchSession('large_a');
  assert.equal(f.state.reads, before + 1, 'an evicted baseline requests a full frame immediately');
  assert.equal(updates.at(-1).snapshot.items[0].text, text);
});

test('a failed replay delivery releases its holds and later replay still returns complete data', async (t) => {
  const f = await viewSyncHost();
  t.after(() => f.close());
  const text = 'retained '.repeat(1_200_000);
  f.records.set('large', {
    id: 'large', revision: 1,
    snapshot: { sessionId: 'large', items: [{ id: 'answer', kind: 'assistant', text }], queued: [], busy: false },
  });
  await assert.rejects(f.host.replaySessionStates(['large'], () => {
    throw new Error('delivery refused');
  }), /delivery refused/);
  let replay;
  await f.host.replaySessionStates(['large'], (values) => { replay = values; });
  assert.equal(replay[0].snapshot.items[0].text, text);
});
