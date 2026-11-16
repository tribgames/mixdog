import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionLaneStore } from './session-lane-store.ts';
import { mergeToolRows, rowsOf } from '../../../../packages/protocol-client/src/rows.ts';
import { prependHistoryPage, appendHistoryPage } from './transcript-history.ts';
import { sessionReducer, desktopSessionState } from '../../../../packages/protocol-client/src/session-state.ts';

const decorator = {
  decorate: (snapshot) => snapshot,
  clear() {},
};

test('compaction history and live windows retain one activity, summary and boundary in source order', () => {
  const tool = (id) => ({ type: 'toolCall', id, name: 'read', input: { path: 'src' }, run: { callId: id, result: 'ok' }, meta: { status: 'completed', ext: { archived: true } } });
  const divider = { type: 'contextCompaction', id: 'divider:c1', meta: {} };
  const summary = { type: 'agentMessage', id: 'summary', text: 'Investigation summary', meta: { ext: { archived: true, dividersAfter: [divider] } } };
  const prompt = { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Continue' }], meta: {} };
  const history = [tool('read-1'), tool('read-2'), summary];
  const page = mergeToolRows(history.flatMap(rowsOf));
  const tail = mergeToolRows([divider, prompt].flatMap(rowsOf));
  const expected = ['read-1', 'summary', 'divider:c1', 'prompt'];
  const older = prependHistoryPage({ items: tail, hasOlder: true, hasNewer: false }, page, false);
  assert.deepEqual(older.items.map((row) => row.id), expected, 'the page carries the same boundary as the live tail');
  const newer = appendHistoryPage({ items: page, hasOlder: false, hasNewer: true }, tail, false);
  assert.deepEqual(newer.items.map((row) => row.id), expected, 'paging forward crosses that same boundary');

  const snapshot = (items) => ({ thread: { id: 'compaction-merge' }, items, state: {} });
  const initial = sessionReducer.initial(snapshot([...history, prompt]));
  assert.deepEqual(desktopSessionState(initial, []).items.map((row) => row.id), expected, 'initial and history projection share the boundary expansion');
  let live = sessionReducer.initial(snapshot([divider, prompt]));
  for (const item of history) live = sessionReducer.apply(live, { method: 'item/completed', params: { item } });
  assert.deepEqual(desktopSessionState(live, []).items.map((row) => row.id), ['divider:c1', 'prompt'], 'unheld archived rows do not enter below the divider');

  const store = createSessionLaneStore({ decorator });
  const apply = (items) => store.apply({ sessionId: 'compaction-merge', frameSource: 'live', snapshot: { sessionId: 'compaction-merge', items } });
  apply(older.items);
  apply(tail);
  assert.deepEqual(store.get('compaction-merge').items.map((row) => row.id), expected);
  // A wider history source can start at an id already on screen while carrying
  // earlier rows under its restored ids. The full overlap, not the first id,
  // identifies which window owns the head.
  apply([
    { ...page[0], id: 'restored-activity' },
    { ...page[1], id: 'restored-summary' },
    ...tail,
  ]);
  assert.deepEqual(store.get('compaction-merge').items.map((row) => row.id), ['restored-activity', 'restored-summary', 'divider:c1', 'prompt']);
  store.clear();

  const activity = page[0];
  const answer = page[1];
  apply([activity, answer, { ...activity, id: 'second-activity' }, { ...answer, id: 'second-summary' }]);
  const restored = [
    { ...activity, id: 'second-activity' }, { ...answer, id: 'second-summary' },
    { ...activity, id: 'restored-second-activity' }, { ...answer, id: 'restored-second-summary' },
    ...tail,
  ];
  apply(restored);
  assert.deepEqual(
    store.get('compaction-merge').items,
    [activity, answer, ...restored],
    'distinct source ids preserve genuinely repeated activity and summary rows'
  );
  store.clear();
});

test('source ids retain repeated turns after the production identity cache evicts their baseline', () => {
  const store = createSessionLaneStore();
  const turn = (n) => [
    { id: `u${n}`, kind: 'user', text: 'Continue' },
    { id: `a${n}`, kind: 'assistant', text: 'Done' },
  ];
  const apply = (sessionId, items) => store.apply({
    sessionId, frameSource: 'live', snapshot: { sessionId, items },
  });
  try {
    apply('identity-evicted', [...turn(1), ...turn(2)]);
    for (let n = 0; n < 12; n += 1) apply(`visited-${n}`, turn(n));
    assert.deepEqual(store.get('identity-evicted').items.map((row) => row.id), ['u1', 'a1', 'u2', 'a2']);
    apply('identity-evicted', [...turn(2), ...turn(3)]);
    assert.deepEqual(
      store.get('identity-evicted').items.map((row) => row.id),
      ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'],
      'shared source ids preserve the cached head despite identical turn text'
    );
  } finally {
    store.clear();
  }
});

test('inactive lane updates do not retain notification keys', () => {
  const store = createSessionLaneStore({ maxEntries: 8, decorator });
  for (let index = 0; index < 40; index += 1) {
    store.apply({
      sessionId: `session-${index}`,
      snapshot: { sessionId: `session-${index}`, items: [] },
      frameSource: 'session.read',
    });
  }
  assert.equal(store.stats().entries, 8);
  assert.equal(store.stats().subscribedSessions, 0);
  assert.equal(store.stats().notificationKeys, 0);
});

const approvalFrame = (sessionId, extra = {}) => ({
  sessionId,
  snapshot: { sessionId, items: [], toolApproval: { id: `ap-${sessionId}`, tool: 'shell' }, ...extra },
  frameSource: 'live',
});

function watchApprovals(store) {
  const seen = { count: 0 };
  const stop = store.subscribeApprovals(() => {
    seen.count += 1;
  });
  return { seen, stop };
}

test('evictInactive drops approval membership of evicted lanes only', () => {
  const store = createSessionLaneStore({ decorator });
  store.apply(approvalFrame('idle'));
  store.apply(approvalFrame('mounted'));
  const release = store.subscribe('mounted', () => {});
  const { seen, stop } = watchApprovals(store);
  store.evictInactive();
  assert.deepEqual([...store.approvalSessionIds()], ['mounted']);
  assert.equal(seen.count, 1);
  store.evictInactive();
  assert.equal(seen.count, 1, 'no change, no notification');
  stop();
  release();
  store.clear();
});

test('pruning a cached lane drops its approval membership', () => {
  const store = createSessionLaneStore({ maxEntries: 1, decorator });
  store.apply(approvalFrame('first'));
  const { seen, stop } = watchApprovals(store);
  store.apply({ sessionId: 'second', snapshot: { sessionId: 'second', items: [] }, frameSource: 'live' });
  assert.equal(store.get('first'), null);
  assert.equal(store.approvalSessionIds().size, 0);
  assert.equal(seen.count, 1);
  stop();
  store.clear();
});

test('releasing the last subscriber of an oversized lane drops its approval membership', () => {
  const store = createSessionLaneStore({ maxBytes: 1_024, decorator });
  const bulk = 'x'.repeat(20_000);
  const release = store.subscribe('big', () => {});
  store.apply(approvalFrame('big', { items: [{ id: 'row', kind: 'assistant', text: bulk }] }));
  assert.deepEqual([...store.approvalSessionIds()], ['big']);
  const { seen, stop } = watchApprovals(store);
  release();
  assert.equal(store.get('big'), null);
  assert.equal(store.approvalSessionIds().size, 0);
  assert.equal(seen.count, 1);
  stop();
  store.clear();
});

// Background shell jobs are injected by the desktop host, never by the session
// runtime: a snapshot returned by a runtime call (slash command, model/Fast
// switch, workflow change) omits the field entirely, and adopting it whole
// blanked the live-work card while a shell was still running.
test('a frame that omits shell jobs keeps the last host bucket', () => {
  const store = createSessionLaneStore({ decorator });
  const running = { count: 1, jobs: [{ taskId: 'task-1', command: 'run.ps1', startedAt: 1 }] };
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', shellJobs: running },
    frameSource: 'live',
  });
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', model: 'gpt-5.6-sol' },
    frameSource: 'live',
  });
  assert.deepEqual(store.get('session').shellJobs, running);
  // A host frame ALWAYS names the bucket, so a finished shell still clears.
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', shellJobs: { count: 0, jobs: [] } },
    frameSource: 'live',
  });
  assert.equal(store.get('session').shellJobs.count, 0);
  store.clear();
});

