// The daemon's session catalog API: ordinary listings go through the reader's
// async listing (which may answer from the session catalog DB), a `limit`
// asks for one keyset page, and the wire result carries its cursor.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeState } from '../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { createStoredSessionViews } from './daemon-stored-session-views.mjs';
import { createSessionActionCalls } from './session-service/session-calls/session-action.mjs';
import { createBusyTracker } from './session-service/retention/busy.mjs';
import { onSessionApprovalCardChange } from '../runtime/shared/session-activity-signal.mjs';
import { roomMemberSessionId } from '../runtime/agent/orchestrator/session/agent-room.mjs';

function views() {
  const calls = [];
  const store = {
    listStoredSessionSummaries: (options) => {
      calls.push(['sync', options]);
      return [{ id: 'sync' }];
    },
    listStoredSessionSummariesAsync: async (options) => {
      calls.push(['async', options]);
      return [{ id: 'async' }];
    },
    listStoredSessionSummaryPage: async (options) => {
      calls.push(['page', options]);
      return { sessions: [{ id: 'page' }], nextCursor: 'next' };
    },
  };
  return { calls, views: createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } }) };
}

test('ordinary listings use the async reader; only `page` pages; a refresh is never paged', async () => {
  const { calls, views: stored } = views();
  assert.deepEqual(await stored.listSessions(), [{ id: 'async' }]);
  assert.deepEqual(await stored.listSessions({ limit: 2 }), [{ id: 'async' }], '`limit` alone keeps the full array');
  assert.deepEqual(await stored.listSessions({ page: { limit: 2, cursor: 'c' } }), {
    sessions: [{ id: 'page' }],
    nextCursor: 'next',
  });
  assert.deepEqual(await stored.listSessions({ page: { limit: 2 }, refreshFromStorage: true }), [{ id: 'async' }]);
  assert.deepEqual(calls, [
    ['async', { refreshFromStorage: false }],
    ['async', { refreshFromStorage: false }],
    ['page', { limit: 2, cursor: 'c' }],
    ['async', { refreshFromStorage: true }],
  ]);
});

test('catalog rows carry the in-memory turn activity of this daemon, never a stored liveness', async (t) => {
  const rows = [{ id: 'lead' }, { id: 'agent' }, { id: 'idle' }, { id: 'other-lead' }];
  const store = {
    listStoredSessionSummariesAsync: async () => rows,
    listStoredSessionSummaryPage: async () => ({ sessions: rows, nextCursor: null }),
  };
  const stored = createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } });
  t.after(() => runtimeState.clear());
  runtimeState.set('agent', { stage: 'tool_running', session: { owner: 'agent', ownerSessionId: 'lead' } });
  runtimeState.set('other-lead', { stage: 'streaming', session: { owner: 'user', agent: 'lead' } });
  runtimeState.set('idle', { stage: 'done', session: { owner: 'agent', ownerSessionId: 'other-lead' } });
  const expected = [
    { id: 'lead', agentWorking: true },
    { id: 'agent', working: true },
    { id: 'idle' },
    { id: 'other-lead', working: true },
  ];
  assert.deepEqual(await stored.listSessions(), expected);
  assert.deepEqual(await stored.listSessions({ page: { limit: 4 } }), { sessions: expected, nextCursor: null });
  runtimeState.clear();
  assert.deepEqual(await stored.listSessions(), rows, 'a settled daemon overlays nothing');
});

