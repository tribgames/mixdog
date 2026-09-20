import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionLifecycleApi } from './lifecycle.mjs';

// Pins the session-boundary transitions: each reset publishes the blank view,
// snapshots the TUI for rollback, commits the empty session only after the
// runtime transition succeeded, and restores the snapshot when it failed.
function createHarness({ runtime: runtimeOverrides = {}, state: stateOverrides = {}, routeState } = {}) {
  const calls = [];
  let state = {
    commandBusy: false,
    items: ['row-1'],
    toasts: ['toast'],
    queued: ['queued'],
    stats: { turns: 1 },
    sessionId: 'sess_current',
    ...stateOverrides,
  };
  const flags = { pendingSessionReset: false, disposed: false, lastUserActivityAt: 0 };
  const pulse = setInterval(() => {}, 60_000);
  pulse.unref?.();
  const lifecycle = {
    runtimePulseTimer: pulse,
    unsubscribeRuntimeNotifications: () => calls.push('unsub:notifications'),
    unsubscribeAgentStatus: () => calls.push('unsub:agent'),
    unsubscribeRemoteState: null,
  };
  const listeners = new Set([() => {}]);
  const snapshot = { marker: 'snapshot' };
  const runtime = {
    cwd: 'C:/work',
    session: { id: 'sess_current' },
    newSession: async () => calls.push('runtime.newSession'),
    deleteSession: async (id) => {
      calls.push(`runtime.deleteSession:${id}`);
      return true;
    },
    switchContext: async (options) => calls.push(['runtime.switchContext', options]),
    inheritFrom: async (id) => {
      calls.push(`runtime.inheritFrom:${id}`);
      return { sessionId: 'sess_heir' };
    },
    readModelMessages: () => ({ messages: [] }),
    inheritancePreflight: () => null,
    clearSessionPresence: () => calls.push('runtime.clearSessionPresence'),
    close: async (reason, options) => calls.push(['runtime.close', reason, options]),
    ...runtimeOverrides,
  };
  const bag = {
    runtime,
    flags,
    lifecycle,
    listeners,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    flushEmitImmediate: () => calls.push('flush'),
    disposeEmit: () => calls.push('disposeEmit'),
    replaceItems: (items) => items,
    pushNotice: () => {},
    removeNotice: () => {},
    setProgressHint: () => {},
    clearToastTimers: () => calls.push('clearToastTimers'),
    disposeTranscriptSpill: () => calls.push('disposeTranscriptSpill'),
    disposeGoalContinuation: () => calls.push('disposeGoalContinuation'),
    routeState: routeState || (() => ({})),
    finishToolApproval: (...args) => {
      calls.push(['finishToolApproval', ...args]);
      return 'finished';
    },
    denyAllToolApprovals: (reason) => calls.push(['denyAll', reason]),
    restoreLeadSteeringFromDisk: async () => calls.push('restoreLeadSteering'),
    clearUiActivityBeforeContextSync: () => calls.push('clear-activity'),
    resetTuiForPendingSessionReset: () => calls.push('reset-pending'),
    snapshotTuiBeforeSessionReset: () => {
      calls.push('snapshot');
      return snapshot;
    },
    restoreTuiAfterFailedSessionReset: (value) => calls.push(['restore', value]),
    commitTuiSessionReset: (value) => calls.push(['commit', value]),
    resetStatsAndSyncContext: () => calls.push('stats-sync'),
  };
  const oauthFlows = { cancelAll: () => calls.push('oauth.cancelAll') };
  const api = createSessionLifecycleApi(bag, {
    restoreTranscriptItems: (messages) => messages.map((message) => ({ kind: message.role, text: message.content })),
    oauthFlows,
  });
  return {
    api,
    calls,
    flags,
    lifecycle,
    listeners,
    snapshot,
    get state() {
      return state;
    },
    dispose: () => clearInterval(pulse),
  };
}

