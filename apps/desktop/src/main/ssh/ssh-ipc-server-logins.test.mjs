import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { waitUntil } from '../bounded-wait.mjs';
import { callbackPortOf, createServerLoginHandlers } from './ssh-ipc-server-logins.ts';

const HOST = { id: 'h1', name: 'build-box', target: 'dev@build-box', lastConnectedAt: 1 };
const AUTH_URL =
  'https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1';

/** One attached server whose daemon answers the scripted capabilities. */
function setup({ modelLogin = 'server', answers = {}, attached = true, forward, maxForwardMs, maxQueuedCancels } = {}) {
  const clock = { now: 1_000_000 };
  const calls = [];
  const opened = [];
  const forwards = [];
  const endListeners = new Set();
  const server = {
    modelLogin,
    async invoke(capability, args) {
      if (!link.reachable) throw new Error('ssh link is down');
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
  const link = { attached, reachable: true };
  const attachListeners = new Set();
  /** The attachment ends (disconnect, quit, a changed model login); settles
   *  once the watchers' work has, as the connection's dispose waits for it. */
  const end = async () => {
    link.attached = false;
    const ended = [];
    for (const listener of [...endListeners]) {
      endListeners.delete(listener);
      ended.push(listener());
    }
    await Promise.all(ended);
  };
  /** The server's connection is attached again (`reachable`: and its link carries calls). */
  const reattach = async (reachable = true) => {
    link.attached = true;
    link.reachable = reachable;
    for (const listener of [...attachListeners]) listener(HOST.id);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const handlers = createServerLoginHandlers({
    store: async () => ({ get: (id) => (id === HOST.id ? HOST : undefined) }),
    connection: (id) => (link.attached && id === HOST.id ? server : null),
    onAttach: (listener) => {
      attachListeners.add(listener);
      return () => attachListeners.delete(listener);
    },
    cancelTimeoutMs: 50,
    now: () => clock.now,
    ...(maxQueuedCancels ? { maxQueuedCancels } : {}),
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
  return { handlers, calls, opened, forwards, server, end, reattach, endListeners, attachListeners, link, clock };
}

const cancelCalls = (s) => s.calls.filter(([capability]) => capability === 'cancelOAuthProviderLogin');

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
    'https://x.example/auth?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A1455%2Fcb',
  ]) {
    assert.equal(callbackPortOf(url), null, String(url));
  }
});

test('an IPv6 loopback callback is not forwarded; the manual paste completes it', async () => {
  const v6 = 'https://x.example/auth?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A1455%2Fauth%2Fcallback';
  const pasted = 'http://[::1]:1455/auth/callback?code=abc&state=s1';
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending({ url: v6 }),
      completeOAuthProviderLogin: (flowId, code) =>
        pending({ flowId, url: v6, state: code === pasted ? 'complete' : 'failed' }),
    },
  });
  const flow = await s.handlers.begin('h1', 'openai-oauth');
  assert.equal(s.forwards.length, 0);
  assert.equal(flow.forwarded, false);
  assert.equal(flow.url, v6);
  const done = await s.handlers.complete('h1', 'f1', pasted);
  assert.deepEqual(s.calls.at(-1), ['completeOAuthProviderLogin', ['f1', pasted]]);
  assert.equal(done.state, 'complete');
  assert.equal(done.forwarded, false);
});

test('an IPv4 loopback callback is still forwarded', async () => {
  const v4 = 'https://x.example/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback';
  const s = setup({ answers: { beginOAuthProviderLogin: pending({ url: v4 }) } });
  const flow = await s.handlers.begin('h1', 'openai-oauth');
  assert.equal(s.forwards.length, 1);
  assert.equal(flow.forwarded, true);
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
  await cancelled.handlers.cancel('h1', 'f1');
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
  // The cap is a fake timer: still open just before it, closed once it is reached.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await capped.handlers.begin('h1', 'openai-oauth');
    mock.timers.tick(19);
    for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capped.forwards[0].closed, 0, 'the forward is kept until the cap');
    mock.timers.tick(1);
    await waitUntil(() => capped.forwards[0].closed === 1, 'the capped login to lose its forward');
  } finally {
    mock.timers.reset();
  }
  assert.equal(capped.forwards[0].closed, 1, 'a login left pending loses its forward after the cap');

  const disposed = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await disposed.handlers.begin('h1', 'openai-oauth');
  await disposed.handlers.dispose();
  assert.equal(disposed.forwards[0].closed, 1);
});

