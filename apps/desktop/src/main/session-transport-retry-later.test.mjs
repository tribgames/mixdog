// A daemon that answers a call with a retry-later refusal (its owner lease is
// being re-verified) must be asked again on the same attachment, under the
// same call id — never re-attached, which re-registers every session and
// re-floods the queue. A fenced daemon is still recovered. The real path: the
// session transport's 503 → the session client's classification → the
// desktop's SessionTransport.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DAEMON_FENCED, DAEMON_RETRY_LATER } from '../../../../src/standalone/daemon-refusal.mjs';
import { attachSession } from '../../../../src/standalone/session-client.mjs';
import { createSessionTransport } from '../../../../src/standalone/session-transport.mjs';
import { SessionTransport } from './session-transport.ts';

const options = {
  userDataPath: 'C:/tmp/mixdog',
  packaged: true,
  resourcesPath: 'C:/tmp/resources',
  appPath: 'C:/tmp/resources/app.asar',
};

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A real session transport whose admission refuses the next `refusals`
 *  requests with `refusal`, and a desktop attached to it. */
async function desktopOnGatedDaemon(t, refusal) {
  const gate = { refusals: 0 };
  const invoked = [];
  const daemon = createSessionTransport({
    serverToken: 'server',
    handleCall: async (name, args) => {
      if (name === 'desktop.init') return { desktopId: 'desktop_retry_later' };
      if (name === 'desktop.invoke') {
        invoked.push(args.method);
        return 'served';
      }
      return { ok: true };
    },
    admitWork: () => {
      if (gate.refusals <= 0) return true;
      gate.refusals -= 1;
      return false;
    },
    workRefusal: () => refusal,
  });
  const { port } = await daemon.start();
  t.after(() => daemon.stop());
  const discovery = { port, token: 'server', pid: process.pid };
  const callIds = [];
  let attachCount = 0;
  const desktop = new SessionTransport('file:///C:/tmp/daemon.cjs', process.cwd(), async () => ({
    ensureDaemon: async () => discovery,
    attachSession: async (attachOptions) => {
      attachCount += 1;
      const attached = await attachSession({ ...attachOptions, discovery, pidAlive: () => true });
      return {
        ...attached,
        call(name, args, callOptions) {
          if (name === 'desktop.invoke') callIds.push(callOptions?.callId);
          return attached.call(name, args, callOptions);
        },
      };
    },
  }));
  const messages = [];
  const diagnostics = [];
  desktop.on('message', (message) => messages.push(message));
  desktop.on('diagnostic', (event) => diagnostics.push(event));
  t.after(() => desktop.close());
  desktop.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));
  return { gate, invoked, callIds, messages, diagnostics, desktop, attaches: () => attachCount };
}

test('a retry-later refusal is asked again under the same call id, silently, without reattaching', async (t) => {
  const run = await desktopOnGatedDaemon(t, {
    code: DAEMON_RETRY_LATER,
    message: 'daemon owner lease is not held (being re-verified)',
    retryAfterMs: 20,
  });
  run.gate.refusals = 2;
  run.desktop.postMessage({ kind: 'request', id: 7, method: 'submit', args: ['keep me'] });
  const response = await waitFor(() => run.messages.find((message) => message.kind === 'response' && message.id === 7));

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.value, 'served');
  assert.equal(run.callIds.length, 3, 'two refusals, then admitted');
  assert.equal(new Set(run.callIds).size, 1, 'every ask carries the same call id');
  assert.deepEqual(run.invoked, ['submit'], 'dispatched once');
  assert.equal(run.attaches(), 1, 'the attachment is kept');
  assert.ok(!run.diagnostics.includes('session-daemon-reconnecting'));
  assert.equal(run.messages.filter((message) => message.kind === 'daemon-replaced').length, 0);
});

/** A desktop on fake attachments whose first `desktop.invoke` is refused
 *  retry-later; a later ask on the first attachment would answer 'late', the
 *  re-attached one 'recovered'. Time is driven by hand once ready: the
 *  monotonic clock and setTimeout move only when `advance` says. */
async function desktopOnFakeClock(t) {
  const invocations = [];
  let attachCount = 0;
  const desktop = new SessionTransport('file:///C:/tmp/daemon.cjs', process.cwd(), async () => ({
    ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
    attachSession: async () => {
      const index = attachCount++;
      return {
        async call(name, _args, callOptions) {
          if (name === 'desktop.init') return { desktopId: 'desktop_fake_clock' };
          if (name !== 'desktop.invoke') return { ok: true };
          invocations.push({ index, callId: callOptions?.callId });
          if (index > 0) return 'recovered';
          if (invocations.length === 1) {
            throw Object.assign(new Error('not ready'), { code: 'EDAEMON_RETRY_LATER', retryable: true, retryAfterMs: 0 });
          }
          return 'late';
        },
        async close() {},
      };
    },
  }));
  const messages = [];
  const diagnostics = [];
  desktop.on('message', (message) => messages.push(message));
  desktop.on('diagnostic', (event) => diagnostics.push(event));
  t.after(() => desktop.close());
  desktop.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));

  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    desktop,
    messages,
    diagnostics,
    invocations,
    settle,
    attaches: () => attachCount,
    // A loop stall: the clock jumps and the pending backoff timer fires late.
    advance: (ms) => {
      now += ms;
      t.mock.timers.tick(ms);
    },
  };
}

test('a retry-later wait that wakes past the 60 s budget hands off to recovery instead of asking again', async (t) => {
  const run = await desktopOnFakeClock(t);
  run.desktop.postMessage({ kind: 'request', id: 9, method: 'submit', args: [] });
  await run.settle();
  assert.equal(run.invocations.length, 1, 'refused once, now waiting');
  run.advance(61_275);
  await run.settle();
  const response = run.messages.find((message) => message.kind === 'response' && message.id === 9);

  assert.equal(response?.ok, true, JSON.stringify(response?.error));
  assert.equal(response.value, 'recovered', 'served by the re-attached daemon, not the late ask');
  assert.deepEqual(
    run.invocations.map((entry) => entry.index),
    [0, 1],
    'never asked the first attachment again'
  );
  assert.equal(new Set(run.invocations.map((entry) => entry.callId)).size, 1);
  assert.equal(run.attaches(), 2);
  assert.ok(run.diagnostics.includes('session-daemon-reconnecting'));
});

test('a retry-later wait that wakes after the transport closed dispatches nothing', async (t) => {
  const run = await desktopOnFakeClock(t);
  run.desktop.postMessage({ kind: 'request', id: 10, method: 'submit', args: [] });
  await run.settle();
  assert.equal(run.invocations.length, 1);
  await run.desktop.close();
  run.advance(1_000);
  await run.settle();

  assert.equal(run.invocations.length, 1, 'no ask after close');
  assert.equal(run.attaches(), 1, 'no re-attach after close');
});

test('a fenced refusal still re-attaches and replays the request', async (t) => {
  const run = await desktopOnGatedDaemon(t, { code: DAEMON_FENCED, message: 'daemon owner lease is not held' });
  run.gate.refusals = 1;
  run.desktop.postMessage({ kind: 'request', id: 8, method: 'submit', args: ['keep me'] });
  const response = await waitFor(() => run.messages.find((message) => message.kind === 'response' && message.id === 8));

  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.value, 'served');
  assert.equal(run.attaches(), 2);
  assert.ok(run.diagnostics.includes('session-daemon-reconnecting'));
  assert.equal(new Set(run.callIds).size, 1);
  assert.deepEqual(run.invoked, ['submit']);
});
