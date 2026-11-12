#!/usr/bin/env node
// Recording of computer-bridge/linux-readiness.test.mjs (b6f10295a): the Linux Computer Use prerequisites. Every probe is injected the
// way the test injects it (env, uinput, the loaded window-helper version, the extension's disk state, AT-SPI, the session bus, the
// commands on PATH), so the recorded readiness is what Node's own decision code makes of that session. Over each session the
// recording keeps: the readiness and how often each async probe was asked, `missingCapabilities` for every command of the list,
// `linuxComputerPreflight` and `linuxCaptureFallback` for every command (a fresh cache each, platform linux), plus the session
// and desktop detection, `requiredCapabilities` for every command, other platforms, and the 3 s probe cache with concurrent calls.
//
//   node benchmarks/rust-core/recorders/record-computer-linux-readiness.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('computer-linux-readiness', import.meta.url, { clock: false });
const mod = await set.load('src/runtime/computer-bridge/linux-readiness.mjs');
const caps = await set.load('src/runtime/computer-bridge/linux-action-capabilities.mjs');
const { checkLinuxComputerReadiness, missingCapabilities, linuxComputerPreflight, linuxCaptureFallback, resetLinuxComputerPreflightCache, detectSession, detectDesktop, MIN_WINDOW_HELPER_VERSION } = mod;