test('a plain verification URL carries the separate device code and the manual-completion flag', async () => {
  const url = 'https://muse.example/device';
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending({ url, userCode: 'ABCD-1234', manualCodeSupported: false }),
      getOAuthProviderLoginStatus: pending({ url, userCode: 'ABCD-1234', manualCodeSupported: false }),
    },
  });
  const flow = await s.handlers.begin('h1', 'muse-code-oauth');
  assert.equal(flow.url, url);
  assert.equal(flow.forwarded, false);
  assert.equal(flow.userCode, 'ABCD-1234');
  assert.equal(flow.manualCodeSupported, false);
  const status = await s.handlers.status('h1', 'f1');
  assert.equal(status.userCode, 'ABCD-1234');
  assert.equal(status.manualCodeSupported, false);
});

test('a disconnect or a changed model login closes the forward at once, without any status read', async () => {
  const s = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await s.handlers.begin('h1', 'openai-oauth');
  assert.equal(s.forwards[0].closed, 0);
  assert.equal(s.endListeners.size, 1, 'the forward watches the attachment that started it');
  await s.end();
  assert.equal(s.forwards[0].closed, 1, 'closed when the attachment ended');
  await assert.rejects(s.handlers.status('h1', 'f1'), /Connect to build-box/);
  await s.handlers.dispose();
  assert.equal(s.forwards[0].closed, 1, 'closed only once');
});

test('a disconnect, dispose or mode change cancels the pending login on a reachable server, forwarded or not', async () => {
  const forwarded = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await forwarded.handlers.begin('h1', 'openai-oauth');
  await forwarded.end();
  assert.deepEqual(cancelCalls(forwarded), [['cancelOAuthProviderLogin', ['f1']]]);

  // No forward (the port is taken here): the server still listens, so it is cancelled too.
  const unforwarded = setup({
    forward: async () => {
      throw new Error('port in use');
    },
    answers: { beginOAuthProviderLogin: pending() },
  });
  await unforwarded.handlers.begin('h1', 'openai-oauth');
  await unforwarded.end();
  assert.deepEqual(cancelCalls(unforwarded), [['cancelOAuthProviderLogin', ['f1']]]);

  const disposed = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await disposed.handlers.begin('h1', 'openai-oauth');
  await disposed.handlers.dispose();
  assert.deepEqual(cancelCalls(disposed), [['cancelOAuthProviderLogin', ['f1']]]);
  assert.equal(disposed.forwards[0].closed, 1);

  // A login that finished is not cancelled when the attachment ends later.
  const done = setup({
    answers: { beginOAuthProviderLogin: pending(), getOAuthProviderLoginStatus: () => pending({ state: 'complete' }) },
  });
  await done.handlers.begin('h1', 'openai-oauth');
  await done.handlers.status('h1', 'f1');
  await done.end();
  assert.deepEqual(cancelCalls(done), []);
});