test('working clears when the daemon is lost and returns only for the turns the reconnected daemon runs', async (t) => {
  const rows = [{ id: 'lead' }, { id: 'agent' }, { id: 'idle' }];
  const store = { listStoredSessionSummariesAsync: async () => rows };
  const stored = createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } });
  t.after(() => runtimeState.clear());
  const running = (stage, session) => ({ stage, session });
  const agentTurn = (stage) => running(stage, { owner: 'agent', ownerSessionId: 'lead' });

  runtimeState.set('lead', running('streaming', { owner: 'user', agent: 'lead' }));
  runtimeState.set('agent', agentTurn('tool_running'));
  assert.deepEqual(await stored.listSessions(), [
    { id: 'lead', working: true, agentWorking: true },
    { id: 'agent', working: true },
    { id: 'idle' },
  ]);

  // The daemon goes away: its in-memory turns die with it and the catalog,
  // still carrying the same durable rows, reports nothing as working.
  runtimeState.clear();
  assert.deepEqual(await stored.listSessions(), rows, 'no stale working survives the disconnect');

  // A reconnected daemon reports only the turn it actually runs again.
  runtimeState.set('agent', agentTurn('requesting'));
  assert.deepEqual(await stored.listSessions(), [
    { id: 'lead', agentWorking: true },
    { id: 'agent', working: true },
    { id: 'idle' },
  ]);
});

test('the session catalog call returns a page with its cursor', async () => {
  const { views: stored } = views();
  const actions = createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    listSessions: stored.listSessions,
    getRemoteSessionState: async () => null,
    projection: {},
    retention: { awaitingApprovalSessionKinds: () => new Map(), roomHandoffQuestions: () => new Map() },
    entries: {},
  });
  assert.deepEqual(await actions.listSessionCatalog({ page: { limit: 1 } }), {
    sessions: [{ id: 'page' }],
    nextCursor: 'next',
    remoteSession: null,
  });
  assert.deepEqual(await actions.listSessionCatalog(), { sessions: [{ id: 'async' }], remoteSession: null });
});

// A Lead waiting on the user's approval is still mid-turn (`working`); only
// its live runtime knows it waits. The catalog is the one status every list
// row reads, so it carries that for every session — open in a pane or not.
test('the session catalog marks every session whose live runtime shows an approval card', async () => {
  const runtime = (state) => ({ getState: () => state });
  const sessions = new Set([
    { id: 'asks', runtime: runtime({ busy: true, toolApproval: { id: 'ap-1', name: 'shell' } }) },
    { id: 'question', runtime: runtime({ busy: true, toolApproval: { id: 'ap-2', kind: 'question' } }) },
    { id: 'busy', runtime: runtime({ busy: true, toolApproval: null }) },
  ]);
  const busy = createBusyTracker({ sessions, currentSessionId: (entry) => entry.id });
  const rows = [{ id: 'asks' }, { id: 'question' }, { id: 'busy' }, { id: 'cold' }];
  const store = {
    listStoredSessionSummariesAsync: async () => rows,
    listStoredSessionSummaryPage: async () => ({ sessions: rows, nextCursor: null }),
  };
  const stored = createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } });
  const actions = createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    listSessions: stored.listSessions,
    getRemoteSessionState: async () => null,
    projection: {},
    retention: busy,
    entries: {},
  });
  const expected = [
    { id: 'asks', awaitingApproval: true },
    { id: 'question', awaitingApproval: true, awaitingQuestion: true },
    { id: 'busy' },
    { id: 'cold' },
  ];
  assert.deepEqual((await actions.listSessionCatalog()).sessions, expected);
  assert.deepEqual((await actions.listSessionCatalog({ page: { limit: 4 } })).sessions, expected);
});

test('a live session that starts or stops showing an approval card announces it once per transition', (t) => {
  const seen = [];
  t.after(onSessionApprovalCardChange((sessionId) => seen.push(sessionId)));
  const entry = { id: 'lead' };
  const busy = createBusyTracker({ sessions: new Set([entry]), currentSessionId: (row) => row.id });
  busy.updateEntryBusy(entry, { busy: true });
  assert.deepEqual(seen, [], 'no card, nothing to announce');
  busy.updateEntryBusy(entry, { busy: true, toolApproval: { id: 'ap' } });
  busy.updateEntryBusy(entry, { busy: true, toolApproval: { id: 'ap' } });
  assert.deepEqual(seen, ['lead'], 'the card appeared: once');
  busy.updateEntryBusy(entry, { busy: true, toolApproval: null });
  busy.updateEntryBusy(entry, { busy: false });
  assert.deepEqual(seen, ['lead', 'lead'], 'the card went away: once');
});

