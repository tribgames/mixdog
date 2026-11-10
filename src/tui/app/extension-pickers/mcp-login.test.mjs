import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { panelCommands } from '../slash-dispatch/panel-commands.mjs';
import { createMcpLogin } from './mcp-login.mjs';

function harness(overrides = {}) {
  const notices = [];
  const calls = [];
  let prompt = null;
  const setProviderPrompt = (next) => {
    prompt = typeof next === 'function' ? next(prompt) : next;
  };
  const store = {
    pushNotice: (m, t) => notices.push([m, t]),
    beginMcpOAuthLogin: async (...a) => {
      calls.push(['begin', ...a]);
      return { flowId: 'f1', state: 'pending', url: 'https://auth.example/authorize?x=1' };
    },
    getMcpOAuthLoginStatus: async () => ({ flowId: 'f1', state: 'pending' }),
    completeMcpOAuthLogin: async (...a) => {
      calls.push(['complete', ...a]);
      return { flowId: 'f1', state: 'complete' };
    },
    cancelMcpOAuthLogin: async (...a) => calls.push(['cancel', ...a]),
    signOutMcpServer: async (...a) => calls.push(['signOut', ...a]),
    ...overrides,
  };
  const login = createMcpLogin({ store, setProviderPrompt, pollMs: 5 });
  return { store, notices, calls, login, prompt: () => prompt };
}

test('login prints the URL, opens browser, shows paste prompt', async () => {
  const h = harness();
  await h.login.loginMcpServer('srv');
  assert.deepEqual(h.calls[0], ['begin', 'srv', { openBrowser: true }]);
  assert.match(h.notices[0][0], /https:\/\/auth\.example\/authorize/);
  assert.equal(h.prompt().kind, 'oauth-code');
  assert.match(h.prompt().hint, /paste its address here/);
  h.prompt().login.cancel();
  assert.deepEqual(h.calls.at(-1), ['cancel', 'f1']);
});

test('polling completion closes the prompt and notifies', async () => {
  let n = 0;
  const h = harness({
    getMcpOAuthLoginStatus: async () => ({ state: ++n > 1 ? 'complete' : 'pending' }),
  });
  await h.login.loginMcpServer('srv');
  await sleep(60);
  assert.equal(h.prompt(), null);
  assert.ok(h.notices.some(([m]) => m === 'MCP sign-in complete for srv'));
});

test('polling failure reports the error', async () => {
  const h = harness({ getMcpOAuthLoginStatus: async () => ({ state: 'failed', error: 'denied' }) });
  await h.login.loginMcpServer('srv');
  await sleep(40);
  assert.equal(h.prompt(), null);
  assert.deepEqual(h.notices.at(-1), ['MCP sign-in failed for srv: denied', 'error']);
});

test('stored tokens complete immediately without a prompt', async () => {
  const h = harness({ beginMcpOAuthLogin: async () => ({ flowId: 'f2', state: 'complete' }) });
  await h.login.loginMcpServer('srv');
  assert.equal(h.prompt(), null);
  assert.deepEqual(h.notices, [['MCP sign-in complete for srv', 'info']]);
});

test('paste completes through completeMcpOAuthLogin; invalid paste throws and can retry', async () => {
  let fail = true;
  const h = harness({
    completeMcpOAuthLogin: async (id, url) => {
      h.calls.push(['complete', id, url]);
      if (fail) throw new Error('invalid redirect address');
      return { state: 'complete' };
    },
  });
  await h.login.loginMcpServer('srv');
  const first = h.prompt();
  await assert.rejects(first.login.completeCode('http://localhost/cb?code=zzz'), /invalid redirect address/);
  first.failureReturn();
  const retry = h.prompt();
  assert.notEqual(retry, first);
  fail = false;
  await retry.login.completeCode('http://localhost/cb?code=ok');
  assert.ok(h.notices.every(([m]) => !m.includes('code=')));
  await sleep(20);
  assert.equal(h.calls.filter((c) => c[0] === 'complete').length, 2);
  // Polling must not add a second completion notice after a successful paste.
  assert.equal(h.notices.filter(([m]) => /complete/.test(m)).length, 0);

  // Through the shared prompt handler: exactly one completion notice.
  const { submitProviderPrompt } = await import('../prompt-submit/provider-prompts.mjs');
  const h2 = harness({ getMcpOAuthLoginStatus: async () => ({ state: 'complete' }) });
  await h2.login.loginMcpServer('srv');
  const p = h2.prompt();
  let opened = 0;
  const ctx = {
    state: {},
    store: h2.store,
    oauthSubmitRef: { current: false },
    setProviderPrompt: () => {},
    clearModelCaches: () => {},
    openPanel: () => opened++,
    openProviderSetupPicker: () => {},
  };
  submitProviderPrompt(ctx, p, 'http://localhost/cb?code=ok');
  await sleep(30);
  assert.equal(h2.notices.filter(([m]) => /complete/.test(m)).length, 1);
  assert.equal(opened, 0);
});

test('logout calls signOutMcpServer', async () => {
  const h = harness();
  await h.login.logoutMcpServer('srv');
  assert.deepEqual(h.calls[0], ['signOut', 'srv']);
  assert.deepEqual(h.notices[0], ['MCP signed out of srv', 'info']);
});

test('/mcp login|logout route to the login deps; bare /mcp opens the panel', () => {
  const seen = [];
  const notices = [];
  const ctx = {
    store: { pushNotice: (m, t) => notices.push([m, t]) },
    deps: {
      loginMcpServer: (n) => seen.push(['login', n]),
      logoutMcpServer: (n) => seen.push(['logout', n]),
      openMcpPicker: () => seen.push(['picker']),
    },
    openSlashPanel: (_c, _t, open) => open(),
  };
  panelCommands.mcp(ctx, 'login my server');
  panelCommands.mcp(ctx, 'LOGOUT srv');
  panelCommands.mcp(ctx, 'login');
  panelCommands.mcp(ctx, '');
  assert.deepEqual(seen, [['login', 'my server'], ['logout', 'srv'], ['picker']]);
  assert.deepEqual(notices, [['usage: /mcp login <name>', 'warn']]);
});
