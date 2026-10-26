import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemoteScreenSource,
  SCREEN_QUIT_BUDGET_MS,
  ScreenSourceDenied,
  stopScreenSourcesForQuit,
} from './screen-source.ts';
import { createScreenWebrtcSource, HELPER_FRAME_INTERVAL_MS, helperVideoStallMs } from './screen-webrtc-source.ts';
import { createSecureDesktopHelper } from './secure-desktop-helper.ts';
import { createPcAccess } from '../pc-access.ts';
import { screenHelperPanel } from '../../renderer/remote-screen-helper.ts';

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
        // The cursor read-back (sampling): `control.cursor` = [x, y] desktop pixels.
        // `control.cursorGate`: a promise the read waits on, to hold it in flight.
        if (command.op === 'cursor') {
          control.cursorReads = (control.cursorReads ?? 0) + 1;
          if (control.cursorGate) await control.cursorGate;
          if (!control.cursor) throw new Error('cursor_unavailable');
          return control.cursor.map(String);
        }
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
  const challengeListeners = new Set();
  const issueListeners = new Set();
  const listen = (set, listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const state = {
    installed: false,
    connected: false,
    desktop: null,
    session: 1,
    /** The helper's WTS lock state while connected. */
    locked: null,
    active: false,
    sent: [],
    /** Declared video runs, relayed grants, and install requests' keys. */
    runs: [],
    grants: [],
    installs: [],
    installState: 'unavailable',
    /** What an install request ends with (an Error: it rejects). */
    installResult: { outcome: 'unavailable', state: 'unavailable' },
    /** What `ensureRunning` answers (an Error: it rejects), and how often it was asked. */
    service: { installed: true, running: true },
    ensures: 0,
    /** Another session holds the helper (a lease's view). */
    ownedElsewhere: false,
    /** The helper-wide run counter (`mintVideoRun`). */
    minted: 0,
    ...over,
  };
  return {
    state,
    client: {
      installed: () => state.installed,
      connected: () => state.connected,
      desktop: () => state.desktop,
      session: () => (state.connected ? state.session : null),
      locked: () => (state.connected ? state.locked : null),
      setActive: async (active) => {
        state.active = active;
      },
      sendInput: async (command) => {
        if (state.hang) await new Promise(() => {});
        state.sent.push(command);
      },
      setVideoRun: (epoch) => state.runs.push(epoch),
      ownedElsewhere: () => state.ownedElsewhere,
      mintVideoRun: () => ++state.minted,
      onHold: () => () => {},
      sendGrant: async (grant) => {
        state.grants.push(grant);
      },
      installState: async () => state.installState,
      requestInstall: async (controllerKey) => {
        state.installs.push(controllerKey);
        if (state.installResult instanceof Error) throw state.installResult;
        return state.installResult;
      },
      ensureRunning: async () => {
        state.ensures += 1;
        if (state.service instanceof Error) throw state.service;
        return state.service;
      },
      latestFrame: () => null,
      onFrame: (listener) => listen(frameListeners, listener),
      onDesktopChanged: (listener) => listen(desktopListeners, listener),
      onGrantChallenge: (listener) => listen(challengeListeners, listener),
      onHelperIssue: (listener) => listen(issueListeners, listener),
      dispose: () => {},
    },
    emitFrame(frame) {
      for (const listener of frameListeners) listener(frame);
    },
    emitDesktop(desktop) {
      state.desktop = desktop;
      for (const listener of desktopListeners) listener(desktop);
    },
    emitChallenge(challenge) {
      for (const listener of challengeListeners) listener(challenge);
    },
    emitIssue(code) {
      for (const listener of issueListeners) listener(code);
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
  // `over.sharedSecure` / `over.lease`: one helper several sessions share,
  // each through its own lease.
  const secure = over.sharedSecure ?? mockSecureDesktop(over.secure);
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
    clientId: over.clientId ?? 'client-a',
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
    secureDesktop: over.lease ?? secure.client,
    pcAccess: over.pcAccess,
    indicator: indicator.indicator,
    log: (event) => log.push(event),
    sampleCursor: over.sampleCursor,
    maxFrameRate: over.maxFrameRate,
  });
  /** Channel pushes the adapter made, as [sourceKey, message]. */
  const pushes = [];
  /** Pictures and track switches it asked of the sender. */
  const sink = [];
  // The WebRTC side drives viewer leave / disconnect and demote through this.
  const adapter = createScreenWebrtcSource(source, {
    screenId: '1',
    sink: {
      geometryChanged() {},
      captureChanged() {},
      frame: (key, picture) => sink.push(['frame', key, picture]),
      drawnTrack: (key, drawn) => sink.push(['drawn', key, drawn]),
      channelPush: (key, message) => pushes.push([key, message]),
    },
  });
  /** Logged drops, as [backend, count]. */
  const dropped = () =>
    log.filter((event) => event.type === 'release-dropped').map((event) => [event.backend, event.count]);
  return { source, adapter, displays, host, secure, indicator, log, auth, dropped, pushes, sink };
}

