import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_WEBRTC_VERSION } from '../../shared/remote-webrtc.ts';
import { createRemoteWebrtcHost } from '../remote-webrtc/host.ts';
import { createRemoteScreenSources, parseRemoteScreenAccess } from './screen-webrtc-sources.ts';
import { NO_SECURE_DESKTOP } from './secure-desktop-switch.ts';

const TURN = [{ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' }];
const screen = { kind: 'screen', screenId: '1' };
const ready = { v: REMOTE_WEBRTC_VERSION, source: screen, type: 'ready', receiveCodecs: ['video/VP8'] };
const display = {
  screenId: '1',
  label: 'Primary',
  primary: true,
  scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  physical: { x: 0, y: 0, width: 1920, height: 1080 },
  captureSourceId: 'screen:0:0',
};
let revision = 0;
/** The service's access messages: each one a newer revision of epoch `e1`. */
const granted = (over = {}) => ({
  epoch: 'e1',
  revision: (revision += 1),
  connection: 'conn-1',
  paired: true,
  label: 'Phone',
  ...over,
});
const denied = (over = {}) => ({
  epoch: 'e1',
  revision: (revision += 1),
  connection: '',
  paired: false,
  label: '',
  ...over,
});
/** Lets the mocked release and host stop run (all of them resolve at once). */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function mockInputHost(log) {
  let started = false;
  return {
    start: async () => {
      started = true;
    },
    command: async (command) => {
      log.push(command);
      return [];
    },
    alive: () => started,
    desktop: () => ({ inputDesktop: 'Default', consent: false, logonUi: false }),
    session: () => (started ? 1 : null),
    onDesktop: () => () => {},
    onExit: () => () => {},
    stop: async () => {
      started = false;
    },
    kill: () => {
      started = false;
    },
  };
}

function build() {
  const commands = [];
  const signals = [];
  const injected = [];
  const indicator = [];
  const events = [];
  let refreshes = 0;
  let hosts = 0;
  let webrtc = null;
  const screens = createRemoteScreenSources({
    displays: {
      list: () => [display],
      onChange: () => () => {},
      refresh: async () => {
        refreshes += 1;
      },
    },
    createInputHost: () => {
      hosts += 1;
      return mockInputHost(injected);
    },
    secureDesktop: NO_SECURE_DESKTOP,
    indicator: () => ({
      show: (view) => indicator.push(['show', view.clientLabel, view.controlling]),
      update: () => {},
      hide: () => indicator.push(['hide']),
    }),
    sink: {
      geometryChanged: (key, geometry) => webrtc.geometryChanged(key, geometry),
      frame: (key, picture) => webrtc.frame(key, picture),
      captureChanged: (key) => webrtc.captureChanged(key),
    },
    log: (event) => events.push(event),
  });
  webrtc = createRemoteWebrtcHost({
    sender: { send: (command) => commands.push(command), onEvent: () => {} },
    sendSignal: async (clientId, signal) => {
      signals.push([clientId, signal]);
    },
    sources: (source, viewer) => (source.kind === 'screen' ? screens.resolve(source, viewer) : null),
    report: () => {},
  });
  return {
    screens,
    webrtc,
    commands,
    signals,
    injected,
    indicator,
    events,
    refreshes: () => refreshes,
    hosts: () => hosts,
  };
}

const stops = (env) => env.events.filter((event) => event.type === 'stop');

/** A control session of `c1` with the A key held. */
async function holdingA(env) {
  await env.screens.setAccess('c1', granted());
  await env.webrtc.signal('c1', ready, TURN);
  await settle();
  const source = env.screens.resolve(screen, { clientId: 'c1', signal: 'promote-ack' });
  await source.dispatch({ type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false });
  return source;
}

const keyUps = (env) => env.injected.filter((command) => command.op === 'key' && command.down === false);

test('a granted client’s ready opens a screen session: geometry, then the offer from the capture plan', async () => {
  const env = build();
  await env.screens.setAccess('c1', granted());
  assert.equal(env.refreshes(), 1, 'the capture ids are fresh before the ready');
  await env.webrtc.signal('c1', ready, TURN);
  await settle();
  const geometry = env.signals.find(([, signal]) => signal.type === 'geometry');
  assert.equal(geometry[0], 'c1');
  assert.equal(geometry[1].geometry.pixelWidth, 1920);
  const capture = env.commands.find((command) => command.type === 'source-capture');
  assert.equal(capture.plan.sourceId, 'screen:0:0');
  assert.ok(env.commands.some((command) => command.type === 'open' && command.sourceKey === 'screen:1'));
  assert.deepEqual(env.indicator, [['show', 'Phone', true]]);
});

test('no session without access, from a non-ready signal, or for a second client', async () => {
  const env = build();
  await assert.rejects(env.webrtc.signal('c1', ready, TURN), /not streamed/);
  await env.screens.setAccess('c1', denied());
  await assert.rejects(env.webrtc.signal('c1', ready, TURN), /not streamed/);
  await env.screens.setAccess('c1', granted());
  assert.equal(env.screens.resolve(screen, { clientId: 'c1', signal: 'geometry-ack' }), null);
  await env.webrtc.signal('c1', ready, TURN);
  await settle();
  await env.screens.setAccess('c2', granted());
  await assert.rejects(env.webrtc.signal('c2', ready, TURN), /not streamed/);
  assert.equal(env.indicator.filter(([kind]) => kind === 'show').length, 1);
});

test('the phone disconnecting releases held keys and ends the session; a new ready opens a new one', async () => {
  const env = build();
  await holdingA(env);
  await env.screens.setAccess('c1', denied());
  await settle();
  assert.equal(keyUps(env).length, 1);
  assert.ok(env.commands.some((command) => command.type === 'source-close' && command.sourceKey === 'screen:1'));
  assert.deepEqual(env.indicator.at(-1), ['hide']);
  assert.ok(env.events.some((event) => event.type === 'stop' && event.reason === 'revoked'));
  // The display is free again, for this client or another.
  await env.screens.setAccess('c2', granted({ connection: 'conn-2' }));
  await env.webrtc.signal('c2', ready, TURN);
  await settle();
  assert.equal(env.indicator.filter(([kind]) => kind === 'show').length, 2);
});

test('regression: a grant delivered after the deny that followed it is ignored', async () => {
  const env = build();
  // Issued in this order by the service, delivered in the opposite order.
  const grant = granted();
  await env.screens.setAccess('c1', denied());
  assert.throws(() => env.screens.setAccess('c1', grant), /stale/);
  await assert.rejects(env.webrtc.signal('c1', ready, TURN), /not streamed/);
  assert.equal(env.hosts(), 0);
  // The same during a live session: the deny stops it, the late grant can't revive it.
  await env.screens.setAccess('c1', granted());
  await holdingA(env);
  const late = granted();
  await env.screens.setAccess('c1', denied());
  assert.throws(() => env.screens.setAccess('c1', late), /stale/);
  await settle();
  assert.equal(stops(env).length, 1);
  assert.equal(keyUps(env).length, 1);
});

test('regression: a client id reused by a new connection never inherits the old one’s access', async () => {
  const env = build();
  await holdingA(env);
  // The relay names a new connection with the same client id: its access is
  // its own, and the old connection's session ends at once.
  await env.screens.setAccess('c1', granted({ connection: 'conn-2', label: 'Other phone' }));
  await settle();
  assert.equal(stops(env).length, 1, 'the old connection’s session ends');
  assert.equal(keyUps(env).length, 1, 'its held key is released');
  // A ready now opens a new session, bound to the new connection alone.
  await env.webrtc.signal('c1', ready, TURN);
  await settle();
  assert.deepEqual(env.indicator.filter(([kind]) => kind === 'show').at(-1), ['show', 'Other phone', true]);
});

test('a new service epoch withdraws the previous epoch’s access and retires it', async () => {
  const env = build();
  await holdingA(env);
  await env.screens.setAccess('c2', granted({ epoch: 'e2', connection: 'conn-9' }));
  await settle();
  assert.equal(stops(env).length, 1, 'the earlier instance’s session ends');
  assert.throws(() => env.screens.setAccess('c1', granted({ revision: 1e9 })), /stale/);
});

test('regression: after dispose a granted ready is refused and starts no input host', async () => {
  const env = build();
  await env.screens.setAccess('c1', granted());
  await env.screens.dispose();
  await assert.rejects(env.webrtc.signal('c1', ready, TURN), /not streamed/);
  assert.equal(env.hosts(), 0);
  assert.throws(() => env.screens.setAccess('c1', granted()), /closed/);
  assert.equal(env.screens.resolve(screen, { clientId: 'c1', signal: 'ready' }), null);
});

test('close latches before the shutdown: a session running then stops, and none opens after', async () => {
  const env = build();
  await holdingA(env);
  const quitting = env.screens.stopForQuit();
  // Access cached before close is gone, and the latch is permanent.
  assert.throws(() => env.screens.setAccess('c1', granted()), /closed/);
  assert.equal(env.screens.resolve(screen, { clientId: 'c1', signal: 'ready' }), null);
  await quitting;
  assert.equal(keyUps(env).length, 1);
  await env.screens.dispose();
  assert.equal(env.screens.resolve(screen, { clientId: 'c1', signal: 'ready' }), null);
  assert.equal(env.hosts(), 1);
});

test('app quit releases held input and stops every session within the quit budget', async () => {
  const env = build();
  await holdingA(env);
  const started = Date.now();
  await env.screens.stopForQuit();
  assert.ok(Date.now() - started < 5_000);
  assert.equal(keyUps(env).length, 1);
  assert.ok(env.events.some((event) => event.type === 'stop' && event.reason === 'user'));
  assert.ok(env.commands.some((command) => command.type === 'source-close'));
});

test('access crossing from the service is validated', () => {
  const grant = granted();
  assert.deepEqual(parseRemoteScreenAccess(grant), grant);
  const deny = denied();
  assert.deepEqual(parseRemoteScreenAccess(deny), deny);
  assert.throws(() => parseRemoteScreenAccess({ ...granted(), paired: 'yes' }), /invalid/);
  assert.throws(() => parseRemoteScreenAccess({ ...granted(), revision: 0 }), /invalid/);
  assert.throws(() => parseRemoteScreenAccess({ ...granted(), revision: 1.5 }), /invalid/);
  assert.throws(() => parseRemoteScreenAccess({ ...granted(), epoch: '' }), /invalid/);
  // A grant must name its connection.
  assert.throws(() => parseRemoteScreenAccess({ ...granted(), connection: '' }), /invalid/);
  assert.throws(() => parseRemoteScreenAccess(null), /invalid/);
  assert.equal(parseRemoteScreenAccess({ ...granted(), label: 'x'.repeat(500) }).label.length, 120);
});
