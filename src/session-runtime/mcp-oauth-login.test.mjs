import assert from 'node:assert/strict';
import test from 'node:test';

import { createResourceApi } from './resource-api.mjs';
import { createMcpOAuthLogins } from './mcp-oauth-login.mjs';

const AUTH_URL = 'https://auth.example/authorize?state=s&code_challenge_method=S256';

function harness(t, { servers = { remote: { type: 'http', url: 'https://mcp.example/mcp' } }, completeMcpLogin } = {}) {
  const calls = [];
  const cleared = [];
  const cancelled = [];
  const probes = [];
  let finishLogin;
  let outcome = { connected: true };
  const api = createResourceApi({
    getConfig: () => ({ mcpServers: servers }),
    getSession: () => null,
    getCurrentCwd: () => process.cwd(),
    cfgMod: {},
    hooks: {},
    saveConfigAndAdopt: () => {},
    async connectConfiguredMcp(options) {
      calls.push(options);
      if (options.login) {
        await options.login.openBrowser(AUTH_URL);
        await new Promise((resolve) => {
          finishLogin = resolve;
        });
      }
      const row = { name: options.only, connected: options.login ? outcome.connected : false };
      if (outcome.error) row.error = outcome.error;
      return { servers: options.only ? [row] : [] };
    },
    cancelMcpLogin: (name) => {
      cancelled.push(name);
      outcome = { connected: false, error: 'MCP OAuth login failed, cancelled, or timed out' };
      finishLogin?.();
    },
    completeMcpLogin,
    clearMcpServerOAuth: async (cfg) => cleared.push(cfg),
    getMcpServerOAuthState: (cfg) => (cfg.url && !cfg.headers ? { signedIn: false } : null),
    probeMcpServerAuth: async (cfg) => {
      probes.push(cfg);
      return { auth: 'oauth' };
    },
    resolveMcpCatalog: () => ({ servers, adoption: null, plugins: {}, entries: {} }),
    invalidatePreSessionToolSurface: () => {},
    normalizeMcpServerInput: () => {
      throw new Error('not used');
    },
    mcpStatus: () => ({ servers: [] }),
    skillsStatus: () => ({ skills: [] }),
    pluginsStatus: () => ({ plugins: [] }),
    reloadFullConfig: () => {},
    awaitKeychainPrewarm: async () => {},
  });
  t.after(() => api.disposeGlobalExtensionSubscription());
  return {
    api,
    calls,
    cleared,
    cancelled,
    probes,
    finish: (next) => {
      if (next) outcome = next;
      finishLogin();
    },
  };
}

