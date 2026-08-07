import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionTransport } from './session-transport.ts';

const options = {
  userDataPath: 'C:/tmp/mixdog',
  packaged: true,
  resourcesPath: 'C:/tmp/resources',
  appPath: 'C:/tmp/resources/app.asar',
};

function waitFor(predicate, timeoutMs = 2_000) {
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

test('failed desktop initialization closes its daemon attachment and preserves the cause', async () => {
  let closeCalls = 0;
  const calls = [];
  const failure = new Error('plain Node could not import the desktop service');
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async () => ({
        async call(name) {
          calls.push(name);
          if (name === 'desktop.init') throw failure;
          return { ok: true };
        },
        async close() { closeCalls += 1; },
      }),
    }),
  );
  let exit = null;
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });

  await waitFor(() => exit);
  assert.equal(exit.code, 1);
  assert.equal(exit.cause, failure);
  assert.equal(closeCalls, 1);
  assert.deepEqual(calls, ['desktop.init', 'desktop.unsubscribe']);
});

test('a mismatched session contract tells desktop users how to recover', async () => {
  const conflict = Object.assign(
    new Error('session protocol mismatch'),
    { sessionProtocolMismatch: true },
  );
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => { throw conflict; },
      attachSession: async () => { throw new Error('must not attach'); },
    }),
  );
  let exit = null;
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });

  await waitFor(() => exit);
  assert.equal(exit.code, 1);
  assert.match(exit.cause.message, /different Mixdog session contract is already running/i);
  assert.match(exit.cause.message, /close every Mixdog window and terminal/i);
  assert.equal(exit.cause.cause, conflict);
});

test('a transient pooled-socket reset retries one desktop request with the same call id', async () => {
  const invocations = [];
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async () => ({
        async call(name, args, callOptions) {
          if (name === 'desktop.init') return { desktopId: 'desktop_test' };
          if (name === 'desktop.control') return { ok: true };
          if (name === 'desktop.invoke') {
            invocations.push({ args, callId: callOptions?.callId });
            if (invocations.length === 1) {
              throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
            }
            return 'recovered';
          }
          return { ok: true };
        },
        async close() {},
      }),
    }),
  );
  const messages = [];
  transport.on('message', (message) => messages.push(message));
  transport.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));
  transport.postMessage({
    kind: 'request',
    id: 42,
    method: 'getProviderSetup',
    args: [],
  });
  const response = await waitFor(() => messages.find((message) =>
    message.kind === 'response' && message.id === 42));
  assert.equal(response.ok, true);
  assert.equal(response.value, 'recovered');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].callId, invocations[1].callId);
  assert.match(invocations[0].callId, /^desktop-invoke:/);
  await transport.close();
});

test('an SSE reconnect resyncs in place without rejecting an in-flight desktop request', async () => {
  const calls = [];
  let streamDisconnect = null;
  let streamReconnect = null;
  let resolveInvoke;
  const transport = new SessionTransport(
    'file:///C:/tmp/daemon.cjs',
    process.cwd(),
    async () => ({
      ensureDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachSession: async (attachOptions) => {
        streamDisconnect = attachOptions.onStreamDisconnect;
        streamReconnect = attachOptions.onStreamReconnect;
        return {
          async call(name, args) {
            calls.push({ name, args });
            if (name === 'desktop.init') return { desktopId: 'desktop_reconnect' };
            if (name === 'desktop.invoke') {
              return await new Promise((resolve) => { resolveInvoke = resolve; });
            }
            return { ok: true };
          },
          async close() {},
        };
      },
    }),
  );
  const messages = [];
  const diagnostics = [];
  let exit = null;
  transport.on('message', (message) => messages.push(message));
  transport.on('diagnostic', (event, details) => diagnostics.push({ event, details }));
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });
  await waitFor(() => messages.some((message) => message.kind === 'ready'));

  transport.postMessage({
    kind: 'request',
    id: 77,
    method: 'submit',
    args: ['preserve me'],
  });
  await waitFor(() => typeof resolveInvoke === 'function');
  streamDisconnect({ reason: 'sse ended' });
  streamReconnect({ reason: 'sse ended', attempt: 1, downtimeMs: 25 });
  await waitFor(() => calls.filter((entry) => entry.name === 'desktop.control').length === 2);
  resolveInvoke(true);
  const response = await waitFor(() => messages.find((message) =>
    message.kind === 'response' && message.id === 77));

  assert.equal(response.ok, true);
  assert.equal(response.value, true);
  assert.equal(exit, null, 'event-stream recovery does not restart the service transport');
  assert.deepEqual(
    diagnostics.map((entry) => entry.event),
    [
      'session-stream-reconnecting',
      'session-stream-reconnected',
      'session-stream-resync-complete',
    ],
  );
  await transport.close();
});
