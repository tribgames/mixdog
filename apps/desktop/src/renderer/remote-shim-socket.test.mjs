import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptRelayE2EEClientHello, createRelayE2EEChallenge } from '../shared/remote-e2ee.ts';
import { FakeSocket, settle, until, withShim } from './remote-shim-test-harness.mjs';

/** Open one socket attempt and stop before any challenge: the joining phone. */
async function joiningSocket(ctx) {
  const known = FakeSocket.instances.length;
  const connecting = ctx.connect();
  connecting.catch(() => {});
  await until(() => FakeSocket.instances.length === known + 1, 'a socket attempt');
  const ws = FakeSocket.instances[known];
  ws.readyState = FakeSocket.OPEN;
  ws.onopen();
  return { ws, connecting };
}

test('a joining phone answers a replaced PC leg challenge on the same socket and becomes ready', async () => {
  await withShim({}, async ({ ctx, identity }) => {
    const { ws, connecting } = await joiningSocket(ctx);
    // The first PC leg challenges; the phone answers and holds a channel.
    ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
    await until(() => ws.sent.length === 1, 'the first hello');
    await until(() => ctx.secureChannel !== null, 'the first channel');
    // That leg died before its ready; the relay kept this socket and the
    // replacement leg sends its own challenge.
    const second = createRelayE2EEChallenge();
    ws.onmessage({ data: JSON.stringify(second) });
    await until(() => ws.sent.length === 2, 'a hello for the replacement leg');
    const server = await acceptRelayE2EEClientHello(identity, second, JSON.parse(ws.sent[1]));
    ws.onmessage({ data: await server.encryptJson({ type: 'e2ee-ready', version: 1 }) });
    assert.equal(await connecting, ws);
    assert.equal(ctx.connectionReady, true);
    assert.equal(ws.closeCalls, 0, 'the joining phone kept its socket');
  });
});

test('handshake restarts on one joining socket are bounded', async () => {
  await withShim({}, async ({ ctx }) => {
    const { ws } = await joiningSocket(ctx);
    for (let challenge = 1; challenge <= 3; challenge++) {
      ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
      await until(() => ws.sent.length === challenge, `hello ${challenge}`);
    }
    assert.equal(ws.closeCalls, 0, 'two restarts are answered');
    ws.onmessage({ data: JSON.stringify(createRelayE2EEChallenge()) });
    await until(() => ws.closeCalls === 1, 'a looping relay ends this attempt');
    assert.equal(ws.sent.length, 3, 'no hello for a challenge past the bound');
  });
});

test('a socket constructor that throws does not pin connect() to a rejected attempt', async () => {
  await withShim({ secure: false }, async ({ ctx }) => {
    let reconnects = 0;
    ctx.scheduleReconnect = () => {
      reconnects += 1;
    };
    const Real = globalThis.WebSocket;
    class Throwing extends Real {
      constructor() {
        throw new SyntaxError('invalid url');
      }
    }
    globalThis.WebSocket = Throwing;
    await assert.rejects(ctx.connect(), /invalid url/);
    await settle();
    assert.equal(ctx.openPromise, null, 'the failed attempt is released');
    assert.equal(reconnects, 1, 'a retry is scheduled');
    globalThis.WebSocket = Real;
    const known = FakeSocket.instances.length;
    const connecting = ctx.connect();
    await until(() => FakeSocket.instances.length === known + 1, 'a fresh socket attempt');
    const ws = FakeSocket.instances[known];
    ws.readyState = FakeSocket.OPEN;
    ws.onopen();
    await connecting;
  });
});

test('a call that finds its socket mid-rekey fails as interrupted and leaves the socket open', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const leg = await dial();
    // The desktop redialed: the relay kept this browser socket and sent a new
    // challenge, so it is open but not ready while the new channel is built.
    ctx.connectionReady = false;
    const failure = await ctx.invoke('abortSession', ['s1']).catch((error) => error);
    assert.equal(failure.code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
    assert.equal(leg.ws.closeCalls, 0, 'the recovering socket is not closed by a call that never sent');
    assert.equal(ctx.pending.size, 0);
  });
});
