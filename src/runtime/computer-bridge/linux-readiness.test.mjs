import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkLinuxComputerReadiness,
  linuxComputerPreflight,
  resetLinuxComputerPreflightCache,
  INPUT_GROUP_SECURITY_NOTE,
  UINPUT_HINT,
} from './linux-readiness.mjs';

const wayland = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', PATH: '' };

test('Wayland GNOME: missing /dev/uinput access and Window Calls are blockers; tools are warnings', async () => {
  const r = await checkLinuxComputerReadiness({
    env: wayland,
    canWrite: () => false,
    hasCommand: () => false,
    windowCallsReachable: async () => false,
  });
  assert.equal(r.session, 'wayland');
  assert.deepEqual(r.blockers.map((b) => b.code), ['input_unavailable', 'wayland_window_control_unavailable']);
  assert.match(r.blockers[0].message, /input group/);
  assert.ok(r.blockers[0].message.includes(INPUT_GROUP_SECURITY_NOTE));
  assert.equal(r.warnings.length, 2); // wl-clipboard + tesseract
});

test('Wayland GNOME fully equipped is ready', async () => {
  const r = await checkLinuxComputerReadiness({
    env: wayland,
    canWrite: () => true,
    hasCommand: () => true,
    windowCallsReachable: async () => true,
  });
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.warnings, []);
});

test('X11 needs only a display; uinput and Window Calls are not required', async () => {
  const r = await checkLinuxComputerReadiness({
    env: { DISPLAY: ':0', PATH: '' },
    canWrite: () => false,
    hasCommand: () => true,
    windowCallsReachable: async () => false,
  });
  assert.equal(r.session, 'x11');
  assert.deepEqual(r.blockers, []);
  const none = await checkLinuxComputerReadiness({ env: { PATH: '' }, hasCommand: () => true });
  assert.deepEqual(none.blockers.map((b) => b.code), ['display_unavailable']);
});

test('preflight: uinput blocks only mutating actions; other platforms are never blocked', async () => {
  resetLinuxComputerPreflightCache();
  const check = async () => ({
    session: 'wayland',
    warnings: [],
    blockers: [{ code: 'input_unavailable', message: UINPUT_HINT, mutatingOnly: true }],
  });
  assert.equal(await linuxComputerPreflight({ mutating: false, platform: 'linux', check }), '');
  const message = await linuxComputerPreflight({ mutating: true, platform: 'linux', check });
  assert.match(message, /nothing was executed/);
  assert.match(message, /\/dev\/uinput/);
  assert.equal(await linuxComputerPreflight({ mutating: true, platform: 'win32', check }), '');
  resetLinuxComputerPreflightCache();
});