// The session runtime republishes the DERIVED context-window fields as 0 — not
// absent — whenever its own route comparison misses, and a 0 denominator made
// the gauge fall back to its last complete reading: after an auto-compact it
// then froze on the pre-compact number for the rest of the session.
test('a frame that zeroes the context window keeps the last known limit', () => {
  const store = createSessionLaneStore({ decorator });
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stats: { currentEstimatedContextTokens: 258_500 },
      contextWindow: 272_000,
      displayContextWindow: 272_000,
      autoCompactTokenLimit: 272_000,
    },
    frameSource: 'live',
  });
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'anthropic',
      model: 'claude-opus-5',
      stats: { currentEstimatedContextTokens: 25_000 },
      contextWindow: 0,
      displayContextWindow: 0,
      autoCompactTokenLimit: 0,
    },
    frameSource: 'live',
  });
  const compacted = store.get('session');
  assert.equal(compacted.autoCompactTokenLimit, 272_000);
  assert.equal(compacted.displayContextWindow, 272_000);
  assert.equal(compacted.stats.currentEstimatedContextTokens, 25_000);

  // A real route change drops the previous window instead of dividing the new
  // model's usage by the old model's limit.
  store.apply({
    sessionId: 'session',
    snapshot: {
      sessionId: 'session',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      stats: { currentEstimatedContextTokens: 25_000 },
      autoCompactTokenLimit: 0,
    },
    frameSource: 'live',
  });
  assert.equal(Number(store.get('session').autoCompactTokenLimit) || 0, 0);
  store.clear();
});

