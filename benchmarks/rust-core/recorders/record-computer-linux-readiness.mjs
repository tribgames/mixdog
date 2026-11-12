#!/usr/bin/env node
// Recording of the Linux Computer Use readiness (what the tool answers before it acts) and of the capture of a screen, as Node b6f10295a
// runs them: every call goes through Node's real `executeComputerTool` (client.mjs: validation, `linuxCaptureFallback`, `linuxComputerPreflight`)
// to Node's real desktop host (apps/desktop/src/main/computer, started with `createComputerHost`, reached over its own loopback HTTP bridge),
// with Node's own probing code running unreplaced. What stands in for the machine is only what that code reads and spawns (lib/computer-host-world.mjs):
// the environment, the executables, the writable and existing paths, `gdbus` / `gsettings` (answers, and the screenshot file the GNOME extension
// writes), a scripted `mixdog-computer` helper, the Electron module (the display, the image object), `process.platform` and `Date.now`.
// Each scenario is one tool call on a fresh host with a fresh probe cache; its outcome is kept whole: the error flag, every content block (text and
// image bytes), the tool meta, and, in the order they happened, every gdbus / gsettings invocation and every helper request.
//
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-computer-linux-readiness.mjs --tree <export of b6f10295a with node_modules>)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { openSet } from './lib/case-set.mjs';
import { RecorderError } from './lib/recorder-error.mjs';
import { Machine, pngOf } from './lib/computer-host-world.mjs';

// The one id every screenshot file gets: the stand-in for the host's entropy source (`randomUUID`).
const SHOT_ID = '00000000-0000-4000-8000-000000000001';
crypto.randomUUID = () => SHOT_ID;
syncBuiltinESMExports();

const set = openSet('computer-linux-readiness', import.meta.url, { clock: false });
const mod = await set.load('src/runtime/computer-bridge/linux-readiness.mjs');
const caps = await set.load('src/runtime/computer-bridge/linux-action-capabilities.mjs');
const schema = await set.load('src/runtime/computer-bridge/action-schema.mjs');
const { executeComputerTool } = await set.load('src/runtime/computer-bridge/client.mjs');
const { resetLinuxComputerPreflightCache, detectSession, detectDesktop, MIN_WINDOW_HELPER_VERSION, GNOME_EXTENSION_UUID } = mod;

