import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemoteScreenSource,
  SCREEN_QUIT_BUDGET_MS,
  ScreenSourceDenied,
  stopScreenSourcesForQuit,
} from './screen-source.ts';
import { createScreenWebrtcSource } from './screen-webrtc-source.ts';

const display = {
  screenId: '1',
  label: 'Primary',
  primary: true,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:0:0',
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const keyA = { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false };
const isKeyUp = (command, vk = 0x41) => command.op === 'key' && command.vk === vk && command.down === false;

function mockDisplays(initial = [display]) {
  let displays = initial;
  const listeners = new Set();
  return {
    provider: {
      list: () => displays,
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next) {
      displays = next;
      for (const listener of listeners) listener();
    },
  };
}

function mockHost() {
  const commands = [];
  const desktopListeners = new Set();
  const exitListeners = new Set();
  let current = { inputDesktop: 'Default', consent: false, logonUi: false };
  let started = false;
  // `reachable` false: the input desktop is the secure one, SendInput fails.
  // `gate`: a promise each command (and start) waits on, to hold one in flight.
  const control = { reachable: true, gate: null, startGate: null, attempts: [], killed: false };
  const inFlight = new Set();
  return {
    commands,
    control,
    host: {
      start: async () => {
        if (control.startGate) await control.startGate;
        started = true;
      },
      command: async (command) => {
        control.attempts.push(command);
        if (control.gate) {
          // Like the real host, a kill fails a command still in flight.
          await new Promise((resolve, reject) => {
            inFlight.add(reject);
            control.gate.then(resolve, reject).finally(() => inFlight.delete(reject));
          });
        }
        if (!started) throw new Error('not started');
        if (!control.reachable) throw new Error('input_cleanup_unconfirmed');
        commands.push(command);
        return [];
      },
      kill: () => {
        control.killed = true;
        started = false;
        for (const reject of [...inFlight]) reject(new Error('host_killed'));
      },
      alive: () => started,
      desktop: () => current,
      session: () => (started ? 1 : null),
      onDesktop(listener) {
        desktopListeners.add(listener);
        return () => desktopListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      stop: async () => {
        if (control.stopHangs) await new Promise(() => {});
        started = false;
      },
    },
    emitDesktop(next) {
      current = next;
      for (const listener of desktopListeners) listener(next);
    },
    /** The process crashed. */
    emitExit() {
      started = false;
      for (const listener of exitListeners) listener();
    },
  };
}

function mockSecureDesktop(over = {}) {
  const frameListeners = new Set();
  const desktopListeners = new Set();
  const state = {
    installed: false,
    connected: false,
    desktop: null,
    session: 1,
    active: false,
    sent: [],
    ...over,
  };
  return {
    state,
    client: {
      installed: () => state.installed,
      connected: () => state.connected,
      desktop: () => state.desktop,
      session: () => (state.connected ? state.session : null),
      setActive: async (active) => {
        state.active = active;
      },
      sendInput: async (command) => {
        if (state.hang) await new Promise(() => {});
        state.sent.push(command);
      },
      latestFrame: () => null,
      onFrame(listener) {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      onDesktopChanged(listener) {
        desktopListeners.add(listener);
        return () => desktopListeners.delete(listener);
      },
    },
    emitFrame(frame) {
      for (const listener of frameListeners) listener(frame);
    },
    emitDesktop(desktop) {
      state.desktop = desktop;
      for (const listener of desktopListeners) listener(desktop);
    },
  };
}

function mockIndicator() {
  const calls = [];
  let view = null;
  return {
    calls,
    current: () => view,
    indicator: {
      show(next) {
        view = next;
        calls.push(['show', next.controlling]);
      },
      update(next) {
        if (view) view = { ...view, controlling: next.controlling };
        calls.push(['update', next.controlling]);
      },
      hide() {
        view = null;
        calls.push(['hide']);
      },
    },
  };
}

function build(over = {}) {
  const displays = mockDisplays(over.displays);
  const host = mockHost();
  const secure = mockSecureDesktop(over.secure);
  const indicator = mockIndicator();
  const log = [];
  const authListeners = new Set();
  const auth = {
    paired: true,
    ...over.auth,
    /** Apply a pairing/connection change and signal it, as the wiring does. */
    change(next) {
      Object.assign(auth, next);
      for (const listener of authListeners) listener();
    },
  };
  const source = createRemoteScreenSource({
    clientId: 'client-a',
    clientLabel: 'Phone',
    screenId: '1',
    displays: displays.provider,
    authorization: {
      paired: () => auth.paired,
      onChange(listener) {
        authListeners.add(listener);
        return () => authListeners.delete(listener);
      },
    },
    shutdownDeadlineMs: over.shutdownDeadlineMs ?? 1_000,
    createInputHost: () => host.host,
    secureDesktop: secure.client,
    indicator: indicator.indicator,
    log: (event) => log.push(event),
  });
  // The WebRTC side drives viewer leave / disconnect and demote through this.
  const adapter = createScreenWebrtcSource(source, {
    screenId: '1',
    sink: { geometryChanged() {}, captureChanged() {}, frame() {} },
  });
  /** Logged drops, as [backend, count]. */
  const dropped = () => log.filter((event) => event.type === 'release-dropped').map((event) => [event.backend, event.count]);
  return { source, adapter, displays, host, secure, indicator, log, auth, dropped };
}

/** A control session holding A and the left button on the ordinary desktop. */
async function holdingOnDesktop() {
  const env = build();
  const { geometry } = await env.source.start();
  await env.source.handleInput(keyA, geometry.generation);
  await env.source.handleInput({ type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 }, geometry.generation);
  return env;
}

/** A control session on the lock screen through the helper, holding A there. */
async function holdingOnHelper() {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  const { geometry } = await env.source.start();
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'applied');
  return env;
}

/** Every defined exit, driven the way its caller drives it. */
const EXIT_PATHS = {
  'viewer leave / phone disconnect': (env) => {
    env.adapter.stop();
    return env.source.released();
  },
  demote: (env) => env.adapter.release(),
  'unpair / disconnect': (env) => {
    env.auth.change({ paired: false });
    return env.source.released();
  },
  stop: (env) => env.source.stop('user'),
  'app quit': (env) => stopScreenSourcesForQuit([env.source]),
};

for (const [exit, run] of Object.entries(EXIT_PATHS)) {
  test(`${exit} releases held input through the backend that pressed it`, async () => {
    const onDesktop = await holdingOnDesktop();
    await run(onDesktop);
    assert.ok(onDesktop.host.commands.some((c) => isKeyUp(c)), 'key-up through the input host');
    assert.ok(onDesktop.host.commands.some((c) => c.op === 'button' && c.down === false), 'button-up through the input host');
    assert.deepEqual(onDesktop.secure.state.sent, [], 'nothing through the helper');
    assert.deepEqual(onDesktop.dropped(), []);

    const onHelper = await holdingOnHelper();
    await run(onHelper);
    assert.ok(onHelper.secure.state.sent.some((c) => isKeyUp(c)), 'key-up through the helper');
    assert.ok(!onHelper.host.control.attempts.some((c) => isKeyUp(c)), 'nothing through the input host');
    assert.deepEqual(onHelper.dropped(), []);
  });
}

test('start is denied when the client is not paired and connected', async () => {
  const unpaired = build({ auth: { paired: false } });
  await assert.rejects(unpaired.source.start(), (error) => error instanceof ScreenSourceDenied && error.reason === 'unauthorized');
  assert.equal(unpaired.log.at(-1).type, 'denied');
  assert.equal(unpaired.source.running(), false);
});

test('an input host that cannot start fails the start and stops the session', async () => {
  const env = build();
  env.host.host.start = async () => {
    throw new Error('spawn failed');
  };
  await assert.rejects(env.source.start(), /spawn failed/);
  assert.equal(env.source.running(), false);
  assert.equal(env.log.at(-1).reason, 'error');
});

test('a control session locks geometry, shows the indicator and injects mapped input', async () => {
  const env = build();
  const result = await env.source.start();
  assert.equal(result.geometry.pixelWidth, 1920);
  assert.equal(result.status.state, 'live');
  assert.equal(result.status.control, true);
  assert.equal(env.log[0].type, 'start');
  assert.equal(env.indicator.current().controlling, true);

  const generation = result.geometry.generation;
  const applied = await env.source.handleInput({ type: 'screen-pointer', action: 'move', x: 960, y: 540 }, generation);
  assert.equal(applied, 'applied');
  assert.deepEqual(env.host.commands.at(-1), { op: 'move', x: 960, y: 540 });

  // Stale geometry generation is rejected without a command.
  const stale = await env.source.handleInput({ type: 'screen-pointer', action: 'move', x: 1, y: 1 }, generation - 1);
  assert.equal(stale, 'rejected');
});

test('stop releases every held key and button, hides the indicator and tears down', async () => {
  const env = build();
  const result = await env.source.start();
  const generation = result.geometry.generation;
  await env.source.handleInput({ type: 'screen-pointer', action: 'down', button: 'left', x: 10, y: 10 }, generation);
  await env.source.handleInput({ type: 'screen-key', action: 'down', vk: 0xa0, scan: 0x2a, extended: false }, generation);
  env.host.commands.length = 0;

  await env.source.stop('user');
  const ops = env.host.commands;
  assert.ok(ops.some((c) => c.op === 'button' && c.down === false), 'the held button was released');
  assert.ok(ops.some((c) => c.op === 'key' && c.down === false), 'the held key was released');
  assert.equal(env.secure.state.active, false);
  assert.deepEqual(env.indicator.calls.at(-1), ['hide']);
  assert.equal(env.log.at(-1).type, 'stop');
  assert.equal(env.log.at(-1).reason, 'user');
  assert.equal(env.source.running(), false);
});

test('a jump to the secure desktop with an attached helper routes frames and input to it', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'default' } });
  const statuses = [];
  env.source.onStatus((status) => statuses.push(status));
  const result = await env.source.start();
  const generation = result.geometry.generation;

  // The input desktop becomes the secure desktop; the helper reports winlogon.
  env.secure.state.desktop = 'winlogon';
  env.host.emitDesktop({ inputDesktop: null, consent: true, logonUi: false });

  const latest = statuses.at(-1);
  assert.equal(latest.state, 'secure-desktop');
  assert.equal(latest.control, true);
  await tick();
  assert.equal(env.secure.state.active, true);

  // Input now goes to the helper, not the ordinary input host.
  const before = env.host.commands.length;
  const applied = await env.source.handleInput({ type: 'screen-pointer', action: 'move', x: 100, y: 100 }, generation);
  assert.equal(applied, 'applied');
  assert.equal(env.host.commands.length, before, 'no ordinary-desktop command was sent');
  assert.deepEqual(env.secure.state.sent.at(-1), { op: 'move', x: 100, y: 100 });

  // A helper frame is fitted and delivered to the sender.
  const frames = [];
  env.source.onFrame((frame) => frames.push(frame));
  env.secure.emitFrame({
    width: 1920,
    height: 1080,
    stride: 1920 * 4,
    originX: 0,
    originY: 0,
    pixels: new Uint8Array(1920 * 1080 * 4),
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].width, 1920);
});

