import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createSessionFlow } from './session-flow.mjs';
import { createSessionApiB } from './session-api-ext.mjs';
import { freshContextCompactMessages, SUMMARY_PREFIX } from '../../runtime/agent/orchestrator/session/compact.mjs';

function createHarness(compact) {
  const messages = [
    { role: 'system', content: 'Keep the user instructions.' },
    { role: 'user', content: 'Keep the existing feature working.' },
    { role: 'assistant', content: 'I will preserve the existing feature.' },
    { role: 'user', content: 'Add the approved regression test.' },
  ];
  const session = { id: 'auto-clear-test', updatedAt: Date.now() - 120_000, messages };
  const originalItem = { kind: 'user', id: 'original', text: messages.at(-1).content };
  let state = { busy: false, commandBusy: false, items: [originalItem], queued: [], stats: {} };
  const flags = {};
  const notices = [];
  const syncs = [];
  let compactCalls = 0;
  let clearCalls = 0;
  const clearOptions = [];
  let sequence = 0;
  const set = (patch) => {
    state = { ...state, ...patch };
  };
  const bag = {
    runtime: {
      id: session.id,
      session,
      compact: async () => {
        compactCalls += 1;
        return compact(session);
      },
      clear: async (options) => {
        clearCalls += 1;
        clearOptions.push(options);
        session.messages = [];
        return true;
      },
      contextStatus: () => ({ usedTokens: 200, compaction: { triggerTokens: 1_000 } }),
    },
    nextId: () => ++sequence,
    flags,
    pending: [],
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set,
    pushItem: (item) => set({ items: [...state.items, item] }),
    replaceItems: (items) => items,
    pushNotice: (message, level) => notices.push({ message, level }),
    autoClearState: () => ({ enabled: true, idleMs: 60_000, minContextPercent: 10 }),
    routeState: () => ({}),
    syncContextStats: (options) => syncs.push(options),
    clearToastTimers: () => {},
    tuiDebug: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
  };
  const flow = createSessionFlow(bag);
  return {
    flow,
    bag,
    session,
    messages,
    originalItem,
    flags,
    notices,
    syncs,
    clearOptions,
    set,
    get state() {
      return state;
    },
    get compactCalls() {
      return compactCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
  };
}

for (const mode of ['rules', 'summary']) {
  test(`auto-clear retains the entire successful ${mode} compaction without clearing it`, async () => {
    const handoffText = mode === 'summary' ? 'Preserve the feature and add its regression test.' : '';
    let compacted;
    const h = createHarness((session) => {
      compacted = freshContextCompactMessages(session.messages, 10_000, {
        force: true,
        contextWindow: 40_000,
        handoffText,
      }).messages;
      session.messages = compacted;
      return { changed: true, handoffSource: mode === 'rules' ? 'rules' : 'session-local' };
    });

    assert.equal(await h.flow.autoClearBeforeSubmit(), true);
    assert.equal(h.compactCalls, 1);
    assert.equal(h.clearCalls, 0);
    assert.equal(h.session.messages, compacted);
    assert.ok(h.session.messages.some((m) => m.role === 'user' && m.content === h.messages.at(-1).content));
    assert.equal(
      h.session.messages.some((m) => m.role === 'user' && m.content.startsWith(SUMMARY_PREFIX)),
      mode === 'summary'
    );
    if (mode === 'rules') {
      assert.ok(h.session.messages.some((m) => m.content === h.messages[1].content));
      assert.ok(h.session.messages.some((m) => m.content === h.messages[2].content));
    }
    assert.equal(h.state.items.at(-1).label, 'Auto-clear complete');
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: true }]);
    assert.equal(h.state.commandBusy, false);
    assert.equal(h.flags.autoClearRunning, false);
  });
}

test('unchanged successful auto-clear preserves both transcripts and the exact context baseline', async () => {
  const h = createHarness(() => ({ changed: false, reason: 'nothing to compact' }));
  assert.equal(await h.flow.autoClearBeforeSubmit(), true);
  assert.equal(h.session.messages, h.messages);
  assert.equal(h.state.items[0], h.originalItem);
  assert.equal(h.state.items.at(-1).label, 'Auto-clear complete');
  assert.equal(h.clearCalls, 0);
  assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: false }]);
});

