import assert from 'node:assert/strict';
import test from 'node:test';

import { screenSpecialKeyInputs } from './remote-screen-keys.ts';
import {
  chooseScreenEntry,
  installScreenReleaseTriggers,
  readScreenDisplays,
  screenInputAllowed,
  screenKeyboardBar,
  screenView,
} from './remote-screen-state.ts';

const display = (screenId, extra = {}) => ({
  screenId,
  label: screenId,
  primary: false,
  pixelWidth: 1920,
  pixelHeight: 1080,
  scaleFactor: 1,
  ...extra,
});
const status = (state, extra = {}) => ({ state, helper: 'missing', control: state === 'live', ...extra });

test('the monitor picker appears only for two or more displays', () => {
  assert.deepEqual(chooseScreenEntry([]), { kind: 'none' });
  assert.deepEqual(chooseScreenEntry([display('a')]), { kind: 'view', display: display('a') });
  const two = chooseScreenEntry([display('a'), display('b')]);
  assert.equal(two.kind, 'pick');
  assert.equal(two.displays.length, 2);
  assert.equal(chooseScreenEntry([display('a'), display('b'), display('c')]).kind, 'pick');
});

test('a host reply keeps only well-formed displays', () => {
  const listed = readScreenDisplays([display('a', { primary: true }), { screenId: 'b' }, null, 'x', display('')]);
  assert.deepEqual(listed.map((entry) => entry.screenId), ['a']);
  assert.equal(listed[0].primary, true);
  assert.deepEqual(readScreenDisplays('nope'), []);
});

test('connection states: connecting, live, failed', () => {
  assert.deepEqual(screenView({ transport: 'negotiating', showsVideo: false, status: null }), { kind: 'connecting' });
  assert.deepEqual(screenView({ transport: 'relay', showsVideo: false, status: null }), { kind: 'connecting' });
  assert.deepEqual(screenView({ transport: 'webrtc', showsVideo: true, status: null }), { kind: 'live', control: true });
  assert.deepEqual(screenView({ transport: 'cooldown', showsVideo: false, status: null }), { kind: 'failed' });
  assert.deepEqual(screenView({ transport: 'closed', showsVideo: false, status: null }), { kind: 'failed' });
});

test('screen-status drives the secure desktop and stopped states', () => {
  const live = { transport: 'webrtc', showsVideo: true };
  assert.deepEqual(screenView({ ...live, status: status('live') }), { kind: 'live', control: true });
  assert.deepEqual(screenView({ ...live, status: status('live', { control: false }) }), {
    kind: 'live',
    control: false,
  });
  assert.deepEqual(screenView({ ...live, status: status('secure-desktop', { reason: 'uac' }) }), {
    kind: 'blocked',
    reason: 'uac',
    dim: true,
  });
  assert.deepEqual(screenView({ ...live, status: status('secure-desktop', { reason: 'lock' }) }), {
    kind: 'blocked',
    reason: 'lock',
    dim: true,
  });
  assert.deepEqual(screenView({ ...live, status: status('secure-desktop') }), {
    kind: 'blocked',
    reason: 'secure',
    dim: true,
  });
  // An elevation prompt on the ordinary desktop stays visible, undimmed.
  assert.deepEqual(screenView({ ...live, status: status('elevation-prompt', { reason: 'uac' }) }), {
    kind: 'blocked',
    reason: 'uac',
    dim: false,
  });
  assert.deepEqual(screenView({ ...live, status: status('stopped', { reason: 'user' }) }), {
    kind: 'stopped',
    reason: 'other',
  });
  assert.deepEqual(screenView({ ...live, status: status('stopped', { reason: 'display-removed' }) }), {
    kind: 'stopped',
    reason: 'display-removed',
  });
  // A stop wins over a dropped connection; coming back live clears the block.
  assert.equal(screenView({ transport: 'cooldown', showsVideo: false, status: status('stopped') }).kind, 'stopped');
  assert.equal(screenView({ ...live, status: status('live') }).kind, 'live');
});

