import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GNOME_EXTENSION_UUID = 'mixdog-windows@mixdog.io';
/** The oldest helper interface this app can use (2 added Screenshot and StopRequested, 3 the in-shell indicator). */
const MIN_WINDOW_HELPER_VERSION = 3;
const READY = Object.freeze({ state: 'ready' });

function onPath(name, env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

// A read-only gdbus call: its stdout, or null when it fails or times out.
function gdbusOutput(env, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gdbus', ['call', '--session', ...args], {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve(status === 0 ? out : null);
    });
  });
}

const gdbusSucceeds = async (env, args, timeoutMs) => (await gdbusOutput(env, args, timeoutMs)) !== null;

// Asks our own interface for its Version property: read-only, never prompts.
// The version the shell actually loaded, or null when nothing answers.
async function gnomeWindowHelperVersion(env) {
  const out = await gdbusOutput(env, [
    '--dest',
    'org.gnome.Shell',
    '--object-path',
    '/io/mixdog/Windows',
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    'io.mixdog.Windows',
    'Version',
  ]);
  const version = /uint32 (\d+)/.exec(out ?? '');
  return version ? Number(version[1]) : null;
}

function gsettingsOutput(env, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gsettings', args, { env, stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve('');
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Where GNOME Shell looks for our extension: system-wide (the .deb) or per user. */
function gnomeExtensionDirs(env = process.env) {
  const home = env.HOME || '';
  const data = env.XDG_DATA_HOME || (home ? path.join(home, '.local', 'share') : '');
  return [
    ...(data ? [path.join(data, 'gnome-shell', 'extensions', GNOME_EXTENSION_UUID)] : []),
    path.join('/usr/share/gnome-shell/extensions', GNOME_EXTENSION_UUID),
  ];
}

/** Whether our extension is on disk and listed as enabled (not whether the shell loaded it). */
async function gnomeWindowHelperStatus(env) {
  const installed = gnomeExtensionDirs(env).some((dir) => fs.existsSync(path.join(dir, 'metadata.json')));
  if (!installed) return { installed: false, enabled: false };
  const list = await gsettingsOutput(env, ['get', 'org.gnome.shell', 'enabled-extensions']);
  const disabledAll = /true/.test(await gsettingsOutput(env, ['get', 'org.gnome.shell', 'disable-user-extensions']));
  return { installed, enabled: list.includes(`'${GNOME_EXTENSION_UUID}'`) && !disabledAll };
}

function accessibilityBusReachable(env) {
  return gdbusSucceeds(env, [
    '--dest',
    'org.a11y.Bus',
    '--object-path',
    '/org/a11y/bus',
    '--method',
    'org.a11y.Bus.GetAddress',
  ]);
}

// zbus (the native client) reaches the session bus through this address or the
// per-user socket; without either there is nothing to ask.
function sessionBusPresent(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  try {
    return Boolean(env.XDG_RUNTIME_DIR) && fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'bus'));
  } catch {
    return false;
  }
}

/** Same rule as native platform::linux::wayland_session(). */
export function detectSession(env) {
  const wayland =
    env.WAYLAND_DISPLAY !== undefined && (env.XDG_SESSION_TYPE === undefined || env.XDG_SESSION_TYPE === 'wayland');
  return wayland ? 'wayland' : 'x11';
}

export function detectDesktop(env, session) {
  if (session === 'wayland') {
    if (env.SWAYSOCK !== undefined) return 'sway';
    if (env.HYPRLAND_INSTANCE_SIGNATURE !== undefined) return 'hyprland';
  }
  const desktop = String(env.XDG_CURRENT_DESKTOP || '');
  if (/gnome/i.test(desktop)) return 'gnome';
  if (/kde|plasma/i.test(desktop)) return 'kde';
  if (/sway/i.test(desktop)) return 'sway';
  if (/hyprland/i.test(desktop)) return 'hyprland';
  return 'other';
}

const needsPackage = (name, extra = {}) => ({ state: 'needs_setup', fix: 'install_package', package: name, ...extra });