test('a live card that turns from an approval into a question, or back, announces each kind change once', (t) => {
  const seen = [];
  t.after(onSessionApprovalCardChange((sessionId) => seen.push(sessionId)));
  let state = {};
  const entry = { id: 'lead', runtime: { getState: () => state } };
  const busy = createBusyTracker({ sessions: new Set([entry]), currentSessionId: (row) => row.id });
  const show = (next) => {
    state = next;
    busy.updateEntryBusy(entry, next);
  };
  show({ busy: true, toolApproval: { id: 'ap' } });
  assert.deepEqual([...busy.awaitingApprovalSessionKinds()], [['lead', 'approval']]);
  show({ busy: true, toolApproval: { id: 'q', kind: 'question' } });
  show({ busy: true, toolApproval: { id: 'q', kind: 'question' } });
  assert.deepEqual([...busy.awaitingApprovalSessionKinds()], [['lead', 'question']]);
  assert.deepEqual(seen, ['lead', 'lead'], 'approval → question: once');
  show({ busy: true, toolApproval: { id: 'ap2' } });
  assert.deepEqual([...busy.awaitingApprovalSessionKinds()], [['lead', 'approval']]);
  assert.deepEqual(seen, ['lead', 'lead', 'lead'], 'question → approval: once');
});

// No view watches a room member's session: its room reads the handed-off
// questions it holds from its catalog row, re-read as they come and go.
test("a room member's handed-off questions ride on its catalog row and announce each change; a bot chat's do not", async (t) => {
  const seen = [];
  t.after(onSessionApprovalCardChange((sessionId) => seen.push(sessionId)));
  const MEMBER = roomMemberSessionId('room123abc', 'mailer');
  const question = (id) => ({ id, kind: 'question', sessionId: 'sess_task', args: { questions: [] } });
  const states = new Map([
    [MEMBER, { handoffQuestions: [] }],
    ['sess_home_mailer', { handoffQuestions: [question('q-home')] }],
  ]);
  const entries = [...states.keys()].map((id) => ({ id, runtime: { getState: () => states.get(id) } }));
  const busy = createBusyTracker({ sessions: new Set(entries), currentSessionId: (entry) => entry.id });
  const show = (id, next) => {
    states.set(id, next);
    busy.updateEntryBusy(
      entries.find((entry) => entry.id === id),
      next
    );
  };
  show('sess_home_mailer', { handoffQuestions: [question('q-home')] });
  assert.deepEqual(seen, [], "a bot chat's copies reach it through its own snapshot");
  show(MEMBER, { handoffQuestions: [question('q1')] });
  show(MEMBER, { handoffQuestions: [question('q1')] });
  show(MEMBER, { handoffQuestions: [question('q1'), question('q2')] });
  show(MEMBER, { handoffQuestions: [question('q2')] });
  assert.deepEqual(seen, [MEMBER, MEMBER, MEMBER], 'each change once');
  const rows = [{ id: MEMBER }, { id: 'sess_home_mailer' }];
  const store = {
    listStoredSessionSummariesAsync: async () => rows,
    listStoredSessionSummaryPage: async () => ({ sessions: rows, nextCursor: null }),
  };
  const actions = createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    listSessions: createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } }).listSessions,
    getRemoteSessionState: async () => null,
    projection: {},
    retention: busy,
    entries: {},
  });
  assert.deepEqual((await actions.listSessionCatalog()).sessions, [
    { id: MEMBER, handoffQuestions: [question('q2')] },
    { id: 'sess_home_mailer' },
  ]);
  show(MEMBER, { handoffQuestions: [] });
  assert.equal(seen.length, 4, 'the last one leaving too');
  assert.deepEqual((await actions.listSessionCatalog()).sessions, rows);
});
