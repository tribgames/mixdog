import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionIntakeApi } from './intake.mjs';

// Pins the prompt intake surface: how a submission is queued or deferred, how
// Esc reclaims an idle or in-flight prompt back into the draft, and the
// message rewind / reserved-session handshakes.
function createHarness({
  state: stateOverrides = {},
  flags: flagsOverrides = {},
  runtime: runtimeOverrides = {},
} = {}) {
  const calls = [];
  let state = {
    busy: false,
    commandBusy: false,
    items: [],
    promptHistoryList: [],
    sessionId: 'sess_r',
    stats: {},
    ...stateOverrides,
  };
  const flags = { autoClearRunning: false, activePromptRestore: null, disposed: false, ...flagsOverrides };
  const pending = [];
  const listeners = new Set();
  let ids = 0;
  let routeSessionId = null;
  const runtime = {
    reserveSessionId: (id) => {
      if (!id) return null;
      routeSessionId = id;
      return id;
    },
    rewindMessages: async ({ text }) => {
      calls.push(['rewindMessages', text]);
      return { removed: 3 };
    },
    interruptTaskWait: (reason) => calls.push(['interruptTaskWait', reason]),
    abort: (reason) => {
      calls.push(['runtime.abort', reason]);
      return true;
    },
    ...runtimeOverrides,
  };
  let restoreQueuedResult = null;
  const bag = {
    runtime,
    nextId: () => `auto-${++ids}`,
    flags,
    pending,
    listeners,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    flushEmitImmediate: () => calls.push('flush'),
    patchItem: () => {},
    replaceItems: (items) => items,
    restoreOlderTranscript: () => {},
    restoreNewerTranscript: () => {},
    routeState: () => ({ sessionId: routeSessionId ?? state.sessionId }),
    syncContextStats: (options) => calls.push(['syncContextStats', options]),
    denyAllToolApprovals: (reason) => calls.push(['denyAll', reason]),
    requeueEntriesFront: (entries) => calls.push(['requeueFront', entries]),
    enqueue: (text, options) => {
      calls.push(['enqueue', text, options.id, options.mode, options.awaitPersistence === true]);
      return true;
    },
    autoClearBeforeSubmit: async () => calls.push('autoClear'),
    restoreQueued: (_text, id) => {
      calls.push(['restoreQueued', id]);
      return restoreQueuedResult;
    },
    prioritizeQueued: () => {},
    drain: async () => calls.push('drain'),
    discardExecutionPendingResume: (keys) => calls.push(['discardPendingResume', keys]),
    cancelQueuedGoalContinuations: () => calls.push('cancelGoalContinuations'),
    archiveCompletedGoalOnUserInput: () => calls.push('archiveCompletedGoal'),
  };
  const api = createSessionIntakeApi(bag);
  return {
    api,
    calls,
    flags,
    pending,
    listeners,
    set: bag.set,
    setRestoreQueued: (value) => {
      restoreQueuedResult = value;
    },
    get state() {
      return state;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an idle submit runs auto-clear first and then enqueues with a minted id', async () => {
  const h = createHarness();
  assert.equal(h.api.submit('hello world'), true);
  // Auto-clear starts synchronously; the enqueue waits for it to settle.
  assert.deepEqual(h.calls, ['autoClear']);
  await tick();
  assert.deepEqual(h.calls, [
    'autoClear',
    ['enqueue', 'hello world', 'auto-1', 'prompt', false],
    'cancelGoalContinuations',
    'archiveCompletedGoal',
    ['interruptTaskWait', 'user-message'],
  ]);
  assert.equal(h.api.submit('   '), false);
});

test('a submit during a busy turn or a session command is queued immediately', () => {
  const busy = createHarness({ state: { busy: true } });
  assert.equal(busy.api.submit('steer', { id: 'given', mode: 'steer' }), true);
  assert.deepEqual(busy.calls, [
    ['enqueue', 'steer', 'given', 'steer', false],
    ['interruptTaskWait', 'user-message'],
  ]);

  const command = createHarness({ state: { commandBusy: true } });
  assert.equal(command.api.submit('after command'), true);
  assert.equal(command.calls[0][0], 'enqueue');
});

test('submitAsync requests persistence and kicks auto-clear without waiting on it', async () => {
  const h = createHarness();
  assert.equal(await h.api.submitAsync('durable'), true);
  assert.deepEqual(h.calls[0], 'autoClear');
  assert.deepEqual(h.calls[1], ['enqueue', 'durable', 'auto-1', 'prompt', true]);
});

test('Esc while idle hands a still-accepting submission back to the draft and cancels its enqueue', async () => {
  const h = createHarness();
  assert.equal(h.api.submit('reclaim me', { id: 'sub-1' }), true);
  const result = h.api.abort({ submissionId: 'sub-1' });
  assert.equal(result.aborted, false);
  assert.equal(result.restoreText, 'reclaim me');
  assert.deepEqual(result.restoredSubmissionIds, ['sub-1']);
  await tick();
  assert.ok(!h.calls.some((call) => call[0] === 'enqueue'));
  assert.equal(h.api.abort({ submissionId: 'sub-1' }), false);
  assert.equal(h.api.abort(), false);
});

test('Esc while idle restores a queued submission through restoreQueued', () => {
  const h = createHarness();
  h.setRestoreQueued({ count: 1, text: 'queued text', pastedImages: null, pastedTexts: null, ids: ['q-1'] });
  const result = h.api.abort({ submissionId: 'q-1' });
  assert.deepEqual(h.calls, [['restoreQueued', 'q-1']]);
  assert.equal(result.aborted, false);
  assert.equal(result.restoreText, 'queued text');
  assert.deepEqual(result.restoredSubmissionIds, ['q-1']);
});

test('aborting a live turn restores the in-flight prompt, its history slot and its requeue entries', () => {
  const restoreState = {
    restorable: true,
    committed: false,
    text: 'draft me',
    submittedIds: ['u1'],
    requeueEntries: [{ text: 'again' }, { text: 'dropped', abortDiscardOnAbort: true }, { mode: 'pending-resume' }],
    discardExecutionPendingResumeKeys: ['k1'],
    pastedImages: null,
    pastedTexts: null,
  };
  const h = createHarness({
    state: {
      busy: true,
      items: [
        { id: 'u1', kind: 'user', text: 'draft me' },
        { id: 'a1', kind: 'assistant', text: 'partial' },
      ],
      promptHistoryList: ['draft me', 'older'],
    },
    flags: { activePromptRestore: restoreState },
  });
  const result = h.api.abort();
  assert.deepEqual(h.calls, [
    ['denyAll', 'interrupted by user'],
    ['runtime.abort', 'user-cancel'],
    ['discardPendingResume', ['k1']],
    ['requeueFront', [{ text: 'again' }]],
  ]);
  assert.equal(result.aborted, true);
  assert.equal(result.restoreText, 'draft me');
  assert.deepEqual(result.restoredSubmissionIds, ['u1']);
  assert.equal(result.discardPastedImages, null);
  assert.deepEqual(
    h.state.items.map((item) => item.id),
    ['a1']
  );
  assert.deepEqual(h.state.promptHistoryList, ['older']);
  assert.equal(h.state.spinner, null);
  assert.equal(restoreState.restorable, false);
  assert.equal(restoreState.reclaimed, true);
  assert.deepEqual(restoreState.requeueEntries, []);
});

test('a queued steering prompt suppresses the restore and hands pasted attachments back for cleanup', () => {
  const pastedImages = { img1: { id: 'img1' } };
  const restoreState = {
    restorable: true,
    committed: true,
    text: 'interrupted',
    submittedIds: ['u1'],
    pastedImages,
    pastedTexts: null,
  };
  const h = createHarness({
    state: { busy: true, items: [{ id: 'u1', kind: 'user', text: 'interrupted' }], promptHistoryList: ['interrupted'] },
    flags: { activePromptRestore: restoreState },
  });
  h.pending.push({ mode: 'prompt', text: 'steer instead' });
  const result = h.api.abort();
  assert.deepEqual(h.calls, [
    ['denyAll', 'interrupted by user'],
    ['runtime.abort', 'interrupt'],
  ]);
  assert.equal(result.restoreText, '');
  assert.equal(result.discardPastedImages, pastedImages);
  assert.deepEqual(result.restoredSubmissionIds, []);
  assert.deepEqual(h.state.items.length, 1);
  assert.deepEqual(h.state.promptHistoryList, ['interrupted']);
  assert.equal(restoreState.restorable, false);
});

test('abort kicks the drain once the turn has unwound with queued work left behind', async () => {
  const h = createHarness({ state: { busy: true } });
  h.pending.push({ mode: 'prompt', text: 'queued' });
  h.api.abort({ restorePrompt: false });
  h.set({ busy: false });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.calls.at(-1), 'drain');
});

