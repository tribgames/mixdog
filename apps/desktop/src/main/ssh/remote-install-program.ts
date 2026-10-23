// The one program every bootstrap, install and cleanup run executes on the
// server, assembled from the section sources of the remote-install-* modules,
// and the shell script that finds node and starts it. The program reads its
// arguments as base64 JSON, an uploaded payload from stdin, and prints exactly
// one MIXDOG_RESULT or MIXDOG_ERROR line.
import { gzipSync } from 'node:zlib';

import { REMOTE_DAEMON_SOURCE } from './remote-install-daemon';
import { REMOTE_GC_SOURCE } from './remote-install-gc';
import { REMOTE_LOCK_SOURCE } from './remote-install-lock';
import { REMOTE_MANIFEST_SOURCE } from './remote-install-manifest';
import { REMOTE_PLATFORM_PROBE_SHELL, REMOTE_PLATFORM_SOURCE } from './remote-install-platform';
import { REMOTE_VERSIONED_SOURCE } from './remote-install-versioned';

/** Server-side directory, relative to the remote $HOME, holding every
 *  desktop-installed artifact. */
export const REMOTE_STATE_DIRECTORY = '.mixdog-remote';
export const REMOTE_MIN_NODE_MAJOR = 22;

/** Arguments of one server program run. */
export interface RemoteProgramArgs {
  mode: 'probe' | 'ensure' | 'cleanup';
  installId?: string;
  version?: string;
  buildHash?: string;
  graceMs?: string;
  /** ensure: the payload archive follows on stdin. */
  upload?: boolean;
  /** ensure: stop another build's daemon even while it runs turns. */
  forceRestart?: boolean;
  /** probe/ensure: 'server' wants a daemon that runs models with the server's
   *  own logins (no model proxy); absent: one in client proxy mode. */
  modelLogin?: 'server';
  /** cleanup: 'stop' stops the daemon only; 'remove' also deletes files. */
  phase?: 'stop' | 'remove';
  removeUserData?: boolean;
  lockWaitMs?: number;
  lockStaleMs?: number;
}

const COMMON_SOURCE = String.raw`
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), http = require('http'), cp = require('child_process'), net = require('net'), zlib = require('zlib');
class RemoteFail extends Error { constructor(code, message) { super(String(message).replace(/\s+/g, ' ').trim()); this.code = code; } }
const fail = (code, message) => { throw new RemoteFail(code, message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); } catch (error) { return error.code === 'EPERM'; }
  // An exited daemon whose parent never reaps it (a container whose pid 1 is
  // not an init) stays a zombie that still answers signal 0.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch {}
  }
  return true;
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const writeJsonAtomic = (file, value) => { const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'); fs.writeFileSync(tmp, JSON.stringify(value) + '\n'); fs.renameSync(tmp, file); };
const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex');
const removeTree = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
/** The desktop-managed daemon is isolated from a daemon the user runs from
 *  their own install: its own runtime root (daemon.json) and its own Mixdog
 *  home (settings, data dir with the single-owner lock, sessions) inside the
 *  version independent user-data, so cleanup keeps it unless asked. */
function remotePaths(home) {
  const root = path.join(home, '.mixdog-remote');
  const runtimeRoot = path.join(root, 'runtime');
  const userData = path.join(root, 'user-data');
  const mixdogHome = path.join(userData, 'home');
  const dataDir = path.join(mixdogHome, 'data');
  return {
    root,
    versions: path.join(root, 'versions'),
    deps: path.join(root, 'deps'),
    userData,
    mixdogHome,
    dataDir,
    lock: path.join(root, '.install-lock'),
    state: path.join(root, 'state.json'),
    log: path.join(root, 'daemon.log'),
    runtimeRoot,
    discovery: path.join(runtimeRoot, 'daemon.json'),
    dataOwner: path.join(dataDir, 'daemon-owner.json'),
  };
}
const readStdin = () => new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  process.stdin.on('error', reject);
});
`;

