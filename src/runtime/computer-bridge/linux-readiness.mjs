// Linux Computer Use prerequisites, probed per capability BEFORE a task starts
// so a missing permission or helper yields one actionable message naming what
// is missing instead of a failure or hang mid-task. Probes never prompt: they
// read the environment, test file access and PATH, and ask D-Bus read-only
// questions. The wording mirrors the native hints in native/mixdog-computer
// (uinput.rs PERMISSION_HINT, compositor.rs supported, apps.rs TESSERACT_HINT /
// CLIPBOARD_HINT, atspi.rs connect).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { requiredCapabilities } from './linux-action-capabilities.mjs';

export const UINPUT_HINT =
  'input_unavailable: Wayland input needs write access to /dev/uinput; add the udev rule `KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"`, add your user to the input group, then sign in again';
export const INPUT_GROUP_SECURITY_NOTE =
  'Security note: membership of the input group lets every program you run read and inject keyboard and mouse input system-wide. Grant it only on a machine and account you trust.';
export const WINDOW_CONTROL_HINT =
  'wayland_window_control_unavailable: this compositor offers no window control to other programs; on GNOME install and enable the Window Calls extension';
export const WINDOW_CONTROL_UNSUPPORTED_HINT =
  'wayland_window_control_unavailable: this desktop offers no window control to other programs (supported: GNOME with the Window Calls extension, sway, Hyprland, or an X11 session); screen, pointer, keyboard and clipboard still work';
export const ACCESSIBILITY_HINT =
  'accessibility_unavailable: the AT-SPI bus is not running; install at-spi2-core';
export const TESSERACT_HINT =
  'ocr_unavailable: install Tesseract (for example `sudo apt install tesseract-ocr tesseract-ocr-kor`) to read text from pixels';
export const CLIPBOARD_HINT =
  'clipboard_unavailable: install wl-clipboard (`wl-copy`/`wl-paste`) for clipboard access on Wayland';
export const DISPLAY_HINT =
  'display_unavailable: no graphical session to drive; run inside a desktop session with DISPLAY (X11) or WAYLAND_DISPLAY set';

/**
 * User-facing English phrases, one per fix a capability can ask for. They are
 * the keys of the UI catalogs (apps/desktop/src/renderer/locales), so a UI that
 * renders a capability's `fix` looks the phrase up there; `{{package}}` is the
 * capability's `package`. The tool result text for the model stays English.
 */
export const FIX_MESSAGES = Object.freeze({
  allow_input:
    'Allow Mixdog to send keyboard and mouse input: grant access to /dev/uinput (add your user to the input group), then sign in again.',
  install_window_helper:
    'Install and enable a window helper for your desktop (on GNOME, the Window Calls extension) so Mixdog can list and control windows.',
  install_package: 'Install {{package}} to enable this Computer Use feature.',
});
export const REFUSAL_MESSAGE = 'Computer Use cannot run this action because a required capability is not ready.';

/** Stable code of the whole refusal; the per-capability codes are the native ones. */
export const CAPABILITY_UNAVAILABLE_CODE = 'computer_capability_unavailable';

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

function gdbusSucceeds(env, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('gdbus', ['call', '--session', ...args], { env, stdio: 'ignore', shell: false, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve(status === 0);
    });
  });
}

function gnomeWindowCallsReachable(env) {
  return gdbusSucceeds(env, [
    '--dest', 'org.gnome.Shell',
    '--object-path', '/org/gnome/Shell/Extensions/Windows',
    '--method', 'org.gnome.Shell.Extensions.Windows.List',
  ]);
}

