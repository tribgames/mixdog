import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecureDesktopAdapter } from './secure-desktop-adapter.ts';
import { NO_SECURE_DESKTOP, secureDesktopIdentity } from './secure-desktop-switch.ts';

/** The real client's surface the adapter uses: `connect()` resolves when
 *  `answer()` is called (or rejects on `refuse()`). */
function fakeService({ available = true } = {}) {
  const handlers = { frame: new Set(), 'desktop-changed': new Set(), close: new Set(), error: new Set() };
  const state = { current: undefined, dials: 0, active: [], inputs: [], pending: null, closes: 0 };
  const service = {
    available,
    session: () => (state.current ? { ...state.current } : undefined),
    connect: () => {
      state.dials += 1;
      return new Promise((resolve, reject) => {
        state.pending = { resolve, reject };
      });
    },
    on(event, handler) {
      handlers[event].add(handler);
      return () => handlers[event].delete(handler);
    },
    setActive: (active) => state.active.push(active),
    sendInput: async (event) => {
      state.inputs.push(event);
    },
    // Like the real client: ends the connection, emits nothing.
    close: () => {
      state.closes += 1;
      state.current = undefined;
    },
  };
  return {
    service,
    state,
    /** Listeners attached to the client. */
    listeners: () => Object.values(handlers).reduce((sum, set) => sum + set.size, 0),
    answer(hello = { protocol: 3, version: '1', session: 2, desktop: 'Default' }) {
      state.current = hello;
      state.pending.resolve({ ...hello });
    },
    refuse() {
      state.pending.reject(new Error('refused'));
    },
    emit(event, ...args) {
      if (event === 'desktop-changed') state.current = { ...state.current, desktop: args[0], session: args[1] };
      if (event === 'close') state.current = undefined;
      for (const handler of handlers[event]) handler(...args);
    },
  };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    timers: {
      setTimeout: (run, ms) => {
        const timer = { run, ms };
        pending.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        const index = pending.indexOf(timer);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    fire() {
      const timer = pending.shift();
      timer.run();
      return timer.ms;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('not installed: the adapter is the not-installed client, so the secure desktop stays blocked', () => {
  const fake = fakeService({ available: false });
  assert.equal(createSecureDesktopAdapter(fake.service), NO_SECURE_DESKTOP);
  assert.equal(fake.state.dials, 0);
});

test('activation dials on demand without waiting, then activates and reports the session', async () => {
  const fake = fakeService();
  const adapter = createSecureDesktopAdapter(fake.service);
  const changes = [];
  adapter.onDesktopChanged(() => changes.push(adapter.desktop()));
  assert.equal(adapter.installed(), true);
  assert.equal(adapter.connected(), false);
  await adapter.setActive(true); // settles before the helper answers
  assert.equal(fake.state.dials, 1);
  fake.answer();
  await flush();
  assert.deepEqual(fake.state.active, [true]);
  assert.equal(adapter.connected(), true);
  assert.deepEqual(changes, ['Default']);
  assert.deepEqual(secureDesktopIdentity(adapter), { session: 2, desktop: 'default' });
  fake.emit('desktop-changed', 'Winlogon', 2);
  assert.deepEqual(changes, ['Default', 'Winlogon']);
  assert.deepEqual(secureDesktopIdentity(adapter), { session: 2, desktop: 'winlogon' });
  await adapter.setActive(false);
  assert.deepEqual(fake.state.active, [true, false]);
});

test('a lost or refused connection is dialled again with a doubling backoff while activation is wanted', async () => {
  const fake = fakeService();
  const clock = fakeTimers();
  const adapter = createSecureDesktopAdapter(fake.service, clock.timers);
  const changes = [];
  adapter.onDesktopChanged(() => changes.push(adapter.connected()));
  await adapter.setActive(true);
  fake.refuse();
  await flush();
  assert.equal(clock.fire(), 1_000);
  fake.refuse();
  await flush();
  assert.equal(clock.fire(), 2_000);
  fake.answer();
  await flush();
  assert.equal(fake.state.dials, 3);
  fake.emit('close');
  assert.deepEqual(changes, [true, false], 'connect and disconnect both re-read');
  assert.equal(clock.pending[0].ms, 1_000, 'a success resets the backoff');
  // No longer wanted: the retry is cancelled.
  await adapter.setActive(false);
  assert.deepEqual(clock.pending, []);
});

test('host commands become helper input events; a cursor read-back is refused', async () => {
  const fake = fakeService();
  const adapter = createSecureDesktopAdapter(fake.service);
  await adapter.sendInput({ op: 'move', x: -10, y: 20 });
  await adapter.sendInput({ op: 'button', button: 'left', down: true, at: { x: 5, y: 6 } });
  await adapter.sendInput({ op: 'button', button: 'left', down: false });
  await adapter.sendInput({ op: 'wheel', x: 1, y: 2, dx: 0, dy: -120 });
  await adapter.sendInput({ op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true });
  await adapter.sendInput({ op: 'text', text: 'é' });
  assert.deepEqual(fake.state.inputs, [
    { kind: 'pointer-move', x: -10, y: 20 },
    { kind: 'pointer-button', button: 'left', down: true, x: 5, y: 6 },
    { kind: 'pointer-button', button: 'left', down: false, x: 5, y: 6 },
    { kind: 'pointer-wheel', x: 1, y: 2, dx: 0, dy: -120 },
    { kind: 'key', down: true, vk: 0x41, scan: 0x1e, extended: false },
    { kind: 'text', text: 'é' },
  ]);
  await assert.rejects(adapter.sendInput({ op: 'cursor' }), /no such input/);
});

test('dispose while a connect is pending: the late success is closed, and no listener or timer is left', async () => {
  const fake = fakeService();
  const clock = fakeTimers();
  const adapter = createSecureDesktopAdapter(fake.service, clock.timers);
  const seen = [];
  adapter.onDesktopChanged(() => seen.push('changed'));
  adapter.onFrame(() => seen.push('frame'));
  assert.equal(fake.listeners(), 3);
  await adapter.setActive(true);
  assert.equal(fake.state.dials, 1);
  adapter.dispose();
  assert.equal(fake.listeners(), 0, 'every listener on the client is detached');
  fake.answer();
  await flush();
  assert.equal(fake.service.session(), undefined, 'the late connection is closed');
  assert.deepEqual(fake.state.active, [], 'and never activated');
  assert.deepEqual(seen, []);
  assert.deepEqual(clock.pending, []);
  // Nothing dials after it.
  await adapter.setActive(true);
  assert.equal(fake.state.dials, 1);
  assert.deepEqual(clock.pending, []);
});

test('dispose cancels a scheduled reconnect and closes a live connection', async () => {
  const clock = fakeTimers();
  const retrying = fakeService();
  const first = createSecureDesktopAdapter(retrying.service, clock.timers);
  await first.setActive(true);
  retrying.refuse();
  await flush();
  assert.equal(clock.pending.length, 1, 'a reconnect is scheduled');
  first.dispose();
  assert.deepEqual(clock.pending, []);
  assert.equal(retrying.listeners(), 0);

  const live = fakeService();
  const second = createSecureDesktopAdapter(live.service, clock.timers);
  await second.setActive(true);
  live.answer();
  await flush();
  assert.equal(second.connected(), true);
  second.dispose();
  assert.equal(live.service.session(), undefined);
  assert.equal(live.state.closes, 1);
  assert.equal(live.listeners(), 0);
  assert.deepEqual(clock.pending, []);
});

test('helper frames arrive as BGRA frames with their desktop origin', () => {
  const fake = fakeService();
  const adapter = createSecureDesktopAdapter(fake.service);
  const frames = [];
  adapter.onFrame((frame) => frames.push(frame));
  const pixels = Buffer.alloc(16);
  fake.emit('frame', { seq: 1, width: 2, height: 2, stride: 8, format: 'bgra', timestampMs: 0, originX: -4, originY: 3, desktop: 'Winlogon', dirty: [] }, pixels);
  assert.deepEqual(frames, [{ width: 2, height: 2, stride: 8, originX: -4, originY: 3, pixels }]);
  assert.equal(adapter.latestFrame(), frames[0]);
  fake.emit('close');
  assert.equal(adapter.latestFrame(), null);
});