for (const mode of ['error-result', 'throw', 'no-session']) {
  test(`auto-clear preserves the conversation and reports the real ${mode} failure`, async () => {
    const reason = mode === 'no-session' ? 'no active session' : 'compact failed: summary service unavailable';
    const h = createHarness(() => {
      if (mode === 'throw') throw new Error(reason);
      return mode === 'no-session' ? null : { changed: false, error: reason };
    });
    assert.equal(await h.flow.autoClearBeforeSubmit(), false);
    assert.equal(h.session.messages, h.messages);
    assert.equal(h.state.items[0], h.originalItem);
    assert.equal(h.state.items.at(-1).label, 'Auto-clear skipped');
    assert.equal(h.state.items.at(-1).detail, `conversation kept · ${reason}`);
    assert.deepEqual(h.notices, [{ message: `auto-clear skipped: ${reason}`, level: 'error' }]);
    assert.equal(h.state.commandBusy, false);
    assert.equal(h.flags.autoClearRunning, false);
    assert.equal(h.clearCalls, 0);
    assert.deepEqual(h.syncs, []);
  });
}

for (const outcome of ['success', 'error-result', 'throw']) {
  test(`timed-out auto-clear safely handles late ${outcome} without a destructive clear`, async () => {
    let resolveCompact;
    let rejectCompact;
    const deferred = new Promise((resolve, reject) => {
      resolveCompact = resolve;
      rejectCompact = reject;
    });
    const h = createHarness(() => deferred);
    assert.equal(await h.flow.performAutoClear({ compactTimeoutMs: 5 }), false);
    assert.equal(h.state.commandBusy, false);
    assert.equal(h.flags.autoClearRunning, false);
    assert.equal(h.flags.autoClearInFlight, true);
    assert.equal(h.state.items[0], h.originalItem);
    assert.match(h.state.items.at(-1).detail, /timed out after 5ms/);
    assert.equal(await h.flow.autoClearBeforeSubmit(), false);
    assert.equal(h.compactCalls, 1);

    if (outcome === 'throw') rejectCompact(new Error('summary unavailable'));
    else resolveCompact(outcome === 'success' ? { changed: true } : { changed: false, error: 'summary unavailable' });
    await nextTurn();

    assert.equal(h.flags.autoClearInFlight, false);
    assert.equal(h.clearCalls, 0);
    assert.equal(h.session.messages, h.messages);
    assert.equal(h.state.items.at(-1).label, outcome === 'success' ? 'Auto-clear complete' : 'Auto-clear skipped');
    assert.equal(h.syncs.length, outcome === 'success' ? 1 : 0);
    if (outcome !== 'success') assert.equal(h.state.items[0], h.originalItem);
  });
}

test('late auto-clear completion defers UI reset until an active turn settles', async () => {
  let resolveCompact;
  const deferred = new Promise((resolve) => {
    resolveCompact = resolve;
  });
  const h = createHarness(() => deferred);
  assert.equal(await h.flow.performAutoClear({ compactTimeoutMs: 5 }), false);
  h.set({ busy: true });
  resolveCompact({ changed: true });
  await nextTurn();
  assert.equal(h.state.busy, true);
  assert.equal(h.state.items[0], h.originalItem);
  assert.equal(h.flags.autoClearInFlight, true);
  assert.deepEqual(h.syncs, []);

  h.set({ busy: false });
  await h.flow.drain();
  assert.equal(h.flags.autoClearInFlight, false);
  assert.equal(h.flags.pendingClearedSessionUi, null);
  assert.equal(h.state.items.at(-1).label, 'Auto-clear complete');
  assert.equal(h.session.messages, h.messages);
  assert.equal(h.clearCalls, 0);
  assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: true }]);
});

test('explicit manual clear still clears the session instead of compacting it', async () => {
  const h = createHarness(() => {
    throw new Error('manual clear must not compact');
  });
  const api = createSessionApiB({
    ...h.bag,
    ...h.flow,
    snapshotTuiBeforeSessionReset: () => ({}),
    resetTuiForPendingSessionReset: () => {},
    commitTuiSessionReset: () => {},
  });
  assert.equal(await api.clear(), true);
  assert.equal(h.clearCalls, 1);
  assert.deepEqual(h.clearOptions, [{ recoverAgent: true }]);
  assert.equal(h.compactCalls, 0);
  assert.deepEqual(h.session.messages, []);
  assert.deepEqual(h.state.items, []);
  assert.equal(h.state.commandBusy, false);
});