const GNOME = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' };
const KDE = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' };
const SWAY = { WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway', SWAYSOCK: '/run/sway.sock' };
const HYPRLAND = { WAYLAND_DISPLAY: 'wayland-1', HYPRLAND_INSTANCE_SIGNATURE: 'abc' };
const X11 = { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'GNOME' };
const NOT_INSTALLED = { installed: false, enabled: false };
const ALL_TOOLS = ['gdbus', 'wl-copy', 'wl-paste', 'tesseract'];
const HOME = '/home/u';
const W = 'hwnd:0x1';
const DISPLAY = { width: 2, height: 2 };
const SECOND_DISPLAY = { width: 3, height: 2 };
// What the GNOME extension's screenshot is: a real 2x2 PNG (zlib-compressed scanlines, CRCs).
const PIXELS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
const SCREENSHOT = pngOf(2, 2, PIXELS).toString('base64');
const EMPTY_SCREENSHOT = pngOf(0, 0, []).toString('base64');
const WINDOW = { id: W, title: 'Editor', class_name: 'gedit', app: 'gedit', pid: 100, focused: true, x: 0, y: 0, width: 2, height: 2 };
// Chromium's JPEG encoder is not in this process: the stand-in keeps the quality and the pixels it was given, so a frame differs by its quality.
const encodeJpeg = (png, quality) => Buffer.concat([Buffer.from(`STANDIN-JPEG q${quality}\n`), png]);

// The host commands of the pure `requiredCapabilities` case.
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

// The tool calls of the `computer` tool every session is asked, as a model sends them (nested `input`): what the preflight answers for a
// window, list, menu, clipboard or verify call, the diagnose, and every kind of capture. An `act` is not here.
const tool = (action, input = {}) => ({ action, input });
const TOOL_CALLS = [
  tool('launch', { app: 'gedit' }), tool('diagnose'),
  tool('list', { kind: 'windows' }), tool('list', { kind: 'apps' }),
  tool('window', { operation: 'focus', window_id: W }), tool('window', { operation: 'move', window_id: W, x: 1 }),
  tool('window', { operation: 'minimize', window_id: W }), tool('window', { operation: 'close', window_id: W }), tool('window', { operation: 'terminate', window_id: W }),
  tool('menu', { window_id: W, path: ['File'] }),
  tool('clipboard', { operation: 'read' }), tool('clipboard', { operation: 'write', text: 'x' }),
  tool('verify', { window_id: W, expect: [{ window_exists: true }] }),
  tool('capture'), tool('capture', { mode: 'state' }), tool('capture', { mode: 'state', include_ocr: true }),
  tool('capture', { mode: 'ax', window_id: W }), tool('capture', { mode: 'ax' }),
  tool('capture', { mode: 'vision', screen: 0 }), tool('capture', { mode: 'vision', screen: 1 }), tool('capture', { mode: 'vision' }),
  tool('capture', { mode: 'state', window_id: W }), tool('capture', { mode: 'state', app: 'gedit' }), tool('capture', { mode: 'vision', window_id: W }),
];
for (const args of TOOL_CALLS) {
  const error = schema.validateComputerToolArgs(args);
  if (error) throw new RecorderError(`TOOL_CALLS: ${JSON.stringify(args)} is refused by Node's validation (${error}): the recording must reach the preflight`);
}

// Each session: [name, base environment, what the machine has].
const SESSIONS = [
  ['gnome-bare', GNOME, { tools: ['gdbus', 'wl-copy', 'wl-paste'] }],
  ['gnome-helper-answering-no-uinput', GNOME, { windowCalls: true, tools: ALL_TOOLS }],
  ['gnome-everything', GNOME, { uinput: true, windowCalls: true, tools: ALL_TOOLS }],
  ['gnome-no-gdbus', GNOME, { uinput: true, tools: [] }],
  ['gnome-helper-older-than-needed', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION - 1, helper: { installed: true, enabled: true }, tools: ['gdbus'] }],
  ['gnome-helper-current', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION, tools: ['gdbus'] }],
  ['gnome-helper-newer', GNOME, { windowCalls: MIN_WINDOW_HELPER_VERSION + 4, helper: { installed: true, enabled: false }, tools: ['gdbus'] }],
  ['gnome-enabled-not-loaded', GNOME, { helper: { installed: true, enabled: true }, tools: ['gdbus'] }],
  ['gnome-enabled-not-loaded-system-wide', GNOME, { helper: { installed: true, enabled: true }, helperDir: 'system', tools: ['gdbus'] }],
  ['gnome-enabled-but-user-extensions-off', GNOME, { helper: { installed: true, enabled: true }, userExtensionsOff: true, tools: ['gdbus'] }],
  ['gnome-installed-not-enabled', GNOME, { helper: { installed: true, enabled: false }, tools: ['gdbus'] }],
  ['gnome-not-installed', GNOME, { helper: NOT_INSTALLED, tools: ['gdbus'] }],
  ['gnome-no-accessibility-bus', GNOME, { windowCalls: true, a11y: false, tools: ['gdbus'] }],
  ['gnome-no-session-bus', GNOME, { windowCalls: true, bus: false, tools: ['gdbus'] }],
  ['gnome-session-bus-by-address', GNOME, { windowCalls: true, busBy: 'address', uinput: true, tools: ALL_TOOLS }],
  ['gnome-screenshot-fails', GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS, screenshot: 'fails' }],
  ['gnome-screenshot-writes-no-file', GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS, screenshot: 'no-file' }],
  ['gnome-screenshot-empty-image', GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS, screenshot: 'empty' }],
  ['gnome-two-displays', GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS, displays: [DISPLAY, SECOND_DISPLAY] }],
  ['gnome-no-runtime-dir', GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS, bus: false, busBy: 'address', runtimeDir: false }],
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
  ['no-display', {}, { tools: ['gdbus'] }],
  ['empty-display', { DISPLAY: '' }, { tools: ['gdbus'] }],
  ['wayland-display-with-x11-session-type', { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, { tools: ['gdbus'] }],
  ['wayland-display-without-session-type-plasma', { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'plasma' }, { uinput: true, tools: ['gdbus'] }],
];