test('the secure desktop without a helper is reported blocked and refuses input', async () => {
  const env = build();
  const result = await env.source.start();
  const statuses = [];
  env.source.onStatus((status) => statuses.push(status));
  env.host.emitDesktop({ inputDesktop: null, consent: true, logonUi: false });

  assert.equal(statuses.at(-1).state, 'secure-desktop');
  assert.equal(statuses.at(-1).control, false);
  const outcome = await env.source.handleInput({ type: 'screen-pointer', action: 'move', x: 1, y: 1 }, result.geometry.generation);
  assert.equal(outcome, 'rejected');
});

test('removing the streamed display stops the session', async () => {
  const env = build();
  await env.source.start();
  env.displays.set([]);
  // running flips synchronously; the teardown log lands after its awaits.
  assert.equal(env.source.running(), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.log.at(-1).type, 'stop');
  assert.equal(env.log.at(-1).reason, 'display-removed');
});

test('screen-release is honored even after the pairing is gone mid-session', async () => {
  const env = build();
  const result = await env.source.start();
  await env.source.handleInput({ type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false }, result.geometry.generation);
  env.host.commands.length = 0;

  // The pairing is gone before its change signal arrives.
  env.auth.paired = false;
  const outcome = await env.source.handleInput({ type: 'screen-release' }, result.geometry.generation);
  assert.equal(outcome, 'applied');
  assert.ok(env.host.commands.some((c) => c.op === 'key' && c.down === false), 'the key was released despite the revoke');
});

