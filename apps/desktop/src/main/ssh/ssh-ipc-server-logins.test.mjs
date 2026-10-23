import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callbackPortOf, createServerLoginHandlers } from './ssh-ipc-server-logins.ts';

const HOST = { id: 'h1', name: 'build-box', target: 'dev@build-box', lastConnectedAt: 1 };
const AUTH_URL =
  'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1';

/** One attached server whose daemon answers the scripted capabilities. */
function setup({ modelLogin = 'server', answers = {}, attached = true, forward, maxForwardMs } = {}) {
  const calls = [];
  const opened = [];
  const forwards = [];
  const endListeners = new Set();
  const server = {
    modelLogin,
    async invoke(capability, args) {
      calls.push([capability, args]);
      const answer = answers[capability];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(...args) : answer;
    },
    busySessions: async () => 1,
    onEnd(listener) {
      endListeners.add(listener);
      return () => endListeners.delete(listener);
    },
  };
  const link = { attached };
  /** The attachment ends (disconnect, quit, a changed model login). */
  const end = () => {
    link.attached = false;
    for (const listener of [...endListeners]) {
      endListeners.delete(listener);
      listener();
    }
  };
  const handlers = createServerLoginHandlers({
    store: async () => ({ get: (id) => (id === HOST.id ? HOST : undefined) }),
    connection: (id) => (link.attached && id === HOST.id ? server : null),
    openExternal: async (url) => {
      opened.push(url);
    },
    forwardCallback:
      forward ??
      (async (host, port) => {
        const entry = { host: host.id, port, closed: 0 };
        forwards.push(entry);
        return {
          close: async () => {
            entry.closed += 1;
          },
        };
      }),
    ...(maxForwardMs ? { maxForwardMs } : {}),
  });
  return { handlers, calls, opened, forwards, server, end, endListeners, link };
}

const pending = (extra = {}) => ({ flowId: 'f1', provider: 'openai-oauth', state: 'pending', url: AUTH_URL, ...extra });

test('the callback port is the loopback redirect_uri port of the authorization URL', () => {
  assert.equal(callbackPortOf(AUTH_URL), 1455);
  assert.equal(
    callbackPortOf('https://x.example/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback'),
    51121
  );
  for (const url of [
    null,
    'not a url',
    'https://x.example/auth',
    'https://x.example/auth?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback',
    'https://x.example/auth?redirect_uri=http%3A%2F%2Fevil.example%3A1455%2Fcb',
    'https://x.example/auth?redirect_uri=http%3A%2F%2Flocalhost%2Fcb',
  ]) {
    assert.equal(callbackPortOf(url), null, String(url));
  }
});

test("a subscription login runs on the server, opens in this PC's browser and forwards the callback port until it ends", async () => {
  let state = 'pending';
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending(),
      getOAuthProviderLoginStatus: () => pending({ state }),
    },
  });
  const flow = await s.handlers.begin('h1', 'openai-oauth');
  // The server never opens a browser of its own.
  assert.deepEqual(s.calls[0], ['beginOAuthProviderLogin', ['openai-oauth', { openBrowser: false }]]);
  assert.deepEqual(s.opened, [AUTH_URL]);
  assert.deepEqual(
    s.forwards.map(({ host, port }) => [host, port]),
    [['h1', 1455]]
  );
  assert.deepEqual(flow, {
    flowId: 'f1',
    provider: 'openai-oauth',
    state: 'pending',
    url: AUTH_URL,
    error: null,
    forwarded: true,
  });
  assert.equal((await s.handlers.status('h1', 'f1')).forwarded, true);
  assert.equal(s.forwards[0].closed, 0, 'open while the login is pending');
  state = 'complete';
  const done = await s.handlers.status('h1', 'f1');
  assert.equal(done.state, 'complete');
  assert.equal(done.forwarded, false);
  assert.equal(s.forwards[0].closed, 1, 'closed once the login ended');
  await s.handlers.status('h1', 'f1');
  assert.equal(s.forwards[0].closed, 1, 'closed only once');
});

