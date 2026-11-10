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
      compact: async (options) => {
        compactCalls += 1;
        assert.deepEqual(options, { requireReduction: true });
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
    assert.equal(h.state.items.at(-1).label, 'Conversation compacted');
    // The compacted conversation stays visible, archived above the divider.
    assert.equal(h.state.items.at(-1).status, 'compacted');
    assert.equal(h.state.items.length, 2);
    assert.equal(h.state.items[0].id, h.originalItem.id);
    assert.equal(h.state.items[0].text, h.originalItem.text);
    assert.equal(h.state.items[0].archived, true);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: true }]);
    assert.equal(h.state.commandBusy, false);
    assert.equal(h.flags.autoClearRunning, false);
  });
}

test('unchanged successful auto-clear preserves both transcripts and the exact context baseline', async () => {
  const h = createHarness(() => ({ changed: false, reason: 'nothing to compact' }));
  assert.equal(await h.flow.autoClearBeforeSubmit(), false);
  assert.equal(h.session.messages, h.messages);
  assert.equal(h.state.items[0], h.originalItem);
  assert.deepEqual(h.state.items, [h.originalItem]);
  assert.equal(h.clearCalls, 0);
  assert.deepEqual(h.syncs, []);
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
    assert.equal(h.state.items.at(-1).label, outcome === 'success' ? 'Conversation compacted' : 'Auto-clear skipped');
    assert.equal(h.syncs.length, outcome === 'success' ? 1 : 0);
    if (outcome !== 'success') assert.equal(h.state.items[0], h.originalItem);
  });
}

for (const outcome of ['success', 'error-result', 'busy-success']) {
  test(`late ${outcome} for an abandoned session applies no cleared-session UI after a session switch`, async () => {
    let resolveCompact;
    const deferred = new Promise((resolve) => {
      resolveCompact = resolve;
    });
    const h = createHarness(() => deferred);
    assert.equal(await h.flow.performAutoClear({ compactTimeoutMs: 5 }), false);
    const itemsAfterTimeout = h.state.items;
    const noticesAfterTimeout = h.notices.length;
    const other = { id: 'other-session', messages: [] };
    h.bag.runtime.session = other;
    if (outcome === 'busy-success') h.set({ busy: true });
    resolveCompact(outcome === 'error-result' ? { changed: false, error: 'summary unavailable' } : { changed: true });
    await nextTurn();
    h.set({ busy: false });
    await h.flow.drain();

    assert.equal(h.bag.runtime.session, other);
    assert.equal(h.flags.autoClearInFlight, false);
    assert.equal(h.flags.pendingClearedSessionUi ?? null, null);
    assert.equal(h.state.items, itemsAfterTimeout);
    assert.equal(h.notices.length, noticesAfterTimeout);
    assert.deepEqual(h.syncs, []);
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
  assert.equal(h.state.items.at(-1).label, 'Conversation compacted');
  assert.equal(h.session.messages, h.messages);
  assert.equal(h.clearCalls, 0);
  assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: true }]);
});

function wakeHarness(compact, { cfg, contextStatus } = {}) {
  const h = createHarness(compact);
  const order = [];
  const origCompact = h.bag.runtime.compact;
  h.bag.runtime.compact = async (options) => {
    order.push('compact');
    return origCompact(options);
  };
  if (cfg) h.bag.autoClearState = () => cfg;
  if (contextStatus) h.bag.runtime.contextStatus = contextStatus;
  h.bag.pushUserOrSyntheticItem = () => {};
  h.bag.runTurn = async () => {
    order.push('wake-turn');
    return 'done';
  };
  const flow = createSessionFlow(h.bag);
  Object.assign(h.bag, flow);
  const wake = async () => {
    flow.enqueue('<task-notification>done</task-notification>', {
      mode: 'task-notification',
      priority: 'next',
      key: 'k1',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return Object.assign(h, { flow, order, wake });
}

test('completion wake after a long idle compacts first, then runs the wake turn', async () => {
  const h = wakeHarness(() => ({ changed: true }));
  await h.wake();
  assert.deepEqual(h.order, ['compact', 'wake-turn']);
  assert.equal(
    h.state.items.some((i) => i.label === 'Conversation compacted'),
    true
  );
  assert.deepEqual(h.syncs, [{ allowEstimated: true, invalidateExact: true }]);
});

for (const [name, opts] of [
  ['disabled', { cfg: { enabled: false, idleMs: 60_000, minContextPercent: 10 } }],
  ['not idle', { cfg: { enabled: true, idleMs: 600_000, minContextPercent: 10 } }],
  ['below the context threshold', { contextStatus: () => ({ usedTokens: 10, compaction: { triggerTokens: 1_000 } }) }],
]) {
  test(`completion wake skips compaction when ${name} and still runs`, async () => {
    const h = wakeHarness(() => ({ changed: true }), opts);
    await h.wake();
    assert.deepEqual(h.order, ['wake-turn']);
    assert.equal(h.compactCalls, 0);
  });
}

test('completion wake still runs when auto-clear compaction fails or times out', async () => {
  const failed = wakeHarness(() => {
    throw new Error('summary unavailable');
  });
  await failed.wake();
  assert.deepEqual(failed.order, ['compact', 'wake-turn']);
  assert.equal(failed.state.items.at(-1).label, 'Auto-clear skipped');

  const timed = wakeHarness(() => new Promise(() => {}));
  assert.equal(await timed.flow.performAutoClear({ compactTimeoutMs: 5 }), false);
  timed.order.length = 0;
  await timed.wake();
  assert.deepEqual(timed.order, ['wake-turn']);
  assert.match(timed.state.items.find((i) => i.label === 'Auto-clear skipped').detail, /timed out after 5ms/);
});

for (const id of ['sess_home_reviewer', 'sess_home_lead', 'sess_task_1']) {
  test(`auto-clear treats ${id} like any Lead session: same idle window and context floor for every turn kind`, async () => {
    const small = wakeHarness(() => ({ changed: true }), {
      contextStatus: () => ({ usedTokens: 10, compaction: { triggerTokens: 1_000 } }),
    });
    small.session.id = id;
    small.flow.enqueue('routine', { mode: 'routine', priority: 'later', id: 'r1', skillSelection: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(small.compactCalls, 0, 'below minContextPercent: not compacted');

    const idle = wakeHarness(() => ({ changed: true }));
    idle.session.id = id;
    assert.equal(await idle.flow.autoClearBeforeSubmit(), true, 'a submit after the provider idle window compacts');
    const wake = wakeHarness(() => ({ changed: true }));
    wake.session.id = id;
    await wake.wake();
    assert.deepEqual(wake.order, ['compact', 'wake-turn'], 'a completion wake compacts first');

    const fresh = wakeHarness(() => ({ changed: true }), {
      cfg: { enabled: true, idleMs: 600_000, minContextPercent: 10 },
    });
    fresh.session.id = id;
    assert.equal(await fresh.flow.autoClearBeforeSubmit(), false, 'inside the idle window: no compaction');
  });
}

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
