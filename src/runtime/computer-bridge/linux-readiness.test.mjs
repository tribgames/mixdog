import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_UNAVAILABLE_CODE,
  CAPTURE_FALLBACK_NOTE,
  INPUT_GROUP_SECURITY_NOTE,
  MIN_WINDOW_HELPER_VERSION,
  checkLinuxComputerReadiness,
  detectSession,
  linuxCaptureFallback,
  linuxComputerPreflight,
  missingCapabilities,
  resetLinuxComputerPreflightCache,
} from './linux-readiness.mjs';
import { requiredCapabilities } from './linux-action-capabilities.mjs';

const GNOME = {
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_SESSION_TYPE: 'wayland',
  XDG_CURRENT_DESKTOP: 'ubuntu:GNOME',
  PATH: '',
};
const KDE = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', PATH: '' };
const SWAY = {
  WAYLAND_DISPLAY: 'wayland-1',
  XDG_SESSION_TYPE: 'wayland',
  XDG_CURRENT_DESKTOP: 'sway',
  SWAYSOCK: '/run/sway.sock',
  PATH: '',
};
const HYPRLAND = { WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'abc', PATH: '' };
const X11 = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME', PATH: '' };

// Every probe is injected; `tools` lists the commands found on PATH.
// helper is the extension's disk/settings state: {installed, enabled}.
function probe(
  env,
  {
    uinput = false,
    windowCalls = false,
    helper = { installed: false, enabled: false },
    a11y = true,
    bus = true,
    tools = [],
  } = {}
) {
  const calls = { windowCalls: 0, a11y: 0, helper: 0 };
  const run = checkLinuxComputerReadiness({
    env,
    canWrite: (file) => file === '/dev/uinput' && uinput,
    hasCommand: (name) => tools.includes(name),
    hasSessionBus: () => bus,
    windowHelperVersion: async () => {
      calls.windowCalls += 1;
      // true: a current helper; a number: that loaded version; false: nothing answers.
      return windowCalls === true ? MIN_WINDOW_HELPER_VERSION : windowCalls || null;
    },
    windowHelperStatus: async () => {
      calls.helper += 1;
      return helper;
    },
    accessibilityReachable: async () => {
      calls.a11y += 1;
      return a11y;
    },
  });
  return Object.assign(run, { calls });
}

const step = (action, extra = {}) => ({ action, ...extra });
const act = (steps, delivery) => ({ action: 'sequence', steps, ...(delivery ? { delivery } : {}) });
const blocked = (readiness, command) => missingCapabilities(readiness, command).map((item) => item.capability);

