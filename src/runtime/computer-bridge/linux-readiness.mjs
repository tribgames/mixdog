// Linux Computer Use prerequisites, checked BEFORE a task starts so a missing
// permission or extension produces one actionable message instead of a failure
// or hang mid-task. The wording mirrors the native hints in
// native/mixdog-computer (uinput.rs PERMISSION_HINT, compositor.rs supported,
// apps.rs TESSERACT_HINT / CLIPBOARD_HINT).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const UINPUT_HINT =
  'input_unavailable: Wayland input needs write access to /dev/uinput; add the udev rule `KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"`, add your user to the input group, then sign in again';
export const INPUT_GROUP_SECURITY_NOTE =
  'Security note: membership of the input group lets every program you run read and inject keyboard and mouse input system-wide. Grant it only on a machine and account you trust.';
export const WINDOW_CONTROL_HINT =
  'wayland_window_control_unavailable: this compositor offers no window control to other programs; on GNOME install and enable the Window Calls extension';
export const TESSERACT_HINT =
  'ocr_unavailable: install Tesseract (for example `sudo apt install tesseract-ocr tesseract-ocr-kor`) to read text from pixels';
export const CLIPBOARD_HINT =
  'clipboard_unavailable: install wl-clipboard (`wl-copy`/`wl-paste`) for clipboard access on Wayland';
export const DISPLAY_HINT =
  'display_unavailable: no graphical session to drive; run inside a desktop session with DISPLAY (X11) or WAYLAND_DISPLAY set';

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

function gnomeWindowCallsReachable(env, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'gdbus',
        [
          'call', '--session', '--dest', 'org.gnome.Shell',
          '--object-path', '/org/gnome/Shell/Extensions/Windows',
          '--method', 'org.gnome.Shell.Extensions.Windows.List',
        ],
        { env, stdio: 'ignore', shell: false, windowsHide: true }
      );
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

/**
 * @returns {Promise<{session: 'wayland'|'x11'|'none', blockers: {code: string, message: string, mutatingOnly: boolean}[], warnings: string[]}>}
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
  windowCallsReachable = () => gnomeWindowCallsReachable(env),
} = {}) {
  const blockers = [];
  const warnings = [];
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  const session = wayland ? 'wayland' : env.DISPLAY ? 'x11' : 'none';
  if (session === 'none') {
    blockers.push({ code: 'display_unavailable', message: DISPLAY_HINT, mutatingOnly: false });
  }
  if (session === 'wayland') {
    if (!canWrite('/dev/uinput')) {
      blockers.push({
        code: 'input_unavailable',
        message: `${UINPUT_HINT}. ${INPUT_GROUP_SECURITY_NOTE}`,
        mutatingOnly: true,
      });
    }
    const desktop = String(env.XDG_CURRENT_DESKTOP || '');
    const hasWindowControl = /gnome/i.test(desktop)
      ? await windowCallsReachable()
      : Boolean(env.SWAYSOCK || env.HYPRLAND_INSTANCE_SIGNATURE);
    if (!hasWindowControl) {
      blockers.push({ code: 'wayland_window_control_unavailable', message: WINDOW_CONTROL_HINT, mutatingOnly: false });
    }
    if (!hasCommand('wl-copy') || !hasCommand('wl-paste')) warnings.push(CLIPBOARD_HINT);
  }
  if (!hasCommand('tesseract')) warnings.push(TESSERACT_HINT);
  return { session, blockers, warnings };
}

const CACHE_MS = 15000;
let cached = null;

/** Cached for a short time; resolves a user-facing message, or '' when ready. */
export async function linuxComputerPreflight({ mutating, platform = process.platform, check = checkLinuxComputerReadiness, now = Date.now } = {}) {
  if (platform !== 'linux') return '';
  if (!cached || now() - cached.at > CACHE_MS) cached = { at: now(), result: await check() };
  const blockers = cached.result.blockers.filter((b) => mutating || !b.mutatingOnly);
  if (blockers.length === 0) return '';
  return `Computer Use is not ready on this Linux session — nothing was executed.\n${blockers.map((b) => `- ${b.message}`).join('\n')}`;
}

export function resetLinuxComputerPreflightCache() {
  cached = null;
}