function accessibilityBusReachable(env) {
  return gdbusSucceeds(env, [
    '--dest', 'org.a11y.Bus',
    '--object-path', '/org/a11y/bus',
    '--method', 'org.a11y.Bus.GetAddress',
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
  const wayland = env.WAYLAND_DISPLAY !== undefined && (env.XDG_SESSION_TYPE === undefined || env.XDG_SESSION_TYPE === 'wayland');
  return wayland ? 'wayland' : 'x11';
}

function detectDesktop(env, session) {
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

async function windowsCapability({ env, session, hasCommand, windowCallsReachable }) {
  if (session === 'x11') return READY;
  // Same order as native Compositor::detect().
  if (env.SWAYSOCK !== undefined) return hasCommand('swaymsg') ? READY : needsPackage('sway');
  if (env.HYPRLAND_INSTANCE_SIGNATURE !== undefined) return hasCommand('hyprctl') ? READY : needsPackage('hyprland');
  if (/gnome/i.test(String(env.XDG_CURRENT_DESKTOP || ''))) {
    // Without gdbus the extension cannot be probed (the native client talks to
    // D-Bus itself), so this is unknown rather than missing.
    if (!hasCommand('gdbus')) return { state: 'unknown' };
    return (await windowCallsReachable()) ? READY : { state: 'needs_setup', fix: 'install_window_helper' };
  }
  return { state: 'unsupported' };
}

async function accessibilityCapability({ env, hasCommand, hasSessionBus, accessibilityReachable }) {
  if (!hasSessionBus() || !hasCommand('gdbus')) return { state: 'unknown' };
  return (await accessibilityReachable()) ? READY : needsPackage('at-spi2-core');
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
  canWrite = (file) => {
    try {
      fs.accessSync(file, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  hasCommand = (name) => onPath(name, env),
  hasSessionBus = () => sessionBusPresent(env),
  windowCallsReachable = () => gnomeWindowCallsReachable(env),
  accessibilityReachable = () => accessibilityBusReachable(env),
} = {}) {
  const session = detectSession(env);
  const desktop = detectDesktop(env, session);
  const optional = (capability) => ({ ...capability, optional: true });
  if (session === 'x11' && !env.DISPLAY) {
    const none = { state: 'unsupported' };
    return {
      session,
      desktop,
      capabilities: {
        capture: none, windows: none, accessibility: none, semanticActions: none,
        pointer: none, keyboard: none, clipboard: optional(none), ocr: optional(none),
      },
    };
  }
  const wayland = session === 'wayland';
  const windows = await windowsCapability({ env, session, hasCommand, windowCallsReachable });
  const accessibility = await accessibilityCapability({ env, hasCommand, hasSessionBus, accessibilityReachable });
  const input = !wayland || canWrite('/dev/uinput') ? READY : { state: 'needs_setup', fix: 'allow_input' };
  const clipboard = !wayland || (hasCommand('wl-copy') && hasCommand('wl-paste')) ? READY : needsPackage('wl-clipboard');
  return {
    session,
    desktop,
    capabilities: {
      // Wayland pixels come through the desktop portal, which only prompts when
      // used, so it cannot be probed.
      capture: wayland ? { state: 'unknown' } : READY,
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

function capabilityIssue(name, readiness) {
  if (readiness.capabilities.capture.state === 'unsupported') return { code: 'display_unavailable', message: DISPLAY_HINT };
  // Semantic actions fail on whichever of their two prerequisites is missing.
  const target = name === 'semanticActions' ? (readiness.capabilities.windows.state === 'ready' ? 'accessibility' : 'windows') : name;
  const capability = readiness.capabilities[target];
  switch (target) {
    case 'windows':
      if (capability.fix === 'install_window_helper') return { code: 'wayland_window_control_unavailable', message: WINDOW_CONTROL_HINT };
      if (capability.fix === 'install_package') {
        return {
          code: 'wayland_window_control_unavailable',
          message: `wayland_window_control_unavailable: the ${readiness.desktop} window tool is missing from PATH; install ${capability.package}`,
        };
      }
      return { code: 'wayland_window_control_unavailable', message: WINDOW_CONTROL_UNSUPPORTED_HINT };
    case 'accessibility':
      return { code: 'accessibility_unavailable', message: ACCESSIBILITY_HINT };
    case 'pointer':
    case 'keyboard':
      return { code: 'input_unavailable', message: `${UINPUT_HINT}. ${INPUT_GROUP_SECURITY_NOTE}` };
    case 'clipboard':
      return { code: 'clipboard_unavailable', message: CLIPBOARD_HINT };
    case 'ocr':
      return { code: 'ocr_unavailable', message: TESSERACT_HINT };
    default:
      return { code: `${target}_unavailable`, message: `${target}_unavailable: ${target} is not available on this session` };
  }
}

/** The required capabilities that are not usable, with their stable codes. */
export function missingCapabilities(readiness, command) {
  const missing = [];
  for (const name of requiredCapabilities(command)) {
    const capability = readiness.capabilities[name];
    if (!capability || capability.state === 'ready' || capability.state === 'unknown') continue;
    const { fix, package: pkg } = capability;
    missing.push({
      capability: name,
      state: capability.state,
      ...(fix ? { fix } : {}),
      ...(pkg ? { package: pkg } : {}),
      ...capabilityIssue(name, readiness),
    });
  }
  return missing;
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

/**
 * Null when the command can run; otherwise `{code, missing, message}` — the
 * model-facing text names every missing capability and says nothing ran.
 */
export async function linuxComputerPreflight({ command, platform = process.platform, check, now } = {}) {
  if (platform !== 'linux') return null;
  const readiness = await getLinuxComputerReadiness({ check, now });
  const missing = missingCapabilities(readiness, command);
  if (missing.length === 0) return null;
  const details = new Map();
  for (const item of missing) {
    const entry = details.get(item.message) ?? { code: item.code, message: item.message, capabilities: [] };
    entry.capabilities.push(item.capability);
    details.set(item.message, entry);
  }
  const lines = [...details.values()].map((entry) => `- ${entry.message} [${entry.capabilities.join(', ')}]`);
  if (String(command?.action) === 'capture' && missing.some((item) => item.capability === 'windows') && !missing.some((item) => item.capability === 'capture')) {
    lines.push('Screenshots that need no window still work: capture with mode="vision" and a screen index (screen=0).');
  }
  return {
    code: CAPABILITY_UNAVAILABLE_CODE,
    missing,
    message: `${CAPABILITY_UNAVAILABLE_CODE}: Computer Use cannot run this action on this Linux session (${[...new Set(missing.map((item) => item.capability))].join(', ')}) — nothing was executed.\n${lines.join('\n')}`,
  };
}

export function resetLinuxComputerPreflightCache() {
  cached = null;
}