async function windowsCapability({ env, session, hasCommand, windowHelperVersion, windowHelperStatus }) {
  if (session === 'x11') return READY;
  // Same order as native Compositor::detect().
  if (env.SWAYSOCK !== undefined) return hasCommand('swaymsg') ? READY : needsPackage('sway');
  if (env.HYPRLAND_INSTANCE_SIGNATURE !== undefined) return hasCommand('hyprctl') ? READY : needsPackage('hyprland');
  if (/gnome/i.test(String(env.XDG_CURRENT_DESKTOP || ''))) {
    // Without gdbus the extension cannot be probed (the native client talks to
    // D-Bus itself), so this is unknown rather than missing.
    if (!hasCommand('gdbus')) return { state: 'unknown' };
    const loaded = await windowHelperVersion();
    // A shell that loaded an older copy keeps running it until the next sign-in.
    if (loaded !== null) return loaded >= MIN_WINDOW_HELPER_VERSION ? READY : { state: 'needs_setup', fix: 'relogin' };
    // Not answering: either the shell has not loaded a freshly enabled
    // extension yet (a sign-in fixes that) or it is not enabled at all.
    const status = await windowHelperStatus();
    return { state: 'needs_setup', fix: status.installed && status.enabled ? 'relogin' : 'enable_window_helper' };
  }
  return { state: 'unsupported' };
}

async function accessibilityCapability({ hasCommand, hasSessionBus, accessibilityReachable }) {
  if (!hasSessionBus() || !hasCommand('gdbus')) return { state: 'unknown' };
  return (await accessibilityReachable()) ? READY : needsPackage('at-spi2-core');
}

const optional = (capability) => ({ ...capability, optional: true });

function writable(file) {
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function noDisplayReadiness(session, desktop) {
  const none = { state: 'unsupported' };
  return {
    session,
    desktop,
    capabilities: {
      capture: none,
      windows: none,
      accessibility: none,
      semanticActions: none,
      pointer: none,
      keyboard: none,
      clipboard: optional(none),
      ocr: optional(none),
    },
  };
}

/**
 * Per-capability readiness of this Linux session. Capabilities report
 * 'unknown' when they cannot be probed without side effects; only
 * 'needs_setup' and 'unsupported' ever block an action.
 * @returns {Promise<{
 *   session: 'wayland'|'x11',
 *   desktop: 'gnome'|'kde'|'sway'|'hyprland'|'other',
 *   capabilities: Record<string, {state: 'ready'|'needs_setup'|'unsupported'|'unknown', fix?: string, package?: string, optional?: boolean}>
 * }>}
 */
export async function checkLinuxComputerReadiness({
  env = process.env,
  canWrite = writable,
  hasCommand = (name) => onPath(name, env),
  hasSessionBus = () => sessionBusPresent(env),
  windowHelperVersion = () => gnomeWindowHelperVersion(env),
  windowHelperStatus = () => gnomeWindowHelperStatus(env),
  accessibilityReachable = () => accessibilityBusReachable(env),
} = {}) {
  const session = detectSession(env);
  const desktop = detectDesktop(env, session);
  if (session === 'x11' && !env.DISPLAY) return noDisplayReadiness(session, desktop);
  const wayland = session === 'wayland';
  const windows = await windowsCapability({ env, session, hasCommand, windowHelperVersion, windowHelperStatus });
  const accessibility = await accessibilityCapability({ env, hasCommand, hasSessionBus, accessibilityReachable });
  const input = !wayland || canWrite('/dev/uinput') ? READY : { state: 'needs_setup', fix: 'allow_input' };
  const clipboard =
    !wayland || (hasCommand('wl-copy') && hasCommand('wl-paste')) ? READY : needsPackage('wl-clipboard');
  return {
    session,
    desktop,
    capabilities: {
      // GNOME Wayland pixels come from our shell extension (no portal, never a
      // prompt), so they are ready exactly when the helper is. Other Wayland
      // desktops use the desktop portal, which only prompts when used and so
      // cannot be probed.
      capture: wayland ? (desktop === 'gnome' ? windows : { state: 'unknown' }) : READY,
      windows,
      accessibility,
      // AT-SPI actions act on an accessible found through a window handle.
      semanticActions: windows.state === 'ready' ? accessibility : windows,
      pointer: input,
      keyboard: input,
      clipboard: optional(clipboard),
      ocr: optional(hasCommand('tesseract') ? READY : needsPackage('tesseract-ocr')),
    },
  };
}

const CACHE_MS = 3000;
let cached = null;

/** Probed at most once per few seconds so a fix is noticed on the next call. */
export function getLinuxComputerReadiness({ check = checkLinuxComputerReadiness, now = Date.now } = {}) {
  if (!cached || now() - cached.at > CACHE_MS) {
    const entry = { at: now(), result: Promise.resolve().then(() => check()) };
    cached = entry;
    entry.result.catch(() => {
      if (cached === entry) cached = null;
    });
  }
  return cached.result;
}
