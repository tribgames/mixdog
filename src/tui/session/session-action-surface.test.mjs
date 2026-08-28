import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionApi } from './session-api.mjs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from '../../standalone/session-protocol.mjs';

// The daemon resolves every session action by NAME on the object
// createLocalSessionRuntime returns — this surface. An action that only exists
// on the runtime beneath it passes the protocol allowlist and then dies in the
// session runtime worker as "session action <name> is unavailable" (desktop
// /inherit shipped exactly that way).
function stubBag(overrides = {}) {
  const defaults = {
    flags: {},
    autoClearState: {},
    pending: [],
    listeners: new Set(),
  };
  return new Proxy({}, {
    get: (_target, key) => {
      if (key in overrides) return overrides[key];
      if (key in defaults) return defaults[key];
      return () => ({});
    },
    has: () => true,
  });
}

test('every advertised session action exists on the session surface', () => {
  const api = createSessionApi(stubBag());
  const missing = [...SESSION_READ_ACTIONS, ...SESSION_CONFIGURE_ACTIONS]
    .filter((action) => typeof api[action] !== 'function');
  assert.deepEqual(missing, []);
});

test('accepted user input archives completed Goal UI before the next turn', () => {
  const calls = [];
  const api = createSessionApi(stubBag({
    nextId: () => 'submission-goal-archive',
    getState: () => ({ commandBusy: false, busy: true }),
    enqueue: () => {
      calls.push('enqueue');
      return true;
    },
    cancelQueuedGoalContinuations: () => calls.push('cancel-goal-continuation'),
    archiveCompletedGoalOnUserInput: () => calls.push('archive-completed-goal'),
    runtime: { interruptTaskWait() {} },
  }));

  assert.equal(api.submit('next request'), true);
  assert.deepEqual(calls, [
    'enqueue',
    'cancel-goal-continuation',
    'archive-completed-goal',
  ]);
});

test('submitAndWait resolves with the main turn settlement', async () => {
  let state = { commandBusy: false, busy: false };
  const api = createSessionApi(stubBag({
    nextId: () => 'submission-1',
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    autoClearBeforeSubmit: async () => {},
    enqueue: (_text, options) => {
      queueMicrotask(() => options.onSettled({
        status: 'done',
        result: { content: 'answer' },
        session: { id: 'sess_agent' },
      }));
      return true;
    },
  }));

  const settled = await api.submitAndWait('question');
  assert.equal(settled.status, 'done');
  assert.equal(settled.result.content, 'answer');
  assert.equal(settled.session.id, 'sess_agent');
});

test('canonical child close is exposed on the session surface', () => {
  const calls = [];
  const api = createSessionApi(stubBag({
    runtime: {
      closeCanonicalSession(reason) {
        calls.push(reason);
        return true;
      },
    },
  }));

  assert.equal(typeof api.closeCanonicalSession, 'function');
  assert.equal(api.closeCanonicalSession('cli-agent-close'), true);
  assert.deepEqual(calls, ['cli-agent-close']);
});

test('canonical Agent completion is delivered through the session surface', () => {
  const calls = [];
  const api = createSessionApi(stubBag({
    runtime: {
      deliverToolCompletion(sessionId, text, meta) {
        calls.push({ sessionId, text, meta });
        return true;
      },
    },
  }));
  const meta = { type: 'agent_task_result', execution_id: 'task-agent-1' };

  assert.equal(typeof api.deliverToolCompletion, 'function');
  assert.equal(api.deliverToolCompletion('sess_lead', 'Agent handoff', meta), true);
  assert.deepEqual(calls, [{
    sessionId: 'sess_lead',
    text: 'Agent handoff',
    meta,
  }]);
});

test('extension editor actions are advertised and forwarded', async () => {
  const calls = [];
  let state = { commandBusy: false, stats: {} };
  const api = createSessionApi(stubBag({
    runtime: {
      getMcpServerConfig: (name) => {
        calls.push(['getMcpServerConfig', name]);
        return { name };
      },
      saveMcpServer: async (input) => {
        calls.push(['saveMcpServer', input]);
        return { name: input.name };
      },
      saveSkill: async (input) => {
        calls.push(['saveSkill', input]);
        return { skill: { name: input.name } };
      },
    },
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    routeState: () => ({}),
  }));

  assert.ok(SESSION_READ_ACTIONS.includes('getMcpServerConfig'));
  assert.ok(SESSION_CONFIGURE_ACTIONS.includes('saveMcpServer'));
  assert.ok(SESSION_CONFIGURE_ACTIONS.includes('saveSkill'));
  assert.deepEqual(api.getMcpServerConfig('UnityMCP'), { name: 'UnityMCP' });
  await api.saveMcpServer({ name: 'UnityMCP' });
  await api.saveSkill({ name: 'unity-helper' });
  assert.deepEqual(calls, [
    ['getMcpServerConfig', 'UnityMCP'],
    ['saveMcpServer', { name: 'UnityMCP' }],
    ['saveSkill', { name: 'unity-helper' }],
  ]);
});

test('inheritFrom carries the conversation and rebuilds the heir transcript', async () => {
  const carried = [
    { role: 'system', content: 'target system prompt' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];
  let state = { sessionId: 'sess_heir', stats: {}, items: [] };
  const calls = [];
  const api = createSessionApi(stubBag({
    runtime: {
      inheritFrom: (sourceSessionId) => {
        calls.push(sourceSessionId);
        return { sessionId: 'sess_heir', sourceSessionId, messages: 2 };
      },
      readModelMessages: () => ({ messageCount: carried.length, messages: carried }),
    },
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    replaceItems: (items) => items,
    routeState: () => ({}),
  }));

  const result = await api.inheritFrom('sess_source');

  assert.deepEqual(calls, ['sess_source']);
  assert.equal(result.messages, 2);
  assert.equal(state.sessionId, 'sess_heir');
  // Only the conversation travels: the target's own system block never becomes
  // a transcript item.
  assert.deepEqual(
    state.items.map((item) => [item.kind, item.text]),
    [['user', 'first question'], ['assistant', 'first answer']],
  );
});