test('rewindToItem trims the transcript to the chosen prompt and returns it for editing', async () => {
  const h = createHarness({
    state: {
      items: [
        { id: 'u1', kind: 'user', text: 'first' },
        { id: 'a1', kind: 'assistant', text: 'one' },
        { id: 'u2', kind: 'user', text: 'second' },
        { id: 'a2', kind: 'assistant', text: 'two' },
      ],
      promptHistoryList: ['first', 'second'],
    },
  });
  assert.deepEqual(await h.api.rewindToItem('u2'), { text: 'second', removed: 2, messages: 3 });
  assert.deepEqual(h.calls, [['rewindMessages', 'second'], ['syncContextStats', { allowEstimated: true }], 'flush']);
  assert.deepEqual(
    h.state.items.map((item) => item.id),
    ['u1', 'a1']
  );
  assert.deepEqual(h.state.promptHistoryList, ['first']);
  assert.equal(h.state.commandBusy, false);

  assert.equal(await h.api.rewindToItem('missing'), null);
  assert.equal(await h.api.rewindToItem('a1'), null);
  h.set({ busy: true });
  assert.equal(await h.api.rewindToItem('u1'), null);
});

test('reserveSession publishes the reserved id and reports whether the route took it', () => {
  const h = createHarness({ state: { sessionId: null } });
  assert.equal(h.api.reserveSession('sess_new'), true);
  assert.deepEqual(h.calls, ['flush']);
  assert.equal(h.state.sessionId, 'sess_new');
  assert.equal(h.api.reserveSession(''), false);
});

test('subscribe registers a listener and returns its removal', () => {
  const h = createHarness();
  const listener = () => {};
  const off = h.api.subscribe(listener);
  assert.equal(h.listeners.has(listener), true);
  off();
  assert.equal(h.listeners.has(listener), false);
});