test('the pasted redirect address completes a login on the server and closes its forward', async () => {
  const pasted = 'http://localhost:1455/auth/callback?code=abc&state=s1';
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending(),
      completeOAuthProviderLogin: (flowId, code) => pending({ flowId, state: code === pasted ? 'complete' : 'failed' }),
    },
  });
  await s.handlers.begin('h1', 'openai-oauth');
  const done = await s.handlers.complete('h1', 'f1', `  ${pasted}  `);
  assert.deepEqual(s.calls.at(-1), ['completeOAuthProviderLogin', ['f1', pasted]]);
  assert.equal(done.state, 'complete');
  assert.equal(s.forwards[0].closed, 1);
  await assert.rejects(s.handlers.complete('h1', 'f1', 'http://x\ny'), /not valid/);
});

test('without the forward the login still opens, the manual page first, and the paste completes it', async () => {
  const manualUrl = 'https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Fcode';
  const s = setup({
    forward: async () => {
      throw new Error('port in use');
    },
    answers: {
      beginOAuthProviderLogin: pending({ provider: 'anthropic-oauth', manualUrl }),
      completeOAuthProviderLogin: () => pending({ provider: 'anthropic-oauth', state: 'complete' }),
    },
  });
  const flow = await s.handlers.begin('h1', 'anthropic-oauth');
  assert.equal(flow.forwarded, false);
  assert.deepEqual(s.opened, [manualUrl]);
  assert.equal((await s.handlers.complete('h1', 'f1', 'code#state')).state, 'complete');
});

test('cancel, a failed browser open, the time cap and dispose all close the forward', async () => {
  const cancelled = setup({
    answers: { beginOAuthProviderLogin: pending(), cancelOAuthProviderLogin: new Error('gone') },
  });
  await cancelled.handlers.begin('h1', 'openai-oauth');
  await assert.rejects(cancelled.handlers.cancel('h1', 'f1'), /gone/);
  assert.equal(cancelled.forwards[0].closed, 1, 'closed even when the server call failed');

  const noBrowser = setup({ answers: { beginOAuthProviderLogin: pending() } });
  const failing = createServerLoginHandlers({
    store: async () => ({ get: () => HOST }),
    connection: () => noBrowser.server,
    openExternal: async () => {
      throw new Error('no browser');
    },
    forwardCallback: async (host, port) => {
      const entry = { host: host.id, port, closed: 0 };
      noBrowser.forwards.push(entry);
      return {
        close: async () => {
          entry.closed += 1;
        },
      };
    },
  });
  await assert.rejects(failing.begin('h1', 'openai-oauth'), /no browser/);
  assert.equal(noBrowser.forwards[0].closed, 1);

  const capped = setup({ answers: { beginOAuthProviderLogin: pending() }, maxForwardMs: 20 });
  await capped.handlers.begin('h1', 'openai-oauth');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(capped.forwards[0].closed, 1, 'a login left pending loses its forward after the cap');

  const disposed = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await disposed.handlers.begin('h1', 'openai-oauth');
  await disposed.handlers.dispose();
  assert.equal(disposed.forwards[0].closed, 1);
});

test('a disconnect or a changed model login closes the forward at once, without any status read', async () => {
  const s = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await s.handlers.begin('h1', 'openai-oauth');
  assert.equal(s.forwards[0].closed, 0);
  assert.equal(s.endListeners.size, 1, 'the forward watches the attachment that started it');
  s.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.forwards[0].closed, 1, 'closed when the attachment ended');
  await assert.rejects(s.handlers.status('h1', 'f1'), /Connect to build-box/);
  await s.handlers.dispose();
  assert.equal(s.forwards[0].closed, 1, 'closed only once');
});