test('the keyboard bar keeps its room from connecting through live and a reconnect', () => {
  const sequence = [
    { kind: 'connecting' },
    { kind: 'live', control: true },
    { kind: 'failed' },
    { kind: 'connecting' },
    { kind: 'live', control: false },
    { kind: 'blocked', reason: 'uac', dim: true },
    { kind: 'blocked', reason: 'uac', dim: false },
    { kind: 'live', control: true },
  ];
  // Present in every step: the stage height, so the picture, never changes.
  assert.ok(sequence.every((view) => screenKeyboardBar(view).present));
  // Typable only while live and controllable.
  assert.deepEqual(sequence.map((view) => screenKeyboardBar(view).enabled), [
    false, true, false, false, false, false, false, true,
  ]);
  // The secure desktop hides it but still reserves it.
  assert.deepEqual(screenKeyboardBar({ kind: 'blocked', reason: 'lock', dim: true }), {
    present: true,
    visible: false,
    enabled: false,
  });
  assert.equal(screenKeyboardBar({ kind: 'connecting' }).visible, true);
  // D3 is its own card with no bar.
  assert.equal(screenKeyboardBar({ kind: 'stopped', reason: 'other' }).present, false);
});

test('control lost between press and release still lets the ups out', () => {
  const live = { kind: 'live', control: true };
  const lost = { kind: 'blocked', reason: 'uac', dim: false };
  const sent = [];
  const gated = (view, inputs) => inputs.filter((input) => screenInputAllowed(input, view)).forEach((i) => sent.push(i));
  const chord = screenSpecialKeyInputs('alt-tab');
  gated(live, chord.slice(0, 2));
  gated(lost, chord.slice(2));
  assert.deepEqual(sent, chord);
  sent.length = 0;
  const drag = [
    { type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 },
    { type: 'screen-pointer', action: 'move', x: 5, y: 5 },
    { type: 'screen-pointer', action: 'up', button: 'left', x: 5, y: 5 },
  ];
  gated(live, drag.slice(0, 1));
  gated(lost, drag.slice(1));
  assert.deepEqual(sent, [drag[0], drag[2]]);
});

test('positive input needs a live, controllable view; release is always allowed', () => {
  const inputs = [
    { type: 'screen-pointer', action: 'move', x: 1, y: 1 },
    { type: 'screen-pointer', action: 'down', button: 'left', x: 1, y: 1 },
    { type: 'screen-wheel', x: 1, y: 1, deltaX: 0, deltaY: 120 },
    { type: 'screen-key', action: 'down', vk: 8, scan: 14, extended: false },
    { type: 'screen-text', text: 'a' },
  ];
  const release = { type: 'screen-release' };
  const refused = [
    { kind: 'live', control: false },
    { kind: 'blocked', reason: 'uac', dim: false },
    { kind: 'blocked', reason: 'lock', dim: true },
    { kind: 'connecting' },
    { kind: 'failed' },
    { kind: 'stopped', reason: 'other' },
  ];
  for (const view of refused) {
    assert.deepEqual(inputs.filter((input) => screenInputAllowed(input, view)), []);
    assert.equal(screenInputAllowed(release, view), true);
  }
  const live = { kind: 'live', control: true };
  assert.equal(inputs.every((input) => screenInputAllowed(input, live)), true);
});

function fakeTargets() {
  const make = () => {
    const handlers = new Map();
    return {
      handlers,
      addEventListener: (type, handler) => handlers.set(type, handler),
      removeEventListener: (type, handler) => {
        if (handlers.get(type) === handler) handlers.delete(type);
      },
      fire: (type) => handlers.get(type)?.(),
    };
  };
  const document = Object.assign(make(), { visibilityState: 'visible' });
  return { document, window: make(), stage: make() };
}

test('input is released on hide, pagehide, blur, touchcancel and when the pane is left', () => {
  const targets = fakeTargets();
  let releases = 0;
  const dispose = installScreenReleaseTriggers(targets, () => (releases += 1));
  // Becoming visible is not a release.
  targets.document.fire('visibilitychange');
  assert.equal(releases, 0);
  targets.document.visibilityState = 'hidden';
  targets.document.fire('visibilitychange');
  assert.equal(releases, 1);
  targets.window.fire('pagehide');
  targets.window.fire('blur');
  targets.stage.fire('touchcancel');
  assert.equal(releases, 4);
  dispose();
  assert.equal(releases, 5);
  assert.equal(targets.window.handlers.size + targets.document.handlers.size + targets.stage.handlers.size, 0);
});
