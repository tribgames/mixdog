// Cross-platform managed-launcher control channel.
//
// Replaces the Windows-only AttachConsole + WriteConsoleInputW front-injection
// path. A `mixdog`-launched session can be "managed": the launcher
// (setup/mixdog.mjs) owns the child process and exposes a file-based
// command queue under the runtime root. Internal commands (/clear,
// /reload-plugins) are enqueued by the MCP server (inject_input)
// and the launcher delivers them to the child's stdin — no terminal keystroke
// injection, no new window. Works on Windows / macOS / Linux.
//
// Native backend (CANONICAL): Rust is canonical for mixdog's native
// functionality. The enqueue/drain primitives and the managed terminal bridge
// are owned by the Rust crate native/mixdog-launch. The pure-JS queue path below
// is only a wire-compatible fallback for queue writes/drains when the binary has
// not landed; managed terminal ownership never falls back to JS/node-pty.
//
// Wire-up:
//   • The launcher sets MIXDOG_LAUNCH_ID (and MIXDOG_MANAGED_LAUNCH=1) on the
//     child env ONLY when it has actually engaged the stdin control bridge.
//   • The MCP server (a descendant of the child) inherits that env, so
//     managedLaunchId() is the single source of truth for "am I managed?".
//   • enqueueLauncherCommand() publishes one command file atomically; the
//     launcher's watchLauncherCommands() drains + delivers them in order.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ENV_LAUNCH_ID = 'MIXDOG_LAUNCH_ID';
const ENV_MANAGED = 'MIXDOG_MANAGED_LAUNCH';

// 0x1E (ASCII Record Separator): how `mixdog-launch drain` joins multiple
// command bodies on stdout so embedded newlines in a command survive transport.
const RECORD_SEP = '\x1e';

// Names the env vars the launcher must set on the child so this module's
// managedLaunchId() resolves inside the MCP server.

// Mirror of channels/lib/runtime-paths.mjs RUNTIME_ROOT resolution so the
// launcher and the MCP server agree on the queue location without importing
// the channels layer into setup/.
function launcherRuntimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : join(tmpdir(), 'mixdog');
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function launcherQueueDir(launchId) {
  return join(launcherRuntimeRoot(), `launch-cmds-${sanitize(launchId)}`);
}

// ── Native backend resolution (canonical) ──────────────────────────────────
// Locate the Rust mixdog-launch binary built by dev-sync / cargo. Resolution
// order: explicit override → fresh live build → local cargo release build →
// shipped prebuilt.
// Returns an absolute path when present, else null (JS fallback engages).
const PLUGIN_ROOT = process.env.MIXDOG_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NATIVE_LAUNCH_DEFAULT_BIN = join(
  PLUGIN_ROOT,
  'native/mixdog-launch/target/release',
  process.platform === 'win32' ? 'mixdog-launch.exe' : 'mixdog-launch',
);
const NATIVE_LAUNCH_LIVE_BIN = join(
  PLUGIN_ROOT,
  'native/mixdog-launch/target-live/release',
  process.platform === 'win32' ? 'mixdog-launch.exe' : 'mixdog-launch',
);

function nativeLaunchSourceMtime() {
  let mtime = 0;
  for (const rel of ['native/mixdog-launch/Cargo.toml', 'native/mixdog-launch/src/main.rs']) {
    try { mtime = Math.max(mtime, statSync(join(PLUGIN_ROOT, rel)).mtimeMs); } catch {}
  }
  return mtime;
}

function freshNativeLaunchBin(path) {
  try {
    const binMtime = statSync(path).mtimeMs;
    const srcMtime = nativeLaunchSourceMtime();
    return binMtime > 0 && binMtime >= srcMtime ? path : null;
  } catch {
    return null;
  }
}

// Shipped prebuilt path under native/prebuilt/<os-arch>/mixdog-launch(.exe)
function nativeLaunchPrebuiltPath() {
  const arch =
    process.arch === 'x64' ? 'x86_64'
    : process.arch === 'arm64' ? 'aarch64'
    : process.arch === 'ia32' ? 'i686'
    : process.arch;
  const os =
    process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos'
    : 'linux';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return join(PLUGIN_ROOT, 'native', 'prebuilt', `${os}-${arch}`, `mixdog-launch${ext}`);
}

