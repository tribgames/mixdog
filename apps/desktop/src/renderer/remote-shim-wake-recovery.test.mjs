// A return from the background reconnects without raising the disconnect
// surface: the real socket state machine and liveness module, driven over a
// fake WebSocket through hide/show the way a phone suspends and thaws a page.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeSocket, publishedCeilings, settle, until, withShim } from './remote-shim-test-harness.mjs';

const withLiveShim = (run) =>
  withShim({}, async (harness) => {
    const { ctx, timers } = harness;
    const listeners = new Map();
    const listen = (scope) => (type, listener) => {
      const key = `${scope}:${type}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(listener);
    };
    window.addEventListener = listen('window');
    window.setInterval = () => 0;
    document.addEventListener = listen('document');
    Object.assign(ctx, { reconnectTimer: null, wakePongTimer: null, backgroundGraceTimer: null, heartbeatSentAt: 0 });
    const { installRemoteLiveness } = await import('./remote-shim-liveness.ts');
    installRemoteLiveness(ctx);
    const setVisibility = (value) => {
      document.visibilityState = value;
      for (const listener of listeners.get('document:visibilitychange') ?? []) {
        listener(new Event('visibilitychange'));
      }
    };
    const fireWakeProbeDeadline = () => {
      const entry = [...timers.live.entries()].find(([, timer]) => timer.ms === 2_500);
      assert.ok(entry, 'the wake probe has a deadline');
      timers.live.delete(entry[0]);
      entry[1].fn();
    };
    await run({
      ...harness,
      hide: () => setVisibility('hidden'),
      show: () => setVisibility('visible'),
      fireWakeProbeDeadline,
      state: () => document.documentElement.dataset.mixdogRemoteConnection,
    });
  });

const pong = (ws) => ws.onmessage({ data: '{"pong":1}' });

test('a wake on a live leg sends its resync only after the relay answers the probe', async () => {
  await withLiveShim(async ({ ctx, dial, hide, show, resyncs, state }) => {
    const leg = await dial();
    hide();
    // What an installed app's background grace leaves for the wake.
    ctx.resyncOnWake = true;
    show();
    assert.equal(leg.ws.sent.at(-1), '{"ping":1}');
    assert.equal(resyncs(), 0, 'no resync on a leg that has not answered yet');
    assert.equal(state(), 'connected');
    pong(leg.ws);
    assert.equal(resyncs(), 1);
    assert.equal(ctx.unprovenSocket, null);
    assert.equal(leg.ws.closeCalls, 0);
  });
});

test('a backgrounded leg found dead on resume redials silently, even with a call in flight', async () => {
  await withLiveShim(async ({ ctx, dial, hide, show, fireWakeProbeDeadline, resyncs, state }) => {
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const call = ctx.invoke('abortSession', ['s1']).catch((error) => error);
    await until(() => ctx.pending.size === 1, 'the call in flight');
    hide();
    ctx.resyncOnWake = true;
    show();
    // The frames a frozen page queued before its socket died arrive as it
    // thaws; they prove nothing about the socket now.
    await leg.deliver({ event: 'stale-before-freeze' });
    const attempts = FakeSocket.instances.length;
    fireWakeProbeDeadline();
    assert.equal(leg.ws.closeCalls, 1, 'the dead leg is recycled');
    assert.equal(state(), 'connecting', 'not a visible reconnect');
    assert.equal(ctx.reconnectTimer, null, 'no backoff wait');
    await until(() => FakeSocket.instances.length === attempts + 1, 'an immediate redial');
    assert.equal((await call).code, 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED');
    assert.equal(resyncs(), 0, 'the replacement connection syncs on its own');
  });
});

test('a close delivered as the page thaws redials silently', async () => {
  await withLiveShim(async ({ ctx, dial, hide, state }) => {
    const leg = await dial();
    hide();
    // The page thaws and the close queued while it was frozen runs first.
    document.visibilityState = 'visible';
    const attempts = FakeSocket.instances.length;
    leg.ws.readyState = FakeSocket.CLOSED;
    leg.ws.onclose({ code: 1006, reason: '' });
    assert.equal(state(), 'connecting');
    assert.equal(ctx.reconnectTimer, null);
    await until(() => FakeSocket.instances.length === attempts + 1, 'an immediate redial');
  });
});

test('a leg still delivering its backlog well after the probe is kept', async () => {
  await withLiveShim(async ({ ctx, dial, hide, show, fireWakeProbeDeadline, resyncs }) => {
    const leg = await dial();
    hide();
    ctx.resyncOnWake = true;
    show();
    // The pong queues behind the backlog the relay is still draining.
    ctx.lastTrafficAt = ctx.heartbeatSentAt + 1_500;
    fireWakeProbeDeadline();
    assert.equal(leg.ws.closeCalls, 0);
    assert.equal(resyncs(), 1);
    assert.equal(ctx.unprovenSocket, null);
  });
});

test('a proven leg that drops in view still takes the visible reconnect path', async () => {
  await withLiveShim(async ({ ctx, dial, hide, show, state }) => {
    const leg = await dial();
    hide();
    show();
    pong(leg.ws);
    await settle();
    leg.ws.readyState = FakeSocket.CLOSED;
    leg.ws.onclose({ code: 1006, reason: '' });
    assert.equal(state(), 'reconnecting');
    assert.notEqual(ctx.reconnectTimer, null, 'the normal backoff runs');
  });
});