const settled = async (api, flowId) => {
  for (let i = 0; i < 100; i++) {
    const status = api.getMcpOAuthLoginStatus(flowId);
    if (status.state !== 'pending') return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return api.getMcpOAuthLoginStatus(flowId);
};

test('beginMcpOAuthLogin returns the authorization URL, then completes after the interactive reconnect', async (t) => {
  const h = harness(t);
  const begun = await h.api.beginMcpOAuthLogin('remote', { openBrowser: false });
  assert.match(begun.flowId, /^mcp_oauth_/);
  assert.deepEqual(begun, { flowId: begun.flowId, state: 'pending', url: AUTH_URL });
  // A pending flow's status keeps its URL (a remote client re-renders from it)
  // and names the step it waits for.
  assert.deepEqual(h.api.getMcpOAuthLoginStatus(begun.flowId), {
    flowId: begun.flowId,
    state: 'pending',
    step: 'browser',
    url: AUTH_URL,
  });
  assert.equal(h.calls[0].only, 'remote');
  assert.equal(h.calls[0].enabled, true);
  assert.equal(typeof h.calls[0].login.openBrowser, 'function');
  h.finish();
  assert.deepEqual(await settled(h.api, begun.flowId), { flowId: begun.flowId, state: 'complete' });
});

test('a failed sign-in reports its error; unknown flows and non-OAuth or disabled servers are refused', async (t) => {
  const h = harness(t, {
    servers: {
      remote: { type: 'http', url: 'https://mcp.example/mcp' },
      keyed: { type: 'http', url: 'https://mcp.example/k', headers: { 'X-Key': 'k' } },
      local: { command: 'node' },
      off: { type: 'http', url: 'https://mcp.example/off', enabled: false },
    },
  });
  const begun = await h.api.beginMcpOAuthLogin('remote', { openBrowser: false });
  h.finish({ connected: false, error: 'MCP OAuth login failed, cancelled, or timed out' });
  assert.deepEqual(await settled(h.api, begun.flowId), {
    flowId: begun.flowId,
    state: 'failed',
    error: 'MCP OAuth login failed, cancelled, or timed out',
  });
  assert.throws(() => h.api.getMcpOAuthLoginStatus('mcp_oauth_missing'), /not found/);
  await assert.rejects(h.api.beginMcpOAuthLogin('keyed'), /does not use OAuth sign-in/);
  await assert.rejects(h.api.beginMcpOAuthLogin('local'), /does not use OAuth sign-in/);
  await assert.rejects(h.api.beginMcpOAuthLogin('off'), /disabled/);
  await assert.rejects(h.api.beginMcpOAuthLogin('missing'), /not configured/);
  await assert.rejects(h.api.beginMcpOAuthLogin('remote', { openBrowser: 'no' }), /openBrowser must be a boolean/);
});

test('cancelMcpOAuthLogin cancels the pending login of that server', async (t) => {
  const h = harness(t);
  const begun = await h.api.beginMcpOAuthLogin('remote', { openBrowser: false });
  assert.deepEqual(await h.api.cancelMcpOAuthLogin(begun.flowId), { flowId: begun.flowId, state: 'cancelled' });
  assert.deepEqual(h.cancelled, ['remote']);
  assert.deepEqual(h.api.getMcpOAuthLoginStatus(begun.flowId), { flowId: begun.flowId, state: 'cancelled' });
});

test('completeMcpOAuthLogin answers the pending flow with the pasted URL and resolves its outcome', async (t) => {
  const pasted = [];
  const h = harness(t, {
    completeMcpLogin(name, callbackUrl) {
      if (!callbackUrl.startsWith('http://127.0.0.1')) throw new Error('The pasted sign-in URL is invalid.');
      pasted.push([name, callbackUrl]);
      h.finish();
    },
  });
  const begun = await h.api.beginMcpOAuthLogin('remote', { openBrowser: false });
  // An invalid paste throws and leaves the flow pending for another try.
  await assert.rejects(h.api.completeMcpOAuthLogin(begun.flowId, 'garbage'), /invalid/);
  assert.equal(h.api.getMcpOAuthLoginStatus(begun.flowId).state, 'pending');
  const callback = 'http://127.0.0.1:1/oauth/callback?code=c&state=s';
  assert.deepEqual(await h.api.completeMcpOAuthLogin(begun.flowId, callback), {
    flowId: begun.flowId,
    state: 'complete',
  });
  assert.deepEqual(pasted, [['remote', callback]]);
  await assert.rejects(h.api.completeMcpOAuthLogin(begun.flowId, callback), /no longer pending/);
  await assert.rejects(h.api.completeMcpOAuthLogin('mcp_oauth_missing', callback), /not found/);
  // After a cancel a paste is refused before it reaches the runtime.
  const next = await h.api.beginMcpOAuthLogin('remote', { openBrowser: false });
  await h.api.cancelMcpOAuthLogin(next.flowId);
  await assert.rejects(h.api.completeMcpOAuthLogin(next.flowId, callback), /no longer pending/);
  assert.equal(pasted.length, 1);
});

test('signOutMcpServer clears stored credentials and reconnects without a login', async (t) => {
  const h = harness(t);
  await h.api.signOutMcpServer('remote');
  assert.deepEqual(h.cleared, [{ type: 'http', url: 'https://mcp.example/mcp' }]);
  assert.deepEqual(h.calls, [{ only: 'remote', enabled: true }, { reconcile: true }]);
});

test('probeMcpServerAuth forwards only the transport and auth fields of an http/sse config', async (t) => {
  const h = harness(t);
  assert.deepEqual(
    await h.api.probeMcpServerAuth({ type: 'sse', url: 'https://mcp.example/sse', command: 'x', enabled: true }),
    { auth: 'oauth' }
  );
  assert.deepEqual(h.probes, [{ type: 'sse', url: 'https://mcp.example/sse' }]);
  assert.throws(() => h.api.probeMcpServerAuth({ command: 'node' }), /type must be/);
});

test('the host browser opens only when the caller allows it', async () => {
  const opened = [];
  for (const hostBrowser of [undefined, false]) {
    let finish;
    const logins = createMcpOAuthLogins({
      connect: async (_name, launch) => {
        await launch(AUTH_URL);
        await new Promise((resolve) => {
          finish = resolve;
        });
        return { connected: true };
      },
      cancel: () => {},
      openBrowser: (url) => opened.push(url),
    });
    const begun = await logins.begin('remote', hostBrowser === undefined ? {} : { openBrowser: hostBrowser });
    assert.equal(begun.url, AUTH_URL);
    finish();
  }
  assert.deepEqual(opened, [AUTH_URL]);
});

// Fake interactive reconnects: each waits for `gate` (read at call time), then
// launches the login and waits until cancelled; `live` holds the unsettled ones.
function fakeLogins({ cancelDelayMs = 0 } = {}) {
  const fake = { live: new Set(), order: [], gate: Promise.resolve() };
  fake.logins = createMcpOAuthLogins({
    async connect(name, launch) {
      fake.order.push(`connect:${name}`);
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      const run = { name, finish };
      fake.live.add(run);
      try {
        const early = await Promise.race([fake.gate.then(() => null), done]);
        if (early) return early;
        await launch(AUTH_URL);
        return await done;
      } finally {
        fake.live.delete(run);
      }
    },
    cancel(name) {
      for (const run of fake.live) {
        if (run.name !== name) continue;
        const settle = () => run.finish({ connected: false, error: 'MCP OAuth login failed, cancelled, or timed out' });
        if (cancelDelayMs > 0) setTimeout(settle, cancelDelayMs);
        else settle();
      }
    },
    openBrowser: () => {},
  });
  return fake;
}

test('overlapping begins for one server leave exactly one pending flow', async () => {
  const fake = fakeLogins({ cancelDelayMs: 5 });
  const first = await fake.logins.begin('remote', { openBrowser: false });
  const [second, third] = await Promise.allSettled([
    fake.logins.begin('remote', { openBrowser: false }),
    fake.logins.begin('remote', { openBrowser: false }),
  ]);
  assert.equal(fake.logins.status(first.flowId).state, 'cancelled');
  // The second either returned its URL before the third replaced it, or was
  // replaced before it had one.
  if (second.status === 'fulfilled') assert.equal(fake.logins.status(second.value.flowId).state, 'cancelled');
  else assert.match(second.reason.message, /not completed|cancelled/);
  assert.equal(third.status, 'fulfilled');
  assert.equal(third.value.state, 'pending');
  assert.equal(fake.logins.status(third.value.flowId).state, 'pending');
  assert.equal(fake.live.size, 1);
});

test('a begin issued during a cancel waits for it and becomes the only pending flow', async () => {
  const fake = fakeLogins({ cancelDelayMs: 10 });
  const first = await fake.logins.begin('remote', { openBrowser: false });
  const cancelling = fake.logins.cancel(first.flowId);
  const next = fake.logins.begin('remote', { openBrowser: false });
  assert.deepEqual(await cancelling, { flowId: first.flowId, state: 'cancelled' });
  const begun = await next;
  assert.equal(fake.logins.status(begun.flowId).state, 'pending');
  assert.equal(fake.live.size, 1);
  assert.deepEqual(fake.order, ['connect:remote', 'connect:remote']);
});

test('a sign-out during a pending begin cancels it, and a later begin starts only after the sign-out', async () => {
  const fake = fakeLogins();
  fake.gate = new Promise(() => {});
  const pending = fake.logins.begin('remote', { openBrowser: false });
  const signedOut = fake.logins.cancelServer('remote', async () => {
    fake.order.push('signed-out');
    fake.gate = Promise.resolve();
    return 'status';
  });
  const later = fake.logins.begin('remote', { openBrowser: false });
  await assert.rejects(pending, /not completed/);
  assert.equal(await signedOut, 'status');
  const begun = await later;
  assert.equal(fake.logins.status(begun.flowId).state, 'pending');
  assert.deepEqual(fake.order, ['connect:remote', 'signed-out', 'connect:remote']);
  assert.equal(fake.live.size, 1);
});

test('a flow begun in one runtime is read, completed and cancelled from another, with its own handlers', async () => {
  const pasted = [];
  // The owner's connect waits for a paste or a cancel.
  const runs = new Set();
  const finishAll = (outcome) => {
    for (const resolve of runs) resolve(outcome);
    runs.clear();
  };
  const flowOwner = createMcpOAuthLogins({
    connect: (_name, launch) =>
      new Promise((resolve) => {
        runs.add(resolve);
        launch(AUTH_URL);
      }),
    cancel: () => finishAll({ connected: false, error: 'cancelled' }),
    completeCallback: (name, url) => {
      pasted.push(['owner', name, url]);
      finishAll({ connected: true });
    },
  });
  const other = createMcpOAuthLogins({
    connect: async () => assert.fail('the other runtime never connects'),
    cancel: () => assert.fail('the other runtime never cancels'),
    completeCallback: () => assert.fail('the other runtime never answers'),
  });
  const begun = await flowOwner.begin('remote', { openBrowser: false });
  assert.deepEqual(other.status(begun.flowId), {
    flowId: begun.flowId,
    state: 'pending',
    step: 'browser',
    url: AUTH_URL,
  });
  assert.deepEqual(await other.complete(begun.flowId, 'http://127.0.0.1:1/cb?code=c&state=s'), {
    flowId: begun.flowId,
    state: 'complete',
  });
  assert.deepEqual(pasted, [['owner', 'remote', 'http://127.0.0.1:1/cb?code=c&state=s']]);
  const next = await flowOwner.begin('remote', { openBrowser: false });
  assert.deepEqual(await other.cancel(next.flowId), { flowId: next.flowId, state: 'cancelled' });
  assert.deepEqual(flowOwner.status(next.flowId), { flowId: next.flowId, state: 'cancelled' });
});

test('a reconnect that needs no login completes immediately and a failure before any URL rejects', async () => {
  const completed = [];
  const ok = createMcpOAuthLogins({
    connect: async () => ({ connected: true }),
    cancel: () => {},
    onComplete: (name) => completed.push(name),
  });
  const begun = await ok.begin('remote');
  assert.deepEqual(begun, { flowId: begun.flowId, state: 'complete' });
  assert.deepEqual(completed, ['remote']);
  const down = createMcpOAuthLogins({
    connect: async () => ({ connected: false, error: 'fetch failed' }),
    cancel: () => {},
  });
  await assert.rejects(down.begin('remote'), /fetch failed/);
});

test('a status read with `since` follows each step as it happens: browser → connecting → tools → complete', {
  timeout: 5_000,
}, async () => {
  let launch;
  let finish;
  const peers = [];
  const logins = createMcpOAuthLogins({
    connect: (_name, opened) =>
      new Promise((resolve) => {
        launch = opened;
        finish = resolve;
        opened(AUTH_URL);
      }),
    cancel: () => {},
    // The other runtimes' reconnect never holds up the flow's completion.
    onComplete: () => new Promise((resolve) => peers.push(resolve)),
    openBrowser: () => {},
  });
  const begun = await logins.begin('remote', { openBrowser: false });
  assert.equal(launch.accountMode, 'connect');
  const seen = [];
  const watch = async (since) => {
    const next = await logins.status(begun.flowId, { since, waitMs: 600_000 });
    seen.push(next.step ? `${next.state}:${next.step}` : next.state);
    return next.state === 'pending' ? watch(`${next.state}:${next.step}`) : next;
  };
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  // An unchanged status keeps the read waiting; a changed one wakes it at once.
  let woke = null;
  const held = logins.status(begun.flowId, { since: 'pending:browser', waitMs: 600_000 }).then((next) => {
    woke = next;
  });
  await flush();
  assert.equal(woke, null, 'unchanged status keeps waiting');
  launch.onCallback();
  await held;
  assert.equal(woke.step, 'connecting', 'a changed status wakes the read immediately');
  seen.push(`${woke.state}:${woke.step}`);
  const watching = watch('pending:connecting');
  await flush();
  launch.onAuthorized();
  await new Promise((resolve) => setImmediate(resolve));
  finish({ connected: true });
  assert.deepEqual(await watching, { flowId: begun.flowId, state: 'complete' });
  assert.deepEqual(seen, ['pending:connecting', 'pending:tools', 'complete']);
  assert.equal(peers.length, 1, 'the peers reconnect after the flow already reports complete');
  // An unchanged flow answers after at most waitMs.
  const next = await logins.begin('other', { openBrowser: false });
  assert.equal((await logins.status(next.flowId, { since: 'pending:browser', waitMs: 30 })).step, 'browser');
  assert.throws(() => logins.status(next.flowId, { since: 1, waitMs: 1 }), /since must be a string/);
});

test('a sign-in nobody finishes times out with its own reason; begin refuses an unknown mode', async () => {
  const logins = createMcpOAuthLogins({
    connect: (_name, launch) =>
      new Promise((resolve) => {
        logins.finish = resolve;
        launch(AUTH_URL);
      }),
    cancel: () => logins.finish({ connected: false, error: 'MCP OAuth login failed, cancelled, or timed out' }),
    openBrowser: () => {},
    loginTimeoutMs: 20,
  });
  const begun = await logins.begin('remote', { openBrowser: false });
  const settledView = await logins.status(begun.flowId, { since: 'pending:browser', waitMs: 2_000 });
  assert.deepEqual(settledView, {
    flowId: begun.flowId,
    state: 'failed',
    error: 'MCP OAuth sign-in timed out',
    reason: 'timeout',
  });
  await assert.rejects(logins.begin('remote', { mode: 'other' }), /mode must be/);
});

test('계정 바꾸기 runs the switch handler with its own abort and paste answer; a cancel changes nothing', async () => {
  const events = [];
  let release;
  const logins = createMcpOAuthLogins({
    connect: async () => assert.fail('a switch never reconnects interactively'),
    cancel: () => assert.fail('a switch is aborted through its own handler'),
    async switchAccount(_name, launch, attempt) {
      assert.equal(launch.accountMode, 'switch');
      attempt.abort = () => {
        events.push('abort');
        release(new Error('MCP OAuth login cancelled'));
      };
      attempt.answer = (url) => events.push(`answer:${url}`);
      await launch(AUTH_URL);
      await new Promise((_resolve, reject) => {
        release = reject;
      });
    },
    openBrowser: () => {},
  });
  const begun = await logins.begin('remote', { openBrowser: false, mode: 'switch' });
  const answered = logins.complete(begun.flowId, 'http://127.0.0.1:1/oauth/callback?code=c&state=s');
  assert.deepEqual(await logins.cancel(begun.flowId), { flowId: begun.flowId, state: 'cancelled' });
  assert.equal((await answered).state, 'cancelled');
  assert.deepEqual(events, ['answer:http://127.0.0.1:1/oauth/callback?code=c&state=s', 'abort']);
});
