#!/usr/bin/env node
// Recording of the Linux Computer Use preflight (b6f10295a, computer-bridge/linux-readiness.mjs) as the product runs it: every call goes
// through Node's real `executeComputerTool` (client.mjs: argument validation, `linuxCaptureFallback`, `linuxComputerPreflight`, the dispatch to
// the bridge and the fallback note) with Node's OWN probing code running, unreplaced: `checkLinuxComputerReadiness` reads `process.env`, asks
// `fs.accessSync` / `fs.existsSync` (PATH, /dev/uinput, the session bus socket, the GNOME extension's files) and `child_process.spawn`
// (`gdbus`, `gsettings`) and times its 3 s cache with `Date.now`. What stands in for the machine is only what those read: a virtual
// world (environment, executables, writable and existing paths, the answers of gdbus and gsettings), `process.platform`, `Date.now`,
// and the HTTP bridge (`fetch`), which records the command the client dispatches and answers `ok`.
// Over each of 30 sessions every tool call is made with a fresh cache and the outcome kept whole (the tool result, the commands dispatched
// to the bridge, the gdbus/gsettings processes spawned); plus the platforms that are not Linux, and the probe cache shared by two
// sessions inside and after its 3 s. The pure decision functions keep their cases: session/desktop detection, requiredCapabilities.
//
//   node benchmarks/rust-core/recorders/record-computer-linux-readiness.mjs --tree <export of b6f10295a with node_modules>
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openSet } from './lib/case-set.mjs';
import { RecorderError } from './lib/recorder-error.mjs';

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
// What the virtual desktop host's screenshot is: a real 2x2 PNG (zlib-compressed scanlines, CRCs), so the image the tool returns is compared byte for byte.
const SCREENSHOT = { mimeType: 'image/png', data: pngOf(2, 2, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]]) };