test('a cancel the connection could not carry is sent once it is attached again', async () => {
  const s = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await s.handlers.begin('h1', 'openai-oauth');
  s.link.reachable = false;
  await s.end();
  assert.equal(s.forwards[0].closed, 1, 'the forward closes whatever the link');
  assert.deepEqual(cancelCalls(s), [], 'nothing could be sent yet');
  await s.reattach();
  assert.deepEqual(cancelCalls(s), [['cancelOAuthProviderLogin', ['f1']]]);
  await s.reattach();
  assert.equal(cancelCalls(s).length, 1, 'sent once');

  // The dialog's own cancel after a failed status read, with the server gone, is kept the same way.
  const gone = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await gone.handlers.begin('h1', 'openai-oauth');
  gone.link.attached = false;
  await gone.handlers.cancel('h1', 'f1');
  await gone.reattach();
  assert.deepEqual(cancelCalls(gone), [['cancelOAuthProviderLogin', ['f1']]]);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a disconnect while the callback forward is being made closes that forward and opens no browser', async () => {
  const closed = [];
  let release;
  const slow = setup({
    answers: { beginOAuthProviderLogin: pending() },
    forward: () =>
      new Promise((resolve) => {
        release = () => resolve({ close: async () => closed.push('closed') });
      }),
  });
  const begun = slow.handlers.begin('h1', 'openai-oauth');
  await tick();
  assert.equal(typeof release, 'function', 'the forward is still being made');
  await slow.end();
  assert.deepEqual(cancelCalls(slow), [['cancelOAuthProviderLogin', ['f1']]], 'the server drops it at once');
  release();
  const flow = await begun;
  assert.deepEqual(closed, ['closed'], 'the late forward is closed, not installed');
  assert.deepEqual(slow.opened, [], 'no browser opens for an ended login');
  assert.equal(flow.state, 'cancelled');
  assert.equal(flow.forwarded, false);
  await slow.handlers.dispose();
  assert.deepEqual(closed, ['closed'], 'nothing unwatched is left behind');

  // The same when the forward fails after the disconnect.
  let fail;
  const failing = setup({
    answers: { beginOAuthProviderLogin: pending({ manualUrl: 'https://x.example/manual' }) },
    forward: () =>
      new Promise((_, reject) => {
        fail = () => reject(new Error('ssh refused'));
      }),
  });
  const failed = failing.handlers.begin('h1', 'openai-oauth');
  await tick();
  await failing.end();
  fail();
  assert.equal((await failed).state, 'cancelled');
  assert.deepEqual(failing.opened, []);
});

test('a queued cancel expires with the server flow, and is sent before that', async () => {
  const lifetime = 10 * 60_000;
  const expired = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await expired.handlers.begin('h1', 'openai-oauth');
  expired.link.reachable = false;
  await expired.end();
  expired.clock.now += lifetime;
  await expired.reattach();
  assert.deepEqual(cancelCalls(expired), [], 'the server dropped that login itself by now');
  await expired.reattach();
  assert.deepEqual(cancelCalls(expired), [], 'and it is forgotten');

  const fresh = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await fresh.handlers.begin('h1', 'openai-oauth');
  fresh.link.reachable = false;
  await fresh.end();
  fresh.clock.now += lifetime - 1;
  await fresh.reattach();
  assert.deepEqual(cancelCalls(fresh), [['cancelOAuthProviderLogin', ['f1']]]);

  // A login that already outlived the server's lifetime is not queued at all.
  const old = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await old.handlers.begin('h1', 'openai-oauth');
  old.clock.now += lifetime;
  old.link.reachable = false;
  await old.end();
  await old.reattach();
  assert.deepEqual(cancelCalls(old), []);
});

test('the queued cancels are capped, dropping the oldest', async () => {
  const ids = ['f1', 'f2', 'f3'];
  const s = setup({
    maxQueuedCancels: 2,
    answers: { beginOAuthProviderLogin: () => pending({ flowId: ids.shift() }) },
  });
  for (let index = 0; index < 3; index += 1) await s.handlers.begin('h1', 'openai-oauth');
  s.link.reachable = false;
  await s.end();
  await s.reattach();
  assert.deepEqual(
    cancelCalls(s).map(([, args]) => args[0]),
    ['f2', 'f3']
  );
});

test('a removed server and a disposed manager drop the cancels still waiting', async () => {
  const removed = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await removed.handlers.begin('h1', 'openai-oauth');
  removed.link.reachable = false;
  await removed.end();
  removed.handlers.forgetHost('h1');
  await removed.reattach();
  assert.deepEqual(cancelCalls(removed), []);

  const disposed = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await disposed.handlers.begin('h1', 'openai-oauth');
  const [attached] = [...disposed.attachListeners];
  disposed.link.reachable = false;
  await disposed.handlers.dispose();
  assert.equal(disposed.attachListeners.size, 0, 'it no longer listens for attaches');
  // Even an attach signal that still reaches it finds nothing to send.
  disposed.link.attached = true;
  disposed.link.reachable = true;
  attached('h1');
  await tick();
  assert.deepEqual(cancelCalls(disposed), []);
});