test('an unpair after a key-down sends the key-up and stops capture at once', async () => {
  const env = build();
  const stops = [];
  const statuses = [];
  env.source.onStop((reason) => stops.push(reason));
  env.source.onStatus((status) => statuses.push(status));
  const result = await env.source.start();
  assert.equal(await env.source.handleInput(keyA, result.geometry.generation), 'applied');

  env.auth.change({ paired: false });
  // Synchronous: no input admitted, capture told to stop, indicator gone.
  assert.equal(env.source.running(), false);
  assert.deepEqual(stops, ['revoked']);
  assert.equal(statuses.at(-1).state, 'stopped');
  assert.equal(env.source.capturePlan(), null);
  assert.deepEqual(env.indicator.calls.at(-1), ['hide']);
  await env.source.released();
  assert.ok(env.host.commands.some((c) => isKeyUp(c)), 'the held key was lifted');
  assert.equal(await env.source.handleInput(keyA, result.geometry.generation), 'rejected');
  assert.equal(env.log.at(-1).type, 'stop');
});

test('a demote releases held input; release stays idempotent', async () => {
  const env = build();
  const result = await env.source.start();
  await env.source.handleInput({ type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 }, result.geometry.generation);
  await env.source.handleInput(keyA, result.geometry.generation);

  await env.source.releaseInput();
  assert.ok(env.host.commands.some((c) => isKeyUp(c)));
  assert.ok(env.host.commands.some((c) => c.op === 'button' && c.down === false));
  assert.equal(env.source.running(), true, 'the session goes on');
  // Demote, then viewer-left: nothing more is sent.
  const before = env.host.commands.length;
  await env.source.releaseInput();
  await env.source.releaseInput();
  assert.equal(env.host.commands.length, before);
});