test('a daemon eviction or transport loss keeps the cached lane', () => {
  const store = createSessionLaneStore({ decorator });
  const seen = [];
  store.subscribe('session', () => {
    seen.push(store.get('session'));
  });
  const snapshot = { sessionId: 'session', items: [{ id: 'a' }] };
  store.apply({ sessionId: 'session', snapshot, frameSource: 'live' });
  assert.equal(store.get('session'), snapshot);

  // The daemon reclaimed an idle session's memory; the transcript still exists.
  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'unloaded',
  });
  assert.equal(store.get('session'), snapshot);

  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'disconnected',
  });
  assert.equal(store.get('session'), snapshot);

  // A real teardown still empties the pane.
  store.apply({
    sessionId: 'session',
    snapshot: null,
    frameSource: 'live',
    laneEnd: 'gone',
  });
  assert.equal(store.get('session'), null);
  store.clear();
});

test('a transport baseline release keeps a mounted pane painted', () => {
  const store = createSessionLaneStore({ decorator });
  store.subscribe('session', () => {});
  const snapshot = { sessionId: 'session', items: [{ id: 'a' }] };
  store.apply({ sessionId: 'session', snapshot, frameSource: 'live' });
  assert.equal(store.get('session'), snapshot);

  // The host releases a delta baseline with an UNNAMED null frame whenever a
  // session leaves the visible set (ipc: releaseHiddenSessionStateEntries). One
  // registration that momentarily omits a mounted session used to erase the
  // pane mid-turn; the frame releases a baseline, never the painted content.
  store.apply({ sessionId: 'session', snapshot: null });
  assert.equal(store.get('session'), snapshot);
  store.clear();
});

// A byte-budgeted older page can start at any row, and its first row can be
// the same weak kind as the cached window's last row (two turn completions).
// Read as a tail window aligned at that row, the cached head was glued in
// front of the page: the older rows painted below the newest turn.
test('an older page that starts before the cached window replaces it as a prepend', () => {
  const rows = [
    { kind: 'turndone' },
    { kind: 'user', text: 'first question' },
    { kind: 'assistant', text: 'first answer' },
    { kind: 'turndone' },
    { kind: 'user', text: 'second question' },
    { kind: 'assistant', text: 'second answer' },
    { kind: 'turndone' },
  ];
  const cached = rows.slice(4);
  const paged = rows.slice(0);
  for (const withIds of [false, true]) {
    const withId = (items, from) =>
      withIds ? items.map((item, index) => ({ ...item, id: `h${from + index}` })) : items;
    const store = createSessionLaneStore({ decorator });
    store.apply({
      sessionId: 'session',
      snapshot: { sessionId: 'session', items: withId(cached, 4) },
      frameSource: 'live',
    });
    const page = withId(paged, 0);
    if (withIds) page[0] = { ...page[0], id: 'h6' };
    store.apply({ sessionId: 'session', snapshot: { sessionId: 'session', items: page }, frameSource: 'replay' });
    assert.deepEqual(
      store.get('session').items.map((item) => item.text ?? item.kind),
      paged.map((item) => item.text ?? item.kind),
      withIds ? 'a page row carrying the cached tail id' : 'rows matched by content'
    );
    // A genuine tail window still keeps the cached head.
    store.apply({
      sessionId: 'session',
      snapshot: {
        sessionId: 'session',
        items: [...withId(paged.slice(5), 5), ...withId([{ kind: 'user', text: 'third' }], 7)],
      },
      frameSource: 'live',
    });
    assert.deepEqual(
      store.get('session').items.map((item) => item.text ?? item.kind),
      [...paged, { text: 'third' }].map((item) => item.text ?? item.kind)
    );
    store.clear();
  }
});

test('unsubscribing releases a lane notification key', () => {
  const store = createSessionLaneStore({ decorator });
  const unsubscribe = store.subscribe('session', () => {});
  store.apply({
    sessionId: 'session',
    snapshot: { sessionId: 'session', items: [] },
    frameSource: 'session.read',
  });
  assert.equal(store.stats().notificationKeys, 1);
  unsubscribe();
  assert.equal(store.stats().notificationKeys, 0);
  store.clear();
});