test('newSession publishes the blank boundary before the runtime call and commits the empty session', async (t) => {
  const h = createHarness({ routeState: () => ({ sessionId: 'sess_new' }) });
  t.after(h.dispose);
  assert.equal(await h.api.newSession(), true);
  assert.deepEqual(h.calls, [
    'clearToastTimers',
    'snapshot',
    'reset-pending',
    'flush',
    'runtime.newSession',
    'clear-activity',
    'stats-sync',
    ['commit', h.snapshot],
    'flush',
  ]);
  assert.deepEqual(h.state.items, []);
  assert.deepEqual(h.state.toasts, []);
  assert.equal(h.state.sessionId, 'sess_new');
  assert.equal(h.state.commandBusy, false);
  assert.equal(h.flags.pendingSessionReset, false);
});

test('a failed newSession restores the snapshot, rethrows and releases commandBusy', async (t) => {
  const h = createHarness({
    runtime: {
      newSession: async () => {
        throw new Error('provider down');
      },
    },
  });
  t.after(h.dispose);
  await assert.rejects(h.api.newSession(), /provider down/);
  assert.deepEqual(h.calls.at(-2), ['restore', h.snapshot]);
  assert.equal(h.calls.at(-1), 'flush');
  assert.ok(!h.calls.some((call) => Array.isArray(call) && call[0] === 'commit'));
  assert.equal(h.state.commandBusy, false);
  assert.equal(h.flags.pendingSessionReset, false);
  assert.equal(h.state.sessionId, null);
});

test('newSession and clear refuse while another command is busy', async (t) => {
  const h = createHarness({ state: { commandBusy: true } });
  t.after(h.dispose);
  assert.equal(await h.api.newSession(), false);
  assert.equal(await h.api.clear(), false);
  assert.equal(await h.api.switchContext({}), false);
  assert.equal(await h.api.deleteSession('sess_current'), false);
  assert.equal(await h.api.inheritSession(), false);
  assert.equal(await h.api.resume('sess_x'), false);
  assert.deepEqual(h.calls, []);
});

test('deleteSession resets the TUI only when the current session is deleted', async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  assert.equal(await h.api.deleteSession('sess_other'), true);
  assert.deepEqual(h.calls, ['clearToastTimers', 'runtime.deleteSession:sess_other']);
  assert.equal(h.state.sessionId, 'sess_current');
  assert.deepEqual(h.state.items, ['row-1']);

  h.calls.length = 0;
  assert.equal(await h.api.deleteSession('sess_current'), true);
  assert.deepEqual(h.calls, [
    'clearToastTimers',
    'snapshot',
    'reset-pending',
    'runtime.deleteSession:sess_current',
    'clear-activity',
    'stats-sync',
    ['commit', h.snapshot],
  ]);
  assert.equal(h.state.sessionId, null);
  assert.equal(h.state.cwd, 'C:/work');
  assert.deepEqual(h.state.items, []);
  assert.equal(h.state.commandBusy, false);
});

test('a refused deleteSession rolls the current view back and reports false', async (t) => {
  const h = createHarness({ runtime: { deleteSession: async () => false } });
  t.after(h.dispose);
  assert.equal(await h.api.deleteSession('sess_current'), false);
  assert.deepEqual(h.calls.at(-1), ['restore', h.snapshot]);
  assert.deepEqual(h.state.items, ['row-1']);
  assert.equal(h.state.commandBusy, false);
  assert.equal(h.flags.pendingSessionReset, false);
});

test('switchContext commits the new cwd on success and restores on failure', async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  assert.equal(await h.api.switchContext({ cwd: 'D:/next' }), true);
  assert.deepEqual(h.calls, [
    'clearToastTimers',
    'snapshot',
    'reset-pending',
    ['runtime.switchContext', { cwd: 'D:/next' }],
    'clear-activity',
    'stats-sync',
    ['commit', h.snapshot],
  ]);
  assert.equal(h.state.sessionId, null);
  assert.equal(h.state.cwd, 'C:/work');

  const failing = createHarness({
    runtime: {
      switchContext: async () => {
        throw new Error('no such project');
      },
    },
  });
  t.after(failing.dispose);
  await assert.rejects(failing.api.switchContext({}), /no such project/);
  assert.deepEqual(failing.calls.at(-1), ['restore', failing.snapshot]);
  assert.equal(failing.state.commandBusy, false);
});