// The machine a session runs on, as data (it is written into the recording): the files and processes the probes read, the display, the
// windows and the screenshot the stand-ins answer. `windowCalls` true = a current helper, a number = that loaded version, false = nothing answers.
function worldOf(env, { displays = [DISPLAY], uinput = false, windowCalls = false, helper = NOT_INSTALLED, a11y = true, bus = true, busBy = 'socket', tools = [], helperDir = 'user', userExtensionsOff = false, screenshot = 'ok', runtimeDir = true }) {
  const socket = bus && busBy === 'socket';
  const extension = `${helperDir === 'system' ? '/usr/share' : `${HOME}/.local/share`}/gnome-shell/extensions/${GNOME_EXTENSION_UUID}/metadata.json`;
  return {
    env: {
      ...env, PATH: '/usr/bin', HOME,
      ...(socket || runtimeDir ? { XDG_RUNTIME_DIR: '/run/user/1000' } : {}),
      ...(bus && busBy === 'address' ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } : {}),
    },
    executables: tools.map((name) => `/usr/bin/${name}`),
    writable: uinput ? ['/dev/uinput'] : [],
    existing: [...(socket ? ['/run/user/1000/bus'] : []), ...(helper.installed ? [extension] : [])],
    windowVersion: windowCalls === true ? MIN_WINDOW_HELPER_VERSION : windowCalls || null,
    a11y,
    gsettings: { enabled: helper.enabled ? `['${GNOME_EXTENSION_UUID}']\n` : '@as []\n', disabled: `${userExtensionsOff}\n` },
    displays,
    shotId: SHOT_ID,
    // The scripted `mixdog-computer`: its answer to each request action it is asked; any other action is answered as an error.
    helperReplies: {
      window_snapshot: { windows: [WINDOW] },
      list_windows: { windows: [WINDOW] },
      ocr_status: { available: false, requested_language: null, active_language: null, installed_languages: [] },
      accessibility_probe: { interactive: true },
      input_idle_state: { observer_ready: true, desktop_ready: true, ready: true, held: false, idleMs: 120, monitor: 'monitor-1', sequence: 7 },
    },
    screenshot: { how: screenshot, png: SCREENSHOT, emptyPng: EMPTY_SCREENSHOT },
  };
}

