import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionExtensionsApi } from './extensions.mjs';

function createHarness(stateOverrides = {}) {
  const calls = [];
  let state = { commandBusy: false, stats: {}, ...stateOverrides };
  const api = createSessionExtensionsApi({
    runtime: {
      saveMcpServer: async (input) => {
        calls.push(['saveMcpServer', input.name, state.commandBusy]);
        return { name: input.name };
      },
      removeMcpServer: async (name) => {
        calls.push(['removeMcpServer', name]);
        return { servers: [] };
      },
    },
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    pushNotice: (text) => calls.push(['notice', text]),
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  return { api, calls, getState: () => state };
}

test('an extension change holds the command lock and announces the result', async () => {
  const h = createHarness();
  assert.deepEqual(await h.api.saveMcpServer({ name: 'docs' }), { name: 'docs' });
  assert.deepEqual(h.calls, [
    ['saveMcpServer', 'docs', true],
    ['notice', 'mcp saved: docs'],
  ]);
  assert.equal(h.getState().commandBusy, false);
});

test('an extension change refused by a running command rejects instead of reporting success', async () => {
  const h = createHarness({ commandBusy: true });
  await assert.rejects(h.api.removeMcpServer('docs'), /Another command is still running/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.getState().commandBusy, true, 'the running command keeps its lock');
});
