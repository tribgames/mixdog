import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { enforceRendererCacheBudget, totalBudgetedChars } from './renderer-cache-budget.ts';
import { RendererLruCache } from './renderer-lru-cache.ts';
import { createSessionLaneStore } from './session-lane-store.ts';
import { createTranscriptSnapshotDecorator } from './snapshot-transcript-decoration.ts';

const decorator = { decorate: (snapshot) => snapshot, clear() {} };
function update(store, sessionId, text = '') {
  const snapshot = { sessionId, items: text ? [{ id: 'answer', text }] : [] };
  store.apply({ sessionId, snapshot, frameSource: 'live' });
  return snapshot;
}

test('a grown lane stays mounted until its last pane closes, then releases an oversized frame', () => {
  const store = createSessionLaneStore({ maxBytes: 4_096, decorator });
  const first = store.subscribe('large', () => {});
  const second = store.subscribe('large', () => {});
  update(store, 'large');
  const large = update(store, 'large', 'x'.repeat(32_000));
  first();
  assert.equal(store.get('large'), large);
  second();
  assert.equal(store.get('large'), null);
  assert.deepEqual(store.stats(), { entries: 0, estimatedBytes: 0, subscribedSessions: 0, notificationKeys: 0 });
});

test('an oversized release does not evict another useful small cached lane', () => {
  const store = createSessionLaneStore({ maxBytes: 4_096, decorator });
  const small = update(store, 'small', 'keep');
  const close = store.subscribe('large', () => {});
  update(store, 'large');
  update(store, 'large', 'x'.repeat(32_000));
  close();
  assert.equal(store.get('small'), small);
  assert.equal(store.get('large'), null);
  store.clear();
});

test('a shown lane counts in the renderer cache budget, which lets hidden lanes go before it', () => {
  const store = createSessionLaneStore({ decorator, budget: true });
  const baseline = totalBudgetedChars();
  update(store, 'hidden', 'h'.repeat(20_000));
  const close = store.subscribe('shown', () => {});
  update(store, 'shown', 'x'.repeat(40_000));
  const counted = totalBudgetedChars() - baseline;
  assert.ok(counted >= 60_000, `the lanes count ${counted} characters`);
  assert.ok(store.stats().estimatedBytes >= 120_000, 'the shown lane is in the estimate');
  enforceRendererCacheBudget(baseline + 45_000);
  assert.equal(store.get('hidden'), null, 'the hidden lane makes room');
  assert.notEqual(store.get('shown'), null, 'the shown lane stays');
  close();
  store.clear();
});

test('lanes shown past the budget leave the other caches their reserve', () => {
  const store = createSessionLaneStore({ decorator, budget: true });
  const other = new RendererLruCache({
    name: 'lane-reserve-probe',
    maxEntries: 8,
    maxChars: 1_000_000,
    measure: (value) => value.length,
  });
  const close = store.subscribe('shown', () => {});
  update(store, 'shown', 'x'.repeat(40_000));
  other.set('kept', 'y'.repeat(5_000));
  // The shown lane alone is past this budget; a quarter of it stays the other caches'.
  enforceRendererCacheBudget(30_000);
  assert.equal(other.get('kept')?.length, 5_000, 'the other cache keeps what fits its reserve');
  assert.notEqual(store.get('shown'), null);
  other.dispose();
  close();
  store.clear();
});

test('a lane a pane shows, or is about to show, is never let go by the budget', () => {
  const store = createSessionLaneStore({ decorator, budget: true });
  store.setShownSessionIds(['pane-a', 'pane-b']);
  const close = store.subscribe('pane-a', () => {});
  update(store, 'pane-a', 'a'.repeat(20_000));
  // Pane b's frame lands before its pane subscribes; a new task's lane is seeded before its pane shows it.
  update(store, 'pane-b', 'b'.repeat(20_000));
  store.seedCreatedSession('created', { sessionId: 'created', items: [{ id: 'c', text: 'c'.repeat(20_000) }] });
  store.seedPreview('previewed', { sessionId: 'previewed', items: [{ id: 'p', text: 'p'.repeat(20_000) }] });
  update(store, 'hidden', 'h'.repeat(20_000));
  // No shown-set update since the seeds: whether a pane shows them is not settled.
  enforceRendererCacheBudget(1_000);
  assert.notEqual(store.get('pane-b'), null, 'the lane a pane shows stays');
  assert.ok(store.liveSessionIds().has('pane-b'));
  assert.notEqual(store.get('created'), null, 'a seeded lane waits for the shown set');
  assert.notEqual(store.get('previewed'), null, 'a seeded preview waits for the shown set');
  assert.equal(store.get('hidden'), null, 'a lane no pane shows makes room');
  // The next shown set settles the seeds: the one a pane shows stays, the one left out goes like any hidden lane.
  store.setShownSessionIds(['pane-a', 'pane-b', 'created']);
  enforceRendererCacheBudget(1_000);
  assert.notEqual(store.get('created'), null, 'the seed a pane shows is kept as shown');
  assert.equal(store.get('previewed'), null, 'the seed no pane shows makes room');
  assert.notEqual(store.get('pane-b'), null);
  close();
  store.clear();
});