/** The Machine's world for a recorded one: its executables, paths, files, and the answers of the programs and of the helper. */
function liveWorld(data) {
  const world = {
    ...structuredClone(data),
    files: {},
    tools(command, args) {
      if (command === 'gdbus') {
        if (args.includes('Version')) return world.windowVersion === null ? { status: 1 } : { status: 0, out: `(<uint32 ${world.windowVersion}>,)\n` };
        if (args.includes('org.a11y.Bus.GetAddress')) return world.a11y ? { status: 0, out: "('unix:path=/run/user/1000/at-spi/bus',)\n" } : { status: 1 };
        if (args.some((arg) => String(arg).endsWith('.Screenshot'))) {
          const { how, png, emptyPng } = world.screenshot;
          if (how === 'fails') return { status: 1, stderr: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.gnome.Shell was not provided by any .service files\n' };
          const file = String(args.at(-1)).slice(1, -1);
          // The extension photographs the area it is asked for: the picture has that area's size.
          const [kind, , , , width, height] = args.slice(args.indexOf('--') + 1);
          const area = kind === "'area'" && Number(width) > 0 && Number(height) > 0
            ? pngOf(Number(width), Number(height), Array.from({ length: Number(width) * Number(height) }, (_, at) => PIXELS[at % PIXELS.length])).toString('base64')
            : png;
          if (how !== 'no-file') world.files[file] = Buffer.from(how === 'empty' ? emptyPng : area, 'base64');
          return { status: 0, out: '()\n' };
        }
        return { status: 1 };
      }
      if (command === 'gsettings') {
        if (args[1] === 'org.gnome.shell' && args[2] === 'enabled-extensions') return { status: 0, out: world.gsettings.enabled };
        if (args[1] === 'org.gnome.shell' && args[2] === 'disable-user-extensions') return { status: 0, out: world.gsettings.disabled };
        return { status: 1 };
      }
      return null;
    },
  };
  return world;
}

// The scripted helper answers from the world's data (the replay answers the same).
const helperFor = (data) => (request) => {
  const answer = data.helperReplies[request.action];
  return answer === undefined ? { ok: false, error: `unscripted helper action ${request.action}` } : { ok: true, result: answer };
};

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-linux-readiness-'));
let currentData = null;
const machine = new Machine({ dataDir: DATA_DIR, helper: (request) => helperFor(currentData)(request), encodeJpeg });
const resultOf = ({ content, isError, toolMeta }) => ({ content, ...(isError ? { isError } : {}), ...(toolMeta ? { toolMeta } : {}) });

// Electron is a stand-in module the first install registers; the host's modules load after it.
currentData = worldOf(GNOME, {});
const restoreFirst = machine.install(liveWorld(currentData), 'linux');
const { createComputerHost } = await set.load('apps/desktop/src/main/computer/index.ts');
restoreFirst();
const { readDisplays } = await set.load('apps/desktop/src/main/computer/host/display-reads.ts');

/** A host on the machine, its bridge listening and published; `finish` takes it down and the machine with it. */
async function withHost(data, platform, body, { keepCache = false } = {}) {
  currentData = data;
  const world = liveWorld(data);
  const restore = machine.install(world, platform);
  machine.reset();
  if (!keepCache) resetLinuxComputerPreflightCache();
  let listening;
  const ready = new Promise((resolve) => { listening = resolve; });
  const host = createComputerHost({ bridgeEnabled: true, onDiagnostic: (event) => { if (event === 'computer-bridge-listening') listening(); } });
  try {
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    return await body();
  } finally {
    await host.dispose();
    restore();
    if (!keepCache) resetLinuxComputerPreflightCache();
  }
}

// The commands the client posts to the host's bridge (the real fetch still carries them) and the bridge's answer to each: a capture is the
// capture of a screen when the command the client sent names a screen and no window. The machine's events up to the first post are the
// client's own (its preflight); the ones after it are the desktop host's.
const realFetch = globalThis.fetch;
let posted = [];
let answers = [];
let hostFrom = null;
globalThis.fetch = async (url, options) => {
  if (options?.body) {
    if (!posted.length) hostFrom = machine.events.length;
    posted.push(JSON.parse(options.body));
  }
  const response = await realFetch(url, options);
  if (options?.body) answers.push(await response.clone().json());
  return response;
};

/**
 * The bridge answer with the time the host measured for each step set to 0: `elapsed_ms` of a capture attempt and the `timings_ms` of a reply
 * are wall-clock milliseconds of the host's code (they differ by run), and the client drops both from the text the model reads.
 */
function settleTimes(answer) {
  if (typeof answer?.value?.text !== 'string') return answer;
  const settle = (value, timed) => {
    if (Array.isArray(value)) return value.map((item) => settle(item, timed));
    if (value === null || typeof value !== 'object') return timed && typeof value === 'number' ? 0 : value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settle(item, timed || key === 'timings_ms' || key === 'elapsed_ms')]));
  };
  return { ...answer, value: { ...answer.value, text: JSON.stringify(settle(JSON.parse(answer.value.text), false)) } };
}

/**
 * One tool call: its result and everything the machine was asked, in order. A capture of a screen ends at the desktop host: `host` is the
 * command it was sent and the bridge's answer (`{ ok, value }` or `{ ok, error }`), `events` the client's own and `hostEvents` the host's.
 */