test('helper video: switched in place; control needs this run delivered and seen; a stall, a lost channel or a path change withdraws it', async (t) => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  const { geometry } = await env.source.start();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const control = () => env.source.status().control;
  const switches = () => env.sink.filter(([kind]) => kind === 'drawn').map(([, key, drawn]) => [key, drawn]);
  const pictures = () => env.sink.filter(([kind]) => kind === 'frame').map(([, , picture]) => picture);
  const helperFrame = {
    width: 1920,
    height: 1080,
    stride: 1920 * 4,
    originX: 0,
    originY: 0,
    pixels: new Uint8Array(1920 * 1080 * 4),
  };
  const videos = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-video').map(([, message]) => message);
  const video = (epoch, path) => ({ v: 1, kind: 'screen-video', epoch, path });
  assert.deepEqual(switches(), [], 'the desktop capture while the ordinary desktop shows');
  assert.deepEqual(
    env.adapter.channelState().find((message) => message.kind === 'screen-video'),
    video(1, 'capture'),
    'a promoted channel hears the run'
  );

  // The lock screen: run 2 on the helper, the sender's track becomes the drawn one.
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await flush();
  assert.equal(env.source.videoPath(), 'helper');
  assert.deepEqual(switches(), [['screen:1', true]]);
  assert.deepEqual(videos(), [], 'a helper run is announced once its first frame is in the track');
  assert.equal(control(), false);

  // A helper frame goes to the sender as raw rows to crop and scale: nothing fitted in main.
  env.secure.emitFrame(helperFrame);
  const [picture] = pictures();
  assert.equal(picture.mimeType, 'image/x-bgrx');
  assert.equal(picture.epoch, 2);
  assert.equal(picture.geometry.generation, geometry.generation, 'same size, same generation');
  assert.equal(picture.pixels.buffer, helperFrame.pixels.buffer, 'the helper’s own bytes');
  assert.deepEqual(picture.source, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(picture.target, { x: 0, y: 0, width: 1920, height: 1080 });
  // At most one per frame interval of the stream (30 fps: 33.3 ms).
  env.secure.emitFrame(helperFrame);
  assert.equal(pictures().length, 1);
  t.mock.timers.tick(34);
  env.secure.emitFrame(helperFrame);
  assert.equal(pictures().length, 2);

  // A seen before the announcement is no evidence.
  env.adapter.frameSeen(2);
  assert.equal(control(), false);
  // Delivered into the track: announced, yet the local pipeline alone grants nothing.
  env.adapter.delivered(2);
  assert.deepEqual(videos(), [video(2, 'helper')]);
  assert.equal(control(), false);
  env.adapter.frameSeen(1);
  assert.equal(control(), false, 'a seen of another run');
  // The phone rendered a frame of run 2: control.
  env.adapter.frameSeen(2);
  assert.equal(control(), true);
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'applied');

  // Deliveries at the helper's cadence keep the watchdog quiet.
  for (let i = 0; i < 5; i += 1) {
    t.mock.timers.tick(HELPER_FRAME_INTERVAL_MS);
    env.adapter.delivered(2);
  }
  const bound = helperVideoStallMs([66, 66, 66, 66, 66]);
  assert.equal(bound, 216, 'max(3 × 66, 66 + 150)');
  t.mock.timers.tick(bound - 1);
  assert.equal(control(), true);
  // The pipeline stalls: run 3 starts, control is withdrawn at once and the key lifted.
  t.mock.timers.tick(1);
  assert.equal(control(), false);
  await flush();
  assert.ok(
    env.secure.state.sent.some((command) => isKeyUp(command)),
    'released through the helper'
  );
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'rejected');
  // Run 2's late delivery and seen count for nothing; run 3 needs both again.
  env.adapter.delivered(2);
  env.adapter.frameSeen(2);
  assert.deepEqual(videos(), [video(2, 'helper')]);
  assert.equal(control(), false);
  env.adapter.delivered(3);
  assert.deepEqual(videos().at(-1), video(3, 'helper'));
  assert.equal(control(), false);
  env.adapter.frameSeen(3);
  assert.equal(control(), true);

  // The channel goes (demote): run 4, which the next channel must see for itself.
  await env.adapter.release();
  assert.equal(control(), false);
  assert.equal(
    env.adapter.channelState().some((message) => message.kind === 'screen-video'),
    false,
    'not announced before its first frame'
  );
  env.adapter.delivered(4);
  env.adapter.frameSeen(4);
  assert.equal(control(), true);

  // Back on the ordinary desktop: run 5 on the capture, announced at once.
  env.host.control.reachable = true;
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await flush();
  assert.equal(env.source.videoPath(), 'capture');
  assert.deepEqual(switches(), [
    ['screen:1', true],
    ['screen:1', false],
  ]);
  assert.deepEqual(videos().at(-1), video(5, 'capture'));
  t.mock.timers.tick(34);
  env.secure.emitFrame(helperFrame);
  assert.equal(pictures().length, 2, 'no helper picture outside the helper path');
  await env.source.stop('user');
});

test('an acknowledgement or a seen from an earlier run never grants control in a later one', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  await env.source.start();
  const lock = { inputDesktop: null, consent: false, logonUi: true };
  // Run 2 on the helper: a frame is handed over, its acknowledgement still pending.
  env.host.emitDesktop(lock);
  await tick();
  env.secure.emitFrame({
    width: 1920,
    height: 1080,
    stride: 7680,
    originX: 0,
    originY: 0,
    pixels: new Uint8Array(7680 * 1080),
  });
  const pending = env.sink.filter(([kind]) => kind === 'frame').at(-1)[2];
  assert.equal(pending.epoch, 2);
  // To the capture (run 3) and back to the helper (run 4).
  env.host.control.reachable = true;
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await tick();
  env.host.control.reachable = false;
  env.host.emitDesktop(lock);
  await tick();
  // The old frame's ok acknowledgement lands now, then a seen for run 4.
  env.adapter.delivered(pending.epoch);
  env.adapter.frameSeen(4);
  assert.equal(env.source.status().control, false);
  assert.equal(
    env.pushes.some(([, message]) => message.kind === 'screen-video' && message.epoch === 4),
    false,
    'run 4 is not announced by run 2’s frame'
  );
  await env.source.stop('user');
});

const NONCE = Buffer.alloc(16, 1).toString('base64');
const CHALLENGE = Buffer.alloc(16, 2).toString('base64');
const SIGNATURE = Buffer.alloc(64, 3).toString('base64');
const CONTROLLER_KEY = Buffer.from([4, ...new Array(64).fill(7)]).toString('base64url');

test('helper grants: each challenge goes to the phone with the current run, only a grant for the current run is relayed, every run is declared', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  env.adapter.start();
  await flush();
  const challenges = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-helper-challenge').map(([, message]) => message);
  const grant = (epoch) => ({ epoch, challenge: CHALLENGE, signature: SIGNATURE });
  assert.deepEqual(env.secure.state.runs, [1], 'the first run, once the session runs');
  env.secure.emitChallenge({ nonce: NONCE, challenge: CHALLENGE });
  assert.deepEqual(challenges(), [
    { v: 1, kind: 'screen-helper-challenge', epoch: 1, nonce: NONCE, challenge: CHALLENGE },
  ]);
  assert.equal(
    env.adapter.channelState().some((message) => message.kind === 'screen-helper-challenge'),
    false,
    'never in the promotion snapshot'
  );

  // The lock screen: run 2 on the helper, declared at once.
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await flush();
  assert.deepEqual(env.secure.state.runs, [1, 2]);
  env.secure.emitChallenge({ nonce: NONCE, challenge: CHALLENGE });
  assert.equal(challenges().at(-1).epoch, 2);
  // Signed for run 1: not relayed. For run 2: relayed as it came.
  env.adapter.helperGrant(grant(1));
  await flush();
  assert.deepEqual(env.secure.state.grants, []);
  env.adapter.helperGrant(grant(2));
  await flush();
  assert.deepEqual(env.secure.state.grants, [grant(2)]);

  // The channel goes: run 3, declared; run 2's grant is no longer relayed.
  await env.adapter.release();
  assert.deepEqual(env.secure.state.runs, [1, 2, 3]);
  env.adapter.helperGrant(grant(2));
  await flush();
  assert.equal(env.secure.state.grants.length, 1);

  // A malformed challenge never reaches the phone.
  for (const nonce of [
    'AAAA',
    NONCE.replace('==', ''),
    Buffer.alloc(17).toString('base64'),
    Buffer.alloc(16, 0xff).toString('base64url'),
  ]) {
    env.secure.emitChallenge({ nonce, challenge: CHALLENGE });
  }
  assert.equal(challenges().length, 2);

  // After the session nothing passes either way.
  await env.source.stop('user');
  env.secure.emitChallenge({ nonce: NONCE, challenge: CHALLENGE });
  env.adapter.helperGrant(grant(3));
  await flush();
  assert.equal(challenges().length, 2);
  assert.equal(env.secure.state.grants.length, 1);
});