const GNOME = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', PATH: '' };
const KDE = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', PATH: '' };
const SWAY = { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway', SWAYSOCK: '/run/sway.sock', PATH: '' };
const HYPRLAND = { WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'abc', PATH: '' };
const X11 = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME', PATH: '' };
const NOT_INSTALLED = { installed: false, enabled: false };
const ALL_TOOLS = ['gdbus', 'wl-copy', 'wl-paste', 'tesseract'];

const step = (action, extra = {}) => ({ action, ...extra });
const act = (steps, delivery) => ({ action: 'sequence', steps, ...(delivery ? { delivery } : {}) });
const COMMANDS = [
  { action: 'launch', app: 'gedit' }, { action: 'list_history' }, { action: 'wait_for_user' }, { action: 'diagnose' },
  { action: 'list_windows' }, { action: 'list_apps' }, { action: 'focus_window', window_id: 'hwnd:0x1' },
  { action: 'move_window', window_id: 'hwnd:0x1', x: 1 }, { action: 'window_state', window_id: 'hwnd:0x1', state: 'minimize' },
  { action: 'close_window', window_id: 'hwnd:0x1' }, { action: 'invoke_menu', window_id: 'hwnd:0x1', path: ['File'] },
  { action: 'clipboard_read' }, { action: 'clipboard_write', text: 'x' }, { action: 'verify', window_id: 'x' }, { action: 'zoom' }, { action: 'screenshot' },
  { action: 'capture' }, { action: 'capture', mode: 'state', session_id: 's1' }, { action: 'capture', mode: 'state', session_id: 's1', include_ocr: true },
  { action: 'capture', mode: 'ax', window_id: 'hwnd:0x1' }, { action: 'capture', mode: 'ax' },
  { action: 'capture', mode: 'vision', screen: 0 }, { action: 'capture', mode: 'vision', screen: 1 }, { action: 'capture', mode: 'vision', screen: 1, app: 'a' },
  { action: 'capture', mode: 'vision' }, { action: 'capture', mode: 'state', window_id: 'hwnd:0x1' }, { action: 'capture', mode: 'state', app: 'gedit' },
  { action: 'capture', mode: 'state', window: 'w' }, { action: 'capture', mode: 'state', window_id: '' },
  { action: 'snapshot' }, { action: 'find' }, { action: 'window_predicates' },
  act([step('click', { x: 1, y: 2 })]), act([step('key', { keys: 'enter' })]), act([step('invoke', { ref: 'e1' })]),
  act([step('invoke', { ref: 'e1' })], 'foreground'), act([step('type', { ref: 'e3', text: 'v' })]), act([step('type', { ref: 'e3', text: 'v' })], 'foreground'),
  act([step('type', { text: 'a' })]), act([step('toggle', { ref: 'e2' }), step('set_value', { ref: 'e3', text: 'v' }), step('wait')]),
  act([step('scroll', { x: 1, y: 1 }), step('drag', { x: 1, y: 1 })]), act([step('click', { ref: 'e1' })]), act([step('key', { keys: 'a' }), step('type', { text: 'a' })]),
  act([step('wait')]), act([]), { action: 'sequence' },
  act([step('click', { x: 1, y: 2 }), step('type', { text: 'a' }), step('invoke', { ref: 'e1' })]),
  act([step('invoke_menu', { ref: 'e1' })]), act([step('click', { element: 'e9' })]),
  { action: 'click', x: 1, y: 2 }, { action: 'click', window_id: 'hwnd:0x1', x: 1, y: 2 }, { action: 'type', ref: 'e1', text: 'v' }, { action: 'type', ref: 'e1', text: 'v', delivery: 'foreground' },
  { action: 'invoke', ref: 'e1', window_id: 'hwnd:0x1' }, { action: 'key', keys: 'a', delivery: 'foreground', app: 'gedit' },
  { action: 'nothing_known' }, {},
];

const SESSIONS = [
  ['gnome-bare', GNOME, { tools: ['gdbus', 'wl-copy', 'wl-paste'] }],
  ['gnome-helper-answering-no-uinput', GNOME, { windowCalls: true, tools: ALL_TOOLS }],
  ['gnome-everything', GNOME, { uinput: true, windowCalls: true, tools: ALL_TOOLS }],
  ['gnome-no-gdbus', GNOME, { uinput: true, tools: [] }],
  ['gnome-helper-older-than-needed', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION - 1, helper: { installed: true, enabled: true }, tools: ['gdbus'] }],
  ['gnome-helper-current', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION, tools: ['gdbus'] }],
  ['gnome-helper-newer', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION + 4, helper: { installed: true, enabled: false }, tools: ['gdbus'] }],
  ['gnome-enabled-not-loaded', GNOME, { helper: { installed: true, enabled: true }, tools: ['gdbus'] }],
  ['gnome-installed-not-enabled', GNOME, { helper: { installed: true, enabled: false }, tools: ['gdbus'] }],
  ['gnome-not-installed', GNOME, { helper: NOT_INSTALLED, tools: ['gdbus'] }],
  ['gnome-no-accessibility-bus', GNOME, { windowCalls: true, a11y: false, tools: ['gdbus'] }],
  ['gnome-no-session-bus', GNOME, { windowCalls: true, bus: false, tools: ['gdbus'] }],
  ['kde-everything', KDE, { uinput: true, tools: ALL_TOOLS }],
  ['kde-gdbus-only', KDE, { tools: ['gdbus'] }],
  ['sway-with-swaymsg', SWAY, { uinput: true, tools: ['swaymsg'] }],
  ['sway-without-swaymsg', SWAY, { uinput: true, tools: [] }],
  ['hyprland-with-hyprctl', HYPRLAND, { uinput: true, tools: ['hyprctl'] }],
  ['hyprland-without-hyprctl', HYPRLAND, { uinput: true, tools: [] }],
  ['sway-socket-beats-gnome-name', { ...SWAY, XDG_CURRENT_DESKTOP: 'GNOME' }, { tools: ['swaymsg'] }],
  ['x11', X11, { tools: ['gdbus'] }],
  ['x11-no-accessibility-bus', X11, { a11y: false, tools: ['gdbus'] }],
  ['x11-no-session-bus', X11, { bus: false, tools: ['gdbus'] }],
  ['x11-no-gdbus', X11, { tools: [] }],
  ['no-display', { PATH: '' }, { tools: ['gdbus'] }],
  ['empty-display', { DISPLAY: '', PATH: '' }, { tools: ['gdbus'] }],
  ['wayland-display-with-x11-session-type', { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', PATH: '' }, { tools: ['gdbus'] }],
  ['wayland-display-without-session-type-plasma', { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'plasma', PATH: '' }, { uinput: true, tools: ['gdbus'] }],
];

function inputOf(env, { uinput = false, windowCalls = false, helper = NOT_INSTALLED, a11y = true, bus = true, tools = [] }) {
  // windowCalls: true = a current helper, a number = that loaded version, false = nothing answers (the test's own convention).
  const windowVersion = windowCalls === true ? MIN_WINDOW_HELPER_VERSION : windowCalls || null;
  return { env, uinput, windowVersion, helper, a11y, bus, tools };
}
async function probe(input) {
  const calls = { windowCalls: 0, a11y: 0, helper: 0 };
  const readiness = await checkLinuxComputerReadiness({
    env: input.env,
    canWrite: (file) => file === '/dev/uinput' && input.uinput,
    hasCommand: (name) => input.tools.includes(name),
    hasSessionBus: () => input.bus,
    windowHelperVersion: async () => { calls.windowCalls += 1; return input.windowVersion; },
    windowHelperStatus: async () => { calls.helper += 1; return input.helper; },
    accessibilityReachable: async () => { calls.a11y += 1; return input.a11y; },
  });
  return { readiness, calls };
}

await set.run('the commands every session is asked about', () => COMMANDS);
await set.run('session and desktop detection', () => {
  const envs = [
    { WAYLAND_DISPLAY: 'wayland-0' }, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }, { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' },
    { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' }, { DISPLAY: ':0' }, { WAYLAND_DISPLAY: '' }, { WAYLAND_DISPLAY: 'w', XDG_SESSION_TYPE: '' },
    GNOME, KDE, SWAY, HYPRLAND, X11,
    { ...SWAY, SWAYSOCK: undefined, XDG_CURRENT_DESKTOP: 'Hyprland' }, { WAYLAND_DISPLAY: 'w', XDG_CURRENT_DESKTOP: 'KDE-Plasma' },
    { WAYLAND_DISPLAY: 'w', XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, { WAYLAND_DISPLAY: 'w', XDG_CURRENT_DESKTOP: 'GNOME-Flashback:GNOME' }, { DISPLAY: ':0', SWAYSOCK: '/s', XDG_CURRENT_DESKTOP: 'sway' },
  ];
  return envs.map((env) => { const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)); const session = detectSession(clean); return { env: clean, session, desktop: detectDesktop(clean, session) }; });
});
await set.run('what each command requires', () => COMMANDS.map((command) => [...caps.requiredCapabilities(command)]));
for (const [name, env, options] of SESSIONS) {
  await set.run(`session ${name}`, async () => {
    const input = inputOf(env, options);
    const { readiness, calls } = await probe(input);
    const missing = COMMANDS.map((command) => missingCapabilities(readiness, command));
    const check = async () => readiness;
    const preflight = [];
    const fallback = [];
    for (const command of COMMANDS) {
      resetLinuxComputerPreflightCache();
      preflight.push(await linuxComputerPreflight({ command, platform: 'linux', check }));
      resetLinuxComputerPreflightCache();
      fallback.push(await linuxCaptureFallback({ command, platform: 'linux', check }));
    }
    resetLinuxComputerPreflightCache();
    return { input, readiness, calls, missing, preflight, fallback };
  });
}
await set.run('other platforms are never blocked and never rewritten', async () => {
  const out = [];
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    const { readiness } = await probe(inputOf(GNOME, { tools: ['gdbus'] }));
    for (const command of [act([step('click', { x: 1, y: 2 })]), { action: 'capture' }, { action: 'list_windows' }]) {
      resetLinuxComputerPreflightCache();
      const preflight = await linuxComputerPreflight({ command, platform, check: async () => readiness });
      resetLinuxComputerPreflightCache();
      const fallback = await linuxCaptureFallback({ command, platform, check: async () => readiness });
      out.push({ platform, command, preflight, fallback });
    }
  }
  resetLinuxComputerPreflightCache();
  return out;
});
await set.run('the probe is cached for 3 seconds and concurrent calls share one probe', async () => {
  resetLinuxComputerPreflightCache();
  let clock = 1000;
  let probes = 0;
  const pointers = ['needs_setup', 'ready'];
  const ready = { state: 'ready' };
  const check = async () => {
    const pointer = pointers[Math.min(probes, pointers.length - 1)];
    probes += 1;
    return {
      session: 'wayland', desktop: 'gnome',
      capabilities: { capture: { state: 'unknown' }, windows: ready, accessibility: ready, semanticActions: ready, pointer: pointer === 'ready' ? ready : { state: 'needs_setup', fix: 'allow_input' }, keyboard: ready, clipboard: ready, ocr: ready },
    };
  };
  const command = act([step('click', { x: 1, y: 2 })]);
  const steps = [{ at: 1000, concurrent: 2 }, { at: 3900, concurrent: 1 }, { at: 4100, concurrent: 1 }, { at: 4100, concurrent: 3 }, { at: 7200, concurrent: 1 }];
  const out = [];
  for (const { at, concurrent } of steps) {
    clock = at;
    const options = { command, platform: 'linux', check, now: () => clock };
    const results = await Promise.all(Array.from({ length: concurrent }, () => linuxComputerPreflight(options)));
    out.push({ at, concurrent, results, probes });
  }
  resetLinuxComputerPreflightCache();
  return { pointers, steps: out };
});

await set.finish({
  entry: 'computer-bridge/linux-readiness.mjs checkLinuxComputerReadiness, missingCapabilities, linuxComputerPreflight, linuxCaptureFallback, detectSession, detectDesktop; linux-action-capabilities.mjs requiredCapabilities',
  replay: { entry: 'mixdog-tools desktop::computer_linux: check_readiness over the recorded probes, missing_capabilities, preflight, capture_fallback, required_capabilities, detect_session/detect_desktop, ReadinessCache; every recorded value compared whole', normalised: {} },
  exclusions: { realProbes: 'the real probes (PATH scan, access(), gdbus, gsettings) are not run: the test injects every one, as the recording does' },
});
process.exit(0);
