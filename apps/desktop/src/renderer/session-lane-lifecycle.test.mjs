import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
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
function laneFrame(sessionId, rows, resultChars) {
  const items = [];
  for (let index = 0; index < rows; index += 1) {
    const turn = Math.floor(index / 3);
    if (index % 3 === 0) items.push({ id: `${sessionId}-u${turn}`, kind: 'user', text: `Fix step ${turn}` });
    else if (index % 3 === 1) {
      const output = `PS C:\\Project\\mixdog> npm test # ${sessionId} ${turn}\n`.padEnd(resultChars, 'ok 1 - passes\n');
      items.push({
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
            args: { command: 'npm test', cwd: 'C:\\Project\\mixdog' },
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
      });
    } else items.push({ id: `${sessionId}-a${turn}`, kind: 'assistant', text: `Step ${turn} is done.`.repeat(20) });
  }
  return {
    sessionId,
    items,
    transcriptHasOlder: true,
    busy: false,
    provider: 'openai',
    model: 'gpt-5.5',
    effort: 'high',
    cwd: 'C:\\Project\\mixdog',
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
  skip: typeof globalThis.gc !== 'function',
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