test('two sessions, one helper: the holder’s runs and grants only; the other reads in-use without control; the hold passes when the holder ends', async () => {
  const secure = mockSecureDesktop({ installed: true, connected: true, desktop: 'winlogon' });
  const helper = createSecureDesktopHelper({
    adapter: () => secure.client,
    installer: {
      state: async () => 'installed',
      request: async () => ({ outcome: 'installed', state: 'installed' }),
      ensureRunning: async () => ({ installed: true, running: true }),
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const [first, second] = [0, 1].map(() => build({ sharedSecure: secure, lease: helper.lease() }));
  for (const env of [first, second]) {
    env.host.control.reachable = false;
    env.adapter.start();
  }
  await flush();
  const grant = (epoch) => ({ epoch, challenge: CHALLENGE, signature: SIGNATURE });
  const challenges = (env) => env.pushes.filter(([, message]) => message.kind === 'screen-helper-challenge');
  assert.deepEqual(secure.state.runs, [], 'nobody holds it: no run declared');

  // The lock screen: the first session to activate the helper holds it.
  first.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await flush();
  const firstRun = secure.state.runs.at(-1);
  assert.deepEqual(secure.state.runs, [firstRun], 'its run, declared');
  assert.equal(first.source.status().helper, 'active');
  second.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await flush();
  assert.deepEqual(second.source.status(), {
    state: 'secure-desktop',
    reason: 'lock',
    helper: 'in-use',
    control: false,
    helperInfo: second.source.status().helperInfo,
  });
  assert.deepEqual(secure.state.runs, [firstRun], 'the waiting session declares nothing');
  assert.equal(secure.state.active, true);

  // Challenges reach the holder's phone only; the other's grant is dropped.
  secure.emitChallenge({ nonce: NONCE, challenge: CHALLENGE });
  assert.equal(challenges(first).length, 1);
  assert.equal(challenges(first)[0][1].epoch, firstRun, 'carrying the epoch the helper was given');
  assert.equal(challenges(second).length, 0);
  // Straight to the source (past the adapter's own run check): the lease refuses it.
  second.source.helperGrant(grant(firstRun));
  await flush();
  assert.deepEqual(secure.state.grants, [], 'cannot disturb the holder’s grant');
  first.adapter.helperGrant(grant(firstRun));
  await flush();
  assert.deepEqual(secure.state.grants, [grant(firstRun)]);
  // Its input can't reach the helper either.
  assert.equal(await second.source.handleInput(keyA, 1), 'rejected');
  assert.equal(secure.state.sent.length, 0);

  // The holder's session ends: the waiting one holds it, its run declared at
  // once (ending the first phone's grant), and the helper never went inactive.
  await first.source.stop('user');
  await flush();
  assert.equal(second.source.status().helper, 'active');
  const secondRun = secure.state.runs.at(-1);
  assert.ok(secondRun > firstRun, 'a fresh epoch from the one helper-wide counter');
  assert.equal(secure.state.active, true);
  secure.emitChallenge({ nonce: NONCE, challenge: CHALLENGE });
  assert.equal(challenges(second).at(-1)[1].epoch, secondRun, 'the epoch the helper was given');
  assert.equal(challenges(first).length, 1);
  // The first phone's grant (its run, an earlier challenge) is dead.
  first.source.helperGrant(grant(firstRun));
  await flush();
  assert.deepEqual(secure.state.grants, [grant(firstRun)]);
  second.adapter.helperGrant(grant(secondRun));
  await flush();
  assert.deepEqual(secure.state.grants, [grant(firstRun), grant(secondRun)]);
  await second.source.stop('user');
  await flush();
  assert.equal(secure.state.active, false, 'the last holder let go');
});

test('the install request is forwarded with the phone’s key; its outcome, detail and the offer reach the status', async () => {
  const env = build({ secure: { installState: 'not-installed' } });
  await env.source.start();
  await tick();
  const pushed = () =>
    env.pushes
      .filter(([, message]) => message.kind === 'screen-status')
      .map(([, message]) => message.status.helperInfo);
  const info = (over = {}) => ({ offer: 'install', outcome: null, detail: null, issue: null, secure: null, ...over });
  // The check answered while the start was in flight: its offer is in the
  // start's own status (sent at promotion), not a pushed change.
  assert.deepEqual(env.source.status().helperInfo, info(), 'the start check offers the install');
  const answer = async (result) => {
    env.secure.state.installResult = result;
    env.adapter.helperInstall(CONTROLLER_KEY);
    await tick();
  };
  await answer({ outcome: 'declined', state: 'not-installed' });
  assert.deepEqual(env.secure.state.installs, [CONTROLLER_KEY], 'with its key, as it came');
  assert.deepEqual(pushed().at(-1), info({ outcome: 'declined' }));
  await answer({ outcome: 'in-progress', state: 'not-installed', detail: 'x'.repeat(300) });
  assert.deepEqual(pushed().at(-1), info({ outcome: 'in-progress', detail: 'x'.repeat(256) }), 'the detail, bounded');
  await answer({ outcome: 'updated', state: 'installed' });
  assert.deepEqual(pushed().at(-1), info({ offer: 'none', outcome: 'updated' }));
  await answer(new Error('could not launch the bridge'));
  assert.deepEqual(pushed().at(-1), info({ offer: 'none', outcome: 'failed', detail: 'could not launch the bridge' }));

  // An answer to an earlier request is not applied over a later one's.
  let finish;
  env.secure.client.requestInstall = (controllerKey) => {
    env.secure.state.installs.push(controllerKey);
    return env.secure.state.installs.length === 5
      ? new Promise((resolve) => (finish = resolve))
      : Promise.resolve({ outcome: 'other-user', state: 'other-user' });
  };
  env.adapter.helperInstall(CONTROLLER_KEY);
  env.adapter.helperInstall(CONTROLLER_KEY);
  await tick();
  finish({ outcome: 'installed', state: 'installed' });
  await tick();
  assert.deepEqual(pushed().at(-1), info({ offer: 'none', outcome: 'other-user' }));

  await env.source.stop('user');
  env.adapter.helperInstall(CONTROLLER_KEY);
  assert.equal(env.secure.state.installs.length, 6, 'not after the session');
});

test('the phone’s Windows password goes to PC access, its outcome reaches the status, and the password is nowhere else', async () => {
  const calls = [];
  const state = { answer: { outcome: 'bad-credentials', state: 'not-enrolled' }, hold: null, admin: false };
  const pcAccess = {
    accountIsAdmin: async () => state.admin,
    approveWithCredential: async (request) => {
      // What PC access saw, copied: the source empties its own object after.
      const { signal, ...rest } = request;
      assert.ok(signal instanceof AbortSignal);
      calls.push({ ...rest, credential: { ...request.credential } });
      if (state.hold) await state.hold;
      if (state.answer instanceof Error) throw state.answer;
      return state.answer;
    },
  };
  const env = build({ secure: { installState: 'installed' }, pcAccess });
  await env.source.start();
  await tick();
  const infos = () =>
    env.pushes
      .filter(([, message]) => message.kind === 'screen-status')
      .map(([, message]) => message.status.helperInfo);
  assert.equal(env.source.status().helperInfo.accountIsAdmin, false, 'the PC says its account is not an administrator');

  const credential = { password: 'hunter2-secret', user: 'PC\\admin' };
  env.adapter.helperCredential(CONTROLLER_KEY, credential);
  await tick();
  assert.deepEqual(calls, [
    { clientId: 'client-a', publicKey: CONTROLLER_KEY, credential: { password: 'hunter2-secret', user: 'PC\\admin' } },
  ]);
  assert.deepEqual(credential, { password: '' }, 'the source emptied its copy once the call ended');
  assert.equal(infos().at(-1).outcome, 'bad-credentials');
  assert.equal(infos().at(-1).offer, 'update', 'the offer is relative to the phone’s key');
  assert.equal(infos().at(-1).accountIsAdmin, false);

  // The same answer again is pushed again: the phone waits for each one.
  const before = infos().length;
  env.adapter.helperCredential(CONTROLLER_KEY, { password: 'again-secret' });
  await tick();
  assert.equal(infos().length, before + 1);
  assert.equal(infos().at(-1).outcome, 'bad-credentials');

  // One at a time: a second request while one runs is dropped, its password emptied.
  let release;
  state.hold = new Promise((resolve) => (release = resolve));
  state.answer = { outcome: 'installed', state: 'installed' };
  env.adapter.helperCredential(CONTROLLER_KEY, { password: 'first-secret' });
  const second = { password: 'second-secret' };
  env.adapter.helperCredential(CONTROLLER_KEY, second);
  await tick();
  assert.equal(calls.length, 3, 'only the first of the two went on');
  assert.deepEqual(second, { password: '' });
  release();
  await tick();
  assert.deepEqual(infos().at(-1), { ...infos().at(-1), offer: 'none', outcome: 'installed' });
  state.hold = null;

  // The delegated path's own refusals are PC-side only: the phone reads `failed`.
  state.answer = { outcome: 'delegation-denied', state: 'installed', detail: 'x' };
  env.adapter.helperCredential(CONTROLLER_KEY, { password: 'p' });
  await tick();
  assert.equal(infos().at(-1).outcome, 'failed');
  state.answer = new Error('bridge could not run');
  env.adapter.helperCredential(CONTROLLER_KEY, { password: 'p' });
  await tick();
  assert.deepEqual([infos().at(-1).outcome, infos().at(-1).detail], ['failed', 'the request could not be completed']);

  // The password is in no message to the phone and no log line.
  const everything = JSON.stringify([env.pushes, env.log]);
  for (const secret of ['hunter2-secret', 'again-secret', 'first-secret', 'second-secret']) {
    assert.ok(!everything.includes(secret), secret);
  }
  assert.ok(!everything.includes('password'), 'no credential field in any outbound message');

  // Not paired, or after the session: nothing is asked of PC access, the password is emptied.
  const unpaired = { password: 'x' };
  env.auth.change({ paired: false });
  env.adapter.helperCredential(CONTROLLER_KEY, unpaired);
  await tick();
  assert.deepEqual(unpaired, { password: '' });
  await env.source.stop('user');
  const after = { password: 'y' };
  env.adapter.helperCredential(CONTROLLER_KEY, after);
  assert.deepEqual(after, { password: '' });
  assert.equal(calls.length, 5, 'nothing more reached PC access');
});

test('a session that ends takes its password request with it: the credential is wiped and the request cancelled, a dispatched one’s result is dropped', async () => {
  const seen = [];
  let release;
  const pcAccess = {
    accountIsAdmin: async () => true,
    // Queued behind other work: `signal` is how it learns the session ended.
    approveWithCredential: async (request) => {
      seen.push({ signal: request.signal, credential: request.credential });
      await new Promise((resolve) => (release = resolve));
      return { outcome: 'installed', state: 'installed' };
    },
  };

  // Stopped while the authorization is still queued.
  const queued = build({ secure: { installState: 'installed' }, pcAccess });
  await queued.source.start();
  await tick();
  const credential = { password: 'queued-secret', user: 'PC\\admin' };
  queued.adapter.helperCredential(CONTROLLER_KEY, credential);
  await tick();
  assert.equal(seen[0].signal.aborted, false);
  assert.equal(credential.password, 'queued-secret', 'still held while the session lives');
  await queued.source.stop('user');
  assert.equal(seen[0].signal.aborted, true, 'cancelled before the installer is reached');
  assert.deepEqual(credential, { password: '' }, 'wiped at the stop, not when the call settles');
  release();
  await tick();
  assert.deepEqual(
    queued.pushes.filter(
      ([, message]) => message.kind === 'screen-status' && message.status.helperInfo.outcome === 'installed'
    ),
    [],
    'a result for a session that ended is dropped'
  );
  assert.equal(queued.source.status().helperInfo.outcome, null);

  // Dispatched already (the call ignores the signal and finishes): same, nothing reported.
  const dispatched = build({ secure: { installState: 'installed' }, pcAccess });
  await dispatched.source.start();
  await tick();
  const second = { password: 'dispatched-secret' };
  dispatched.adapter.helperCredential(CONTROLLER_KEY, second);
  await tick();
  await dispatched.source.stop('user');
  assert.deepEqual(second, { password: '' });
  release();
  await tick();
  assert.equal(dispatched.source.status().helperInfo.outcome, null);
  assert.ok(!JSON.stringify([dispatched.pushes, dispatched.log, queued.pushes, queued.log]).includes('secret'));
});

test('no password reaches a status, a log or the console through an error text: a thrown error, a failed result that quotes its input', async (t) => {
  const consoleLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => consoleLines.push(args.map(String).join(' ')));
  }
  const PASSWORD = 'p@ss-leak-check';
  const USER = 'PC\\leak-admin';
  const answers = [
    () => Promise.reject(new Error(`bridge failed for ${USER} with ${PASSWORD}`)),
    () => Promise.resolve({ outcome: 'failed', state: 'installed', detail: `could not log on ${USER}:${PASSWORD}` }),
    () => Promise.resolve({ outcome: 'bad-credentials', state: 'installed', detail: 'the logon was refused' }),
  ];
  const pcAccess = { accountIsAdmin: async () => false, approveWithCredential: async () => answers.shift()() };
  const env = build({ secure: { installState: 'installed' }, pcAccess });
  await env.source.start();
  await tick();
  for (let index = 0; index < 3; index++) {
    env.adapter.helperCredential(CONTROLLER_KEY, { password: PASSWORD, user: USER });
    await tick();
  }
  const info = env.source.status().helperInfo;
  assert.deepEqual(
    [info.outcome, info.detail],
    ['bad-credentials', 'the logon was refused'],
    'an innocent detail still passes'
  );
  const everything = JSON.stringify([env.pushes, env.log, env.source.status(), consoleLines]);
  for (const secret of [PASSWORD, USER, 'leak-admin']) assert.ok(!everything.includes(secret), secret);
  // The first two answers were told as fixed lines.
  const details = env.pushes
    .filter(([, message]) => message.kind === 'screen-status')
    .map(([, message]) => message.status.helperInfo.detail)
    .filter(Boolean);
  assert.deepEqual(details.slice(0, 2), ['the request could not be completed', 'the request failed']);
});

test('two phones asking at once: the PC-wide busy refusal keeps the second one’s action, and it can retry whether the first succeeded or failed', async () => {
  const KEY_B = Buffer.from([4, ...new Array(64).fill(8)]).toString('base64url');
  for (const firstFails of [false, true]) {
    let release;
    const installer = {
      installState: 'not-installed',
      enrolled: new Set(),
      gate: new Promise((resolve) => (release = resolve)),
      fail: firstFails,
      async state(key) {
        if (key === undefined || installer.installState !== 'installed') return installer.installState;
        return installer.enrolled.has(key) ? 'installed' : 'not-enrolled';
      },
      async install(keys) {
        await installer.gate;
        if (installer.fail) return { outcome: 'bad-credentials', state: installer.installState };
        installer.installState = 'installed';
        installer.enrolled = new Set(keys);
        return { outcome: 'installed', state: 'installed' };
      },
      enroll: async () => ({ outcome: 'enrolled', state: 'installed' }),
      revoke: async () => ({ outcome: 'revoked', state: 'installed' }),
    };
    const access = createPcAccess({
      installer,
      pending: {
        read: async () => ({ keys: [], unknown: null }),
        add: async () => {},
        markUnknown: async () => {},
        settle: async () => {},
      },
      keys: async () => [
        { clientId: 'client-a', publicKey: CONTROLLER_KEY, unpaired: false },
        { clientId: 'client-b', publicKey: KEY_B, unpaired: false },
      ],
      owed: async () => ({ keys: [], unknown: 0 }),
      settleOwed: async () => {},
    });
    const pcAccess = { accountIsAdmin: async () => true, approveWithCredential: access.approveWithCredential };
    const first = build({ clientId: 'client-a', secure: { installState: 'not-installed' }, pcAccess });
    const second = build({ clientId: 'client-b', secure: { installState: 'not-installed' }, pcAccess });
    await first.source.start();
    await second.source.start();
    await tick();
    const panelOf = (env) => screenHelperPanel(env.source.status().helperInfo, false);

    first.adapter.helperCredential(CONTROLLER_KEY, { password: 'first-pw' });
    await tick();
    second.adapter.helperCredential(KEY_B, { password: 'second-pw' });
    await tick();
    // Refused only because the first is running: not "in progress" for this phone.
    assert.equal(second.source.status().helperInfo.outcome, 'busy');
    assert.equal(panelOf(second).action, 'install', 'the button stays');
    assert.deepEqual(panelOf(second).lines, [{ kind: 'copy', id: 'busy' }]);

    // The first ends, one way or the other.
    release();
    await tick();
    assert.equal(first.source.status().helperInfo.outcome, firstFails ? 'bad-credentials' : 'installed');
    assert.equal(panelOf(second).action, 'install', 'still there when the first has finished');

    // The second asks again, and is answered for itself.
    installer.fail = false;
    second.adapter.helperCredential(KEY_B, { password: 'second-pw' });
    await tick();
    const done = second.source.status().helperInfo;
    assert.equal(done.outcome, firstFails ? 'installed' : 'enrolled');
    assert.equal(done.offer, 'none');
    assert.equal(panelOf(second).action, null, 'done: nothing left to offer');
    await first.source.stop('user');
    await second.source.stop('user');
  }
});

test('a password request with no PC access is answered unavailable; an unknown admin account is not claimed', async () => {
  const env = build({
    secure: { installState: 'installed' },
    pcAccess: undefined,
  });
  await env.source.start();
  await tick();
  assert.equal('accountIsAdmin' in env.source.status().helperInfo, false);
  const credential = { password: 'secret', user: 'u' };
  env.adapter.helperCredential(CONTROLLER_KEY, credential);
  await tick();
  assert.equal(env.source.status().helperInfo.outcome, 'unavailable');
  assert.deepEqual(credential, { password: '' });

  const unknown = build({
    secure: { installState: 'installed' },
    pcAccess: {
      accountIsAdmin: async () => null,
      approveWithCredential: async () => ({ outcome: 'enrolled', state: 'installed' }),
    },
  });
  await unknown.source.start();
  await tick();
  assert.equal('accountIsAdmin' in unknown.source.status().helperInfo, false, 'absent, not false');
  const failing = build({
    secure: { installState: 'installed' },
    pcAccess: {
      accountIsAdmin: async () => Promise.reject(new Error('x')),
      approveWithCredential: async () => ({ outcome: 'enrolled', state: 'installed' }),
    },
  });
  await failing.source.start();
  await tick();
  assert.equal('accountIsAdmin' in failing.source.status().helperInfo, false);
});

test('a stopped service (after a reboot) is started at session start and when the helper is needed; one that can’t start shows as failed', async () => {
  // A current install, its service not running: nothing connects.
  const env = build({
    secure: {
      installed: true,
      connected: false,
      installState: 'installed',
      service: { installed: true, running: false },
    },
  });
  await env.source.start();
  await tick();
  assert.equal(env.secure.state.ensures, 1, 'at session start');
  assert.equal(env.source.status().helper, 'failed');
  assert.equal(env.source.status().state, 'live', 'the ordinary desktop is unaffected');

  // The lock screen needs the helper: started again, and now it runs.
  env.secure.state.service = { installed: true, running: true };
  env.host.control.reachable = false;
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  assert.equal(env.secure.state.ensures, 2, 'when the helper is needed');
  assert.equal(env.secure.state.active, true);
  assert.equal(env.source.status().helper, 'starting', 'running: the adapter reaches it on its next dial');
  const pushed = env.pushes
    .filter(([, message]) => message.kind === 'screen-status')
    .map(([, message]) => message.status.helper);
  assert.equal(pushed.at(-1), 'starting', 'pushed to the phone');

  // It connects: active, and nothing more is started.
  env.secure.state.connected = true;
  env.secure.emitDesktop('winlogon');
  await tick();
  assert.equal(env.source.status().helper, 'active');
  assert.equal(env.secure.state.ensures, 2);
  await env.source.stop('user');

  // An attempt that rejects could not bring it up either.
  const rejected = build({
    secure: { installed: true, connected: false, installState: 'installed', service: new Error('start failed') },
  });
  await rejected.source.start();
  await tick();
  assert.equal(rejected.secure.state.ensures, 1);
  assert.equal(rejected.source.status().helper, 'failed');
  await rejected.source.stop('user');

  // Not for an install that isn't current (the offer covers it), nor while connected.
  for (const secure of [
    { installed: false, installState: 'not-installed' },
    { installed: true, installState: 'outdated' },
    { installed: true, connected: true, desktop: 'default', installState: 'installed' },
  ]) {
    const other = build({ secure });
    await other.source.start();
    await tick();
    assert.equal(other.secure.state.ensures, 0, JSON.stringify(secure));
    await other.source.stop('user');
  }
});

test('helper issues: the phone hears the listed codes while the helper is active, until what they report ends', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'default' } });
  await env.source.start();
  const issue = () => env.source.status().helperInfo.issue;
  const pushedIssue = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-status').at(-1)[1].status.helperInfo.issue;
  env.secure.emitIssue('input_failed');
  assert.equal(issue(), null, 'not while this session has the helper inactive');

  // The lock screen: the helper serves.
  env.host.control.reachable = false;
  env.secure.state.desktop = 'winlogon';
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  for (const code of [
    'grant_key_missing',
    'grant_expired',
    'input_failed',
    'desktop_unavailable',
    'sas_disabled_by_policy',
  ]) {
    env.secure.emitIssue(code);
    assert.equal(issue(), code);
    assert.equal(pushedIssue(), code, 'pushed');
  }
  env.secure.emitIssue('grant_bad_signature');
  env.secure.emitIssue('capture_failed');
  assert.equal(issue(), 'sas_disabled_by_policy', 'other codes are not the phone’s');

  // The helper's desktop changed: a report about the desktop ends …
  env.secure.emitDesktop('winlogon');
  assert.equal(issue(), null);
  // … the missing key stands while connected, and ends with the connection.
  env.secure.emitIssue('grant_key_missing');
  env.secure.emitDesktop('winlogon');
  assert.equal(issue(), 'grant_key_missing');
  env.secure.state.connected = false;
  env.secure.emitDesktop(null);
  assert.equal(issue(), null);
  env.secure.state.connected = true;
  env.secure.emitDesktop('winlogon');
  await tick();

  // A lapsed grant ends once the next grant for the run was relayed.
  env.secure.emitIssue('grant_expired');
  env.adapter.helperGrant({ epoch: env.secure.state.runs.at(-1), challenge: CHALLENGE, signature: SIGNATURE });
  await tick();
  assert.equal(env.secure.state.grants.length, 1);
  assert.equal(issue(), null);

  // Deactivated (the ordinary desktop again): it ends, and the helper's own
  // lapse report after it is not the phone's concern.
  env.secure.emitIssue('input_failed');
  env.host.control.reachable = true;
  env.secure.state.desktop = 'default';
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await tick();
  assert.equal(env.secure.state.active, false);
  assert.equal(issue(), null);
  env.secure.emitIssue('grant_expired');
  assert.equal(issue(), null);
  await env.source.stop('user');
});

