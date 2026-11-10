// A connection opened under one network proxy route never carries a request
// after the route changed: the OpenAI WebSocket pool and Cursor's parked runs
// retire what they hold (proxy-policy.mjs: proxyRouteEpoch, onProxyRouteChange).
import '../../agent/orchestrator/tools/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

const { acquireWebSocket, releaseWebSocket, hasPooledWebSocket, _clearWebSocketPoolForTest, _setOpenSocketForTest } =
  await import('../../agent/orchestrator/providers/openai-ws-pool.mjs');
const { __cursorWireInternals: wire } = await import('../../agent/orchestrator/providers/cursor-wire.mjs');
const { adoptProxySetting, _resetProxySettingForTest } = await import('./proxy-policy.mjs');

const SOCKS_A = { mode: 'manual', url: 'socks5://127.0.0.1:1080' };
const SOCKS_B = { mode: 'manual', url: 'socks5://127.0.0.1:1081' };
const OFF = { mode: 'off' };
const SYSTEM = { mode: 'system' };

test.after(() => _resetProxySettingForTest());

class FakeSocket extends EventEmitter {
  readyState = 1;

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

const AUTH = { type: 'openai-direct', apiKey: 'k' };

function useFakeSockets(t) {
  _clearWebSocketPoolForTest();
  _setOpenSocketForTest(async () => ({ socket: new FakeSocket() }));
  t.after(() => {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  });
}

const acquire = (poolKey) => acquireWebSocket({ auth: AUTH, poolKey, cacheKey: 'cache', codexHeaders: {} });

const TRANSITIONS = [
  ['manual SOCKS5 → off', SOCKS_A, OFF],
  ['off → manual', OFF, SOCKS_A],
  ['system → manual', SYSTEM, SOCKS_A],
  ['manual address change', SOCKS_A, SOCKS_B],
];

for (const [name, from, to] of TRANSITIONS) {
  test(`WS pool: an idle socket opened before "${name}" is closed and not reused`, async (t) => {
    useFakeSockets(t);
    adoptProxySetting(from);
    const first = await acquire(`idle:${name}`);
    releaseWebSocket({ entry: first.entry, poolKey: `idle:${name}`, keep: true });
    assert.equal(hasPooledWebSocket(`idle:${name}`), true);

    adoptProxySetting(to);
    assert.equal(first.entry.socket.readyState, 3, "the old route's idle socket is closed");
    assert.equal(hasPooledWebSocket(`idle:${name}`), false);

    const second = await acquire(`idle:${name}`);
    assert.equal(second.reused, false);
    assert.notEqual(second.entry.socket, first.entry.socket);
    releaseWebSocket({ entry: second.entry, poolKey: `idle:${name}`, keep: true });
  });
}

test('WS pool: a request in flight finishes on its socket, which is then closed instead of kept', async (t) => {
  useFakeSockets(t);
  adoptProxySetting(SOCKS_A);
  const inFlight = await acquire('in-flight');
  adoptProxySetting(OFF);
  assert.equal(inFlight.entry.socket.readyState, 1, 'a busy socket is not cut off');

  releaseWebSocket({ entry: inFlight.entry, poolKey: 'in-flight', keep: true });
  assert.equal(inFlight.entry.socket.readyState, 3);
  const next = await acquire('in-flight');
  assert.equal(next.reused, false);
  releaseWebSocket({ entry: next.entry, poolKey: 'in-flight', keep: true });
});

test('WS pool: a socket still connecting when the route changes is not reused', async (t) => {
  _clearWebSocketPoolForTest();
  let finish;
  _setOpenSocketForTest(() => new Promise((resolve) => (finish = () => resolve({ socket: new FakeSocket() }))));
  t.after(() => {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  });
  adoptProxySetting(SOCKS_A);
  const opening = acquire('connecting');
  await new Promise((resolve) => setImmediate(resolve));
  adoptProxySetting(OFF);
  finish();
  const entry = (await opening).entry;
  releaseWebSocket({ entry, poolKey: 'connecting', keep: true });
  assert.equal(entry.socket.readyState, 3);
});

test('WS pool: a socket is reused while the route holds', async (t) => {
  useFakeSockets(t);
  adoptProxySetting(SOCKS_A);
  const first = await acquire('steady');
  releaseWebSocket({ entry: first.entry, poolKey: 'steady', keep: true });
  adoptProxySetting(SOCKS_A);
  const second = await acquire('steady');
  assert.equal(second.reused, true);
  assert.equal(second.entry.socket, first.entry.socket);
  releaseWebSocket({ entry: second.entry, poolKey: 'steady', keep: true });
});

function fakeBridge() {
  return {
    alive: true,
    close() {
      this.alive = false;
    },
    write() {},
  };
}

function parked(t, key) {
  const bridge = fakeBridge();
  wire.stampBridgeRoute(bridge);
  const active = { bridge, heartbeat: setInterval(() => {}, 10_000), pending: [] };
  t.after(() => {
    clearInterval(active.heartbeat);
    globalThis.__mixdogCloseProviderConnectionsForSession?.(key, 'test-complete');
  });
  return { bridge, active };
}

test('Cursor: a run parked for its tool results is closed when the route changes', (t) => {
  adoptProxySetting(SOCKS_A);
  const { bridge, active } = parked(t, 'cursor-route:parked');
  wire.parkRun('cursor-route:parked', active);
  assert.equal(bridge.alive, true);
  adoptProxySetting(OFF);
  assert.equal(bridge.alive, false);
});

test('Cursor: a run that parks after the route changed is closed, not kept for a resume', async (t) => {
  adoptProxySetting(SOCKS_A);
  const { bridge, active } = parked(t, 'cursor-route:late');
  adoptProxySetting(OFF);
  wire.parkRun('cursor-route:late', active);
  await Promise.resolve();
  assert.equal(bridge.alive, false);
});

test('Cursor: a parked run is kept while the route holds', (t) => {
  adoptProxySetting(OFF);
  const { bridge, active } = parked(t, 'cursor-route:steady');
  wire.parkRun('cursor-route:steady', active);
  adoptProxySetting(OFF);
  assert.equal(bridge.alive, true);
});