test('a released callback cannot unsubscribe a replacement pane', () => {
  const store = createSessionLaneStore({ decorator });
  const old = store.subscribe('same', () => {});
  old();
  let calls = 0;
  const current = store.subscribe('same', () => {
    calls += 1;
  });
  old();
  update(store, 'same');
  assert.equal(calls, 1);
  assert.deepEqual(store.subscribedSessionIds(), ['same']);
  current();
  store.clear();
});

// A decorated renderer lane as the desktop host publishes it: a transcript
// window of user / tool-card / assistant rows (a live tool card carries both
// the shown and the raw result text), plus the host-injected read-outs.
function toolCardRow(sessionId, turn, resultChars) {
  const output = `PS C:\\Project\\sample> npm test # ${sessionId} ${turn}\n`.padEnd(resultChars, 'ok 1 - passes\n');
  return {
    id: `${sessionId}-t${turn}`,
    kind: 'tool',
    name: 'shell',
    count: 1,
    completedCount: 1,
    headerFinalized: true,
    calls: [
      {
        callId: `${sessionId}-c${turn}`,
        name: 'shell',
        args: { command: 'npm test', cwd: 'C:\\Project\\sample' },
        category: 'shell',
        summary: 'npm test',
        isError: false,
        exitCode: 0,
        resultText: output,
        rawResultText: `${output}\n`,
        resolved: true,
        startedAt: 1,
        completedAt: 2,
      },
    ],
  };
}

function laneFrame(sessionId, rows, resultChars) {
  const items = [];
  for (let index = 0; index < rows; index += 1) {
    const turn = Math.floor(index / 3);
    if (index % 3 === 0) items.push({ id: `${sessionId}-u${turn}`, kind: 'user', text: `Fix step ${turn}` });
    else if (index % 3 === 1) items.push(toolCardRow(sessionId, turn, resultChars));
    else items.push({ id: `${sessionId}-a${turn}`, kind: 'assistant', text: `Step ${turn} is done.`.repeat(20) });
  }
  return {
    sessionId,
    items,
    transcriptHasOlder: true,
    busy: false,
    provider: 'openai',
    model: 'gpt-5.5',
    effort: 'high',
    cwd: 'C:\\Project\\sample',
    stats: { inputTokens: 120_000, outputTokens: 8_000 },
    contextWindow: 400_000,
    promptHistoryList: ['Fix step 1', 'Fix step 2'],
    shellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
    hostShellJobs: { count: 0, elapsedLabel: '', jobs: [], finished: [] },
    remoteEnabled: false,
    remoteSessionId: null,
  };
}

function realisticStore() {
  return createSessionLaneStore({ decorator: createTranscriptSnapshotDecorator({ register: false }) });
}

test('mounted panes never starve the lane the user just left out of the background budget', () => {
  const store = realisticStore();
  // Three split panes and the pet's Mixy chat stay mounted with grown live
  // transcripts that together fill most of the default background budget.
  const mounted = ['pane-a', 'pane-b', 'pane-c'].map((id) => {
    const release = store.subscribe(id, () => {});
    store.apply({ sessionId: id, snapshot: laneFrame(id, 268, 24_000), frameSource: 'replay' });
    return release;
  });
  // The user opens a session in the fourth pane (a first 32-row tail) and
  // moves that pane on to another task.
  const leave = store.subscribe('viewed', () => {});
  store.apply({ sessionId: 'viewed', snapshot: laneFrame('viewed', 32, 6_000), frameSource: 'replay' });
  leave();
  assert.notEqual(store.get('viewed'), null, 'returning to the session must not re-read it from the host');
  for (const release of mounted) release();
  store.clear();
});

test('inactive lanes stay within the byte budget, least recently viewed first', () => {
  const store = realisticStore();
  const view = (id) => {
    const leave = store.subscribe(id, () => {});
    store.apply({ sessionId: id, snapshot: laneFrame(id, 186, 20_000), frameSource: 'replay' });
    return leave;
  };
  const leaveFirst = view('first');
  // A background lane refreshes while the pane still shows `first`.
  for (const id of ['second', 'third', 'fourth', 'fifth']) view(id)();
  leaveFirst();
  const { estimatedBytes } = store.stats();
  assert.ok(estimatedBytes <= 24 * 1024 * 1024, `background lanes retain ${estimatedBytes} bytes`);
  assert.equal(store.get('second'), null, 'the least recently viewed lane is evicted');
  assert.notEqual(store.get('first'), null, 'the lane just left is the most recently viewed');
  store.clear();
});

test('repeated pane open/grow/close cycles release snapshots, subscriptions and frame work', {
  skip: typeof globalThis.gc !== 'function' && 'requires node --expose-gc (globalThis.gc is not exposed)',
}, async () => {
  const store = createSessionLaneStore({ maxEntries: 64, maxBytes: 4_096, decorator });
  const refs = [];
  for (let index = 0; index < 2_000; index += 1) {
    const id = `cycle-${index}`;
    const close = store.subscribe(id, () => {});
    update(store, id);
    refs.push(new WeakRef(update(store, id, `message-${index} ${'x'.repeat(8_000)}`)));
    close();
  }
  assert.deepEqual(store.stats(), { entries: 0, estimatedBytes: 0, subscribedSessions: 0, notificationKeys: 0 });
  for (let index = 0; index < 3; index += 1) {
    await setImmediate();
    globalThis.gc();
  }
  assert.ok(
    refs.every((ref) => !ref.deref()),
    'a live store must not pin closed oversized snapshots'
  );
  store.clear();
});