test('leaving the helper releases its press through the helper, before the switch', async () => {
  const env = await holdingOnHelper();
  // Back on the ordinary desktop while the helper is still on winlogon.
  env.host.control.reachable = true;
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await tick();
  assert.ok(env.secure.state.sent.some((c) => isKeyUp(c)), 'the helper lifted its own press');
  assert.ok(!env.host.control.attempts.some((c) => isKeyUp(c)), 'the input host never sends it');
  assert.equal(env.secure.state.active, false, 'deactivated after the release');
  assert.deepEqual(env.dropped(), []);
});

test('a switch to the secure desktop drops the desktop press it can’t reach; no key-up is sent later', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'default' } });
  const result = await env.source.start();
  await env.source.handleInput(keyA, result.geometry.generation);

  // The input desktop is now unreadable: the release can't go anywhere.
  env.secure.state.desktop = 'winlogon';
  env.host.emitDesktop({ inputDesktop: null, consent: true, logonUi: false });
  await tick();
  assert.deepEqual(env.dropped(), [['desktop', 1]]);
  assert.ok(!env.secure.state.sent.some((c) => isKeyUp(c)), 'never sent to the helper, which did not press it');

  // Back on the ordinary desktop, and at stop: nothing was carried over.
  env.secure.state.desktop = 'default';
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await env.source.stop('user');
  assert.ok(!env.host.control.attempts.some((c) => isKeyUp(c)));
});

test('a helper reconnected to another session never receives an old release: it is dropped', async () => {
  const env = await holdingOnHelper();
  env.secure.state.session = 2;
  env.secure.emitDesktop('winlogon');
  await tick();
  await env.source.stop('user');
  assert.ok(!env.secure.state.sent.some((c) => isKeyUp(c)), 'never sent into session 2');
  assert.deepEqual(env.dropped(), [['secure', 1]]);
});

