#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlashDispatch } from '../src/tui/app/slash-dispatch.mjs';
import { normalizeSlashCommandName } from '../src/tui/app/slash-commands.mjs';
import { createEngineApiB } from '../src/tui/engine/session-api-ext.mjs';

const noop = () => {};

function slashHarness({ state = {}, newSession }) {
  const notices = [];
  let repaints = 0;
  let calls = 0;
  const store = {
    newSession: async () => {
      calls += 1;
      return newSession();
    },
    pushNotice: (text, level) => notices.push({ text, level }),
    forceRenderRepaint: () => { repaints += 1; },
  };
  const dispatch = createSlashDispatch({
    state: { busy: false, commandBusy: false, ...state },
    store,
    normalizeSlashCommandName,
    setContextPanel: noop,
    closeUsagePanel: noop,
  });
  return {
    ...dispatch,
    notices,
    calls: () => calls,
    repaints: () => repaints,
  };
}

test('/new reports a blocked command instead of silently keeping the transcript', async () => {
  const harness = slashHarness({ newSession: async () => false });
  assert.equal(harness.runSlashCommand('new'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls(), 1);
  assert.deepEqual(harness.notices, [{ text: 'new session is already running', level: 'warn' }]);
  assert.equal(harness.repaints(), 0);
});

test('/new repaints only after a successful session replacement', async () => {
  const harness = slashHarness({ newSession: async () => true });
  assert.equal(harness.runSlashCommand('new'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.repaints(), 1);
  assert.deepEqual(harness.notices, []);
});

test('/new rejects immediately while another session command owns the boundary', () => {
  const harness = slashHarness({
    state: { commandBusy: true },
    newSession: async () => true,
  });
  assert.equal(harness.runSlashCommand('new'), false);
  assert.equal(harness.calls(), 0);
  assert.deepEqual(harness.notices, [{
    text: 'wait for the current session command to finish before /new',
    level: 'warn',
  }]);
});

test('engine publishes an empty transcript before and after runtime newSession', async () => {
  let state = {
    commandBusy: false,
    items: [{ id: 'old', kind: 'assistant', text: 'old transcript' }],
    transcriptViewItems: [{ id: 'old', kind: 'assistant', text: 'old transcript' }],
    transcriptViewRevision: 3,
    toasts: [],
    queued: [],
    thinking: null,
    spinner: null,
    lastTurn: null,
    stats: {},
    sessionId: 'old-session',
  };
  const flags = {};
  const flushes = [];
  let releaseRuntime;
  let runtimeSessionId = 'old-session';
  const set = (patch) => { state = { ...state, ...patch }; };
  const replaceItems = (items) => {
    state = {
      ...state,
      transcriptViewItems: null,
      transcriptViewRevision: state.transcriptViewRevision + 1,
    };
    return items;
  };
  const clearUi = () => set({
    items: replaceItems([]),
    toasts: [],
    queued: [],
    thinking: null,
    spinner: null,
    lastTurn: null,
  });
  const api = createEngineApiB({
    runtime: {
      newSession: () => new Promise((resolve) => {
        releaseRuntime = () => {
          runtimeSessionId = 'new-session';
          resolve();
        };
      }),
    },
    flags,
    getState: () => state,
    set,
    flushEmitImmediate: () => flushes.push({
      items: state.items.slice(),
      transcriptViewItems: state.transcriptViewItems,
      sessionId: state.sessionId,
      commandBusy: state.commandBusy,
    }),
    replaceItems,
    clearToastTimers: noop,
    routeState: () => ({ sessionId: runtimeSessionId }),
    syncContextStats: noop,
    clearUiActivityBeforeContextSync: clearUi,
    resetTuiForPendingSessionReset: () => {
      flags.pendingSessionReset = true;
      clearUi();
    },
    snapshotTuiBeforeSessionReset: () => ({ token: 'rollback' }),
    restoreTuiAfterFailedSessionReset: noop,
    commitTuiSessionReset: noop,
    resetStatsAndSyncContext: () => state.stats,
  });

  const pending = api.newSession();
  assert.deepEqual(flushes[0], {
    items: [],
    transcriptViewItems: null,
    sessionId: null,
    commandBusy: true,
  });
  releaseRuntime();
  assert.equal(await pending, true);
  assert.deepEqual(flushes.at(-1), {
    items: [],
    transcriptViewItems: null,
    sessionId: 'new-session',
    commandBusy: false,
  });
});