const STEPS_SOURCE = `
function daemonSummary(state, want) {
  const health = state.health;
  return {
    daemonJson: state.raw,
    healthy: Boolean(health),
    modelProxy: health && typeof health.modelProxy === 'string' ? health.modelProxy : null,
    daemonVersion: health ? daemonVersionOf(health) || null : null,
    daemonBuildHash: health && typeof health.buildHash === 'string' ? health.buildHash : null,
    daemonBusy: health ? daemonBusyCount(health) : 0,
    daemonCurrent: daemonIsCurrent(health, want),
  };
}
function recordCurrent(p, installId) {
  const state = readJson(p.state) || {};
  if (state.current !== installId) {
    state.previous = state.current || null;
    state.current = installId;
  }
  writeJsonAtomic(p.state, state);
  return state;
}
function lockOptions(args, purpose) {
  return { waitMs: args.lockWaitMs, staleMs: args.lockStaleMs, purpose };
}
async function ensureServer(p, args, info, uid) {
  const upload = args.upload ? await readStdin() : null;
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  const lock = await acquireInstallLock(p.lock, lockOptions(args, 'install ' + args.installId));
  try {
    const install = await ensureInstalled(p, args, upload, info);
    fs.mkdirSync(p.userData, { recursive: true });
    const daemon = await ensureDaemon(p, args, install.versionDir, uid);
    const state = recordCurrent(p, args.installId);
    rotateLog(p.log, LOG_MAX_BYTES);
    const gc = garbageCollect(p, new Set([state.current, state.previous].filter(Boolean)), processCommandLines());
    return Object.assign({}, install, daemonSummary(daemon.state, args), { started: daemon.started, replaced: daemon.replaced, gcRemoved: gc.removed, gcSkipped: gc.skipped });
  } finally {
    lock.release();
  }
}
/** Nothing may still run from (or own) what a removal deletes. */
function assertInstallIdle(p) {
  const users = installUsers(p);
  if (!users) fail('daemon-unproven', 'Could not list the processes on the server to prove nothing still runs Mixdog from ' + p.root + '; nothing was removed.');
  const owner = readJson(p.dataOwner);
  const ownerPid = owner ? Number(owner.pid) : 0;
  if (ownerPid > 0 && ownerPid !== process.pid && alive(ownerPid) && !users.some((entry) => entry.pid === ownerPid)) {
    users.push({ pid: ownerPid, command: 'owner of ' + path.dirname(p.dataOwner) });
  }
  if (users.length) {
    fail('daemon-unproven', 'A process the desktop did not stop still uses ' + p.root + ' (' + users.slice(0, 3).map((entry) => 'pid ' + entry.pid).join(', ') +
      '); nothing was removed. Stop it on the server, then try again.');
  }
}
/** Stop, prove and remove inside one lock hold: no install or daemon start
 *  can slip in between the check and the removal. The 'stop' phase only
 *  stops (progress for the UI); 'remove' repeats the stop before deleting. */
async function cleanupServer(p, args) {
  if (!fs.existsSync(p.root)) return { cleanup: { stopped: null, removed: [], kept: [] } };
  const lock = await acquireInstallLock(p.lock, lockOptions(args, 'cleanup'));
  const removed = [];
  const kept = [];
  let stopped = null;
  try {
    stopped = await stopOwnedDaemon(p);
    if (stopped && !stopped.stopped) {
      fail('daemon-unproven', 'A process (pid ' + stopped.pid + ') holds the Mixdog daemon record on the server but could not be proven to be ' +
        "the desktop's Mixdog daemon; nothing was removed. Stop it on the server, then try again.");
    }
    if (args.phase === 'remove') {
      assertInstallIdle(p);
      for (const name of fs.readdirSync(p.root)) {
        if (name === path.basename(p.lock)) continue;
        if (name === path.basename(p.userData) && !args.removeUserData) { kept.push(name); continue; }
        removeTree(path.join(p.root, name));
        removed.push(name);
      }
    }
  } finally {
    lock.release();
  }
  if (args.phase === 'remove' && kept.length === 0) { try { fs.rmdirSync(p.root); } catch {} }
  return { cleanup: { stopped, removed, kept } };
}
`;

