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

test("only a creating operation's answer seeds a lane, and never over its stream or after the session is gone", () => {
  const store = createSessionLaneStore({ decorator });
  const rows = [
    { id: 'q1', role: 'user', text: 'hi' },
    { id: 'a1', role: 'assistant', text: 'hello' },
  ];
  const tail = { id: 'a2', kind: 'assistant', streaming: true, text: 'streaming\n' };
  // The stream already shows the newer value and the reply being streamed.
  store.apply({
    sessionId: 'reply',
    frameSource: 'live',
    snapshot: { sessionId: 'reply', items: rows, streamingTail: tail, orchestrationMode: 'swarm' },
  });
  const streamed = store.get('reply');
  // A late, transcript-less answer carrying an older value changes nothing.
  store.seedCreatedSession('reply', {
    sessionId: 'reply',
    items: [],
    streamingTail: null,
    orchestrationMode: 'balanced',
  });
  assert.equal(store.get('reply'), streamed);
  assert.equal(store.get('reply').streamingTail, tail);
  // A new task's or a fork's first state seeds its lane.
  store.seedCreatedSession('started', { sessionId: 'started', items: [], model: 'one' });
  assert.equal(store.get('started').model, 'one');
  // Another device deleted a session (the ordered `gone`): an answer that arrives afterwards cannot reinstall it.
  store.apply({ sessionId: 'deleted', frameSource: 'live', snapshot: { sessionId: 'deleted', items: rows } });
  store.apply({ sessionId: 'deleted', frameSource: 'live', snapshot: null, laneEnd: 'gone' });
  store.seedCreatedSession('deleted', { sessionId: 'deleted', items: [], model: 'stale' });
  assert.equal(store.get('deleted'), null);
  store.apply({ sessionId: 'never-shown', frameSource: 'live', snapshot: null, laneEnd: 'gone' });
  store.seedCreatedSession('never-shown', { sessionId: 'never-shown', items: [] });
  assert.equal(store.get('never-shown'), null, 'a session gone before its first frame is not seeded either');
});

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a received position is reached by a shown one at or past it, epochs ordered as they were received', async () => {
  const store = createSessionLaneStore({ decorator });
  const off = store.subscribe('s', () => {});
  const position = (order, seq) => ({ epoch: `e${order}`, seq, order });
  const frame = async (order, seq) => {
    store.apply({
      sessionId: 's',
      frameSource: 'live',
      snapshot: { sessionId: 's', items: [{ id: `${order}:${seq}`, role: 'user', text: 'x' }] },
      streamPosition: position(order, seq),
    });
    await nextFrame();
  };
  await frame(1, 3);
  const mark = position(1, 5);
  assert.equal(store.streamReached('s', mark), false);
  await frame(1, 4);
  assert.equal(store.streamReached('s', mark), false);
  store.apply({
    sessionId: 's',
    frameSource: 'live',
    snapshot: { sessionId: 's', items: [{ id: 'late', role: 'user', text: 'x' }] },
    streamPosition: position(1, 5),
  });
  assert.equal(store.streamReached('s', mark), false, 'a state is shown at its position only with its notification');
  await nextFrame();
  assert.equal(store.streamReached('s', mark), true);
  await frame(2, 1);
  assert.equal(
    store.streamReached('s', position(1, 9)),
    true,
    'a later epoch was received after the mark: its state includes it'
  );
  assert.equal(store.streamReached('s', position(3, 2)), false, 'an epoch received but not yet shown is not reached');
  // The review's race: epoch B is shown while the call's position is still being read; the read then names B. Nothing of the
  // store's own history enters the comparison, so B's later frames reach it.
  await frame(4, 1);
  const readAfterB = position(4, 3);
  assert.equal(store.streamReached('s', readAfterB), false);
  await frame(4, 3);
  assert.equal(store.streamReached('s', readAfterB), true);
  off();
});

test("a pane leaving before its state's notification does not strand that state's position", async () => {
  const store = createSessionLaneStore({ decorator });
  const rows = [{ id: 'q1', role: 'user', text: 'hi' }];
  const leave = store.subscribe('s', () => {});
  store.apply({
    sessionId: 's',
    frameSource: 'live',
    snapshot: { sessionId: 's', items: rows, title: 'A' },
    streamPosition: { epoch: 'e', seq: 39, order: 1 },
  });
  await nextFrame();
  // Accepted at 40 with its (non-urgent) notification scheduled; the last pane unsubscribes before it runs.
  const snapshot = { sessionId: 's', items: rows, title: 'B' };
  store.apply({ sessionId: 's', frameSource: 'live', snapshot, streamPosition: { epoch: 'e', seq: 40, order: 1 } });
  assert.equal(
    store.streamReached('s', { epoch: 'e', seq: 40, order: 1 }),
    false,
    'the position waits for its notification'
  );
  leave();
  // A trailing note that changes nothing hands the same state on at 41; the feed then goes quiet.
  store.apply({ sessionId: 's', frameSource: 'live', snapshot, streamPosition: { epoch: 'e', seq: 41, order: 1 } });
  await nextFrame();
  const back = store.subscribe('s', () => {});
  assert.ok(store.get('s'), 'the returning pane reads the cached state');
  assert.equal(store.streamReached('s', { epoch: 'e', seq: 41, order: 1 }), true);
  back();
});