test('lock screen vs UAC: the helper’s lock state decides before LogonUI', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon', locked: false } });
  env.host.control.reachable = false;
  await env.source.start();
  // LogonUI runs, but the helper reports the session unlocked: the consent prompt.
  env.host.emitDesktop({ inputDesktop: null, consent: true, logonUi: true });
  await tick();
  assert.equal(env.source.status().reason, 'uac');
  assert.equal(env.source.status().helperInfo.secure, 'uac');
  // A change of the lock state alone arrives as a desktop change.
  env.secure.state.locked = true;
  env.secure.emitDesktop('winlogon');
  assert.equal(env.source.status().reason, 'lock');
  assert.equal(env.source.status().helperInfo.secure, 'lock');
  await env.source.stop('user');
});

const CTRL = { vk: 0xa2, scan: 0x1d, extended: false };
const KEY_C = { vk: 0x43, scan: 0x2e, extended: false };

test('a key combo is injected atomically: in order, then released in reverse', async () => {
  const env = build();
  const { geometry } = await env.source.start();
  assert.equal(
    await env.source.handleInput({ type: 'screen-keys', keys: [CTRL, KEY_C] }, geometry.generation),
    'applied'
  );
  assert.deepEqual(
    env.host.commands.map((command) => [command.vk, command.down]),
    [
      [0xa2, true],
      [0x43, true],
      [0x43, false],
      [0xa2, false],
    ]
  );
  // Without control (an in-place elevation prompt, no helper) nothing is sent.
  env.host.emitDesktop({ inputDesktop: 'Default', consent: true, logonUi: false });
  await tick();
  env.host.commands.length = 0;
  assert.equal(
    await env.source.handleInput({ type: 'screen-keys', keys: [CTRL, KEY_C] }, geometry.generation),
    'rejected'
  );
  assert.deepEqual(env.host.commands, []);
  await env.source.stop('user');
});