function pngOf(width, height, pixels) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.from([0, ...pixels.slice(y * width, (y + 1) * width).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

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

// The tool calls of the `computer` tool every session is asked, as a model sends them (nested `input`).
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
  tool('act', { window_id: W, frame_id: 'f1', actions: [{ type: 'click', x: 1, y: 2 }] }),
  tool('act', { window_id: W, actions: [{ type: 'key', keys: 'enter' }] }),
  tool('act', { window_id: W, actions: [{ type: 'click', ref: 'e1' }] }),
  tool('act', { window_id: W, actions: [{ type: 'click', element: 9 }] }),
  tool('act', { window_id: W, actions: [{ type: 'type', ref: 'e3', text: 'v' }] }),
  tool('act', { window_id: W, delivery: 'foreground', actions: [{ type: 'type', ref: 'e3', text: 'v' }] }),
  tool('act', { window_id: W, actions: [{ type: 'type', text: 'a' }] }),
  tool('act', { window_id: W, actions: [{ type: 'set_value', ref: 'e3', value: 'v' }] }),
  tool('act', { window_id: W, frame_id: 'f1', actions: [{ type: 'scroll', x: 1, y: 1, direction: 'down' }] }),
  tool('act', { window_id: W, frame_id: 'f1', actions: [{ type: 'drag', x: 1, y: 1, to_x: 2, to_y: 2 }] }),
  tool('act', { window_id: W, frame_id: 'f1', actions: [{ type: 'click', x: 1, y: 2 }, { type: 'type', text: 'a' }, { type: 'set_value', ref: 'e3', value: 'v' }] }),
  tool('act', { app: 'gedit', actions: [{ type: 'key', keys: 'a' }] }),
  tool('act', { window_id: W, observe: 'ax', actions: [{ type: 'key', keys: 'a' }] }),
  tool('act', { window_id: W, delivery: 'foreground', actions: [{ type: 'key', keys: 'ctrl+a' }, { type: 'wait', duration: 1 }] }),
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

// The machine a session runs on, as the files and processes the probes read: `windowCalls` true = a current helper, a number = that
// loaded version, false = nothing answers.
function worldOf(env, { uinput = false, windowCalls = false, helper = NOT_INSTALLED, a11y = true, bus = true, busBy = 'socket', tools = [], helperDir = 'user', userExtensionsOff = false }) {
  const socket = bus && busBy === 'socket';
  const extension = `${helperDir === 'system' ? '/usr/share' : `${HOME}/.local/share`}/gnome-shell/extensions/${GNOME_EXTENSION_UUID}/metadata.json`;
  return {
    env: { ...env, PATH: '/usr/bin', HOME, ...(socket ? { XDG_RUNTIME_DIR: '/run/user/1000' } : {}), ...(bus && busBy === 'address' ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' } : {}) },
    executables: tools.map((name) => `/usr/bin/${name}`),
    writable: uinput ? ['/dev/uinput'] : [],
    existing: [...(socket ? ['/run/user/1000/bus'] : []), ...(helper.installed ? [extension] : [])],
    windowVersion: windowCalls === true ? MIN_WINDOW_HELPER_VERSION : windowCalls || null,
    a11y,
    gsettings: { enabled: helper.enabled ? `['${GNOME_EXTENSION_UUID}']\n` : '@as []\n', disabled: `${userExtensionsOff}\n` },
    image: SCREENSHOT,
  };
}

// --- the stand-in for the machine ---
const machine = { world: null, clock: 0, spawns: [], dispatched: [] };
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-linux-readiness-'));
fs.writeFileSync(path.join(DATA_DIR, 'computer-bridge.json'), JSON.stringify({ version: 1, port: 12345, token: 'synthetic-linux-readiness' }));
const CLOCK_ORIGIN = Date.now();
const posix = (file) => String(file).replaceAll('\\', '/');
const virtual = (file) => posix(file).startsWith('/');
const missing = (file) => Object.assign(new Error(`ENOENT: no such file or directory, access '${file}'`), { code: 'ENOENT' });

function answerOf(world, command, args) {
  if (command === 'gdbus') {
    if (args.includes('Version')) return world.windowVersion === null ? { status: 1 } : { status: 0, out: `(<uint32 ${world.windowVersion}>,)\n` };
    if (args.includes('org.a11y.Bus.GetAddress')) return world.a11y ? { status: 0, out: "('unix:path=/run/user/1000/at-spi/bus',)\n" } : { status: 1 };
    return { status: 1 };
  }
  if (command === 'gsettings') {
    if (args[1] === 'org.gnome.shell' && args[2] === 'enabled-extensions') return { status: 0, out: world.gsettings.enabled };
    if (args[1] === 'org.gnome.shell' && args[2] === 'disable-user-extensions') return { status: 0, out: world.gsettings.disabled };
    return { status: 1 };
  }
  return null;
}

function standInSpawn(command, args) {
  machine.spawns.push([command, ...args]);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const answer = answerOf(machine.world, command, args);
  setImmediate(() => {
    if (!answer) return child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
    if (answer.out) child.stdout.emit('data', answer.out);
    child.emit('close', answer.status);
  });
  return child;
}

/** Runs `body` on the virtual machine: Node's probing code reads these in place of the real ones. */
async function onMachine(world, platform, body) {
  const saved = {
    access: fs.accessSync, exists: fs.existsSync, spawn: childProcess.spawn, env: process.env, now: Date.now, fetch: globalThis.fetch,
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  };
  machine.world = world;
  machine.clock = 0;
  fs.accessSync = (file, mode) => {
    if (!virtual(file)) return saved.access(file, mode);
    const held = mode === fs.constants.X_OK ? machine.world.executables : machine.world.writable;
    if (!held.includes(posix(file))) throw missing(file);
  };
  fs.existsSync = (file) => (virtual(file) ? machine.world.existing.includes(posix(file)) : saved.exists(file));
  childProcess.spawn = standInSpawn;
  syncBuiltinESMExports();
  process.env = { ...world.env, MIXDOG_DATA_DIR: DATA_DIR };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Date.now = () => CLOCK_ORIGIN + machine.clock;
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    machine.dispatched.push(command);
    // The desktop host's screenshot rides on a capture that is not accessibility-only and on a sequence that observes its window afterwards.
    const observes = command.action === 'capture' ? command.mode !== 'ax' : command.action === 'sequence' && (command.window_id || command.app) && command.capture_after_mode !== 'ax';
    return Response.json({ ok: true, value: { text: 'ok', ...(observes ? { image: machine.world.image } : {}) } });
  };
  try {
    return await body();
  } finally {
    fs.accessSync = saved.access;
    fs.existsSync = saved.exists;
    childProcess.spawn = saved.spawn;
    syncBuiltinESMExports();
    process.env = saved.env;
    Object.defineProperty(process, 'platform', saved.platform);
    Date.now = saved.now;
    globalThis.fetch = saved.fetch;
  }
}

const resultOf = ({ content, isError, toolMeta }) => ({ content, ...(isError ? { isError } : {}), ...(toolMeta ? { toolMeta } : {}) });

/** One tool call: its result, the commands it dispatched to the bridge, the gdbus/gsettings processes it spawned. */
async function call(args, sessionId) {
  machine.spawns = [];
  machine.dispatched = [];
  const result = await executeComputerTool(args, sessionId ? { sessionId } : {});
  return { result: resultOf(result), dispatched: machine.dispatched, spawns: machine.spawns };
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

for (const [name, env, options] of SESSIONS) {
  await set.run(`session ${name}`, async () => {
    const world = worldOf(env, options);
    const calls = await onMachine(structuredClone(world), 'linux', async () => {
      const out = [];
      for (const args of TOOL_CALLS) {
        resetLinuxComputerPreflightCache();
        out.push(await call(args, ''));
      }
      return out;
    });
    resetLinuxComputerPreflightCache();
    return { world, calls };
  });
}

await set.run('a platform that is not linux is never blocked and never rewritten', async () => {
  const world = worldOf(GNOME, { tools: ['gdbus'] });
  const out = [];
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    await onMachine(structuredClone(world), platform, async () => {
      for (const args of [TOOL_CALLS[24], TOOL_CALLS[13], TOOL_CALLS[2]]) {
        resetLinuxComputerPreflightCache();
        out.push({ platform, args, ...(await call(args, '')) });
      }
    });
  }
  resetLinuxComputerPreflightCache();
  return { world, calls: out };
});

// One probe for the whole process: two sessions inside its 3 s (and the concurrent calls of one instant) share it; the first call past it asks again.
await set.run('the probe is shared by two sessions inside 3 seconds and asked again after', async () => {
  const world = worldOf(GNOME, { windowCalls: true, tools: ALL_TOOLS });
  const click = tool('act', { window_id: W, frame_id: 'f1', actions: [{ type: 'click', x: 1, y: 2 }] });
  const steps = [
    { at: 1000, uinput: false, sessions: ['s1', 's2'] },
    { at: 3900, uinput: true, sessions: ['s2'] },
    { at: 4100, uinput: true, sessions: ['s1', 's2', 's2'] },
    { at: 4100, uinput: false, sessions: ['s1'] },
    { at: 7200, uinput: false, sessions: ['s2'] },
  ];
  resetLinuxComputerPreflightCache();
  const out = await onMachine(structuredClone(world), 'linux', async () => {
    const rows = [];
    for (const { at, uinput, sessions } of steps) {
      machine.clock = at;
      machine.world.writable = uinput ? ['/dev/uinput'] : [];
      machine.spawns = [];
      machine.dispatched = [];
      const results = await Promise.all(sessions.map((sessionId) => executeComputerTool(click, { sessionId })));
      rows.push({ at, uinput, sessions, results: results.map(resultOf), dispatches: machine.dispatched.length, spawns: machine.spawns });
    }
    return rows;
  });
  resetLinuxComputerPreflightCache();
  return { world, call: click, steps: out };
});

fs.rmSync(DATA_DIR, { recursive: true, force: true });
await set.finish({
  entry: 'computer-bridge/client.mjs executeComputerTool (validation, linuxCaptureFallback, linuxComputerPreflight, the dispatch and the fallback note), over linux-readiness.mjs probing its own machine (process.env, fs.accessSync/existsSync, child_process.spawn gdbus/gsettings, Date.now); detectSession, detectDesktop; linux-action-capabilities.mjs requiredCapabilities',
  replay: { entry: 'mixdog-tools desktop::computer_linux tests: each recorded tool call through ProcessComputerBackend::run on the Linux path (probes injected at the process manager and environment, the 3 s cache on the runtime clock, one cache for every session), compared whole with the recorded outcome; detect_session/detect_desktop, required_capabilities', normalised: {} },
  exclusions: {
    bridge: 'the desktop bridge is a stand-in HTTP endpoint (fetch) that records the dispatched command and answers ok, with a real 2x2 PNG screenshot for a capture that is not accessibility-only and for a sequence that observes its window; the desktop host is not run',
    layers: 'Node dispatches one command per tool call to the desktop host, which does its own steps; Rust drives the helper step by step. The replay therefore derives the helper requests from each recorded dispatched command (sequence = one request per step then the observing capture; capture = snapshot then window_capture; diagnose = the two probes; list_apps/verify renamed) and compares them whole; the content is compared whole except that the text of an act (composed by the host in Node, by the client in Rust from the stand-in answers) is not compared, and a diagnose answers once per probe',
    platform: 'process.platform is set to linux (or the named platform) for each case: the recorder runs on Windows',
    machine: 'the machine under the probes is virtual (environment, executables, writable and existing paths, gdbus/gsettings answers); the Rust side reads the same world through its process manager, where Node reads it through fs and spawn, so the shell checks Rust uses for PATH/uinput/files are answered from that world and only the gdbus/gsettings spawns are compared one to one',
    notRecorded: 'the recording keeps no readiness object: a session is judged by what the tool returned and dispatched',
  },
});
process.exit(0);