test('stop during a pending dispatch cancels queued input and releases after the in-flight one', async () => {
  const env = build();
  const result = await env.source.start();
  let open;
  env.host.control.gate = new Promise((resolve) => {
    open = resolve;
  });
  const inFlight = env.source.handleInput(keyA, result.geometry.generation);
  // Let it reach the host so it is truly in flight.
  await tick();
  assert.ok(env.host.control.attempts.some((c) => c.op === 'key' && c.vk === 0x41));
  const queued = env.source.handleInput({ ...keyA, vk: 0x42, scan: 0x30 }, result.geometry.generation);
  const stopped = env.source.stop('user');
  env.host.control.gate = null;
  open();
  assert.equal(await inFlight, 'applied');
  assert.equal(await queued, 'rejected');
  await stopped;
  await env.source.released();
  const keys = env.host.commands.filter((c) => c.op === 'key');
  assert.deepEqual(
    keys.map((c) => [c.vk, c.down]),
    [
      [0x41, true],
      [0x41, false],
    ]
  );
});

test('a release the backend can’t deliver at stop is dropped and counted; nothing outlives the session', async () => {
  const env = await holdingOnDesktop();
  // SendInput is refused at the moment of the release.
  env.host.control.reachable = false;
  await env.source.stop('user');
  assert.deepEqual(env.dropped(), [['desktop', 2]]);
  assert.deepEqual(env.log.at(-1), { type: 'release-dropped', clientId: 'client-a', screenId: '1', backend: 'desktop', count: 2 });
  assert.equal(env.host.host.alive(), false, 'the session host is closed');
  // A later release from the viewer finds nothing left.
  await env.source.releaseInput();
  assert.equal(env.dropped().length, 1);
});

test('a crashed input host stops the session; its presses are dropped and counted', async () => {
  const env = await holdingOnDesktop();
  env.host.emitExit();
  assert.equal(env.source.running(), false);
  await env.source.released();
  assert.equal(env.log.find((event) => event.type === 'stop').reason, 'error');
  assert.ok(!env.host.control.attempts.some((c) => isKeyUp(c)), 'nothing sent to a dead host');
  assert.deepEqual(env.dropped(), [['desktop', 2]]);
});

test('a helper that stops answering cannot hold stop open: the watchdog kills it and drops its presses', async () => {
  const env = build({ shutdownDeadlineMs: 20 });
  const result = await env.source.start();
  assert.equal(await env.source.handleInput(keyA, result.geometry.generation), 'applied');
  // From now on the helper never acknowledges; a second key-down is in flight.
  env.host.control.gate = new Promise(() => {});
  const inFlight = env.source.handleInput({ ...keyA, vk: 0x42, scan: 0x30 }, result.geometry.generation);
  await tick();

  await env.source.stop('user');
  await env.source.released();
  assert.equal(await inFlight, 'rejected');
  assert.equal(env.host.control.killed, true, 'the unresponsive helper was killed');
  // The held press and the one cut off mid-delivery.
  assert.deepEqual(env.dropped(), [['desktop', 2]]);
});

test('app quit stops every session within the 5 s budget, even with hung hosts', async (t) => {
  assert.equal(SCREEN_QUIT_BUDGET_MS, 5_000);
  const sessions = [build({ shutdownDeadlineMs: 60_000 }), build({ shutdownDeadlineMs: 60_000 })];
  for (const env of sessions) {
    const result = await env.source.start();
    await env.source.handleInput(keyA, result.geometry.generation);
    // Neither the key-up nor the host's own graceful stop ever completes.
    env.host.control.gate = new Promise(() => {});
    env.host.control.stopHangs = true;
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  let done = false;
  const quitting = stopScreenSourcesForQuit(sessions.map((env) => env.source)).then(() => {
    done = true;
  });
  await flush();
  t.mock.timers.tick(SCREEN_QUIT_BUDGET_MS - 1);
  await flush();
  assert.equal(done, false, 'the budget is used while the hosts hang');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true, 'both sessions finished at 5 s, in parallel');
  await quitting;
  for (const env of sessions) {
    assert.equal(env.host.control.killed, true);
    assert.deepEqual(env.dropped(), [['desktop', 1]]);
  }
});

