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

test('MCP OAuth sign-in actions forward to the runtime; sign-out holds the command lock', async () => {
  const calls = [];
  let state = { commandBusy: false, stats: {} };
  const runtime = {
    beginMcpOAuthLogin: async (name, options) => {
      calls.push(['begin', name, options]);
      return { flowId: 'mcp_oauth_1', state: 'pending', url: 'https://auth.example/authorize' };
    },
    getMcpOAuthLoginStatus: (flowId) => ({ flowId, state: 'pending' }),
    cancelMcpOAuthLogin: async (flowId) => ({ flowId, state: 'cancelled' }),
    completeMcpOAuthLogin: async (flowId, callbackUrl) => {
      calls.push(['complete', flowId, callbackUrl, state.commandBusy]);
      return { flowId, state: 'complete' };
    },
    signOutMcpServer: async (name) => {
      calls.push(['signOut', name, state.commandBusy]);
      return { servers: [] };
    },
    probeMcpServerAuth: async (cfg) => ({ auth: cfg.url ? 'oauth' : 'none' }),
  };
  const api = createSessionExtensionsApi({
    runtime,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    pushNotice: (text) => calls.push(['notice', text]),
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  assert.deepEqual(await api.beginMcpOAuthLogin('docs', { openBrowser: false }), {
    flowId: 'mcp_oauth_1',
    state: 'pending',
    url: 'https://auth.example/authorize',
  });
  assert.deepEqual(api.getMcpOAuthLoginStatus('mcp_oauth_1'), { flowId: 'mcp_oauth_1', state: 'pending' });
  assert.deepEqual(await api.cancelMcpOAuthLogin('mcp_oauth_1'), { flowId: 'mcp_oauth_1', state: 'cancelled' });
  assert.deepEqual(await api.completeMcpOAuthLogin('mcp_oauth_1', 'http://127.0.0.1:1/oauth/callback?code=c'), {
    flowId: 'mcp_oauth_1',
    state: 'complete',
  });
  await api.signOutMcpServer('docs');
  assert.deepEqual(await api.probeMcpServerAuth({ type: 'http', url: 'https://x' }), { auth: 'oauth' });
  assert.deepEqual(calls, [
    ['begin', 'docs', { openBrowser: false }],
    ['notice', 'mcp sign-in started: docs'],
    ['complete', 'mcp_oauth_1', 'http://127.0.0.1:1/oauth/callback?code=c', false],
    ['signOut', 'docs', true],
    ['notice', 'mcp signed out: docs'],
  ]);
  delete runtime.probeMcpServerAuth;
  assert.throws(() => api.probeMcpServerAuth({}), /MCP sign-in is unavailable/);
});

test('an extension change refused by a running command rejects instead of reporting success', async () => {
  const h = createHarness({ commandBusy: true });
  await assert.rejects(h.api.removeMcpServer('docs'), /Another command is still running/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.getState().commandBusy, true, 'the running command keeps its lock');
});

test('concurrent connector account adds both succeed: no command lock, each notice posted', async () => {
  const calls = [];
  const state = { commandBusy: false, stats: {} };
  const api = createSessionExtensionsApi({
    runtime: {
      addConnectorAccount: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { account: input.key };
      },
    },
    getState: () => state,
    set: () => {},
    pushNotice: (text) => calls.push(text),
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  const added = await Promise.all([
    api.addConnectorAccount({ connector: 'hugging-face', key: 'hf_ONE' }),
    api.addConnectorAccount({ connector: 'hugging-face', key: 'hf_TWO' }),
  ]);
  assert.deepEqual(
    added.map((one) => one.account),
    ['hf_ONE', 'hf_TWO']
  );
  assert.deepEqual(calls.sort(), ['mcp account added: hf_ONE', 'mcp account added: hf_TWO']);
});