test('the status is pushed on each change, and a promoted channel gets the current one', async () => {
  const env = build();
  await env.source.start();
  const statuses = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-status').map(([, message]) => message.status);
  const before = statuses().length;
  env.host.emitDesktop({ inputDesktop: 'Default', consent: true, logonUi: false });
  await tick();
  const prompt = {
    state: 'elevation-prompt',
    reason: 'uac',
    helper: 'missing',
    control: false,
    helperInfo: { offer: 'none', outcome: null, detail: null, issue: null, secure: 'uac' },
  };
  assert.deepEqual(statuses().slice(before), [prompt]);
  assert.deepEqual(env.adapter.channelState(), [
    { v: 1, kind: 'screen-status', status: prompt },
    { v: 1, kind: 'screen-video', epoch: 1, path: 'capture' },
  ]);
  assert.equal(
    env.pushes.every(([key]) => key === 'screen:1'),
    true
  );
  await env.source.stop('user');
  assert.equal(statuses().at(-1).state, 'stopped', 'the stop is pushed too');
});

test('the cursor is sampled once per frame interval, in video pixels, and pushed only on change', async (t) => {
  // The sampling interval on the mock clock: the cadence is checked exactly,
  // whatever the machine's load.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = build({
    sampleCursor: true,
    maxFrameRate: 100,
    displays: [{ ...display, physical: { x: -3840, y: 0, width: 3840, height: 2160 } }],
  });
  env.host.control.cursor = [-3840 + 1920, 1080];
  const { geometry } = await env.source.start();
  const cursors = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-cursor').map(([, message]) => message);
  const reads = () => env.host.control.cursorReads ?? 0;
  /** Advance the clock and let the read it started complete. */
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await tick();
  };
  // 100 fps: one read per 10 ms frame interval.
  await advance(9);
  assert.equal(reads(), 0, 'not before the first interval');
  await advance(1);
  assert.equal(reads(), 1);
  // 3840×2160 physical streams as 3840×2160 video pixels (within the bound).
  assert.deepEqual(cursors(), [{ v: 1, kind: 'screen-cursor', x: 1920, y: 1080, generation: geometry.generation }]);
  await advance(10);
  await advance(10);
  assert.equal(reads(), 3, 'sampled once per interval');
  assert.equal(cursors().length, 1, 'sampled again, but unchanged positions are not pushed');
  // x ≥ 0 is the display to the right of this one.
  env.host.control.cursor = [10, 5];
  await advance(10);
  assert.equal(reads(), 4);
  assert.equal(cursors().length, 1, 'a cursor on another display is not pushed');
  env.host.control.cursor = [-3840, 0];
  await advance(10);
  assert.deepEqual(cursors().at(-1), { v: 1, kind: 'screen-cursor', x: 0, y: 0, generation: geometry.generation });
  assert.deepEqual(env.adapter.channelState().at(-1), cursors().at(-1), 'a promoted channel gets the last one');
  assert.deepEqual(env.host.control.attempts, [], 'sampling injects nothing');
  await env.source.stop('user');
  const before = reads();
  await advance(10);
  await advance(10);
  assert.equal(reads(), before, 'sampling ends with the session');
  assert.equal(env.source.cursor(), null);
});