async function call(args, sessionId) {
  machine.reset();
  posted = [];
  answers = [];
  hostFrom = null;
  const result = await executeComputerTool(args, sessionId ? { sessionId } : {});
  const [command] = posted;
  const screen = command?.action === 'capture' && command.screen !== undefined && !command.window_id && !command.app;
  if (!screen) return { result: resultOf(result), events: machine.events, screen };
  return {
    result: resultOf(result), events: machine.events.slice(0, hostFrom), hostEvents: machine.events.slice(hostFrom), screen,
    host: { command, answer: settleTimes(answers[0]) },
  };
}


await set.run('the commands every session is asked about', () => COMMANDS);
await set.run('the tool calls every session is asked', () => TOOL_CALLS);
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

// A call the preflight lets through runs the desktop host's own layers (window arrivals, idle checks, element state) that the core does not
// have: those are not recorded, except the two the core asks of the desktop host: the capture of a screen and the display list of a diagnose.
const passedThrough = [];
for (const [name, env, options] of SESSIONS) {
  await set.run(`session ${name}`, async () => {
    const world = worldOf(env, options);
    const calls = [];
    for (const args of TOOL_CALLS) {
      const outcome = await withHost(world, 'linux', () => call(args, ''));
      const passed = outcome.result.toolMeta === undefined;
      if (!passed || args.action === 'diagnose' || outcome.screen) calls.push({ args, ...outcome });
      else passedThrough.push(`${name} / ${JSON.stringify(args)}`);
    }
    // The display list the host answers `host/computer/displays` with: its own `readDisplays()`.
    const hostDisplays = await withHost(world, 'linux', async () => readDisplays());
    return { world, hostDisplays, calls };
  });
}