test('a later stop with a shorter deadline shortens the one already running', async () => {
  const env = build({ shutdownDeadlineMs: 60_000 });
  const result = await env.source.start();
  await env.source.handleInput(keyA, result.geometry.generation);
  env.host.control.gate = new Promise(() => {});
  const startedAt = Date.now();
  // A session stop already under way with a long deadline...
  const first = env.source.stop('viewer-left', { deadlineMs: 5_000 });
  await tick();
  // ...then app quit asks for its shared budget.
  const second = env.source.stop('user', { deadlineMs: 20 });
  assert.equal(second, first, 'the same stop');
  await second;
  await env.source.released();
  assert.ok(Date.now() - startedAt < 1_000, 'finished at the shorter deadline');
  assert.equal(env.host.control.killed, true);
  assert.deepEqual(env.dropped(), [['desktop', 1]]);
});

test('a later stop never lengthens the running deadline', async () => {
  const env = build({ shutdownDeadlineMs: 60_000 });
  await env.source.start();
  env.host.control.stopHangs = true;
  const startedAt = Date.now();
  const first = env.source.stop('user', { deadlineMs: 20 });
  env.source.stop('user', { deadlineMs: 60_000 });
  await first;
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(env.host.control.killed, true);
});

test('the shared quit budget also cuts a host close already under way', async () => {
  const env = build({ shutdownDeadlineMs: 60_000 });
  await env.source.start();
  env.host.control.stopHangs = true;
  const startedAt = Date.now();
  const first = env.source.stop('viewer-left', { deadlineMs: 5_000 });
  await tick();
  await tick();
  env.source.stop('user', { deadlineMs: 20 });
  await first;
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(env.host.control.killed, true);
});

test('a host whose graceful stop hangs is killed at the stop deadline', async () => {
  const env = build({ shutdownDeadlineMs: 60_000 });
  await env.source.start();
  env.host.control.stopHangs = true;
  const startedAt = Date.now();
  await env.source.stop('user', { deadlineMs: 30 });
  await env.source.released();
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(env.host.control.killed, true);
});

test('a secure-desktop helper that hangs is abandoned at the stop deadline and its release dropped', async () => {
  const env = await holdingOnHelper();
  env.secure.state.hang = true;
  await env.source.stop('user', { deadlineMs: 20 });
  assert.deepEqual(env.dropped(), [['secure', 1]]);
});

test('a disconnect while the input host starts fails the start', async () => {
  const env = build();
  let open;
  env.host.control.startGate = new Promise((resolve) => {
    open = resolve;
  });
  const starting = env.source.start();
  await tick();
  env.auth.change({ paired: false });
  open();
  await assert.rejects(starting, (error) => error instanceof ScreenSourceDenied && error.reason === 'revoked');
  assert.ok(!env.log.some((entry) => entry.type === 'start'));
  assert.equal(env.indicator.current(), null);
});

test('helper frames stop flowing once the pairing is gone', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  const result = await env.source.start();
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  const frames = [];
  env.source.onFrame((frame) => frames.push(frame));
  const frame = { width: 1920, height: 1080, stride: 1920 * 4, originX: 0, originY: 0, pixels: new Uint8Array(1920 * 1080 * 4) };
  env.secure.emitFrame(frame);
  assert.equal(frames.length, 1);
  // Not yet signalled: the live read alone already gates frames.
  env.auth.paired = false;
  env.secure.emitFrame(frame);
  assert.equal(frames.length, 1);
  // A malformed helper frame is dropped, not thrown into the helper client.
  env.auth.paired = true;
  env.secure.emitFrame({ ...frame, pixels: new Uint8Array(4) });
  assert.equal(frames.length, 1);
  assert.equal(result.plan.sourceId, 'screen:0:0');
});

test('a display change that keeps the geometry does not renew capture', async () => {
  const env = build();
  const renewals = [];
  env.source.onGeometry((renewal) => renewals.push(renewal));
  await env.source.start();
  env.displays.set([{ ...display }]);
  assert.equal(renewals.length, 0);
  env.displays.set([{ ...display, physical: { ...display.physical, width: 2560, height: 1440 } }]);
  assert.equal(renewals.length, 1);
  assert.equal(renewals[0].plan.width, 2560);
});