test('a cancel the server did not take on replay stays for the next attach', async () => {
  const s = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await s.handlers.begin('h1', 'openai-oauth');
  s.link.reachable = false;
  await s.end();
  await s.reattach(false);
  assert.deepEqual(cancelCalls(s), [], 'attached, but the link carried nothing');
  await s.reattach(true);
  assert.deepEqual(cancelCalls(s), [['cancelOAuthProviderLogin', ['f1']]]);
  await s.reattach(true);
  assert.equal(cancelCalls(s).length, 1, 'taken once, then forgotten');
});

test('a stale queued cancel never ends a newer login that reuses the flow id', async () => {
  // The older login is queued; a new one gets the same id before the attach.
  const reused = setup({ answers: { beginOAuthProviderLogin: pending() } });
  await reused.handlers.begin('h1', 'openai-oauth');
  reused.link.reachable = false;
  await reused.end();
  reused.link.attached = true;
  reused.link.reachable = true;
  await reused.handlers.begin('h1', 'openai-oauth');
  await reused.reattach();
  assert.deepEqual(cancelCalls(reused), [], 'the live login keeps its flow');
  assert.equal(reused.endListeners.size, 1, 'and is still watched');

  // The older login's cancel fails only after the newer one has started.
  let failCancel;
  const gate = new Promise((_, reject) => {
    failCancel = reject;
  });
  const late = setup({ answers: { beginOAuthProviderLogin: pending(), cancelOAuthProviderLogin: () => gate } });
  await late.handlers.begin('h1', 'openai-oauth');
  const ending = late.end();
  await tick();
  late.link.attached = true;
  await late.handlers.begin('h1', 'openai-oauth');
  failCancel(new Error('ssh link is down'));
  await ending;
  await late.reattach();
  assert.equal(cancelCalls(late).length, 1, 'only the first, failed attempt: the stale cancel is not replayed');
});

/** A cancel the test settles later: `fail()` makes it reject. */
const deferredCancel = () => {
  let fail;
  const gate = new Promise((_, reject) => {
    fail = () => reject(new Error('ssh link is down'));
  });
  return { answer: () => gate, fail };
};

test('a cancel still in flight when its server is removed is not queued when it fails', async () => {
  // A disconnect's cancel.
  const ended = deferredCancel();
  const s = setup({ answers: { beginOAuthProviderLogin: pending(), cancelOAuthProviderLogin: ended.answer } });
  await s.handlers.begin('h1', 'openai-oauth');
  const ending = s.end();
  await tick();
  s.handlers.forgetHost('h1');
  ended.fail();
  await ending;
  await s.reattach();
  assert.equal(cancelCalls(s).length, 1, 'the failed attempt is not replayed for a removed server');

  // The dialog's own cancel.
  const explicit = deferredCancel();
  const e = setup({ answers: { beginOAuthProviderLogin: pending(), cancelOAuthProviderLogin: explicit.answer } });
  await e.handlers.begin('h1', 'openai-oauth');
  const cancelling = e.handlers.cancel('h1', 'f1');
  await tick();
  e.handlers.forgetHost('h1');
  explicit.fail();
  await cancelling;
  await e.reattach();
  assert.equal(cancelCalls(e).length, 1);

  // A server removed and saved again is a new one: its cancels queue as usual.
  const again = setup({ answers: { beginOAuthProviderLogin: pending() } });
  again.handlers.forgetHost('h1');
  await again.handlers.begin('h1', 'openai-oauth');
  again.link.reachable = false;
  await again.end();
  await again.reattach();
  assert.equal(cancelCalls(again).length, 1);
});