test('the indicator is told which display is viewed', async () => {
  const env = build();
  const views = [];
  const show = env.indicator.indicator.show;
  env.indicator.indicator.show = (view) => {
    views.push(view.screenId);
    show(view);
  };
  await env.source.start();
  assert.deepEqual(views, ['1']);
  await env.source.stop('user');
});

/** A control session holding A and the left button on the ordinary desktop. */
async function holdingOnDesktop() {
  const env = build();
  const { geometry } = await env.source.start();
  await env.source.handleInput(keyA, geometry.generation);
  await env.source.handleInput(
    { type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 },
    geometry.generation
  );
  return env;
}

/** A control session on the lock screen through the helper, holding A there. */
async function holdingOnHelper() {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  const { geometry } = await env.source.start();
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  env.source.setHelperVideo(true);
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'applied');
  return env;
}

test('on the helper path control waits for the helper video to reach the viewer, and ends with it', async () => {
  const env = build({ secure: { installed: true, connected: true, desktop: 'winlogon' } });
  env.host.control.reachable = false;
  const { geometry } = await env.source.start();
  const lastPushed = () => env.pushes.filter(([, message]) => message.kind === 'screen-status').at(-1)[1].status;
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  // Helper attached, no video: view-blocked, not blind control.
  assert.deepEqual(lastPushed(), {
    state: 'secure-desktop',
    reason: 'lock',
    helper: 'active',
    control: false,
    helperInfo: { offer: 'none', outcome: null, detail: null, issue: null, secure: 'lock' },
  });
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'rejected');
  assert.deepEqual(env.secure.state.sent, []);
  // The video starts: control.
  env.source.setHelperVideo(true);
  assert.equal(lastPushed().control, true);
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'applied');
  assert.deepEqual(
    env.secure.state.sent.map((command) => [command.vk, command.down]),
    [[0x41, true]]
  );
  // The video stops: control is withdrawn at once and the held key lifted.
  env.source.setHelperVideo(false);
  assert.equal(lastPushed().control, false);
  assert.equal(await env.source.handleInput(keyA, geometry.generation), 'rejected');
  await tick();
  assert.deepEqual(
    env.secure.state.sent.map((command) => [command.vk, command.down]),
    [
      [0x41, true],
      [0x41, false],
    ],
    'released through the helper'
  );
  assert.equal(
    await env.source.handleInput({ type: 'screen-release' }, geometry.generation),
    'applied',
    'releases go through'
  );
  // Leaving the helper clears the report: the next helper period waits for its own.
  env.source.setHelperVideo(true);
  env.host.control.reachable = true;
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  await tick();
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  await tick();
  assert.equal(env.source.status().control, false);
  // A report outside the helper path counts for nothing.
  const off = build({ secure: { installed: true, connected: true, desktop: 'default' } });
  await off.source.start();
  off.source.setHelperVideo(true);
  off.secure.state.desktop = 'winlogon';
  off.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  assert.equal(off.source.status().state, 'secure-desktop');
  assert.equal(off.source.status().control, false);
  await Promise.all([env.source.stop('user'), off.source.stop('user')]);
});