const MAIN_SOURCE = String.raw`
(async () => {
  const args = JSON.parse(Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8'));
  const home = os.homedir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const p = remotePaths(home);
  const info = platformInfo();
  assertSupportedRuntime(info);
  const result = { home, uid, nodeVersion: process.versions.node, platform: info, runtimeRoot: p.runtimeRoot };
  if (args.mode === 'probe') {
    Object.assign(result, installedState(p, args), daemonSummary(await readDaemonState(p), args));
  } else if (args.mode === 'ensure') {
    Object.assign(result, await ensureServer(p, args, info, uid));
  } else if (args.mode === 'cleanup') {
    Object.assign(result, await cleanupServer(p, args));
  } else {
    fail('protocol', 'Unknown server program mode: ' + args.mode);
  }
  process.stdout.write('MIXDOG_RESULT ' + JSON.stringify(result) + '\n', () => process.exit(0));
})().catch((error) => {
  const known = error instanceof RemoteFail;
  const message = known ? error.message : String((error && error.stack) || error).replace(/\s+/g, ' ');
  process.stdout.write('MIXDOG_ERROR ' + (known ? error.code : 'internal') + ' ' + message + '\n', () => process.exit(3));
});
`;

/** Every section except the entry point: what unit tests load to call one
 *  server function directly. */
export const REMOTE_SERVER_LIBRARY = [
  COMMON_SOURCE,
  REMOTE_PLATFORM_SOURCE,
  REMOTE_LOCK_SOURCE,
  REMOTE_MANIFEST_SOURCE,
  REMOTE_GC_SOURCE,
  REMOTE_DAEMON_SOURCE,
  REMOTE_VERSIONED_SOURCE,
  STEPS_SOURCE,
].join('\n');

export const REMOTE_SERVER_PROGRAM = `${REMOTE_SERVER_LIBRARY}\n${MAIN_SOURCE}`;

/** `node -e` decompresses and evaluates the program: the whole command line
 *  must stay under Windows' 32 KiB CreateProcess limit for ssh.exe. */
export const REMOTE_PROGRAM_LOADER =
  "eval(require('zlib').gunzipSync(Buffer.from(process.argv[1], 'base64')).toString('utf8'))";
const PROGRAM_BASE64 = gzipSync(Buffer.from(REMOTE_SERVER_PROGRAM, 'utf8'), { level: 9 }).toString('base64');

/** POSIX single-quote quoting. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function encodeProgramArgs(args: RemoteProgramArgs): string {
  return Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
}

/** argv for running the program with a local node (tests) or remotely. */
export function remoteProgramArgv(args: RemoteProgramArgs): string[] {
  return ['-e', REMOTE_PROGRAM_LOADER, PROGRAM_BASE64, encodeProgramArgs(args)];
}

/** Non-interactive ssh sessions skip the rc files that usually put node on
 *  PATH (nvm, volta, fnm, ~/.local): look in the usual places once. */
export const NODE_PATH_SHELL = `
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME/.local/bin" "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" /usr/local/bin /opt/homebrew/bin; do
    [ -x "$d/node" ] && PATH="$d:$PATH"
  done
  if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi
fi
export PATH
`;

const REQUIRE_NODE_SHELL = `
command -v node >/dev/null 2>&1 || fail node-missing "Node.js was not found on the server (PATH=$PATH). Install Node.js ${REMOTE_MIN_NODE_MAJOR} or newer."
NODE_VERSION=$(node -p process.versions.node 2>/dev/null) || fail node-missing "node on the server does not run."
NODE_MAJOR=\${NODE_VERSION%%.*}
[ "$NODE_MAJOR" -ge ${REMOTE_MIN_NODE_MAJOR} ] 2>/dev/null || fail node-too-old "Mixdog needs Node.js ${REMOTE_MIN_NODE_MAJOR} or newer on the server; found $NODE_VERSION."
`;

const FAIL_SHELL = `fail() { printf 'MIXDOG_ERROR %s %s\\n' "$1" "$2"; exit 3; }`;

/** Platform probe, node lookup and version gate, then the program. */
export function remoteProgramScript(args: RemoteProgramArgs): string {
  const invoke = ['exec node', ...remoteProgramArgv(args).map(shQuote)].join(' ');
  return [FAIL_SHELL, REMOTE_PLATFORM_PROBE_SHELL, NODE_PATH_SHELL, REQUIRE_NODE_SHELL, invoke, ''].join('\n');
}

/** The command line handed to the user's login shell. Only base64 crosses
 *  it, inside single quotes, so bash, zsh, fish and csh all pass the script
 *  to `sh` unchanged. */
export function remoteShellCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `sh -c 'eval "$(printf %s ${encoded} | base64 -d)"'`;
}