test('a cancel still in flight when the manager is disposed is not queued when it fails', async () => {
  // The status error's background cancel.
  const status = deferredCancel();
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending(),
      getOAuthProviderLoginStatus: new Error('boom'),
      cancelOAuthProviderLogin: status.answer,
    },
  });
  await s.handlers.begin('h1', 'openai-oauth');
  const [attached] = [...s.attachListeners];
  await assert.rejects(s.handlers.status('h1', 'f1'), /boom/);
  await tick();
  await s.handlers.dispose();
  status.fail();
  await tick();
  // An attach signal that still reaches the disposed manager finds nothing to send.
  attached('h1');
  await tick();
  assert.equal(cancelCalls(s).length, 1);

  // A disconnect's cancel that is still in flight when dispose runs.
  const ended = deferredCancel();
  const d = setup({ answers: { beginOAuthProviderLogin: pending(), cancelOAuthProviderLogin: ended.answer } });
  await d.handlers.begin('h1', 'openai-oauth');
  const [reattached] = [...d.attachListeners];
  const ending = d.end();
  await tick();
  const disposing = d.handlers.dispose();
  ended.fail();
  await Promise.all([ending, disposing]);
  d.link.attached = true;
  reattached('h1');
  await tick();
  assert.equal(cancelCalls(d).length, 1);
});