test('a state handed on unchanged moves only its position: nothing is decided again and the pane is not told', async () => {
  const store = createSessionLaneStore({ decorator });
  const snapshot = { sessionId: 's', items: [{ id: 'q1', role: 'user', text: 'hi' }] };
  let paneHeard = 0;
  let positionHeard = 0;
  const offPane = store.subscribe('s', () => (paneHeard += 1));
  const offPosition = store.subscribeStreamPosition('s', () => (positionHeard += 1));
  store.apply({ sessionId: 's', frameSource: 'live', snapshot, streamPosition: { epoch: 'e', seq: 4, order: 1 } });
  const shown = store.get('s');
  await new Promise((resolve) => setTimeout(resolve, 30));
  paneHeard = 0;
  store.apply({ sessionId: 's', frameSource: 'live', snapshot, streamPosition: { epoch: 'e', seq: 5, order: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.get('s'), shown);
  assert.equal(paneHeard, 0);
  assert.equal(positionHeard, 2);
  assert.deepEqual(store.streamPosition('s'), { epoch: 'e', seq: 5, order: 1 });
  offPane();
  offPosition();
});

test('compaction history and live windows retain one activity, summary and boundary in source order', () => {
  const tool = (id) => ({
    type: 'toolCall',
    id,
    name: 'read',
    input: { path: 'src' },
    run: { callId: id, result: 'ok' },
    meta: { status: 'completed', ext: { archived: true } },
  });
  const divider = { type: 'contextCompaction', id: 'divider:c1', meta: {} };
  const summary = {
    type: 'agentMessage',
    id: 'summary',
    text: 'Investigation summary',
    meta: { ext: { archived: true, dividersAfter: [divider] } },
  };
  const prompt = { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Continue' }], meta: {} };
  const history = [tool('read-1'), tool('read-2'), summary];
  const page = mergeToolRows(history.flatMap(rowsOf));
  const tail = mergeToolRows([divider, prompt].flatMap(rowsOf));
  const expected = ['read-1', 'summary', 'divider:c1', 'prompt'];
  const older = prependHistoryPage({ items: tail, hasOlder: true, hasNewer: false }, page, false);
  assert.deepEqual(
    older.items.map((row) => row.id),
    expected,
    'the page carries the same boundary as the live tail'
  );
  const newer = appendHistoryPage({ items: page, hasOlder: false, hasNewer: true }, tail, false);
  assert.deepEqual(
    newer.items.map((row) => row.id),
    expected,
    'paging forward crosses that same boundary'
  );

  const snapshot = (items) => ({ thread: { id: 'compaction-merge' }, items, state: {} });
  const initial = sessionReducer.initial(snapshot([...history, prompt]));
  assert.deepEqual(
    desktopSessionState(initial, []).items.map((row) => row.id),
    expected,
    'initial and history projection share the boundary expansion'
  );
  let live = sessionReducer.initial(snapshot([divider, prompt]));
  for (const item of history) live = sessionReducer.apply(live, { method: 'item/completed', params: { item } });
  assert.deepEqual(
    desktopSessionState(live, []).items.map((row) => row.id),
    ['divider:c1', 'prompt'],
    'unheld archived rows do not enter below the divider'
  );

  const store = createSessionLaneStore({ decorator });
  const apply = (items) =>
    store.apply({
      sessionId: 'compaction-merge',
      frameSource: 'live',
      snapshot: { sessionId: 'compaction-merge', items },
    });
  apply(older.items);
  apply(tail);
  assert.deepEqual(
    store.get('compaction-merge').items.map((row) => row.id),
    expected
  );
  // A wider history source can start at an id already on screen while carrying
  // earlier rows under its restored ids. The full overlap, not the first id,
  // identifies which window owns the head.
  apply([{ ...page[0], id: 'restored-activity' }, { ...page[1], id: 'restored-summary' }, ...tail]);
  assert.deepEqual(
    store.get('compaction-merge').items.map((row) => row.id),
    ['restored-activity', 'restored-summary', 'divider:c1', 'prompt']
  );
  store.clear();

  const activity = page[0];
  const answer = page[1];
  apply([activity, answer, { ...activity, id: 'second-activity' }, { ...answer, id: 'second-summary' }]);
  const restored = [
    { ...activity, id: 'second-activity' },
    { ...answer, id: 'second-summary' },
    { ...activity, id: 'restored-second-activity' },
    { ...answer, id: 'restored-second-summary' },
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
  const apply = (sessionId, items) =>
    store.apply({
      sessionId,
      frameSource: 'live',
      snapshot: { sessionId, items },
    });
  try {
    apply('identity-evicted', [...turn(1), ...turn(2)]);
    for (let n = 0; n < 12; n += 1) apply(`visited-${n}`, turn(n));
    assert.deepEqual(
      store.get('identity-evicted').items.map((row) => row.id),
      ['u1', 'a1', 'u2', 'a2']
    );
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

// The desktop grows a followed window (and re-follows a thread) with a new
// `thread/resume`, which the core answers with a whole `thread/snapshot` while
// the turn streams. Swapped in as new objects, every row on screen re-rendered,
// and the reply being streamed fell back to the next delta's text alone.
test('a snapshot that replaces the fold mid-turn keeps every unchanged row and the streamed reply', () => {
  const sessionId = 'snapshot-mid-turn';
  const thread = { id: sessionId };
  const user = (id, text) => ({
    type: 'userMessage',
    id,
    content: [{ type: 'text', text }],
    meta: { status: 'completed', at: 1 },
  });
  const reply = (id, text, status = 'completed') => ({ type: 'agentMessage', id, text, meta: { status, at: 2 } });
  const call = (id, live) => ({
    type: 'toolCall',
    id,
    name: 'read',
    input: { path: `src/${id}.ts` },
    output: `body ${id}`,
    run: { callId: `call-${id}`, result: `body ${id}`, ...(live ? { live: true, startedAt: 3, completedAt: 4 } : {}) },
    meta: { status: 'completed', at: 3 },
  });
  const history = [user('u1', 'first'), reply('a1', 'one'), call('t1'), call('t2'), user('u2', 'second')];
  const turn = [reply('a2', 'Reading.'), call('t3', true), call('t4', true)];
  const streamed = 'Now the long reply.\nLine two ';
  const state = { runtime: { busy: true } };

  const store = createSessionLaneStore();
  let fold = sessionReducer.initial({ thread, items: history, state, hasOlder: true });
  const publish = () => store.apply({ sessionId, frameSource: 'live', snapshot: desktopSessionState(fold, []) });
  const apply = (method, params) => {
    fold = sessionReducer.apply(fold, { jsonrpc: '2.0', method, params: { threadId: sessionId, ...params } });
    publish();
  };
  publish();
  for (const item of turn) apply('item/completed', { item });
  apply('item/started', { item: reply('a3', '', 'inProgress') });
  apply('item/agentMessage/delta', { itemId: 'a3', delta: streamed });
  const before = store.get(sessionId);
  assert.equal(before.streamingTail.text, streamed);

  // The window grown by older rows: the core's snapshot of the same rows, the reply still in progress.
  const older = [user('u0', 'zero'), reply('a0', 'zero answer')];
  fold = sessionReducer.initial({
    thread,
    items: [...older, ...history, ...turn, reply('a3', streamed, 'inProgress')],
    state,
    hasOlder: true,
  });
  publish();
  const grown = store.get(sessionId);
  assert.deepEqual(
    grown.items.slice(0, 2).map((row) => row.id),
    ['u0', 'a0']
  );
  assert.deepEqual(grown.items.slice(2), before.items);
  grown.items
    .slice(2)
    .forEach((row, index) => assert.equal(row, before.items[index], `row ${row.id} kept its identity`));
  assert.equal(grown.streamingTail, before.streamingTail, 'the streamed reply is the same live row');

  apply('item/agentMessage/delta', { itemId: 'a3', delta: 'continues.\n' });
  const next = store.get(sessionId);
  assert.equal(next.items, grown.items, 'a delta leaves every row as it was');
  assert.equal(next.streamingTail.text, `${streamed}continues.\n`);

  // The connection closes (a slow consumer) and the thread is followed again on the next one: a fresh fold of the core's
  // tail window, the reply grown meanwhile.
  const resumed = `${streamed}continues.\nMore.\n`;
  fold = sessionReducer.initial({
    thread,
    items: [...turn, reply('a3', resumed, 'inProgress')],
    state,
    hasOlder: true,
  });
  publish();
  const reconnected = store.get(sessionId);
  assert.equal(reconnected.items, grown.items, 'the rows on screen are the rows held, the same objects');
  assert.equal(reconnected.streamingTail.text, resumed);
  store.clear();
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