test('a cursor read in flight across a switch to the helper is dropped; no cursor is offered while it serves', async () => {
  const env = build({
    sampleCursor: true,
    maxFrameRate: 100,
    secure: { installed: true, connected: true, desktop: 'default' },
  });
  env.host.control.cursor = [100, 200];
  const { geometry } = await env.source.start();
  const cursors = () =>
    env.pushes.filter(([, message]) => message.kind === 'screen-cursor').map(([, message]) => message);
  const offered = () => env.adapter.channelState().some((message) => message.kind === 'screen-cursor');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(cursors(), [{ v: 1, kind: 'screen-cursor', x: 100, y: 200, generation: geometry.generation }]);
  assert.equal(offered(), true);
  // Hold the next read in flight, then switch to the helper's capture.
  let open;
  env.host.control.cursorGate = new Promise((resolve) => {
    open = resolve;
  });
  const reads = env.host.control.cursorReads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.host.control.cursorReads, reads + 1, 'one read in flight');
  env.secure.state.desktop = 'winlogon';
  env.host.emitDesktop({ inputDesktop: null, consent: false, logonUi: true });
  assert.equal(env.source.cursor(), null);
  assert.equal(offered(), false, 'the promotion snapshot has no cursor while the helper serves');
  // The read completes after the switch, with the cursor moved: dropped.
  env.host.control.cursor = [300, 400];
  env.host.control.cursorGate = null;
  open();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cursors().length, 1, 'the late read is not pushed');
  assert.equal(offered(), false);
  assert.equal(env.host.control.cursorReads, reads + 1, 'no reads while the helper serves');
  // Back on the ordinary desktop: the old position was cleared, a new sample comes.
  env.secure.state.desktop = 'default';
  env.host.emitDesktop({ inputDesktop: 'Default', consent: false, logonUi: false });
  assert.equal(env.source.cursor(), null, 'the cached cursor was cleared at the switch');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(cursors().at(-1), { v: 1, kind: 'screen-cursor', x: 300, y: 400, generation: geometry.generation });
  await env.source.stop('user');
});

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
    assert.ok(
      onDesktop.host.commands.some((c) => isKeyUp(c)),
      'key-up through the input host'
    );
    assert.ok(
      onDesktop.host.commands.some((c) => c.op === 'button' && c.down === false),
      'button-up through the input host'
    );
    assert.deepEqual(onDesktop.secure.state.sent, [], 'nothing through the helper');
    assert.deepEqual(onDesktop.dropped(), []);

    const onHelper = await holdingOnHelper();
    await run(onHelper);
    assert.ok(
      onHelper.secure.state.sent.some((c) => isKeyUp(c)),
      'key-up through the helper'
    );
    assert.ok(!onHelper.host.control.attempts.some((c) => isKeyUp(c)), 'nothing through the input host');
    assert.deepEqual(onHelper.dropped(), []);
  });
}