/** Whether `promise` settles within a second (a hung call never does). */
const settlesSoon = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1_000, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("the dialog's own cancel is bounded and kept for the next attach when the server fails it", async () => {
  let mode = 'fail';
  const s = setup({
    answers: {
      beginOAuthProviderLogin: pending(),
      cancelOAuthProviderLogin: () => {
        if (mode === 'fail') throw new Error('gone');
        if (mode === 'hang') return new Promise(() => undefined);
        return undefined;
      },
    },
  });

  // A rejection: the dialog's call settles, the forward is closed, the cancel is kept.
  await s.handlers.begin('h1', 'openai-oauth');
  await s.handlers.cancel('h1', 'f1');
  assert.equal(s.forwards[0].closed, 1, 'closed even when the server call failed');
  mode = 'ok';
  await s.reattach();
  assert.equal(cancelCalls(s).length, 2, 'the failed cancel is sent again on the next attach');
  await s.reattach();
  assert.equal(cancelCalls(s).length, 2, 'and then forgotten');

  // A call that never answers: the forward closes at once and the call is bounded.
  mode = 'hang';
  await s.handlers.begin('h1', 'openai-oauth');
  const cancelling = s.handlers.cancel('h1', 'f1');
  await tick();
  assert.equal(s.forwards[1].closed, 1, 'closed while the server still has not answered');
  assert.equal(await settlesSoon(cancelling), true, 'the call does not wait for the server for ever');
  mode = 'ok';
  await s.reattach();
  assert.equal(cancelCalls(s).length, 4, 'the unanswered cancel is sent again on the next attach');
  await s.reattach();
  assert.equal(cancelCalls(s).length, 4);

  // A login the PC does not track is still bounded.
  mode = 'hang';
  assert.equal(await settlesSoon(s.handlers.cancel('h1', 'other')), true);
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
          { id: 'openai', name: 'OpenAI', authenticated: true, stored: true, detail: 'stored in private file' },
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
    { id: 'openai', name: 'OpenAI', kind: 'api', signedIn: true, storedInPrivateFile: true },
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

const CUSTOM_KEYED = 'custom-0b0a8b3e-1111-4222-8333-444455556666';
const CUSTOM_KEYLESS = 'custom-1c1b9c4f-2222-4333-8444-555566667777';

test('a custom provider on the server saves its key and is removed through the custom-provider operations, and the refreshed list shows it', async () => {
  // A scripted server: the custom provider is signed in once its key is saved, and gone once removed.
  let stored = false;
  let removed = false;
  const s = setup({
    answers: {
      getProviderSetup: () => ({
        oauth: [],
        api: [
          { id: 'openai', name: 'OpenAI', authenticated: false },
          ...(removed
            ? []
            : [
                {
                  id: CUSTOM_KEYED,
                  name: 'Acme',
                  custom: true,
                  auth: 'key',
                  protocol: 'openai-chat',
                  baseURL: 'https://llm.acme.test/v1',
                  schemaVersion: 2,
                  enabled: true,
                  authenticated: stored,
                  stored,
                },
              ]),
          {
            id: CUSTOM_KEYLESS,
            name: 'Local gateway',
            custom: true,
            auth: 'none',
            protocol: 'openai-chat',
            baseURL: 'http://127.0.0.1:8080/v1',
            schemaVersion: 2,
            enabled: true,
            authenticated: true,
            stored: false,
          },
        ],
      }),
      saveCustomProviderKey: () => {
        stored = true;
      },
      removeCustomProvider: () => {
        removed = true;
      },
    },
  });
  const find = async (id) => (await s.handlers.logins('h1')).providers.find((row) => row.id === id);
  assert.deepEqual(await find(CUSTOM_KEYED), {
    id: CUSTOM_KEYED,
    name: 'Acme',
    kind: 'api',
    signedIn: false,
    custom: true,
  });
  assert.deepEqual(await find(CUSTOM_KEYLESS), {
    id: CUSTOM_KEYLESS,
    name: 'Local gateway',
    kind: 'api',
    signedIn: true,
    custom: true,
    keyless: true,
  });

  s.calls.length = 0;
  await s.handlers.saveKey('h1', CUSTOM_KEYED, '  sk-acme  ');
  assert.deepEqual(s.calls, [['saveCustomProviderKey', [CUSTOM_KEYED, 'sk-acme']]], 'only the key travels; the provider’s settings are never resubmitted');
  assert.equal((await find(CUSTOM_KEYED)).signedIn, true, 'the refreshed list shows the saved key');

  s.calls.length = 0;
  await s.handlers.logout('h1', CUSTOM_KEYED);
  assert.deepEqual(s.calls, [['forgetProviderAuth', [CUSTOM_KEYED]]], 'Log out never deletes the provider');
  assert.notEqual(await find(CUSTOM_KEYED), undefined, 'the provider is still listed');

  s.calls.length = 0;
  await s.handlers.removeCustomProvider('h1', CUSTOM_KEYED);
  assert.deepEqual(s.calls, [['removeCustomProvider', [CUSTOM_KEYED]]]);
  assert.equal(await find(CUSTOM_KEYED), undefined, 'the refreshed list no longer has it');
  await assert.rejects(s.handlers.removeCustomProvider('h1', 'openai'), /provider id is not valid/);
});

test('the server refuses a key for a keyless or environment-key custom provider; the refusal reaches the dialog', async () => {
  const s = setup({
    answers: { saveCustomProviderKey: new Error('this custom provider needs no API key') },
  });
  await assert.rejects(s.handlers.saveKey('h1', CUSTOM_KEYLESS, 'sk-x'), /needs no API key/);
  assert.deepEqual(
    s.calls.map(([capability]) => capability),
    ['saveCustomProviderKey']
  );
});

test('a failed key save never carries the key, and the server’s own failure is what is shown', async () => {
  const key = 'sk-very-secret-123';
  for (const id of ['openai', CUSTOM_KEYED]) {
    const s = setup({
      answers: {
        saveProviderApiKey: new Error(`401 for key ${key} (${JSON.stringify(key)})`),
        saveCustomProviderKey: new Error(`bad key ${key}`),
      },
    });
    const failure = await s.handlers.saveKey('h1', id, key).then(
      () => null,
      (error) => error
    );
    assert.ok(failure, 'the save fails');
    assert.ok(!String(failure.message).includes(key) && !String(failure.stack).includes(key), 'no key in the error');
    assert.match(failure.message, /\[redacted\]/);
  }
  const failing = setup({
    answers: { saveCustomProviderKey: new TypeError('session action saveCustomProviderKey is unavailable') },
  });
  await assert.rejects(failing.handlers.saveKey('h1', CUSTOM_KEYED, key), /session action saveCustomProviderKey is unavailable/);
  assert.deepEqual(
    failing.calls.map(([capability]) => capability),
    ['saveCustomProviderKey'],
    'no stale round trip follows'
  );
});

test('a custom provider with a key variable is listed as from the environment, set or not, stored key or not', async () => {
  const rows = async (entries) =>
    (await setup({ answers: { getProviderSetup: { api: entries } } }).handlers.logins('h1')).providers;
  const base = { name: 'Acme', custom: true, apiKeyEnv: 'ACME_KEY' };
  assert.deepEqual(
    await rows([
      { ...base, id: 'custom-a', authenticated: true, env: true, stored: false },
      { ...base, id: 'custom-b', authenticated: false, env: false, stored: false },
      { ...base, id: 'custom-c', authenticated: true, env: true, stored: true },
      { ...base, id: 'custom-d', authenticated: false, env: false, stored: true },
    ]),
    [
      { id: 'custom-a', name: 'Acme', kind: 'api', signedIn: true, fromEnvironment: true, custom: true },
      { id: 'custom-c', name: 'Acme', kind: 'api', signedIn: true, fromEnvironment: true, custom: true },
      { id: 'custom-b', name: 'Acme', kind: 'api', signedIn: false, fromEnvironment: true, custom: true },
      { id: 'custom-d', name: 'Acme', kind: 'api', signedIn: false, fromEnvironment: true, custom: true },
    ]
  );
  // Without a variable the stored key is the key.
  assert.deepEqual(await rows([{ id: 'custom-e', name: 'Plain', custom: true, authenticated: true, stored: true }]), [
    { id: 'custom-e', name: 'Plain', kind: 'api', signedIn: true, custom: true },
  ]);
});

test('the effective credential source is carried; only an environment key with nothing stored is read-only', async () => {
  const s = setup({
    answers: {
      getProviderSetup: {
        api: [
          { id: 'openai', name: 'OpenAI', authenticated: true, stored: true, env: true, credentialSource: 'environment', detail: 'OPENAI_API_KEY' },
          { id: 'groq', name: 'Groq', authenticated: true, stored: false, env: true, credentialSource: 'environment', detail: 'GROQ_API_KEY' },
          { id: 'xai', name: 'xAI', authenticated: true, stored: true, credentialSource: 'private-file', detail: 'stored in private file' },
          { id: 'gemini', name: 'Gemini', authenticated: true, stored: true, credentialSource: 'keychain' },
          { id: 'deepseek', name: 'DeepSeek', authenticated: true, stored: true, credentialSource: 'bogus' },
        ],
      },
    },
  });
  const rows = Object.fromEntries((await s.handlers.logins('h1')).providers.map((row) => [row.id, row]));
  assert.equal(rows.openai.fromEnvironment, undefined, 'a stored key can still be changed or logged out');
  assert.equal(rows.openai.storedInPrivateFile, undefined);
  assert.equal(rows.openai.credentialSource, 'environment');
  assert.equal(rows.groq.fromEnvironment, true, 'an environment key with nothing stored is read-only');
  assert.equal(rows.groq.credentialSource, 'environment');
  assert.equal(rows.xai.storedInPrivateFile, true);
  assert.equal(rows.xai.fromEnvironment, undefined);
  assert.equal(rows.xai.credentialSource, 'private-file');
  assert.equal(rows.gemini.credentialSource, 'keychain');
  assert.equal(rows.gemini.storedInPrivateFile, undefined);
  assert.equal(rows.deepseek.credentialSource, undefined, 'an unknown source is dropped');
});

test('a key with quotes or backslashes is redacted in its JSON-escaped spelling too', async () => {
  const key = 'sk-"q"\\b-0123';
  const s = setup({ answers: { saveCustomProviderKey: new Error(`bad {"apiKey":${JSON.stringify(key)}} / ${key}`) } });
  const failure = await s.handlers.saveKey('h1', CUSTOM_KEYED, key).catch((error) => error);
  assert.equal(failure.message, 'bad {"apiKey":"[redacted]"} / [redacted]');
});
