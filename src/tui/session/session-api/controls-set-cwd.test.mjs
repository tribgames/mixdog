import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionControlsApi } from './controls.mjs';

function controls(setCwd) {
  let state = { cwd: 'C:\\before', items: [], promptHistoryList: [] };
  const notices = [];
  const api = createSessionControlsApi({
    runtime: { setCwd },
    nextId: () => 1,
    flags: {},
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    pushItem: () => {},
    pushNotice: (text, level) => notices.push([text, level]),
    agentStatusState: {},
    routeState: {},
    updateAgentJobCard: () => {},
    resetStatsAndSyncContext: () => {},
  });
  return { api, notices, state: () => state };
}

test('setCwd publishes the folder only after the runtime switch resolves', async () => {
  const { api, notices, state } = controls(async (path) => path);
  const next = await api.setCwd('C:\\after');
  assert.equal(next, 'C:\\after');
  assert.equal(state().cwd, 'C:\\after');
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0][0], /Promise/);
});

test('a refused setCwd leaves cwd unchanged and posts no notice', async () => {
  const { api, notices, state } = controls(async () => {
    throw new Error('refused');
  });
  await assert.rejects(api.setCwd('C:\\after'), /refused/);
  assert.equal(state().cwd, 'C:\\before');
  assert.equal(notices.length, 0);
});