test('session detection matches native wayland_session()', () => {
  assert.equal(detectSession({ WAYLAND_DISPLAY: 'wayland-0' }), 'wayland');
  assert.equal(detectSession({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }), 'wayland');
  assert.equal(detectSession({ WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' }), 'x11');
  assert.equal(detectSession({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }), 'x11');
  assert.equal(detectSession({ DISPLAY: ':0' }), 'x11');
});

test('GNOME without uinput and the window helper: only the actions that need them are blocked', async () => {
  const readiness = await probe(GNOME, { tools: ['gdbus', 'wl-copy', 'wl-paste'] });
  assert.equal(readiness.session, 'wayland');
  assert.equal(readiness.desktop, 'gnome');
  assert.deepEqual(readiness.capabilities.windows, { state: 'needs_setup', fix: 'enable_window_helper' });
  assert.deepEqual(readiness.capabilities.pointer, { state: 'needs_setup', fix: 'allow_input' });
  assert.deepEqual(readiness.capabilities.keyboard, { state: 'needs_setup', fix: 'allow_input' });
  assert.deepEqual(readiness.capabilities.semanticActions, { state: 'needs_setup', fix: 'enable_window_helper' });
  // GNOME pixels come from the same helper, so they are blocked with it.
  assert.deepEqual(readiness.capabilities.capture, { state: 'needs_setup', fix: 'enable_window_helper' });
  assert.deepEqual(readiness.capabilities.clipboard, { state: 'ready', optional: true });
  assert.deepEqual(readiness.capabilities.ocr, {
    state: 'needs_setup',
    fix: 'install_package',
    package: 'tesseract-ocr',
    optional: true,
  });

  // Launch, clipboard and diagnose still run.
  for (const command of [
    { action: 'launch', app: 'gedit' },
    { action: 'clipboard_write', text: 'x' },
    { action: 'clipboard_read' },
    { action: 'diagnose' },
    { action: 'list_history' },
  ]) {
    assert.deepEqual(blocked(readiness, command), [], command.action);
  }
  assert.deepEqual(blocked(readiness, { action: 'list_windows' }), ['windows']);
  assert.deepEqual(blocked(readiness, { action: 'capture' }), ['capture', 'windows']);
  // GNOME takes pixels through the helper (never a portal), so any capture waits for it.
  assert.deepEqual(blocked(readiness, { action: 'capture', mode: 'vision', screen: 0 }), ['capture']);
  assert.match(
    missingCapabilities(readiness, { action: 'capture', mode: 'vision', screen: 0 })[0].message,
    /Mixdog Windows/
  );
  assert.deepEqual(blocked(readiness, act([step('click', { x: 1, y: 2 })])), ['windows', 'pointer']);
  assert.deepEqual(blocked(readiness, act([step('invoke', { ref: 'e1' })])), ['windows', 'semanticActions']);
});

test('GNOME with the window helper answering but no uinput: window control, AT-SPI actions, menu, launch and clipboard run', async () => {
  const readiness = await probe(GNOME, { windowCalls: true, tools: ['gdbus', 'wl-copy', 'wl-paste', 'tesseract'] });
  assert.deepEqual(readiness.capabilities.windows, { state: 'ready' });
  assert.deepEqual(readiness.capabilities.accessibility, { state: 'ready' });
  assert.deepEqual(readiness.capabilities.semanticActions, { state: 'ready' });
  assert.equal(readiness.capabilities.pointer.state, 'needs_setup');
  for (const command of [
    { action: 'list_windows' },
    { action: 'list_apps' },
    { action: 'focus_window', window_id: 'hwnd:0x1' },
    { action: 'move_window', window_id: 'hwnd:0x1', x: 1 },
    { action: 'window_state', window_id: 'hwnd:0x1', state: 'minimize' },
    { action: 'close_window', window_id: 'hwnd:0x1' },
    { action: 'invoke_menu', window_id: 'hwnd:0x1', path: ['File'] },
    { action: 'launch', app: 'gedit' },
    { action: 'clipboard_write', text: 'x' },
    { action: 'capture' },
    { action: 'capture', mode: 'ax', window_id: 'hwnd:0x1' },
    act([step('invoke', { ref: 'e1' })]),
    act([step('toggle', { ref: 'e2' }), step('set_value', { ref: 'e3', text: 'v' }), step('wait')]),
    act([step('type', { ref: 'e3', text: 'v' })]),
  ]) {
    assert.deepEqual(blocked(readiness, command), [], JSON.stringify(command));
  }
  // Real input needs uinput, and the refusal names it with the stable code.
  assert.deepEqual(blocked(readiness, act([step('click', { x: 1, y: 2 })])), ['pointer']);
  assert.deepEqual(blocked(readiness, act([step('key', { keys: 'enter' })])), ['keyboard']);
  assert.deepEqual(blocked(readiness, act([step('invoke', { ref: 'e1' })], 'foreground')), ['pointer']);
  assert.deepEqual(blocked(readiness, act([step('type', { ref: 'e3', text: 'v' })], 'foreground')), ['keyboard']);
  const [missing] = missingCapabilities(readiness, act([step('click', { x: 1, y: 2 })]));
  assert.deepEqual(missing, {
    capability: 'pointer',
    state: 'needs_setup',
    fix: 'allow_input',
    code: 'input_unavailable',
    message: missing.message,
  });
  assert.match(missing.message, /\/dev\/uinput/);
  assert.ok(missing.message.includes(INPUT_GROUP_SECURITY_NOTE));
});

test('GNOME with everything installed is ready for every action', async () => {
  const readiness = await probe(GNOME, {
    uinput: true,
    windowCalls: true,
    tools: ['gdbus', 'wl-copy', 'wl-paste', 'tesseract'],
  });
  assert.ok(
    Object.values(readiness.capabilities).every(
      (capability) => capability.state === 'ready' || capability === readiness.capabilities.capture
    )
  );
  assert.deepEqual(blocked(readiness, act([step('click', { x: 1, y: 2 }), step('type', { text: 'a' })])), []);
});

test('GNOME without gdbus cannot probe the window helper: unknown, never blocking', async () => {
  const run = probe(GNOME, { uinput: true, tools: [] });
  const readiness = await run;
  assert.deepEqual(readiness.capabilities.windows, { state: 'unknown' });
  assert.deepEqual(readiness.capabilities.accessibility, { state: 'unknown' });
  assert.equal(run.calls.windowCalls, 0);
  assert.equal(run.calls.a11y, 0);
  assert.deepEqual(blocked(readiness, { action: 'list_windows' }), []);
});

test('a loaded helper older than the app needs is a sign-out away from ready', async () => {
  const stale = await probe(GNOME, {
    windowCalls: MIN_WINDOW_HELPER_VERSION - 1,
    helper: { installed: true, enabled: true },
    tools: ['gdbus'],
  });
  assert.deepEqual(stale.capabilities.windows, { state: 'needs_setup', fix: 'relogin' });
  assert.deepEqual(stale.capabilities.capture, { state: 'needs_setup', fix: 'relogin' });
  const current = await probe(GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION, tools: ['gdbus'] });
  assert.deepEqual(current.capabilities.capture, { state: 'ready' });
});

test('GNOME window helper states: ready, relogin once enabled but not loaded, enable when not enabled', async () => {
  const ready = await probe(GNOME, { windowCalls: true, helper: { installed: true, enabled: true }, tools: ['gdbus'] });
  assert.deepEqual(ready.capabilities.windows, { state: 'ready' });

  const notLoaded = await probe(GNOME, { helper: { installed: true, enabled: true }, tools: ['gdbus'] });
  assert.deepEqual(notLoaded.capabilities.windows, { state: 'needs_setup', fix: 'relogin' });
  assert.deepEqual(notLoaded.capabilities.semanticActions, { state: 'needs_setup', fix: 'relogin' });
  const [refusal] = missingCapabilities(notLoaded, { action: 'list_windows' });
  assert.equal(refusal.code, 'wayland_window_control_unavailable');
  assert.match(refusal.message, /sign out and sign in again/);

  for (const helper of [
    { installed: true, enabled: false },
    { installed: false, enabled: false },
  ]) {
    const off = await probe(GNOME, { helper, tools: ['gdbus'] });
    assert.deepEqual(off.capabilities.windows, { state: 'needs_setup', fix: 'enable_window_helper' });
    assert.match(
      missingCapabilities(off, { action: 'list_windows' })[0].message,
      /gnome-extensions enable mixdog-windows@mixdog\.io/
    );
  }
  // An answering interface never consults the disk state.
  assert.equal(ready.capabilities.windows.fix, undefined);
  const answering = probe(GNOME, { windowCalls: true, tools: ['gdbus'] });
  await answering;
  assert.equal(answering.calls.helper, 0);
});

test('a default capture without window control becomes a full-screen capture with a note', async () => {
  const missing = await probe(KDE, { tools: ['gdbus'] });
  const check = async () => missing;
  resetLinuxComputerPreflightCache();
  const fallback = await linuxCaptureFallback({
    command: { action: 'capture', mode: 'state', session_id: 's1' },
    platform: 'linux',
    check,
  });
  assert.deepEqual(fallback.command, { action: 'capture', mode: 'vision', screen: 0, session_id: 's1' });
  assert.equal(fallback.note, CAPTURE_FALLBACK_NOTE);
  // The rewritten command passes the preflight (nothing it needs is missing).
  assert.deepEqual(blocked(missing, fallback.command), []);
  // Named windows, explicit screens, other actions and other platforms are untouched.
  for (const command of [
    { action: 'capture', mode: 'state', window_id: 'hwnd:0x1' },
    { action: 'capture', mode: 'state', app: 'gedit' },
    { action: 'capture', mode: 'vision', screen: 1 },
    { action: 'list_windows' },
  ]) {
    assert.equal(await linuxCaptureFallback({ command, platform: 'linux', check }), null, JSON.stringify(command));
  }
  assert.equal(await linuxCaptureFallback({ command: { action: 'capture' }, platform: 'win32', check }), null);
  // On GNOME the screen needs the same helper, so there is nothing to fall back to.
  resetLinuxComputerPreflightCache();
  const gnome = await probe(GNOME, { tools: ['gdbus'] });
  assert.equal(
    await linuxCaptureFallback({ command: { action: 'capture' }, platform: 'linux', check: async () => gnome }),
    null
  );
  // With window control ready there is no fallback.
  resetLinuxComputerPreflightCache();
  const ready = await probe(GNOME, { windowCalls: true, tools: ['gdbus'] });
  assert.equal(
    await linuxCaptureFallback({ command: { action: 'capture' }, platform: 'linux', check: async () => ready }),
    null
  );
  resetLinuxComputerPreflightCache();
});

test('KDE Wayland: no window backend; capture, pointer, keyboard, clipboard and OCR stay available', async () => {
  const run = probe(KDE, { uinput: true, tools: ['gdbus', 'wl-copy', 'wl-paste', 'tesseract'] });
  const readiness = await run;
  assert.equal(readiness.desktop, 'kde');
  assert.deepEqual(readiness.capabilities.windows, { state: 'unsupported' });
  assert.deepEqual(readiness.capabilities.semanticActions, { state: 'unsupported' });
  assert.equal(readiness.capabilities.pointer.state, 'ready');
  assert.equal(readiness.capabilities.keyboard.state, 'ready');
  assert.equal(run.calls.windowCalls, 0);
  for (const command of [
    { action: 'capture', mode: 'vision', screen: 0 },
    { action: 'zoom' },
    { action: 'clipboard_read' },
    { action: 'clipboard_write', text: 'x' },
    { action: 'launch', app: 'kate' },
  ]) {
    assert.deepEqual(blocked(readiness, command), [], command.action);
  }
  assert.deepEqual(blocked(readiness, { action: 'list_windows' }), ['windows']);
  assert.deepEqual(blocked(readiness, act([step('click', { x: 1, y: 2 })])), ['windows']);
  resetLinuxComputerPreflightCache();
  const refusal = await linuxComputerPreflight({
    command: { action: 'capture' },
    platform: 'linux',
    check: async () => readiness,
  });
  assert.equal(refusal.code, CAPABILITY_UNAVAILABLE_CODE);
  assert.match(refusal.message, /nothing was executed/);
  assert.match(refusal.message, /mode="vision"/);
  resetLinuxComputerPreflightCache();
});

test('sway and Hyprland need their control tool on PATH', async () => {
  const sway = await probe(SWAY, { uinput: true, tools: ['swaymsg'] });
  assert.equal(sway.desktop, 'sway');
  assert.deepEqual(sway.capabilities.windows, { state: 'ready' });
  const noSwaymsg = await probe(SWAY, { uinput: true, tools: [] });
  assert.deepEqual(noSwaymsg.capabilities.windows, { state: 'needs_setup', fix: 'install_package', package: 'sway' });
  assert.match(missingCapabilities(noSwaymsg, { action: 'list_windows' })[0].message, /install sway/);
  const hypr = await probe(HYPRLAND, { uinput: true, tools: ['hyprctl'] });
  assert.equal(hypr.desktop, 'hyprland');
  assert.deepEqual(hypr.capabilities.windows, { state: 'ready' });
  const noHyprctl = await probe(HYPRLAND, { uinput: true, tools: [] });
  assert.deepEqual(noHyprctl.capabilities.windows, {
    state: 'needs_setup',
    fix: 'install_package',
    package: 'hyprland',
  });
  // The compositor sockets win over the desktop name, as in native Compositor::detect().
  const both = await probe({ ...SWAY, XDG_CURRENT_DESKTOP: 'GNOME' }, { tools: ['swaymsg'] });
  assert.equal(both.desktop, 'sway');
  assert.equal(both.capabilities.windows.state, 'ready');
});

test('X11 needs neither uinput nor the window helper', async () => {
  const run = probe(X11, { tools: ['gdbus'] });
  const readiness = await run;
  assert.equal(readiness.session, 'x11');
  assert.equal(readiness.desktop, 'gnome');
  for (const name of ['capture', 'windows', 'pointer', 'keyboard', 'clipboard', 'semanticActions']) {
    assert.equal(readiness.capabilities[name].state, 'ready', name);
  }
  assert.equal(run.calls.windowCalls, 0);
  assert.deepEqual(
    blocked(
      readiness,
      act([step('click', { x: 1, y: 2 }), step('type', { text: 'a' }), step('invoke', { ref: 'e1' })])
    ),
    []
  );
});

test('AT-SPI missing blocks only what reads it; a missing display blocks everything', async () => {
  const noBus = await probe(X11, { a11y: false, tools: ['gdbus'] });
  assert.deepEqual(noBus.capabilities.accessibility, {
    state: 'needs_setup',
    fix: 'install_package',
    package: 'at-spi2-core',
  });
  assert.deepEqual(noBus.capabilities.semanticActions, noBus.capabilities.accessibility);
  assert.deepEqual(blocked(noBus, act([step('invoke', { ref: 'e1' })])), ['accessibility', 'semanticActions']);
  assert.deepEqual(blocked(noBus, act([step('click', { x: 1, y: 2 })])), []);
  assert.deepEqual(blocked(noBus, { action: 'capture' }), []);
  assert.deepEqual(blocked(noBus, { action: 'capture', mode: 'ax', window_id: 'hwnd:0x1' }), ['accessibility']);
  assert.match(missingCapabilities(noBus, { action: 'capture', mode: 'ax' })[0].message, /at-spi2-core/);

  const none = await probe({ PATH: '' }, { tools: ['gdbus'] });
  assert.equal(none.session, 'x11');
  assert.ok(Object.values(none.capabilities).every((capability) => capability.state === 'unsupported'));
  assert.equal(
    missingCapabilities(none, { action: 'capture', mode: 'vision', screen: 0 })[0].code,
    'display_unavailable'
  );
  assert.deepEqual(blocked(none, { action: 'diagnose' }), []);
});

test('requiredCapabilities maps each action to what native really needs', () => {
  const need = (command) => [...requiredCapabilities(command)].sort();
  assert.deepEqual(need({ action: 'list_history' }), []);
  assert.deepEqual(need({ action: 'wait_for_user' }), []);
  assert.deepEqual(need({ action: 'launch' }), []);
  assert.deepEqual(need({ action: 'list_windows' }), ['windows']);
  assert.deepEqual(need({ action: 'verify', window_id: 'x' }), ['windows']);
  assert.deepEqual(need({ action: 'capture', mode: 'vision', screen: 1 }), ['capture']);
  assert.deepEqual(need({ action: 'capture', mode: 'vision', screen: 1, app: 'a' }), ['capture', 'windows']);
  assert.deepEqual(need({ action: 'capture', mode: 'vision' }), ['capture', 'windows']);
  assert.deepEqual(need({ action: 'capture', mode: 'ax', window_id: 'x' }), ['accessibility', 'capture', 'windows']);
  assert.deepEqual(need({ action: 'zoom' }), ['capture']);
  assert.deepEqual(need({ action: 'clipboard_write' }), ['clipboard']);
  assert.deepEqual(need(act([step('wait')])), ['windows']);
  assert.deepEqual(need(act([step('scroll', { x: 1, y: 1 }), step('drag', { x: 1, y: 1 })])), ['pointer', 'windows']);
  assert.deepEqual(need(act([step('click', { ref: 'e1' })])), ['accessibility', 'pointer', 'windows']);
  assert.deepEqual(need(act([step('key', { keys: 'a' }), step('type', { text: 'a' })])), ['keyboard', 'windows']);
  assert.deepEqual(need(act([step('toggle', { ref: 'e1' })])), ['accessibility', 'semanticActions', 'windows']);
});

test('preflight: other platforms and ready sessions are never blocked', async () => {
  resetLinuxComputerPreflightCache();
  const readiness = await probe(GNOME, { uinput: false, tools: ['gdbus'] });
  const check = async () => readiness;
  assert.equal(
    await linuxComputerPreflight({ command: act([step('click', { x: 1, y: 2 })]), platform: 'win32', check }),
    null
  );
  assert.equal(
    await linuxComputerPreflight({ command: { action: 'launch', app: 'x' }, platform: 'linux', check }),
    null
  );
  const refusal = await linuxComputerPreflight({
    command: act([step('click', { x: 1, y: 2 })]),
    platform: 'linux',
    check,
  });
  assert.equal(refusal.code, CAPABILITY_UNAVAILABLE_CODE);
  assert.deepEqual(
    refusal.missing.map((item) => item.capability),
    ['windows', 'pointer']
  );
  assert.match(refusal.message, /nothing was executed/);
  assert.match(refusal.message, /Mixdog Windows/);
  assert.match(refusal.message, /\/dev\/uinput/);
  resetLinuxComputerPreflightCache();
});

test('preflight re-probes after 3 seconds and shares one probe between concurrent calls', async () => {
  resetLinuxComputerPreflightCache();
  let clock = 1000;
  let probes = 0;
  const states = [{ pointer: 'needs_setup' }, { pointer: 'ready' }];
  const check = async () => {
    const pointer = states[Math.min(probes, states.length - 1)].pointer;
    probes += 1;
    const ready = { state: 'ready' };
    return {
      session: 'wayland',
      desktop: 'gnome',
      capabilities: {
        capture: { state: 'unknown' },
        windows: ready,
        accessibility: ready,
        semanticActions: ready,
        pointer: pointer === 'ready' ? ready : { state: 'needs_setup', fix: 'allow_input' },
        keyboard: ready,
        clipboard: ready,
        ocr: ready,
      },
    };
  };
  const command = act([step('click', { x: 1, y: 2 })]);
  const options = { command, platform: 'linux', check, now: () => clock };
  const [first, second] = await Promise.all([linuxComputerPreflight(options), linuxComputerPreflight(options)]);
  assert.ok(first && second);
  assert.equal(probes, 1, 'concurrent calls share one probe');
  clock += 2900;
  assert.ok(await linuxComputerPreflight(options), 'still cached inside the window');
  assert.equal(probes, 1);
  clock += 200;
  assert.equal(await linuxComputerPreflight(options), null, 'the fix is noticed once the window passes');
  assert.equal(probes, 2);
  resetLinuxComputerPreflightCache();
});