test('inheritSession refuses before creating a heir when the route cannot hold the conversation', async (t) => {
  const h = createHarness({
    runtime: {
      inheritancePreflight: () => ({ known: true, fits: false, willCompact: false, reason: 'route cannot hold it' }),
    },
  });
  t.after(h.dispose);
  await assert.rejects(h.api.inheritSession(), /route cannot hold it/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state.commandBusy, false);
});

test('inheritSession opens the heir and carries the source when compaction will fit it', async (t) => {
  const h = createHarness({
    runtime: { inheritancePreflight: () => ({ known: true, fits: false, willCompact: true }) },
  });
  t.after(h.dispose);
  const result = await h.api.inheritSession();
  assert.equal(result.sessionId, 'sess_heir');
  assert.deepEqual(h.calls, ['runtime.newSession', 'runtime.inheritFrom:sess_current', 'stats-sync', 'flush']);
  assert.equal(h.state.sessionId, 'sess_heir');
  assert.equal(h.state.commandBusy, false);

  const blank = createHarness({ state: { sessionId: null } });
  t.after(blank.dispose);
  assert.equal(await blank.api.inheritSession(), false);
});

test('inheritancePreflight forwards the current session when the runtime supports it', (t) => {
  const seen = [];
  const h = createHarness({
    runtime: {
      inheritancePreflight: (id, selection) => {
        seen.push([id, selection]);
        return { known: true, fits: true };
      },
    },
  });
  t.after(h.dispose);
  assert.deepEqual(h.api.inheritancePreflight(), { known: true, fits: true });
  assert.deepEqual(h.api.inheritancePreflight('sess_x', { provider: 'p' }), { known: true, fits: true });
  assert.deepEqual(seen, [
    ['sess_current', null],
    ['sess_x', { provider: 'p' }],
  ]);
  const legacy = createHarness({ runtime: { inheritancePreflight: undefined } });
  t.after(legacy.dispose);
  assert.equal(legacy.api.inheritancePreflight(), null);
});

test('resolveToolApproval maps boolean and object decisions onto finishToolApproval', (t) => {
  const h = createHarness();
  t.after(h.dispose);
  assert.equal(h.api.resolveToolApproval('t1', true), 'finished');
  h.api.resolveToolApproval('t2', { approved: false, reason: 'nope' });
  h.api.resolveToolApproval('t3', {});
  h.api.resolveToolApproval('t4');
  assert.deepEqual(h.calls, [
    ['finishToolApproval', 't1', true, 'approved by user'],
    ['finishToolApproval', 't2', false, 'nope'],
    ['finishToolApproval', 't3', false, 'denied by user'],
    ['finishToolApproval', 't4', false, 'denied by user'],
  ]);
});

test('sessionStoreDir swallows runtime failures', (t) => {
  const h = createHarness({
    runtime: {
      sessionStoreDir: () => {
        throw new Error('no store');
      },
    },
  });
  t.after(h.dispose);
  assert.equal(h.api.sessionStoreDir(), null);
  const legacy = createHarness();
  t.after(legacy.dispose);
  assert.equal(legacy.api.sessionStoreDir(), null);
});

test('dispose tears down subscriptions, approvals, oauth flows and the runtime exactly once', async (t) => {
  const h = createHarness();
  t.after(h.dispose);
  await h.api.dispose('desktop-close', { force: true });
  assert.deepEqual(h.calls, [
    'disposeEmit',
    'runtime.clearSessionPresence',
    'clearToastTimers',
    'disposeTranscriptSpill',
    'disposeGoalContinuation',
    'unsub:notifications',
    'unsub:agent',
    ['denyAll', 'runtime closing'],
    'oauth.cancelAll',
    ['runtime.close', 'desktop-close', { force: true }],
  ]);
  assert.equal(h.flags.disposed, true);
  assert.equal(h.lifecycle.unsubscribeRuntimeNotifications, null);
  assert.equal(h.lifecycle.unsubscribeAgentStatus, null);
  assert.equal(h.listeners.size, 0);

  h.calls.length = 0;
  await h.api.dispose();
  assert.deepEqual(h.calls, []);
});
