// The real session store MCP sign-in methods composed with the TUI app's
// `/mcp login` flow and the shared oauth-code prompt: only the session runtime
// is stubbed. The TUI app owns the completion notice, so exactly one is posted.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpLogin } from '../../app/extension-pickers/mcp-login.mjs';
import { submitProviderPrompt } from '../../app/prompt-submit/provider-prompts.mjs';
import { createSessionExtensionsApi } from './extensions.mjs';

const CALLBACK = 'http://127.0.0.1:1/oauth/callback?code=c&state=s';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compose(runtime) {
  const notices = [];
  let state = { commandBusy: false, stats: {} };
  const api = createSessionExtensionsApi({
    runtime,
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
    },
    pushNotice: (text, level) => notices.push([text, level]),
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  const store = { ...api, pushNotice: (text, level) => notices.push([text, level]) };
  let prompt = null;
  const setProviderPrompt = (next) => {
    prompt = typeof next === 'function' ? next(prompt) : next;
  };
  const login = createMcpLogin({ store, setProviderPrompt, pollMs: 5 });
  const ctx = {
    state,
    store,
    oauthSubmitRef: { current: false },
    setProviderPrompt,
    clearModelCaches: () => {},
    openPanel: () => assert.fail('no provider picker follows an MCP sign-in'),
  };
  const completions = () => notices.filter(([text]) => /complete/i.test(text));
  return { login, ctx, notices, completions, prompt: () => prompt };
}

test('a pasted callback posts exactly one sign-in completion notice', async () => {
  let flowState = 'pending';
  const c = compose({
    beginMcpOAuthLogin: async () => ({ flowId: 'mcp_oauth_1', state: 'pending', url: 'https://auth.example/a' }),
    getMcpOAuthLoginStatus: (flowId) => ({ flowId, state: flowState }),
    cancelMcpOAuthLogin: async (flowId) => ({ flowId, state: 'cancelled' }),
    completeMcpOAuthLogin: async (flowId) => {
      flowState = 'complete';
      return { flowId, state: 'complete' };
    },
  });
  await c.login.loginMcpServer('srv');
  const prompt = c.prompt();
  assert.equal(prompt.kind, 'oauth-code');
  assert.equal(submitProviderPrompt(c.ctx, prompt, CALLBACK), true);
  // Let the paste settle and any further status poll run.
  await sleep(40);
  assert.equal(c.prompt(), null);
  assert.equal(c.completions().length, 1, JSON.stringify(c.notices));
  assert.ok(c.notices.every(([text]) => !text.includes('code=')));
});

test('a sign-in completed by stored tokens posts exactly one completion notice', async () => {
  const c = compose({
    beginMcpOAuthLogin: async () => ({ flowId: 'mcp_oauth_2', state: 'complete' }),
    getMcpOAuthLoginStatus: () => assert.fail('no flow to poll'),
    cancelMcpOAuthLogin: async () => assert.fail('nothing to cancel'),
    completeMcpOAuthLogin: async () => assert.fail('nothing to paste'),
  });
  await c.login.loginMcpServer('srv');
  await sleep(20);
  assert.equal(c.prompt(), null);
  assert.deepEqual(c.completions(), [['MCP sign-in complete for srv', 'info']]);
});