test('a rejected status closes the forward: the server went, or its call failed', async () => {
  // The server is no longer attached (no end signal reached the handlers).
  const gone = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await gone.handlers.begin('h1', 'openai-oauth');
  gone.link.attached = false;
  await assert.rejects(gone.handlers.status('h1', 'f1'), /Connect to build-box/);
  assert.equal(gone.forwards[0].closed, 1);
  assert.equal(gone.endListeners.size, 0, 'its watch is dropped with it');

  const failing = setup({
    answers: { beginOAuthProviderLogin: pending(), getOAuthProviderLoginStatus: new Error('daemon restarting') },
  });
  await failing.handlers.begin('h1', 'openai-oauth');
  await assert.rejects(failing.handlers.status('h1', 'f1'), /daemon restarting/);
  assert.equal(failing.forwards[0].closed, 1);
});

test("only a server attached with its own logins is reached; this PC's sign-ins never are", async () => {
  const offline = setup({ attached: false });
  assert.deepEqual(await offline.handlers.logins('h1'), {
    connected: false,
    modelLogin: null,
    busySessions: null,
    providers: null,
  });
  await assert.rejects(offline.handlers.begin('h1', 'openai-oauth'), /Connect to build-box/);
  await assert.rejects(offline.handlers.logins('nobody'), /no longer saved/);

  const pcMode = setup({ modelLogin: 'pc' });
  assert.deepEqual(await pcMode.handlers.logins('h1'), {
    connected: true,
    modelLogin: 'pc',
    busySessions: 1,
    providers: null,
  });
  for (const run of [
    () => pcMode.handlers.begin('h1', 'openai-oauth'),
    () => pcMode.handlers.status('h1', 'f1'),
    () => pcMode.handlers.complete('h1', 'f1', 'http://localhost:1455/?code=x'),
    () => pcMode.handlers.saveKey('h1', 'openai', 'sk-test'),
    () => pcMode.handlers.logout('h1', 'openai'),
  ]) {
    await assert.rejects(run(), /this PC's accounts/);
  }
  await pcMode.handlers.cancel('h1', 'f1');
  assert.deepEqual(pcMode.calls, [], 'a server on this PC’s logins is asked nothing');
});

test("the server's own logins are listed, signed-in first, and keys and log-outs go to the server", async () => {
  const s = setup({
    answers: {
      getProviderSetup: {
        oauth: [
          { id: 'gemini-oauth', name: 'Gemini', authenticated: false },
          { id: 'anthropic-oauth', name: 'Claude', authenticated: true },
        ],
        api: [
          { id: 'openai', name: 'OpenAI', authenticated: true, stored: true },
          { id: 'xai', name: 'xAI', authenticated: true, env: true, stored: false },
        ],
        local: [{ id: 'local', name: 'Local' }],
      },
      getProviderAccounts: (id) => ({
        provider: id,
        selectedId: 'work',
        accounts: [
          { id: 'default', label: 'Account 1', email: 'home@example.com' },
          { id: 'work', label: 'Account 2', email: 'you@example.com', identity: 'you@example.com · Acme' },
        ],
      }),
    },
  });
  const logins = await s.handlers.logins('h1');
  assert.equal(logins.busySessions, 1);
  assert.deepEqual(logins.providers, [
    { id: 'anthropic-oauth', name: 'Claude', kind: 'oauth', signedIn: true, identity: 'you@example.com' },
    { id: 'openai', name: 'OpenAI', kind: 'api', signedIn: true },
    { id: 'xai', name: 'xAI', kind: 'api', signedIn: true, fromEnvironment: true },
    { id: 'gemini-oauth', name: 'Gemini', kind: 'oauth', signedIn: false },
  ]);
  await s.handlers.saveKey('h1', 'openai', '  sk-new  ');
  await s.handlers.logout('h1', 'anthropic-oauth');
  // Only the signed-in subscription's roster is read, for its account name.
  assert.deepEqual(s.calls.slice(1), [
    ['getProviderAccounts', ['anthropic-oauth']],
    ['saveProviderApiKey', ['openai', 'sk-new']],
    ['forgetProviderAuth', ['anthropic-oauth']],
  ]);
  await assert.rejects(s.handlers.saveKey('h1', '../x', 'sk'), /provider id is not valid/);
  await assert.rejects(s.handlers.saveKey('h1', 'openai', 'sk\u0000'), /API key is not valid/);
  await assert.rejects(s.handlers.logout('h1', ''), /provider/);
});
