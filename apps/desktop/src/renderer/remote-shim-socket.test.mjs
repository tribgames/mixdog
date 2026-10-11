import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeSocket, settle, until, withShim } from './remote-shim-test-harness.mjs';

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