test('start is denied when the client is not paired and connected', async () => {
  const unpaired = build({ auth: { paired: false } });
  await assert.rejects(
    unpaired.source.start(),
    (error) => error instanceof ScreenSourceDenied && error.reason === 'unauthorized'
  );
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
  await env.source.handleInput(
    { type: 'screen-key', action: 'down', vk: 0xa0, scan: 0x2a, extended: false },
    generation
  );
  env.host.commands.length = 0;

  await env.source.stop('user');
  const ops = env.host.commands;
  assert.ok(
    ops.some((c) => c.op === 'button' && c.down === false),
    'the held button was released'
  );
  assert.ok(
    ops.some((c) => c.op === 'key' && c.down === false),
    'the held key was released'
  );
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
  assert.equal(latest.control, false, 'no control before the helper video reaches the viewer');
  await tick();
  assert.equal(env.secure.state.active, true);
  // The sender reports the helper video reaching the viewer.
  env.source.setHelperVideo(true);
  assert.equal(statuses.at(-1).control, true);

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
  const outcome = await env.source.handleInput(
    { type: 'screen-pointer', action: 'move', x: 1, y: 1 },
    result.geometry.generation
  );
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
  await env.source.handleInput(
    { type: 'screen-key', action: 'down', vk: 0x41, scan: 0x1e, extended: false },
    result.geometry.generation
  );
  env.host.commands.length = 0;

  // The pairing is gone before its change signal arrives.
  env.auth.paired = false;
  const outcome = await env.source.handleInput({ type: 'screen-release' }, result.geometry.generation);
  assert.equal(outcome, 'applied');
  assert.ok(
    env.host.commands.some((c) => c.op === 'key' && c.down === false),
    'the key was released despite the revoke'
  );
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
  assert.ok(
    env.host.commands.some((c) => isKeyUp(c)),
    'the held key was lifted'
  );
  assert.equal(await env.source.handleInput(keyA, result.geometry.generation), 'rejected');
  assert.equal(env.log.at(-1).type, 'stop');
});

test('a demote releases held input; release stays idempotent', async () => {
  const env = build();
  const result = await env.source.start();
  await env.source.handleInput(
    { type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 },
    result.geometry.generation
  );
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
  assert.ok(
    env.secure.state.sent.some((c) => isKeyUp(c)),
    'the helper lifted its own press'
  );
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
  assert.deepEqual(env.log.at(-1), {
    type: 'release-dropped',
    clientId: 'client-a',
    screenId: '1',
    backend: 'desktop',
    count: 2,
  });
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
  const frame = {
    width: 1920,
    height: 1080,
    stride: 1920 * 4,
    originX: 0,
    originY: 0,
    pixels: new Uint8Array(1920 * 1080 * 4),
  };
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