let _nativeBinCache; // undefined = unresolved, string|null = resolved
function nativeLaunchBin() {
  if (_nativeBinCache !== undefined) return _nativeBinCache;
  // Opt-out for tests / forced-JS parity checks.
  if (/^(0|false|no|off|js)$/i.test(String(process.env.MIXDOG_LAUNCH_NATIVE || ''))) {
    _nativeBinCache = null;
    return _nativeBinCache;
  }
  const override = process.env.MIXDOG_LAUNCH_NATIVE_BIN;
  if (override && existsSync(override)) { _nativeBinCache = override; return _nativeBinCache; }
  const live = freshNativeLaunchBin(NATIVE_LAUNCH_LIVE_BIN);
  if (live) { _nativeBinCache = live; return _nativeBinCache; }
  const release = freshNativeLaunchBin(NATIVE_LAUNCH_DEFAULT_BIN);
  if (release) { _nativeBinCache = release; return _nativeBinCache; }
  // Shipped prebuilt fallback (under native/prebuilt/<os-arch>/)
  const prebuilt = nativeLaunchPrebuiltPath();
  if (prebuilt && existsSync(prebuilt)) { _nativeBinCache = prebuilt; return _nativeBinCache; }
  _nativeBinCache = null;
  return _nativeBinCache;
}

// Returns true when the native mixdog-launch binary's `bridge` subcommand is
// available for this platform (exit 0). The launcher uses this to gate the
// managed-launch interactive path — no JS stdin pipe bridge fallback.
function nativeBridgeAvailable() {
  const bin = nativeLaunchBin();
  if (!bin) return false;
  const r = spawnSync(bin, ['bridge', '--probe'], {
    encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

function newLaunchId() {
  return `${process.pid}-${randomUUID().slice(0, 8)}`;
}

// MCP-server side: returns the managed launch id when this process belongs to a
// `mixdog`-launched session that engaged the control bridge, else null. The
// launcher only sets MIXDOG_LAUNCH_ID once the bridge is live, so presence is
// sufficient — there is no half-managed state to disambiguate.
function managedLaunchId() {
  const id = process.env[ENV_LAUNCH_ID];
  return id && String(id).length > 0 ? String(id) : null;
}

let enqueueSequence = 0;

// Writer side (inject_input): publish one command for the
// launcher to deliver. Prefers the canonical Rust backend; the JS writer (temp
// name + rename so the watcher never sees a partial file) is the fallback.
// Returns the published path.
function enqueueLauncherCommand(launchId, command) {
  const dir = launcherQueueDir(launchId);
  mkdirSync(dir, { recursive: true });
  const bin = nativeLaunchBin();
  if (bin) {
    const r = spawnSync(bin, ['enqueue', '--dir', dir, '--command', String(command)], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0) {
      const out = String(r.stdout || '').trim();
      if (out) return out;
    }
    // Native spawn failed / non-zero → fall through to the JS writer.
  }
  const seq = String(enqueueSequence++).padStart(6, '0');
  const base = `${Date.now()}-${seq}-${randomUUID().slice(0, 8)}.cmd`;
  const tmp = join(dir, `.${base}.tmp`);
  const dst = join(dir, base);
  writeFileSync(tmp, String(command), 'utf8');
  renameSync(tmp, dst);
  return dst;
}

// Launcher side: drain queued commands oldest-first (lexical sort on the
// timestamp-prefixed name), deleting each as it is read. Prefers the canonical
// Rust backend; the JS reader is the fallback.
function drainLauncherCommands(launchId) {
  const dir = launcherQueueDir(launchId);
  const bin = nativeLaunchBin();
  if (bin) {
    const r = spawnSync(bin, ['drain', '--dir', dir], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0) {
      const out = String(r.stdout || '');
      return out.length === 0 ? [] : out.split(RECORD_SEP);
    }
    // Native spawn failed / non-zero → fall through to the JS reader.
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries.filter((f) => f.endsWith('.cmd')).sort()) {
    const full = join(dir, name);
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    try {
      rmSync(full, { force: true });
    } catch {}
    out.push(text);
  }
  return out;
}

// Launcher side: poll-based watcher. fs.watch semantics differ enough across
// platforms (and miss atomic-rename publishes on some) that a short poll is the
// robust choice for this low-rate control path. Returns a stop() that also
// removes the queue directory.
function watchLauncherCommands(launchId, onCommand, { intervalMs = 150 } = {}) {
  mkdirSync(launcherQueueDir(launchId), { recursive: true });
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    for (const cmd of drainLauncherCommands(launchId)) {
      try {
        onCommand(cmd);
      } catch {}
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      rmSync(launcherQueueDir(launchId), { recursive: true, force: true });
    } catch {}
  };
}