// No desktop attached: no bridge is published, and Node's client refuses before it validates, probes or dispatches anything.
await set.run('no desktop attached', async () => {
  const world = worldOf(GNOME, { windowCalls: true, uinput: true, tools: ALL_TOOLS });
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-no-desktop-'));
  const dataDir = machine.dataDir;
  machine.dataDir = emptyDir;
  const calls = [];
  try {
    for (const args of [tool('capture', { mode: 'vision', screen: 0 }), tool('capture', { mode: 'vision', screen: 1 }), tool('diagnose')]) {
      currentData = world;
      const restore = machine.install(liveWorld(world), 'linux');
      resetLinuxComputerPreflightCache();
      try {
        calls.push({ args, ...(await call(args, '')) });
      } finally {
        restore();
      }
    }
  } finally {
    machine.dataDir = dataDir;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
  return { world, calls };
});

// One probe for the whole process: the calls of two sessions inside its 3 s share it; the first call past it asks again. Each call runs on its
// own host (the probe's cache lives in the module, not in the host), one after the other.
await set.run('the probe is shared by two sessions inside 3 seconds and asked again after', async () => {
  const world = worldOf(GNOME, { windowCalls: true, tools: ALL_TOOLS });
  const diagnose = tool('diagnose');
  const steps = [
    { at: 1000, uinput: false, sessions: ['s1', 's2'] },
    { at: 3900, uinput: true, sessions: ['s2'] },
    { at: 4100, uinput: true, sessions: ['s1', 's2', 's2'] },
    { at: 4100, uinput: false, sessions: ['s1'] },
    { at: 7200, uinput: false, sessions: ['s2'] },
  ];
  resetLinuxComputerPreflightCache();
  const rows = [];
  for (const { at, uinput, sessions } of steps) {
    const calls = [];
    for (const sessionId of sessions) {
      const stepWorld = { ...world, writable: uinput ? ['/dev/uinput'] : [] };
      calls.push({ sessionId, ...(await withHost(stepWorld, 'linux', () => { machine.clock = at; return call(diagnose, sessionId); }, { keepCache: true })) });
    }
    rows.push({ at, uinput, calls });
  }
  resetLinuxComputerPreflightCache();
  const hostDisplays = await withHost(world, 'linux', async () => readDisplays());
  return { world, hostDisplays, call: diagnose, steps: rows };
});

fs.rmSync(DATA_DIR, { recursive: true, force: true });
await set.finish({
  entry: 'computer-bridge/client.mjs executeComputerTool (validation, linuxCaptureFallback, linuxComputerPreflight, the dispatch and the fallback note) over the desktop host apps/desktop/src/main/computer (createComputerHost, its loopback bridge, diagnose, the capture engine and its GNOME shell source), over linux-readiness.mjs probing its own machine (process.env, fs.accessSync/existsSync/readFileSync, child_process.spawn/execFile gdbus/gsettings, Date.now); detectSession, detectDesktop; linux-action-capabilities.mjs requiredCapabilities',
  replay: { entry: 'mixdog-tools desktop::computer_linux tests: each recorded tool call through ProcessComputerBackend::run on the Linux path (probes, gdbus and the helper injected at the process manager, the environment, the 3 s cache on the runtime clock, one cache for every session), with the desktop standing for the one the recorder ran (it answers host/computer/capture with the bridge answer the recorder saw, and host/computer/displays with the readDisplays() it recorded), compared whole with the recorded outcome (error flag, every content block with the image media type, bytes, width and height, the gdbus/gsettings invocations and helper requests in order, the command the desktop was sent); detect_session/detect_desktop, required_capabilities', normalised: {} },
  exclusions: {
    hostLayer: `a call the preflight lets through that is not a capture of a screen or a diagnose runs the desktop host's own layers (window arrivals, idle checks, element state, about 40 helper requests for a launch); that layer is a separate task and these calls are not recorded. Calls dropped: ${passedThrough.length}, case by case: ${JSON.stringify(passedThrough)}`,
    hostEvents: "a capture of a screen ends at the desktop host, so the gdbus / gsettings invocations and helper requests the host made while taking it are recorded as `hostEvents` and not replayed: the core does not make them (it asks the host); `events` holds only the client's own, up to the command's post. A diagnose is composed by the core from the helper's own reads, so its events are all compared.",
    timings: "the milliseconds the desktop host measured for its own steps (`elapsed_ms` of each capture attempt, `timings_ms` of a reply) differ by run: in the recorded bridge answer (`host.answer`) every number under those keys is 0. The client removes both from the text the model reads, so the tool result (`result`) is the real one.",
    hostStandIn: "the host that took each capture is Node's real desktop host with Electron replaced by the recorder's stand-in (lib/computer-host-world.mjs): its `toJPEG(quality)` keeps the PNG it was given behind a `STANDIN-JPEG q<quality>` line, so the recorded JPEG bytes are Node's fit-and-encode path run over that stand-in, not Chromium's. The core passes the host's reply on unchanged, so the bytes are compared as recorded; they say nothing about Chromium's encoder.",
    noDesktop: "with no desktop attached Node refuses every call before it validates (client.mjs dispatchComputerCommand); only the calls the core sends to the desktop (a capture of a screen, a diagnose) are recorded in that state. The core runs every other action on its own helper with no desktop, and that is not recorded.",
    gnomeCaptureLimit: "the 12 s GNOME_SHELL_CAPTURE_TIMEOUT_MS runs inside the desktop host (capture-source-plan.ts), where the pixels are taken; the core no longer takes them, so a timeout of the shell is the host's reply and is not recorded (a hanging gdbus would need 12 real seconds of Node). The core's own bound is the client's REQUEST_TIMEOUT_MS of 150 s, the capability's deadline, covered by a unit test.",
    randomUUID: `crypto.randomUUID returns ${SHOT_ID} for every call (the screenshot file name); the replay's id source gives the same`,
    platform: 'process.platform is set to linux for each case: the recorder runs on Windows. Another platform is not recorded: the preflight does not run there, and its host answers through Electron (the stand-in has no systemPreferences), which the core does not have',
    probeCache: 'the concurrent calls of one instant are not recorded: their helper requests interleave in an order the replay cannot reproduce; the calls of the 3 s window are sequential',
    machine: 'the machine under the probes is virtual (environment, executables, writable and existing paths, gdbus/gsettings answers, the helper, the display, the windows); the Rust side reads the same world through its process manager',
  },
});
process.exit(0);
