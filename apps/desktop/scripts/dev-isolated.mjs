//   npm run dev:isolated -- --name <tag> [--copy-auth] [--onboarding] [--ttl-minutes=120] [--idle-minutes=7]
//     [--hmr] [--phone-relay] [--reuse] [--require-fresh-core] [--owner-pid=<pid>] [--foreground]
//   npm run dev:isolated:ensure -- [--name <tag>] [--phone-relay] [--hmr] [--copy-auth] [--require-fresh-core]
//   npm run dev:isolated:capture -- --out <file-or-dir> [--phone] [--eval <file> ...] [--require-fresh-core]
//
// Build modes:
//   default (capture): runs an unminified static `electron-vite build --mode development` served from disk.
//     Note: this static build runs production React and bundled CSS, so it is close to the shipped app but
//     is NOT the live Vite HMR dev build. Use `--hmr` when actively iterating on live renderer edits.
// Session ownership & observed use:
//   Each session owns its own instance; `ensure` and `capture` reuse only the calling session's instance
//   (never another agent's) and automatically rebuild if any file read by the build changed.
//   Clients reach CDP through the supervisor, so any attached CDP client pauses idle shutdown and its
//   disconnect starts the backstop idle period (7 min, matching runtime IDLE_RELEASE_MS in
//   native/core/crates/mixdog-agent/src/agent_tool/idle_release.rs).
//
// Every start hands the instance the provider sign-ins kept in the kept dev profile's dev-isolated-auth folder,
// refresh tokens included, and its stop (or the start or sweep that reclaims it) saves the instance's provider
// sign-ins, those it was handed and those made in it, back there. One live instance at a time holds them: another
// start while it runs gets none and saves none. The kept dev app never reads that folder.
// --copy-auth also copies the kept dev profile's own sign-ins and model routes without their refresh tokens: refresh
// tokens rotate, so an instance that refreshed one would sign the kept profile out.
//   --config-overlay=<json file>  deep-merged into the seeded config before the core starts
//   --pass-env=NAME,NAME          MIXDOG_* names of this shell kept in the instance env (never a name the
//                                 isolation sets itself); MIXDOGD_TEST_HOOKS and MIXDOG_DEV_COMPUTER_RUN reach
//                                 only a dev core: a packaged app strips them (src/main/protocol/local-core.ts)
//   --inspect-main=<port>         V8 inspector of the Electron main process
//   --hmr                         run electron-vite dev for live renderer HMR (default: static dev build with production React & bundled CSS)
//   --phone-relay                 run a loopback phone relay inside the instance supervisor
//   --reuse                       reuse this session's compatible fresh live instance instead of starting another
//   --require-fresh-core          refuse to start if the dev core binary is older than its Rust sources (default: warn)
//   --idle-minutes=<N>            shut down after N idle minutes with no attached client (default: 7, matching runtime IDLE_RELEASE_MS; 0 disables)
//   --owner-pid=<pid>             shut down automatically when <pid> exits (default: persistent ancestor)
//   --foreground                  stay attached to stdin/signals and shut down when closed
//   npm run dev:isolated:stop -- --name <tag> | --all [--all-sessions]
//   npm run dev:isolated:sweep [-- --all] [--all-sessions]
//   npm run dev:isolated:list
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { refreshStaleLocalBinaries } from '../../../scripts/native-release-status.mjs';
import {
  JS_RUNTIME_MANIFEST,
  OFFICE_TEMPLATES_DIR,
  ortBinaryDir,
  stageOfficeTemplates,
} from './core-layout.mjs';
import { writeDevInstall } from './dev-core-install.mjs';
import {
  assertSupportedUnitPlatform,
  getProcessCreationTimeMs,
  isSameProcess,
  leaseBelongsToSession,
  resolveCallerSession,
  watchProcessExit,
} from './dev-isolated-job.mjs';
import { electronBinary } from './electron-binary.mjs';
import { expiryFromAccessToken, normalizeExpiresAtMs } from './oauth-token-expiry.mjs';

// The onboarding marker version mixdogd writes (native/core/crates/mixdog-core-config/src/workflow/onboarding.rs).
const ONBOARDING_VERSION = 1;

import {
  assertDebugPortAvailable,
  buildMainNativeModule,
  buildWindowLibrary,
  createPersistentDevEnv,
  DEV_DEBUG_PORT,
  devRendererPortFor,
  persistentDevProfileDir,
} from './dev-profile.mjs';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = resolve(desktopDir, '..', '..');
const supervisorScript = fileURLToPath(new URL('./dev-isolated-supervisor.mjs', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/i;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_START_TIMEOUT_MS = 300_000;
/** Where the runtime defines the idle-agent parking period (`IDLE_RELEASE_MS`). */
export const RUNTIME_IDLE_RELEASE_SOURCE = 'native/core/crates/mixdog-agent/src/agent_tool/idle_release.rs';
const FALLBACK_IDLE_MS = 420_000;

/** Reads the runtime's `IDLE_RELEASE_MS` (the time after which an idle agent is parked and cannot use
 *  the instance without a new turn) directly from the repository source. Throws if missing or renamed. */
export function readRuntimeIdleReleaseMs(repo = repoDir) {
  const sourcePath = join(repo, RUNTIME_IDLE_RELEASE_SOURCE);
  const text = readFileSync(sourcePath, 'utf8');
  const match = /\bpub\s+const\s+IDLE_RELEASE_MS\b[^=]*=\s*([0-9_]+(?:\.[0-9_]+)?)\s*;/.exec(text);
  if (!match) {
    throw new Error(`Could not find pub const IDLE_RELEASE_MS in ${sourcePath}.`);
  }
  const value = Number(match[1].replaceAll('_', ''));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid IDLE_RELEASE_MS value (${match[1]}) in ${sourcePath}.`);
  }
  return value;
}

// Primary ends are owner-session exit, explicit stop, and replacement on source change.
// Backstop idle period matches the runtime's idle-agent parking period (`IDLE_RELEASE_MS`, 7 min):
// once an owning agent has been parked, it cannot use the instance without a new turn.
// Falls back to 7 min at module load so a rename in Rust never crashes tool imports (caught by unit test).
export const DEFAULT_IDLE_MS = (() => {
  try {
    return readRuntimeIdleReleaseMs();
  } catch {
    return FALLBACK_IDLE_MS;
  }
})();
export const DEFAULT_CAPTURE_NAME = 'capture';
/** The only relay an isolated instance may dial: one on this machine. */
const LOOPBACK_RELAY = /^ws:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/;
export const CDP_PORT_RANGE = Object.freeze([9400, 9899]);
const RESERVED_PORTS = new Set([DEV_DEBUG_PORT, devRendererPortFor(DEV_DEBUG_PORT)]);

const HELP_TEXT = `Usage (from apps/desktop):
  npm run dev:isolated -- --name <tag> [--hmr] [--phone-relay] [--reuse] [--copy-auth] [--onboarding]
    [--ttl-minutes=120] [--idle-minutes=${DEFAULT_IDLE_MS / 60_000}] [--require-fresh-core]
    [--owner-pid=<pid|none>] [--foreground]
    [--config-overlay=<json>] [--pass-env=NAME,...] [--inspect-main=<port>]
  npm run dev:isolated:ensure -- [--name <tag>] [--phone-relay] [--hmr] [--copy-auth] [--require-fresh-core]
  npm run dev:isolated:capture -- --out <file-or-dir> [--phone] [--eval <file> ...] [--require-fresh-core]
  npm run dev:isolated:list
  npm run dev:isolated:stop -- --name <tag> | --all [--all-sessions]
  npm run dev:isolated:sweep [-- --all] [--all-sessions]

Build modes:
  default (capture): static unminified dev build served from disk. Runs production React and bundled CSS,
    so it is close to the shipped app but is NOT the live Vite HMR dev build.
  --hmr: runs electron-vite dev for live renderer HMR while editing UI code.

Session isolation & lifecycle:
  Instances belong to the session that started them and are never shared across agents.
  ensure/capture reuse this session's instance only while every file read by the build (main, preload,
    renderer, relay, native modules) and config match; any edit triggers a rebuild.
  Clients connect to CDP through the supervisor: attached clients pause idle shutdown, and disconnect
    starts the backstop idle period (default ${DEFAULT_IDLE_MS / 60_000} min, from IDLE_RELEASE_MS in ${RUNTIME_IDLE_RELEASE_SOURCE}; 0 disables).
  For parked agent sessions, the instance ends when the session ends, on explicit stop, on source change,
    or after the ${DEFAULT_IDLE_MS / 60_000}-minute idle backstop.
  For sessions that are never parked (a Lead session or an interactive terminal), the instance ends on
    explicit dev:isolated:stop, when the terminal/owner process exits (or Ctrl-C with --foreground), on
    replacement after a source change, or after --idle-minutes / --ttl-minutes.
  A dev core binary older than its Rust sources warns by default; pass --require-fresh-core to refuse.
  stop --all stops only this session's instances; pass --all-sessions to stop across all sessions.
`;

/** Every isolated instance lives below this root; nothing else is ever deleted. */
export function isolatedRoot(env = process.env) {
  if (env.MIXDOG_DEV_ISOLATED_ROOT) return resolve(env.MIXDOG_DEV_ISOLATED_ROOT);
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'mixdog-dev-isolated') : join(homedir(), '.mixdog-dev-isolated');
}

const leasesDir = (root) => join(root, 'leases');
const portsDir = (root) => join(root, 'ports');
const locksDir = (root) => join(root, 'locks');
const instancesDir = (root) => join(root, 'instances');
const leasePath = (root, name) => join(leasesDir(root), `${name}.json`);
const lockPath = (root, name) => join(locksDir(root), `${name}.lock`);

function assertName(name) {
  if (!NAME.test(name ?? '')) throw new Error('--name must use letters, digits and hyphens (at most 48).');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** Persists the latest activity timestamp to the lease file when it still belongs to the same start. */
export async function updateLeaseLastUsed(root, name, startedAt, lastUsedAt) {
  const path = leasePath(root, name);
  const current = await readJson(path).catch(() => null);
  if (!current || (startedAt && current.startedAt !== startedAt)) return false;
  await replaceJson(path, { ...current, lastUsedAt });
  return true;
}

/** A lease is stale only when its process is gone or its PID was reused by a different process;
 *  live instances are never swept as stale. */
export function leaseIsStale(
  lease,
  { alive = isPidAlive, getCreated = getProcessCreationTimeMs } = {}
) {
  let runner;
  let expectedCreated;
  if (lease.supervisorPid !== undefined && lease.supervisorPid !== null) {
    runner = lease.supervisorPid;
    expectedCreated = lease.supervisorCreated;
  } else if (lease.pid !== undefined && lease.pid !== null) {
    runner = lease.pid;
    expectedCreated = lease.appCreated;
  } else {
    runner = lease.starterPid;
    expectedCreated = lease.starterCreated;
  }
  return !isSameProcess(runner, expectedCreated, { alive, getCreated });
}

/** Claim the name atomically (exclusive create); a stale holder is reclaimed once. */
export async function acquireLease(
  root,
  name,
  { ttlMs = DEFAULT_TTL_MS, now = Date.now(), alive = isPidAlive, getCreated = getProcessCreationTimeMs, list, devProfileDir } = {}
) {
  assertName(name);
  await mkdir(leasesDir(root), { recursive: true });
  const lease = {
    name,
    starterPid: process.pid,
    starterCreated: getCreated(process.pid),
    startedAt: new Date(now).toISOString(),
    ttlMs,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(leasePath(root, name), JSON.stringify(lease, null, 2), { flag: 'wx' });
      return lease;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readJson(leasePath(root, name));
      if (holder && !leaseIsStale(holder, { alive, getCreated })) {
        throw new Error(
          `Isolated instance "${name}" is running (pid ${holder.pid ?? holder.starterPid}). ` +
            'Stop it with dev:isolated:stop -- --name ' +
            name +
            ', or pick another --name.'
        );
      }
      if (holder) {
        const stopped = await stopInstance(root, holder, { ...(list ? { list } : {}), devProfileDir });
        if (stopped.unsaved) throw new Error(`Isolated instance "${name}" was not stopped: ${stopped.unsaved}`);
      } else await rm(leasePath(root, name), { force: true });
    }
  }
  throw new Error(`Could not claim isolated instance name "${name}".`);
}

/** Reserve a CDP port (exclusive file create) whose CDP and renderer ports are both free. */
export async function allocatePorts(
  root,
  name,
  { range = CDP_PORT_RANGE, probe = portIsFree, start = Math.floor(Math.random() * (range[1] - range[0] + 1)) } = {}
) {
  await mkdir(portsDir(root), { recursive: true });
  const span = range[1] - range[0] + 1;
  for (let index = 0; index < span; index += 1) {
    const cdpPort = range[0] + ((start + index) % span);
    const rendererPort = devRendererPortFor(cdpPort);
    if (RESERVED_PORTS.has(cdpPort) || RESERVED_PORTS.has(rendererPort)) continue;
    const reservation = join(portsDir(root), `${cdpPort}.json`);
    try {
      await writeFile(reservation, JSON.stringify({ name, pid: process.pid, rendererPort }), { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    if ((await probe(cdpPort)) && (await probe(rendererPort))) return { cdpPort, rendererPort };
    await rm(reservation, { force: true });
  }
  throw new Error(`No free CDP/renderer port pair in ${range[0]}-${range[1]}.`);
}

export async function portIsFree(port) {
  try {
    await assertDebugPortAvailable(port);
    return true;
  } catch {
    return false;
  }
}

const insideDir = (path, parent) => {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
};

/** The variables that make the core read a provider's own credential from another file than its data folder's
 *  (native/core/crates/mixdog-ai/src/accounts/mod.rs OWN_FILES). */
const CREDENTIAL_PATH_VARIABLES = [
  'OPENAI_OAUTH_CREDENTIALS_PATH',
  'ANTHROPIC_OAUTH_CREDENTIALS_PATH',
  'GROK_OAUTH_CREDENTIALS_PATH',
  'MUSE_CODE_OAUTH_CREDENTIALS_PATH',
  'COMMAND_CODE_OAUTH_CREDENTIALS_PATH',
  'OPENCODE_GO_OAUTH_CREDENTIALS_PATH',
  'MIMO_OAUTH_CREDENTIALS_PATH',
  'CURSOR_OAUTH_CREDENTIALS_PATH',
  'DEVIN_OAUTH_CREDENTIALS_PATH',
  'ANTIGRAVITY_OAUTH_CREDENTIALS_PATH',
];

/** Throws unless every data location sits inside the instance and no port is a shared one. */
export function assertIsolation(env, { instanceDir, cdpPort, rendererPort, parent = process.env }) {
  if (RESERVED_PORTS.has(cdpPort) || RESERVED_PORTS.has(rendererPort)) {
    throw new Error(`Port ${cdpPort}/${rendererPort} belongs to the shared 9342 dev app.`);
  }
  const forbidden = [
    join(homedir(), '.mixdog'),
    parent.APPDATA && join(parent.APPDATA, 'mixdog-desktop'),
    parent.APPDATA && join(parent.APPDATA, 'Mixdog'),
    persistentDevProfileDir('default', parent),
    desktopDir,
  ].filter(Boolean);
  const keys = [
    'MIXDOG_DESKTOP_USER_DATA',
    'MIXDOG_HOME',
    'MIXDOG_CONFIG_DIR',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
    'MIXDOG_USER_DATA_BACKUP_ROOT',
    'MIXDOG_DEV_VITE_CACHE_DIR',
  ];
  for (const key of keys) {
    const value = env[key];
    if (!value || !insideDir(value, instanceDir)) throw new Error(`${key} is not inside the instance (${value}).`);
    const shared = forbidden.find((path) => insideDir(value, path) || insideDir(path, value));
    if (shared) throw new Error(`${key} overlaps a shared location: ${shared}`);
  }
  for (const key of CREDENTIAL_PATH_VARIABLES) {
    const value = env[key];
    if (!value) continue;
    const shared = forbidden.find((path) => insideDir(value, path) || insideDir(path, value));
    if (shared) throw new Error(`${key} names a credential file in a shared location: ${shared}`);
  }
  if (env.MIXDOG_RELAY_URL !== 'off' && !LOOPBACK_RELAY.test(env.MIXDOG_RELAY_URL || '')) {
    throw new Error('An isolated instance must not dial the relay (only a loopback --relay).');
  }
}

// ── processes ────────────────────────────────────────────────────────────────

export function listProcesses({ withMemory = false } = {}) {
  if (process.platform === 'win32') {
    const props = withMemory
      ? 'ProcessId,ParentProcessId,CommandLine,WorkingSetSize,@{n="Created";e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}'
      : 'ProcessId,ParentProcessId,CommandLine,@{n="Created";e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}';
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Select-Object ${props} | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    // Windows never rewrites a dead parent's pid in ParentProcessId, so `created` lets a
    // reused parent pid be told apart from the real parent (see instanceProcessIds).
    return [JSON.parse(raw || '[]')].flat().map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      cmd: row.CommandLine ?? '',
      created: Number.isFinite(row.Created) ? row.Created : undefined,
      ...(withMemory ? { rssBytes: Number.isFinite(row.WorkingSetSize) ? row.WorkingSetSize : 0 } : {}),
    }));
  }
  const cols = withMemory ? 'pid=,ppid=,rss=,args=' : 'pid=,ppid=,args=';
  const raw = execFileSync('ps', ['-A', '-o', cols], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\n').flatMap((line) => {
    if (withMemory) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, cmd: match[4] }]
        : [];
    }
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] }] : [];
  });
}

/** Every process naming the instance directory on its command line and all their descendants started after the lease.
 *  Nothing matched by bare PID or image name is ever included. `ancestors` (killed: pid → creation time) only adopt
 *  orphans. Windows keeps a dead parent's pid in ParentProcessId, so a child counts only when it started after its
 *  parent (and at or after `minCreatedAt`). */
export function instanceProcessIds(
  processes,
  { ancestors = new Map(), needle, minCreatedAt, self = process.pid } = {}
) {
  // Normalize slashes on Windows so postgres (`-D "C:/.../instances/..."`) matches backslash instanceDir paths.
  const fold = (text) =>
    process.platform === 'win32' ? String(text).replaceAll('\\', '/').toLowerCase() : String(text);
  const marker = needle ? fold(needle) : null;
  const afterLease = (row) =>
    !Number.isFinite(minCreatedAt) || typeof row.created !== 'number' || row.created >= minCreatedAt;
  const ids = new Set();
  for (const row of processes) {
    if (row.pid !== self && marker && fold(row.cmd).includes(marker) && afterLease(row)) {
      ids.add(row.pid);
    }
  }
  const createdOf = new Map(processes.map((row) => [row.pid, row.created]));
  // Never seed `parents` with `self`, otherwise a supervisor cleaning itself up adopts its own `listProcesses` shell.
  const parents = new Map([...ancestors, ...[...ids].map((pid) => [pid, createdOf.get(pid)])]);
  parents.delete(self);
  // A killed ancestor's pid that is live again with another creation time now belongs
  // to an unrelated process; only children started before that reuse are orphans of ours.
  const reusedAt = (pid) => {
    if (!ancestors.has(pid)) return undefined;
    const recorded = ancestors.get(pid);
    const live = createdOf.get(pid);
    return recorded !== undefined && live !== undefined && live !== recorded ? live : undefined;
  };
  const startedAfter = (row) => {
    if (!afterLease(row)) return false;
    const parentCreated = parents.get(row.ppid);
    if (parentCreated === undefined || row.created === undefined) return true;
    const reuse = reusedAt(row.ppid);
    return row.created >= parentCreated && (reuse === undefined || row.created < reuse);
  };
  for (let size = -1; size !== parents.size; ) {
    size = parents.size;
    for (const row of processes) {
      if (parents.has(row.ppid) && !parents.has(row.pid) && startedAfter(row)) {
        parents.set(row.pid, row.created);
        ids.add(row.pid);
      }
    }
  }
  ids.delete(self);
  const live = new Set(processes.map((row) => row.pid));
  return [...ids].filter((pid) => live.has(pid));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Call the running supervisor's loopback control endpoint, or null when absent/unreachable.
 *  Loopback TCP fails immediately with ECONNREFUSED/ECONNRESET if the supervisor is not running. */
export async function querySupervisor(lease, path, { method = 'GET', body, signal } = {}) {
  if (!Number.isInteger(lease?.controlPort) || !lease?.controlToken) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${lease.controlPort}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${lease.controlToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Find a live lease matching a CDP port under `root`. */
export async function findLeaseByPort(root, cdpPort) {
  const port = Number(cdpPort);
  if (!Number.isInteger(port)) return null;
  const leases = await readLeases(root);
  return leases.find((lease) => lease.cdpPort === port && !leaseIsStale(lease)) ?? null;
}

/** Reset and persist the idle timestamp of an isolated instance (identified by CDP port or name). */
export async function touchInstance(root, portOrName) {
  const leases = await readLeases(root);
  const asPort = Number(portOrName);
  const lease = leases.find(
    (entry) =>
      !leaseIsStale(entry) &&
      (entry.name === portOrName || (Number.isInteger(asPort) && entry.cdpPort === asPort))
  );
  if (!lease) return null;
  const status = await querySupervisor(lease, '/touch', { method: 'POST' });
  return { lease, status };
}

/** Assign a capture browser PID into a supervisor-owned OS Job Object tied to the caller PID. */
export async function assignCaptureBrowser(lease, pid, { ownerPid = process.pid, profileDir = null } = {}) {
  if (!lease || !Number.isInteger(pid) || pid <= 0) return false;
  const res = await querySupervisor(lease, '/browser/assign', {
    method: 'POST',
    body: {
      pid,
      ...(Number.isInteger(ownerPid) && ownerPid > 0 ? { ownerPid } : {}),
      ...(profileDir ? { profileDir } : {}),
    },
  });
  return Boolean(res?.assigned);
}

/** Release a capture browser PID from the supervisor's active set after closing it. */
export async function releaseCaptureBrowser(lease, pid) {
  if (!lease || !Number.isInteger(pid) || pid <= 0) return;
  await querySupervisor(lease, '/browser/release', { method: 'POST', body: { pid } });
}

/** Kill every process whose command line carries the instance directory (created at/after the lease) and its descendants. */
export async function killInstanceProcesses(lease, { list = listProcesses } = {}) {
  const minCreatedAt = lease.startedAt ? Date.parse(lease.startedAt) : undefined;
  const killed = new Map(); // pid → creation time
  let remaining = [];
  for (let round = 0; round < 20; round += 1) {
    const processes = list();
    remaining = instanceProcessIds(processes, {
      ancestors: killed,
      needle: lease.instanceDir && join(lease.instanceDir, sep),
      minCreatedAt: Number.isFinite(minCreatedAt) ? minCreatedAt : undefined,
    });
    if (remaining.length === 0) break;
    const createdOf = new Map(processes.map((row) => [row.pid, row.created]));
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.set(pid, createdOf.get(pid));
      } catch {
        // Already gone.
      }
    }
    await sleep(500);
  }
  return { killed: [...killed.keys()], remaining };
}

/** Stop an instance: supervisor /stop (atomic Job Object kill) or instanceDir+created fallback, then auth save and cleanup. */
export async function stopInstance(
  root,
  lease,
  { devProfileDir = persistentDevProfileDir('default'), skipControlStop = false, preKilled = [], ...options } = {}
) {
  if (
    !skipControlStop &&
    Number.isInteger(lease?.controlPort) &&
    lease?.controlToken &&
    Number.isInteger(lease?.supervisorPid) &&
    lease.supervisorPid !== process.pid &&
    isSameProcess(lease.supervisorPid, lease.supervisorCreated, { alive: isPidAlive })
  ) {
    const controlled = await querySupervisor(lease, '/stop', { method: 'POST' });
    if (controlled && typeof controlled.removed === 'boolean') return controlled;
  }
  const { killed: newlyKilled, remaining } = await killInstanceProcesses(lease, options);
  const killed = [...new Set([...preKilled, ...newlyKilled])];
  let removed = true;
  if (
    lease.instanceDir &&
    (!insideDir(lease.instanceDir, instancesDir(root)) || resolve(lease.instanceDir) === resolve(instancesDir(root)))
  ) {
    throw new Error(`Refusing to delete ${lease.instanceDir}: not an isolated instance directory.`);
  }
  let carried = [];
  if (lease.instanceDir && (lease.authCarry?.seeded || startedUnkept(lease))) {
    // Saved only once no process of the instance can still rotate a token; an instance not saved is never deleted.
    let unsaved = remaining.length ? `processes ${remaining.join(', ')} still run` : null;
    if (!unsaved) {
      try {
        carried = await carryAuthOut(root, lease, devProfileDir);
      } catch (error) {
        unsaved = error.message;
      }
    }
    if (unsaved) {
      return {
        name: lease.name,
        killed,
        remaining,
        removed: false,
        carried,
        unsaved: `its provider sign-ins were not saved, so ${lease.instanceDir} and its lease stay (${unsaved}).`,
      };
    }
  }
  if (lease.instanceDir) {
    removed = false;
    for (let attempt = 0; attempt < 20 && !removed; attempt += 1) {
      try {
        // fs.rm removes junctions/symlinks themselves, never their targets.
        await rm(lease.instanceDir, { recursive: true, force: true, maxRetries: 3 });
        removed = true;
      } catch {
        await sleep(500);
      }
    }
  }
  if (Number.isInteger(lease.cdpPort)) {
    const reservation = join(portsDir(root), `${lease.cdpPort}.json`);
    if ((await readJson(reservation).catch(() => null))?.name === lease.name) await rm(reservation, { force: true });
  }
  // A directory Windows still locks keeps its lease, so the next sweep retries.
  if (removed && remaining.length === 0) {
    const current = await readJson(leasePath(root, lease.name)).catch(() => null);
    if (!current || current.startedAt === lease.startedAt) await rm(leasePath(root, lease.name), { force: true });
  }
  return { name: lease.name, killed, remaining, removed, carried };
}

/** Called by the supervisor itself after terminating its Job Object to save auth and delete instance files. */
export async function cleanupStoppedInstance(root, name, { devProfileDir, killed = [] } = {}) {
  const lease = await readJson(leasePath(root, name)).catch(() => null);
  if (!lease) return { name, killed, remaining: [], removed: true, carried: [] };
  return stopInstance(root, lease, { devProfileDir, skipControlStop: true, preKilled: killed });
}

export async function readLeases(root) {
  const names = await readdir(leasesDir(root)).catch(() => []);
  const leases = [];
  for (const file of names.filter((entry) => entry.endsWith('.json'))) {
    const lease = await readJson(join(leasesDir(root), file)).catch(() => null);
    if (lease?.name) leases.push(lease);
  }
  return leases;
}

/** Reclaim dead leases, then reservations and directories no lease owns.
 *  With `all: true`, stops live leases of the calling session (or every session when `allSessions: true`). */
export async function sweep(
  root,
  {
    all = false,
    allSessions = false,
    caller = null,
    alive = isPidAlive,
    getCreated = getProcessCreationTimeMs,
    list = listProcesses,
    devProfileDir,
  } = {}
) {
  const session =
    all && !allSessions
      ? caller ?? resolveCallerSession(process.env, { processes: list(), selfPid: process.pid })
      : null;
  const results = [];
  for (const lease of await readLeases(root)) {
    const stale = leaseIsStale(lease, { alive, getCreated });
    const owned = all && (allSessions || leaseBelongsToSession(lease, session));
    if (stale || owned) {
      results.push(await stopInstance(root, lease, { list, devProfileDir }));
    }
  }
  // List reservations and directories BEFORE reading leases: a starter writes
  // its lease before either, so anything listed here already has its lease.
  const portFiles = await readdir(portsDir(root)).catch(() => []);
  const instanceEntries = await readdir(instancesDir(root)).catch(() => []);
  const live = await readLeases(root);
  const owners = new Set(live.map((lease) => lease.name));
  for (const file of portFiles) {
    const reservation = await readJson(join(portsDir(root), file)).catch(() => null);
    if (!reservation || !owners.has(reservation.name)) await rm(join(portsDir(root), file), { force: true });
  }
  const used = new Set(live.map((lease) => lease.instanceDir && resolve(lease.instanceDir)));
  for (const entry of instanceEntries) {
    const instanceDir = join(instancesDir(root), entry);
    // A starter creates its lease before its directory, so an unowned one is debris.
    if (!used.has(resolve(instanceDir))) {
      results.push(await stopInstance(root, { name: `orphan:${entry}`, instanceDir }, { list }));
    }
  }
  return results;
}

// ── start ────────────────────────────────────────────────────────────────────

const POOL_FILE = 'provider-accounts.json';
const CONFIG_FILE = 'mixdog-config.json';
/** Developer-only providers and their `agent.developer` option: hidden while it is off (ai_account/oauth_status.rs
 *  `oauth_available`). */
const DEVELOPER_OPTION = {
  'antigravity-oauth': 'antigravityOAuth',
  'cursor-oauth': 'cursorOAuth',
  'devin-oauth': 'devinOAuth',
  'mimo-oauth': 'mimoOAuth',
};
const CREDENTIAL_FILE = /^(provider-accounts\.json|[a-z0-9-]+-oauth(-credentials)?\.json)$/;
const ACCOUNT_PROVIDER_DIR = /^[a-z0-9-]+$/;
/** The GPT subscription's credential, as named in the copied list. */
const GPT_CREDENTIAL = /^(openai-oauth\.json|provider-accounts\/openai-oauth\/[^/]+\.json)$/;
const REFRESH_TOKEN_KEYS = new Set(['refresh_token', 'refreshToken']);

/** The credential without any refresh token, however deeply nested. */
function withoutRefreshTokens(value) {
  if (Array.isArray(value)) return value.map(withoutRefreshTokens);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !REFRESH_TOKEN_KEYS.has(key))
      .map(([key, item]) => [key, withoutRefreshTokens(item)])
  );
}

/** A copy cannot refresh, so its GPT access token must outlive the lease. */
function assertAccessTokenOutlivesLease(credential, label, ttlMs) {
  const expiresAt =
    normalizeExpiresAtMs(credential?.expires_at ?? credential?.expiresAt) ||
    expiryFromAccessToken(credential?.access_token);
  const now = Date.now();
  if (expiresAt > now + ttlMs) return;
  const prefix = `--copy-auth: the kept dev profile's GPT sign-in (${label})`;
  const never =
    'A refresh token is never copied (refreshing it in an isolated instance would sign the kept profile out).';
  if (expiresAt <= now) {
    const problem = expiresAt ? 'is expired' : 'has no readable access-token expiry';
    throw new Error(
      `${prefix} ${problem}. ${never} Open the kept dev app once (npm run dev in apps/desktop) so it refreshes, then start again.`
    );
  }
  // The kept app refreshes only within minutes of expiry, so opening it now would not help.
  const minutes = Math.floor((expiresAt - now) / 60_000);
  throw new Error(
    `${prefix} is valid for only ${minutes} more minutes, less than this ${Math.round(ttlMs / 60_000)}-minute lease. ` +
      `${never} ${minutes >= 2 ? `Start with --ttl-minutes ${minutes - 1} or less, or try` : 'Try'} again once it is ` +
      'near expiry (the kept dev app refreshes it then).'
  );
}

/** Runs an fs lookup that names the dev-profile path in its failure; a missing path yields null when optional. */
async function readDevSource(lookup, path, { optional = false } = {}) {
  try {
    return await lookup(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`--copy-auth: cannot read the kept dev profile at ${path} (${error.code ?? error.message}).`, {
      cause: error,
    });
  }
}

/** The directory holding the kept-profile root (LOCALAPPDATA or the home directory) for a
 *  `<base>/mixdog-dev/<name>` profile. It is the user's own location, so it is where trust starts. */
const devTrustedRoot = (devProfileDir) => resolve(devProfileDir, '..', '..');

const foldCase = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** A credential source is only ever a real directory or file below the trusted root: links
 *  and junctions could point anywhere, so they are refused. */
function assertNotLink(stat, path) {
  if (stat.isSymbolicLink()) throw new Error(`--copy-auth: refusing ${path}: it is a symlink or junction.`);
}

/** lstat of `path` after proving every component below the trusted root is a real entry: lstat rejects symlinks and
 *  junctions, and each realpath must equal its expected location. Null when optional and `path` is absent. */
async function lstatTrusted(trustedRoot, path, { optional = false } = {}) {
  const root = resolve(trustedRoot);
  const below = relative(root, resolve(path));
  if (!below || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) {
    throw new Error(`--copy-auth: refusing ${path}: it is outside the trusted dev tree ${root}.`);
  }
  let current = root;
  let expected = await readDevSource(realpath, root);
  let stat = null;
  for (const part of below.split(sep)) {
    current = join(current, part);
    expected = join(expected, part);
    stat = await readDevSource(lstat, current, { optional });
    if (!stat) return null;
    assertNotLink(stat, current);
    const actual = await readDevSource(realpath, current);
    if (foldCase(actual) !== foldCase(expected)) {
      throw new Error(`--copy-auth: refusing ${current}: it resolves to ${actual} through a symlink or junction.`);
    }
  }
  return stat;
}

async function readDevDir(path) {
  try {
    return await readdir(path);
  } catch (error) {
    throw new Error(`--copy-auth: cannot read ${path} (${error.code ?? error.message}).`, { cause: error });
  }
}

async function assertDevFile(trustedRoot, path, { optional = false } = {}) {
  const stat = await lstatTrusted(trustedRoot, path, { optional });
  if (!stat) return;
  if (!stat.isFile()) throw new Error(`--copy-auth: ${path} is not a regular file.`);
}

/** Writes one sign-in without its refresh tokens: OAuth refresh tokens rotate, so a copy that
 *  refreshed would invalidate the kept profile's own. The parse error is not chained or quoted:
 *  it can echo file content. */
async function copyCredential(source, destination, label, ttlMs) {
  const text = await readDevSource((path) => readFile(path, 'utf8'), source);
  let credential;
  try {
    credential = JSON.parse(text);
  } catch {
    throw new Error(`--copy-auth: ${label} in the kept dev profile is not valid JSON.`);
  }
  if (GPT_CREDENTIAL.test(label)) assertAccessTokenOutlivesLease(credential, label, ttlMs);
  await writeFile(destination, JSON.stringify(withoutRefreshTokens(credential)), { mode: 0o600 });
}

/** Opt-in: copy provider sign-ins from the kept dev profile (never ~/.mixdog), without their
 *  refresh tokens, and refuse a GPT sign-in whose access token expires within `ttlMs`.
 *  Source is only read. A missing or unreadable profile, or any link from the trusted root down
 *  to a source, fails instead of copying nothing or copying from outside the kept dev tree. */
export async function copyDevAuth(
  dataDir,
  {
    devProfileDir = persistentDevProfileDir('default'),
    trustedRoot = devTrustedRoot(devProfileDir),
    ttlMs = DEFAULT_TTL_MS,
    skip = new Set(),
    required = true,
  } = {}
) {
  const source = join(devProfileDir, 'data');
  for (const dir of [devProfileDir, source]) {
    const stat = await lstatTrusted(trustedRoot, dir);
    if (!stat.isDirectory()) throw new Error(`--copy-auth: ${dir} is not a directory.`);
  }
  const copied = [];
  for (const entry of (await readDevDir(source)).filter((name) => CREDENTIAL_FILE.test(name) && !skip.has(name))) {
    await assertDevFile(trustedRoot, join(source, entry));
    if (entry === POOL_FILE) await copyFile(join(source, entry), join(dataDir, entry));
    else await copyCredential(join(source, entry), join(dataDir, entry), entry, ttlMs);
    copied.push(entry);
  }
  // Every account but a provider's default keeps its credential in
  // provider-accounts/<provider>/<id>.json; the pool file alone names accounts
  // whose sign-ins would then be missing.
  const accountsDir = join(source, 'provider-accounts');
  if (await lstatTrusted(trustedRoot, accountsDir, { optional: true })) {
    for (const provider of (await readDevDir(accountsDir)).filter((name) => ACCOUNT_PROVIDER_DIR.test(name))) {
      const providerDir = join(accountsDir, provider);
      const stat = await lstatTrusted(trustedRoot, providerDir);
      if (!stat.isDirectory()) continue;
      const accounts = (await readDevDir(providerDir)).filter((name) => name.endsWith('.json'));
      if (accounts.length) await mkdir(join(dataDir, 'provider-accounts', provider), { recursive: true });
      for (const entry of accounts) {
        const label = `provider-accounts/${provider}/${entry}`;
        if (skip.has(label)) continue;
        await assertDevFile(trustedRoot, join(providerDir, entry));
        const destination = join(dataDir, 'provider-accounts', provider, entry);
        await copyCredential(join(providerDir, entry), destination, label, ttlMs);
        copied.push(label);
      }
    }
  }
  const secretsDir = join(source, 'secrets');
  if (await lstatTrusted(trustedRoot, secretsDir, { optional: true })) {
    // A connector sign-in is a grant whose refresh token rotates: the instance signs in for itself.
    const secrets = (await readDevDir(secretsDir)).filter(
      (name) => name.endsWith('.dpapi') && !name.startsWith('mcp-oauth.')
    );
    if (secrets.length) await mkdir(join(dataDir, 'secrets'), { recursive: true });
    for (const entry of secrets) {
      await assertDevFile(trustedRoot, join(secretsDir, entry));
      await copyFile(join(secretsDir, entry), join(dataDir, 'secrets', entry));
      copied.push(`secrets/${entry}`);
    }
  }
  if (!copied.length && required) {
    throw new Error(`--copy-auth: the kept dev profile at ${devProfileDir} has no provider sign-ins to copy.`);
  }
  return copied;
}

// ── sign-ins kept between instances ─────────────────────────────────────────

const CARRY_DIR = 'dev-isolated-auth';
const HOLDER_FILE = 'holder.json';
const CARRY_ENTRY = /^[a-z0-9-]+\.json$/;
const ACCOUNT_FILE = /^provider-accounts\/([a-z0-9-]+)\/([a-z0-9-]+)\.json$/;
// native/core/crates/mixdog-ai/src/accounts/mod.rs MAX_ACCOUNTS: a longer list makes the core read the roster as damaged.
const MAX_ACCOUNTS = 20;

/** Where instances keep sign-ins: always the kept profile's own folder, which the kept dev app never reads. */
export const carryStoreDir = (devProfileDir) => join(devProfileDir, CARRY_DIR);

/** The provider an instance credential file belongs to, or null for anything else. */
function credentialProvider(rel) {
  if (CREDENTIAL_FILE.test(rel) && rel !== POOL_FILE) return rel.replace(/\.json$/, '').replace(/-credentials$/, '');
  return ACCOUNT_FILE.exec(rel)?.[1] ?? null;
}

/** The roster account id a credential file belongs to: `default` for the provider's own file. */
const accountIdOf = (rel) => ACCOUNT_FILE.exec(rel)?.[2] ?? 'default';

function hasRefreshToken(value) {
  if (Array.isArray(value)) return value.some(hasRefreshToken);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) => (REFRESH_TOKEN_KEYS.has(key) && typeof item === 'string' && item !== '') || hasRefreshToken(item)
  );
}

async function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Parsed JSON of a file already proven a regular file; a parse error names the file, never its content. */
async function readTrustedJson(path, label) {
  const text = await readDevSource((file) => readFile(file, 'utf8'), path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

/** One isolated root, however a shell spelled it: Windows paths differ in case (`c:\` and `C:\`) and name one folder. */
const rootKey = (root) => (process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));
const sameHolder = (a, b) =>
  isPlainObject(a) &&
  isPlainObject(b) &&
  typeof a.root === 'string' &&
  typeof b.root === 'string' &&
  rootKey(a.root) === rootKey(b.root) &&
  a.name === b.name &&
  a.startedAt === b.startedAt;

/** Serializes claims and write-backs between starters and stoppers of every isolated root. */
async function withCarryLock(store, run) {
  const lock = join(store, '.lock');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
      const age = await lstat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0
      );
      if (owner ? !isPidAlive(owner) : age > 10_000) {
        await rm(lock, { force: true });
        continue;
      }
      if (attempt >= 300) throw new Error(`Kept sign-ins: ${lock} stays held by pid ${owner || 'unknown'}.`);
      await sleep(100);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lock, { force: true });
  }
}

/** The holder record as written, or undefined when there is no record. */
async function readHolder(trustedRoot, store) {
  const path = join(store, HOLDER_FILE);
  if (!(await lstatTrusted(trustedRoot, path, { optional: true }))) return undefined;
  await assertDevFile(trustedRoot, path);
  return readTrustedJson(path, `Kept sign-ins: the holder record ${path}`);
}

/** Why the kept sign-ins are in use, or null when free. Free is only no record, or a record whose lease is gone or
 *  is another start's; a record or lease that cannot be read, or does not say what it must, holds them: stopInstance
 *  drops a lease only once its instance is gone. */
async function carryHeldBy(trustedRoot, store) {
  let holder;
  try {
    holder = await readHolder(trustedRoot, store);
  } catch (error) {
    return error.message;
  }
  if (holder === undefined) return null;
  if (!isPlainObject(holder) || typeof holder.root !== 'string' || !NAME.test(holder.name ?? '')) {
    return `${join(store, HOLDER_FILE)} names no instance`;
  }
  const stop = `stop it with npm run dev:isolated:stop -- --name ${holder.name}`;
  let lease;
  try {
    lease = JSON.parse(await readFile(leasePath(holder.root, holder.name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `the lease of isolated instance "${holder.name}" (${holder.root}) cannot be read; ${stop}`;
  }
  if (!isPlainObject(lease) || typeof lease.startedAt !== 'string') {
    return `the lease of isolated instance "${holder.name}" (${holder.root}) cannot be read; ${stop}`;
  }
  if (lease.startedAt !== holder.startedAt) return null;
  return `isolated instance "${holder.name}" (${holder.root}, started ${holder.startedAt}) holds them; ${stop}`;
}

/** The carry store, created below the kept profile when absent; only real directories below the trusted root. */
async function ensureCarryStore(trustedRoot, devProfileDir) {
  const store = carryStoreDir(devProfileDir);
  const stat = await lstatTrusted(trustedRoot, store, { optional: true });
  if (!stat) {
    await mkdir(store, { recursive: true });
    await lstatTrusted(trustedRoot, store);
  } else if (!stat.isDirectory()) throw new Error(`Kept sign-ins: ${store} is not a directory.`);
  return store;
}

/** The kept sign-ins, by provider. */
async function readCarriedEntries(trustedRoot, store) {
  const entries = new Map();
  for (const file of (await readDevDir(store)).filter((name) => CARRY_ENTRY.test(name) && name !== HOLDER_FILE)) {
    const path = join(store, file);
    await assertDevFile(trustedRoot, path);
    const entry = await readTrustedJson(path, `Kept sign-ins: ${path}`);
    if (!isPlainObject(entry?.files)) throw new Error(`Kept sign-ins: ${path} holds no sign-in.`);
    entries.set(file.slice(0, -'.json'.length), entry);
  }
  return entries;
}

/** Makes `holder` the one instance with the kept sign-ins and returns them, by provider. While another instance
 *  holds them, returns none and why, and `holder` holds nothing. */
async function claimCarriedAuth({ devProfileDir, trustedRoot, holder }) {
  const store = await ensureCarryStore(trustedRoot, devProfileDir);
  return withCarryLock(store, async () => {
    const heldBy = await carryHeldBy(trustedRoot, store);
    if (heldBy) return { entries: new Map(), heldBy: `the kept sign-ins in ${store} are in use: ${heldBy}` };
    const entries = await readCarriedEntries(trustedRoot, store);
    await writePrivateJson(join(store, HOLDER_FILE), holder);
    return { entries, heldBy: null };
  });
}

/** The kept roster's pool with the carried accounts merged in by id. */
function mergePool(kept, carried) {
  if (!isPlainObject(kept)) return carried;
  const accounts = Array.isArray(kept.accounts) ? [...kept.accounts] : [];
  for (const row of Array.isArray(carried.accounts) ? carried.accounts : []) {
    const at = accounts.findIndex((account) => account?.id === row?.id);
    if (at >= 0) accounts[at] = row;
    else if (accounts.length < MAX_ACCOUNTS) accounts.push(row);
  }
  const selectedId = accounts.some((row) => row?.id === kept.selectedId) ? kept.selectedId : carried.selectedId;
  return { ...kept, accounts, selectedId };
}

/** Writes the kept sign-ins into the instance, replacing the kept profile's copy of the same file, and merges their
 *  accounts into its roster. Returns where each credential file came from. */
async function applyCarriedAuth(dataDir, entries, kept) {
  const seeded = Object.fromEntries(kept.map((label) => [label, 'kept']));
  for (const [provider, entry] of entries) {
    for (const [rel, credential] of Object.entries(entry.files)) {
      if (credentialProvider(rel) !== provider) continue;
      const destination = join(dataDir, ...rel.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify(credential), { mode: 0o600 });
      seeded[rel] = 'carry';
    }
  }
  const pools = [...entries].filter(([, entry]) => isPlainObject(entry.pool));
  if (pools.length) {
    const rosterPath = join(dataDir, POOL_FILE);
    const copied = await readFile(rosterPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    // The core reads any other roster as damaged.
    const roster =
      isPlainObject(copied) && copied.version === 1 && isPlainObject(copied.providers)
        ? copied
        : { version: 1, providers: {} };
    for (const [provider, entry] of pools)
      roster.providers[provider] = mergePool(roster.providers[provider], entry.pool);
    await writeFile(rosterPath, JSON.stringify(roster, null, 2), { mode: 0o600 });
  }
  return seeded;
}

/** Every start: claims the kept sign-ins for `holder` and writes them into the instance; with `copyAuth`, the kept
 *  profile's sign-ins are copied first as --copy-auth does, and the kept ones replace the same files. `seeded` is null
 *  when another instance holds them: this one then holds and saves nothing. */
export async function seedInstanceAuth(
  dataDir,
  {
    devProfileDir = persistentDevProfileDir('default'),
    trustedRoot = devTrustedRoot(devProfileDir),
    ttlMs = DEFAULT_TTL_MS,
    holder,
    copyAuth = false,
  }
) {
  const { entries, heldBy } = await claimCarriedAuth({ devProfileDir, trustedRoot, holder });
  const skip = new Set();
  for (const [provider, entry] of entries) {
    for (const rel of Object.keys(entry.files)) if (credentialProvider(rel) === provider) skip.add(rel);
  }
  const copied = copyAuth
    ? await copyDevAuth(dataDir, { devProfileDir, trustedRoot, ttlMs, skip, required: !entries.size })
    : [];
  const seeded = await applyCarriedAuth(dataDir, entries, copied);
  // A sign-in sets its provider `enabled` (ai_account/admin.rs); an entry saved before configs were kept says nothing else.
  const providerConfigs = Object.fromEntries(
    [...entries].map(([provider, entry]) => [provider, isPlainObject(entry.config) ? entry.config : { enabled: true }])
  );
  // A developer-only provider can only be signed in to with its option on, so an entry that did not record it had it on.
  const developerOptions = Object.fromEntries(
    [...entries]
      .filter(([provider]) => DEVELOPER_OPTION[provider])
      .map(([provider, entry]) => [
        DEVELOPER_OPTION[provider],
        typeof entry.developer === 'boolean' ? entry.developer : true,
      ])
  );
  return {
    copied,
    carried: [...entries.keys()],
    seeded: heldBy ? null : seeded,
    heldBy,
    providerConfigs,
    developerOptions,
  };
}

/** Puts each kept provider's config, as its sign-in left it, into the instance config under agent.providers, and the
 *  developer options of the developer-only ones under agent.developer. */
export async function restoreProviderConfig(dataDir, providerConfigs, developerOptions = {}) {
  if (!Object.keys(providerConfigs).length && !Object.keys(developerOptions).length) return;
  const file = join(dataDir, CONFIG_FILE);
  const read = await readJson(file);
  const config = isPlainObject(read) ? read : {};
  const agent = isPlainObject(config.agent) ? config.agent : {};
  const providers = isPlainObject(agent.providers) ? { ...agent.providers } : {};
  for (const [provider, entry] of Object.entries(providerConfigs)) {
    providers[provider] = { ...(isPlainObject(providers[provider]) ? providers[provider] : {}), ...entry };
  }
  const developer = { ...(isPlainObject(agent.developer) ? agent.developer : {}), ...developerOptions };
  config.agent = { ...agent, providers, ...(Object.keys(developer).length ? { developer } : {}) };
  await writeFile(file, JSON.stringify(config, null, 2));
}

/** The instance's provider credential files, by provider; any link or unreadable file throws. */
async function instanceCredentials(trustedRoot, dataDir) {
  await lstatTrusted(trustedRoot, dataDir);
  const rels = (await readDevDir(dataDir)).filter((name) => credentialProvider(name));
  const accountsDir = join(dataDir, 'provider-accounts');
  if (await lstatTrusted(trustedRoot, accountsDir, { optional: true })) {
    for (const provider of (await readDevDir(accountsDir)).filter((name) => ACCOUNT_PROVIDER_DIR.test(name))) {
      const stat = await lstatTrusted(trustedRoot, join(accountsDir, provider));
      if (!stat.isDirectory()) continue;
      for (const entry of await readDevDir(join(accountsDir, provider))) {
        const rel = `provider-accounts/${provider}/${entry}`;
        if (credentialProvider(rel)) rels.push(rel);
      }
    }
  }
  const byProvider = new Map();
  for (const rel of rels) {
    const path = join(dataDir, ...rel.split('/'));
    await assertDevFile(trustedRoot, path);
    const credential = await readTrustedJson(path, `The instance's ${rel}`);
    const provider = credentialProvider(rel);
    byProvider.set(provider, { ...byProvider.get(provider), [rel]: credential });
  }
  return byProvider;
}

/** True for the lease of an instance started before sign-ins were kept by default: it holds no claim, and its stop
 *  adopts its sign-ins when no instance holds the kept ones. */
const startedUnkept = (lease) => !('authCarry' in lease) && typeof lease.startedAt === 'string';

/** The write-back at a stop. The holder's sign-ins (those it was handed and those made in it), with the roster
 *  accounts they belong to, replace the kept ones, and its claim ends; the kept profile's --copy-auth copies stay
 *  behind. An instance started before this adds its sign-ins per provider, unless another instance holds them. An
 *  instance that no longer holds writes nothing. */
async function carryAuthOut(root, lease, devProfileDir) {
  const trustedRoot = devTrustedRoot(devProfileDir);
  const adopt = startedUnkept(lease);
  const store = carryStoreDir(devProfileDir);
  if (!adopt && !(await lstatTrusted(trustedRoot, store, { optional: true }))) return [];
  if (adopt) await ensureCarryStore(trustedRoot, devProfileDir);
  return withCarryLock(store, async () => {
    const holder = { root: resolve(root), name: lease.name, startedAt: lease.startedAt };
    if (adopt ? await carryHeldBy(trustedRoot, store) : !sameHolder(await readHolder(trustedRoot, store), holder)) {
      return [];
    }
    const fromKeptProfile = adopt
      ? (rel) => existsSync(join(devProfileDir, 'data', ...rel.split('/')))
      : (rel) => lease.authCarry.seeded[rel] === 'kept';
    const previous = await readCarriedEntries(trustedRoot, store);
    const instanceTrust = instancesDir(root);
    const dataDir = join(lease.instanceDir, 'profile', 'data');
    if (adopt && !(await lstatTrusted(instanceTrust, dataDir, { optional: true }))) return [];
    const found = await instanceCredentials(instanceTrust, dataDir);
    const readInstanceJson = async (file) => {
      const path = join(dataDir, file);
      if (!(await lstatTrusted(instanceTrust, path, { optional: true }))) return null;
      await assertDevFile(instanceTrust, path);
      return readTrustedJson(path, `The instance's ${file}`);
    };
    const roster = await readInstanceJson(POOL_FILE);
    const agentConfig = (await readInstanceJson(CONFIG_FILE))?.agent;
    const configured = agentConfig?.providers;
    const saved = [];
    for (const [provider, files] of found) {
      const own = Object.fromEntries(
        Object.entries(files).filter(([rel, credential]) => hasRefreshToken(credential) || !fromKeptProfile(rel))
      );
      if (!Object.keys(own).length) continue;
      const ids = new Set(Object.keys(own).map(accountIdOf));
      const pool = roster?.providers?.[provider];
      // An adopting instance adds to the kept entry; the holder's own entry replaces it.
      const earlier = adopt ? previous.get(provider) : undefined;
      const record = { files: { ...earlier?.files, ...own }, savedAt: new Date().toISOString() };
      // What the sign-in wrote to the config; an entry saved before configs were kept keeps none until one is written.
      const config = isPlainObject(configured?.[provider]) ? configured[provider] : previous.get(provider)?.config;
      if (isPlainObject(config)) record.config = config;
      const option = DEVELOPER_OPTION[provider];
      const developer = option && agentConfig?.developer?.[option];
      if (typeof developer === 'boolean') record.developer = developer;
      else if (typeof previous.get(provider)?.developer === 'boolean')
        record.developer = previous.get(provider).developer;
      if (isPlainObject(pool) && Array.isArray(pool.accounts)) {
        record.pool = {
          ...pool,
          accounts: pool.accounts.filter((row) => ids.has(row?.id)),
          selectedId: ids.has(pool.selectedId) ? pool.selectedId : undefined,
        };
        if (isPlainObject(earlier?.pool)) {
          record.pool = {
            ...mergePool(earlier.pool, record.pool),
            selectedId: record.pool.selectedId ?? earlier.pool.selectedId,
          };
        }
      } else if (earlier?.pool) record.pool = earlier.pool;
      await writePrivateJson(join(store, `${provider}.json`), record);
      saved.push(provider);
    }
    if (adopt) return saved;
    for (const file of await readDevDir(store)) {
      if (CARRY_ENTRY.test(file) && file !== HOLDER_FILE && !saved.includes(file.slice(0, -'.json'.length))) {
        await rm(join(store, file), { force: true });
      }
    }
    await rm(join(store, HOLDER_FILE), { force: true });
    return saved;
  });
}

const PASS_ENV_NAME = /^MIXDOGD?_[A-Z0-9_]+$/;

/** The names of a --pass-env value; anything outside the MIXDOG_/MIXDOGD_ prefix is refused. */
export function parsePassEnv(value) {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!PASS_ENV_NAME.test(name)) throw new Error(`--pass-env accepts only MIXDOG_* names (got "${name}").`);
  }
  return [...new Set(names)];
}

/** Copies the named variables of `parent` into `env`. A name the isolation already owns (and sets to another
 *  value) is refused: a pass-through never replaces the instance's stores, relay or ports. A name unset in
 *  `parent` is skipped. */
export function applyPassEnv(env, names, parent = process.env) {
  for (const name of names) {
    if (name in env && env[name] !== parent[name]) {
      throw new Error(`--pass-env cannot override ${name}: the instance isolation sets it.`);
    }
    if (parent[name] !== undefined) env[name] = parent[name];
  }
  return env;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `overlay` laid over `base`: objects merge key by key at every depth, anything else (arrays included) replaces. */
export function mergeConfigOverlay(base, overlay) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(overlay)) {
    if (key === '__proto__') continue;
    out[key] = isPlainObject(value) ? mergeConfigOverlay(out[key], value) : value;
  }
  return out;
}

/** Merges the JSON object in `overlayPath` into the instance's config file (the seeded one, or a new one). */
export async function applyConfigOverlay(dataDir, overlayPath) {
  const overlay = JSON.parse(await readFile(resolve(overlayPath), 'utf8'));
  if (!isPlainObject(overlay)) throw new Error('--config-overlay must name a JSON file holding an object.');
  const file = join(dataDir, 'mixdog-config.json');
  const seeded = await readJson(file);
  await writeFile(file, JSON.stringify(mergeConfigOverlay(seeded, overlay), null, 2));
}

/** A ready profile's config: onboarding and the getting-started guide done
 *  (or, with skipOnboarding false, left to run), on top of the kept dev
 *  profile's config (its model routes) when signed in. The source is only read. */
export async function seedReadyConfig(
  dataDir,
  { withRoutes = false, skipOnboarding = true, devDataDir = join(persistentDevProfileDir('default'), 'data') } = {}
) {
  if (withRoutes) {
    await assertDevFile(devTrustedRoot(resolve(devDataDir, '..')), join(devDataDir, 'mixdog-config.json'), {
      optional: true,
    });
  }
  const source = withRoutes ? await readJson(join(devDataDir, 'mixdog-config.json')) : null;
  const config = source && typeof source === 'object' ? source : {};
  const agent = config.agent && typeof config.agent === 'object' ? config.agent : {};
  if (!skipOnboarding) {
    const { onboarding: _done, ...rest } = agent;
    config.agent = rest;
    await writeFile(join(dataDir, 'mixdog-config.json'), JSON.stringify(config, null, 2));
    return;
  }
  config.agent = {
    ...agent,
    onboarding: {
      ...agent.onboarding,
      completed: true,
      version: ONBOARDING_VERSION,
      completedAt: new Date().toISOString(),
      skipped: true,
      starterGuide: { closed: true, welcomed: true, visited: [] },
    },
  };
  await writeFile(join(dataDir, 'mixdog-config.json'), JSON.stringify(config, null, 2));
}

// The unpackaged main resolves the runtime as <appPath>/../../src and helpers as <appPath>/../../native.
// package.json is copied, not linked: a file link needs elevation on Windows (main/ssh/remote-install-payload.ts reads it).
export async function prepareAppDir(instanceDir) {
  const appDir = join(instanceDir, 'app', 'desktop');
  await mkdir(appDir, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await copyFile(join(repoDir, 'package.json'), join(instanceDir, 'package.json'));
  await symlink(join(repoDir, 'src'), join(instanceDir, 'src'), linkType);
  await symlink(join(repoDir, 'native'), join(instanceDir, 'native'), linkType);
  await symlink(join(desktopDir, 'node_modules'), join(appDir, 'node_modules'), linkType);
  await symlink(join(desktopDir, 'build'), join(appDir, 'build'), linkType);
  const pkg = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'));
  await writeFile(
    join(appDir, 'package.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true, type: pkg.type, main: './out/main/index.js' },
      null,
      2
    )
  );
  return appDir;
}

/** The launcher environment: every store inside the instance, relay off, checked before use. */
export async function instanceEnv({ instanceDir, cdpPort, rendererPort, appDir, parent = process.env, relay = 'off' }) {
  const env = await createPersistentDevEnv(parent, join(instanceDir, 'profile'));
  Object.assign(env, {
    MIXDOG_RELAY_URL: relay,
    MIXDOG_DEV_RENDERER_PORT: String(rendererPort),
    MIXDOG_DEV_VITE_CACHE_DIR: join(instanceDir, 'vite-cache'),
    ELECTRON_ENTRY: appDir,
  });
  assertIsolation(env, { instanceDir, cdpPort, rendererPort, parent });
  return env;
}

/** Records the native desktop crate outputs and their Cargo dep-info inputs (`mixdog-main-native`,
 *  and `mixdog-window` on Windows) into `build-inputs.json` so native edits invalidate reuse. */
export async function recordNativeBuildInputs(
  manifestPath,
  { repo = repoDir, platform = process.platform } = {}
) {
  const crates = ['mixdog-main-native', ...(platform === 'win32' ? ['mixdog-window'] : [])];
  const fold = (p) => (platform === 'win32' ? resolve(p).replaceAll('/', '\\').toLowerCase() : resolve(p));
  const repoPrefix = fold(repo) + (platform === 'win32' ? '\\' : '/');
  const files = {};
  const addFile = (candidate) => {
    try {
      const real = realpathSync(candidate);
      const st = statSync(real);
      if (st.isFile()) files[real] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      // Absent or unreadable.
    }
  };

  for (const crate of crates) {
    const crateDir = join(repo, 'native', crate);
    addFile(join(crateDir, 'Cargo.toml'));
    addFile(join(crateDir, 'Cargo.lock'));
    const releaseDir = join(crateDir, 'target', 'release');
    let entries = [];
    try {
      entries = readdirSync(releaseDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.d')) continue;
      const depPath = join(releaseDir, entry);
      let text = '';
      try {
        text = readFileSync(depPath, 'utf8');
      } catch {
        continue;
      }
      const colon = text.indexOf(': ');
      if (colon < 0) continue;
      const targetOut = text.slice(0, colon).trim().replaceAll('\\ ', ' ');
      if (targetOut) addFile(targetOut);
      const firstLine = text.slice(colon + 2).split(/\r?\n/, 1)[0].trim();
      const deps = firstLine
        .split(/(?<!\\) /)
        .map((item) => item.replaceAll('\\ ', ' '))
        .filter(Boolean);
      for (const dep of deps) {
        if (fold(dep).startsWith(repoPrefix)) addFile(dep);
      }
    }
  }

  await mkdir(dirname(manifestPath), { recursive: true });
  const current = (await readJson(manifestPath).catch(() => null)) ?? {};
  current.native = { files, dirs: {} };
  await replaceJson(manifestPath, current);
  return current.native;
}

/** Verifies every file and glob/public directory actually read by the build (written to `manifestPath`
 *  by the Vite/Rollup build plugin, Cargo native dep-info, and the supervisor's relay module hook). Any edit,
 *  deletion, or new file in a watched directory marks the build stale — no hand-kept source list. */
export function areBuildInputsFresh(
  manifestPath,
  {
    targets = ['main', 'preload', 'renderer'],
    fileExists = existsSync,
    readText = (p) => readFileSync(p, 'utf8'),
    statFile = statSync,
    readDir = readdirSync,
  } = {}
) {
  if (!manifestPath || !fileExists(manifestPath)) {
    return { fresh: false, reason: 'missing-manifest' };
  }
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch {
    return { fresh: false, reason: 'invalid-manifest' };
  }
  for (const target of targets) {
    const section = manifest?.[target];
    if (!section || !section.files || typeof section.files !== 'object') {
      return { fresh: false, reason: `missing-target:${target}` };
    }
    for (const [filePath, recorded] of Object.entries(section.files)) {
      let current;
      try {
        current = statFile(filePath);
      } catch {
        return { fresh: false, reason: 'deleted', changedPath: filePath, target };
      }
      if (!current.isFile() || current.size !== recorded.size || current.mtimeMs !== recorded.mtimeMs) {
        return { fresh: false, reason: 'modified', changedPath: filePath, target };
      }
    }
    for (const [dirPath, recordedEntries] of Object.entries(section.dirs || {})) {
      let currentEntries;
      try {
        currentEntries = [...readDir(dirPath)].sort();
      } catch {
        return { fresh: false, reason: 'dir-deleted', changedPath: dirPath, target };
      }
      if (
        currentEntries.length !== recordedEntries.length ||
        currentEntries.some((entry, index) => entry !== recordedEntries[index])
      ) {
        return { fresh: false, reason: 'dir-changed', changedPath: dirPath, target };
      }
    }
  }
  return { fresh: true };
}

/** Locates cargo-gate.ps1 from explicit env or Cargo's own `rustc-wrapper` config (no hard-coded machine paths). */
export function findCargoGateScript(
  env = process.env,
  { platform = process.platform, cargoHome = env.CARGO_HOME || join(homedir(), '.cargo'), fileExists = existsSync, readText = (p) => readFileSync(p, 'utf8') } = {}
) {
  if (platform !== 'win32') return null;
  if (env.MIXDOG_CARGO_GATE && fileExists(env.MIXDOG_CARGO_GATE)) return resolve(env.MIXDOG_CARGO_GATE);
  if (env.MIXDOG_CARGO) {
    const match = /([A-Za-z]:[^"'\s]*cargo-gate\.ps1)/i.exec(env.MIXDOG_CARGO);
    if (match && fileExists(match[1])) return resolve(match[1]);
  }
  const cargoConfig = join(cargoHome, 'config.toml');
  if (fileExists(cargoConfig)) {
    try {
      const text = readText(cargoConfig);
      const match = /^\s*rustc-wrapper\s*=\s*['"]([^'"]+)['"]/m.exec(text);
      if (match) {
        const candidate = join(dirname(match[1]), 'cargo-gate.ps1');
        if (fileExists(candidate)) return resolve(candidate);
      }
    } catch {
      // Ignore unreadable cargo config.
    }
  }
  return null;
}

/** Queries the build gate's own `--placement` output for this checkout's cargo target directory. */
export function queryCargoGateTarget(
  gatePath,
  { repo = repoDir, run = execFileSync } = {}
) {
  if (!gatePath) return null;
  try {
    const raw = run('pwsh', ['-NoProfile', '-NonInteractive', '-File', gatePath, '--placement'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    });
    const parsed = JSON.parse(raw);
    return typeof parsed?.Target === 'string' && parsed.Target ? resolve(parsed.Target) : null;
  } catch {
    return null;
  }
}

function scanNewerCoreSources(builtMs, repo = repoDir) {
  const coreRoot = join(repo, 'native', 'core');
  const skip = new Set(['node_modules', '.git', 'target']);
  const newer = [];
  const checkFile = (file) => {
    try {
      const info = statSync(file);
      if (info.isFile() && info.mtimeMs > builtMs) newer.push(file);
    } catch {
      // Absent.
    }
  };
  const walk = (dir) => {
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (skip.has(item.name)) continue;
        walk(join(dir, item.name));
      } else if (item.isFile()) {
        checkFile(join(dir, item.name));
      }
    }
  };
  checkFile(join(coreRoot, 'Cargo.toml'));
  checkFile(join(coreRoot, 'Cargo.lock'));
  walk(join(coreRoot, 'crates'));
  return newer;
}

function formatCoreBuildCommand({ gatePath, platform = process.platform }) {
  if (gatePath && platform === 'win32') {
    return `pwsh -NoProfile -File ${gatePath} build --manifest-path native/core/Cargo.toml -p mixdog-cli --bin mixdogd`;
  }
  return 'cargo build --manifest-path native/core/Cargo.toml -p mixdog-cli --bin mixdogd';
}

/** Checks a dev `mixdogd` binary against cargo's `<bin>.d` dep-info and `native/core` sources.
 *  Returns `null` when up to date, or a structured warning describing the newer sources and build command. */
export function inspectCoreBinaryFreshness(
  binPath,
  {
    repo = repoDir,
    gatePath = null,
    platform = process.platform,
    checkTree = true,
  } = {}
) {
  const resolvedBin = resolve(binPath);
  const builtMs = statSync(resolvedBin).mtimeMs;
  const buildCommand = formatCoreBuildCommand({ gatePath, platform });
  const depInfo = `${resolvedBin.replace(/\.exe$/i, '')}.d`;
  const fold = (p) => (platform === 'win32' ? resolve(p).replaceAll('/', '\\').toLowerCase() : resolve(p));
  const repoPrefix = fold(repo) + (platform === 'win32' ? '\\' : '/');

  if (existsSync(depInfo)) {
    const text = readFileSync(depInfo, 'utf8');
    const colon = text.indexOf(': ');
    if (colon >= 0) {
      const firstLine = text.slice(colon + 2).split(/\r?\n/, 1)[0].trim();
      const sources = firstLine
        .split(/(?<!\\) /)
        .map((entry) => entry.replaceAll('\\ ', ' '))
        .filter(Boolean);
      const foreign = sources.filter((src) => {
        const low = fold(src);
        return (
          (low.includes('\\native\\core\\crates\\') || low.includes('/native/core/crates/')) &&
          !low.startsWith(repoPrefix)
        );
      });
      if (foreign.length) {
        const message = `Dev core binary ${resolvedBin} was built from another checkout (${foreign[0]}), not ${repo}. Rebuild with:\n  ${buildCommand}`;
        return {
          binary: resolvedBin,
          reason: 'foreign-checkout',
          newerCount: foreign.length,
          sample: foreign.slice(0, 3),
          buildCommand,
          message,
        };
      }
      const newer = sources.filter(
        (src) => fold(src).startsWith(repoPrefix) && (!existsSync(src) || statSync(src).mtimeMs > builtMs)
      );
      if (newer.length) {
        const sample = newer.slice(0, 3).map((src) => relative(repo, src));
        const message = `Dev core binary ${resolvedBin} is older than ${newer.length} of its sources (e.g. ${sample.join(', ')}). Rebuild with:\n  ${buildCommand}`;
        return {
          binary: resolvedBin,
          reason: 'stale-sources',
          newerCount: newer.length,
          sample,
          buildCommand,
          message,
        };
      }
    }
  }

  if (checkTree && existsSync(join(repo, 'native', 'core', 'crates'))) {
    const newer = scanNewerCoreSources(builtMs, repo);
    if (newer.length) {
      const sample = newer.slice(0, 3).map((src) => relative(repo, src));
      const message = `Dev core binary ${resolvedBin} is older than ${newer.length} core source(s) (e.g. ${sample.join(', ')}). Rebuild with:\n  ${buildCommand}`;
      return {
        binary: resolvedBin,
        reason: 'stale-sources',
        newerCount: newer.length,
        sample,
        buildCommand,
        message,
      };
    }
  }
  return null;
}

/** Throws if `binPath` is older than its Rust core sources (used when `--require-fresh-core` is set). */
export function assertFreshCoreBinary(binPath, options = {}) {
  const warning = inspectCoreBinaryFreshness(binPath, options);
  if (warning) throw new Error(warning.message);
}

/** Resolves a dev-build `mixdogd` binary (taking target placement from cargo-gate's own configuration, never
 *  hard-coding machine paths and never auto-picking `native/core/target/release/mixdogd`).
 *  Returns `{ binary, staleWarning }` by default; throws when `requireFreshCore: true` and the binary is stale. */
export function resolveDevCore(
  env,
  {
    platform = process.platform,
    repo = repoDir,
    gatePath,
    targetDir,
    checkFreshness = true,
    requireFreshCore = false,
    canRun = (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        if (platform !== 'win32') accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  } = {}
) {
  const resolvedGate = gatePath !== undefined ? gatePath : findCargoGateScript(env, { platform });
  if (env.MIXDOGD_BIN) {
    let staleWarning = null;
    if (checkFreshness && canRun(env.MIXDOGD_BIN)) {
      const depInfo = `${resolve(env.MIXDOGD_BIN).replace(/\.exe$/i, '')}.d`;
      if (existsSync(depInfo)) {
        staleWarning = inspectCoreBinaryFreshness(env.MIXDOGD_BIN, {
          repo,
          gatePath: resolvedGate,
          platform,
          checkTree: false,
        });
        if (staleWarning && requireFreshCore) throw new Error(staleWarning.message);
      }
    }
    return { binary: env.MIXDOGD_BIN, staleWarning };
  }
  const exe = platform === 'win32' ? 'mixdogd.exe' : 'mixdogd';
  const gateTarget = targetDir !== undefined ? targetDir : queryCargoGateTarget(resolvedGate, { repo });
  const candidates = [
    ...(gateTarget ? [join(gateTarget, 'debug', exe)] : []),
    ...(env.CARGO_TARGET_DIR ? [join(resolve(env.CARGO_TARGET_DIR), 'debug', exe)] : []),
    join(repo, 'native', 'core', 'target', 'debug', exe),
  ];
  for (const candidate of candidates) {
    if (canRun(candidate)) {
      let staleWarning = null;
      if (checkFreshness) {
        staleWarning = inspectCoreBinaryFreshness(candidate, {
          repo,
          gatePath: resolvedGate,
          platform,
          checkTree: true,
        });
        if (staleWarning && requireFreshCore) throw new Error(staleWarning.message);
      }
      return { binary: candidate, staleWarning };
    }
  }
  return { binary: null, staleWarning: null };
}

export function resolveDevCoreBinary(env, options = {}) {
  return resolveDevCore(env, options).binary;
}

function findOrtLibrary(repo = repoDir, desktop = desktopDir, platform = process.platform, arch = process.arch) {
  const fileName =
    platform === 'win32'
      ? 'onnxruntime.dll'
      : platform === 'darwin'
        ? 'libonnxruntime.1.dylib'
        : 'libonnxruntime.so.1';
  const sub = join('onnxruntime-node', ortBinaryDir(platform, arch), fileName);
  for (const base of [join(desktop, 'node_modules'), join(repo, 'node_modules')]) {
    const candidate = join(base, sub);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Stages a per-instance copy of `mixdogd` under `<instanceDir>/core/` (with `js-runtime.json` and Office
 *  templates) so running the instance never locks cargo's target binary and its command line carries `instanceDir`. */
export async function stageInstanceCore({
  sourceExe,
  instanceDir,
  repo = repoDir,
  desktop = desktopDir,
  platform = process.platform,
  arch = process.arch,
}) {
  const resolvedSource = resolve(sourceExe);
  const st = statSync(resolvedSource);
  const coreDir = join(instanceDir, 'core');
  await mkdir(coreDir, { recursive: true });
  const stagedExe = join(coreDir, basename(resolvedSource));
  await copyFile(resolvedSource, stagedExe);

  const sourceDir = dirname(resolvedSource);
  const sourceManifest = join(sourceDir, JS_RUNTIME_MANIFEST);
  if (existsSync(sourceManifest)) {
    await copyFile(sourceManifest, join(coreDir, JS_RUNTIME_MANIFEST));
  } else {
    const ortLibrary = findOrtLibrary(repo, desktop, platform, arch);
    if (ortLibrary) {
      await writeDevInstall({ exe: stagedExe, ortLibrary, packageRoot: repo });
    }
  }

  const sourceTemplates = join(sourceDir, OFFICE_TEMPLATES_DIR);
  const targetTemplates = join(coreDir, OFFICE_TEMPLATES_DIR);
  if (!existsSync(targetTemplates)) {
    if (existsSync(sourceTemplates)) {
      await cp(sourceTemplates, targetTemplates, { recursive: true });
    } else {
      await stageOfficeTemplates(coreDir).catch(() => {});
    }
  }

  return {
    stagedExe,
    sourceStamp: { path: resolvedSource, size: st.size, mtimeMs: st.mtimeMs },
  };
}

/** The core the instance's app will start (src/main/protocol/local-core.ts `coreBinaryPath`): `MIXDOGD_BIN`, else `mixdogd` on
 *  PATH. An instance's profile is new, so no core can already serve it: with no binary it can run, the app builds, opens and
 *  never starts. */
export function assertCoreBinary(
  env,
  {
    platform = process.platform,
    cwd = desktopDir,
    // Windows runs any file it can read; elsewhere a file without the execute bit fails the spawn (EACCES) like a missing one.
    canRun = (path) => {
      try {
        if (!statSync(path).isFile()) return false;
        if (platform !== 'win32') accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  } = {}
) {
  const bin = env.MIXDOGD_BIN || 'mixdogd';
  const names = platform === 'win32' && !/\.[^\\/.]+$/.test(bin) ? [bin, `${bin}.exe`, `${bin}.com`] : [bin];
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const searched = /[\\/]/.test(bin)
    ? [cwd]
    : [
        ...(platform === 'win32' ? [cwd] : []),
        ...String((pathKey && env[pathKey]) || '')
          .split(delimiter)
          .filter(Boolean),
      ];
  for (const directory of searched) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (canRun(candidate)) return candidate;
    }
  }
  throw new Error(
    env.MIXDOGD_BIN
      ? `MIXDOGD_BIN names no file that can be run (${env.MIXDOGD_BIN}): the app could not start its core. Name a built mixdogd and start again.`
      : 'No core to start: MIXDOGD_BIN is not set and PATH has no mixdogd that can be run, so the app could not start its core. ' +
          'Set MIXDOGD_BIN to a built dev mixdogd (laid out by apps/desktop/scripts/dev-core-install.mjs) and start again.'
  );
}

async function waitForRenderer({ cdpPort, rendererPort, launcher, timeoutMs, logPath }) {
  const deadline = Date.now() + timeoutMs;
  const rendererOrigin = `http://127.0.0.1:${rendererPort}/`;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) {
      throw new Error(`Instance supervisor exited (${launcher.exitCode}) before the window loaded.\n${logTail(logPath)}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) }).then(
        (response) => response.json()
      );
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith(rendererOrigin));
      if (page) return page;
    } catch {
      // CDP is not listening yet.
    }
    await sleep(500);
  }
  throw new Error(
    `The isolated app did not load ${rendererOrigin} on CDP ${cdpPort} within ${timeoutMs / 1000}s.\n${logTail(logPath)}`
  );
}

function logTail(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).slice(-30).join('\n');
  } catch {
    return '';
  }
}

/** Builds an unminified development bundle into `<appDir>/out` so Vite and esbuild exit before Electron runs.
 *  When `buildInputsPath` is provided, electron.vite.config.ts records every file read by the build. */
function buildIsolatedDevBundle(appDir, env, { rendererOnly = false, logPath, buildInputsPath } = {}) {
  const electronViteBin = join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  return new Promise((resolveBuild, rejectBuild) => {
    const buildEnv = {
      ...env,
      MIXDOG_DEV_UNMINIFIED: '1',
      ...(rendererOnly ? { MIXDOG_ELECTRON_BUILD_TARGETS: 'renderer' } : {}),
      ...(buildInputsPath ? { MIXDOG_BUILD_INPUTS_MANIFEST: buildInputsPath } : {}),
    };
    let output = '';
    const child = spawn(
      process.execPath,
      [electronViteBin, 'build', '--mode', 'development', '--outDir', join(appDir, 'out')],
      { cwd: desktopDir, env: buildEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', rejectBuild);
    child.once('exit', (code) => {
      if (logPath && output) {
        writeFile(logPath, output, { flag: 'a' }).catch(() => {});
      }
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Isolated dev build failed (exit ${code}).\n${output.slice(-2000)}`));
    });
  });
}

/** Spawns the detached instance supervisor and awaits its one-shot loopback ready callback (zero polling). */
async function launchSupervisor(configPath, { foreground = false, timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
  assertSupportedUnitPlatform();
  const readyToken = randomBytes(16).toString('hex');
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolveFn, rejectFn) => {
    resolveReady = resolveFn;
    rejectReady = rejectFn;
  });
  const readyServer = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${readyToken}`) {
      res.writeHead(401, { Connection: 'close' });
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.writeHead(200, { Connection: 'close' });
    res.end('ok');
    if (req.url === '/ready') resolveReady(body);
    else rejectReady(new Error(body.error || 'Supervisor failed to start.'));
  });
  await new Promise((resolveListen, rejectListen) => {
    readyServer.once('error', rejectListen);
    readyServer.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
  });
  const readyPort = readyServer.address().port;
  const supervisor = spawn(
    process.execPath,
    [
      supervisorScript,
      `--config=${configPath}`,
      `--ready-port=${readyPort}`,
      `--ready-token=${readyToken}`,
      ...(foreground ? ['--foreground'] : []),
    ],
    {
      cwd: desktopDir,
      detached: !foreground,
      windowsHide: true,
      stdio: foreground ? ['pipe', 'ignore', 'inherit'] : 'ignore',
    }
  );
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          rejectReady(new Error(`Instance supervisor did not report ready within ${timeoutMs / 1000}s.`));
        }, timeoutMs)
      : null;
  supervisor.once('error', (error) => rejectReady(error));
  supervisor.once('exit', (code, signal) => {
    rejectReady(new Error(`Instance supervisor exited before ready (code=${code}, signal=${signal}).`));
  });
  try {
    const ready = await readyPromise;
    return { supervisor, ready };
  } finally {
    if (timer) clearTimeout(timer);
    readyServer.closeAllConnections?.();
    await new Promise((resolveClose) => readyServer.close(() => resolveClose()));
  }
}

function formatLeaseInfo(
  lease,
  {
    pageUrl = null,
    copiedAuth = [],
    carriedAuth = [],
    keptAuthHeldBy = null,
    reused = false,
    status = null,
    coreStaleWarning = null,
  } = {}
) {
  const ttlMs = Number.isFinite(lease.ttlMs) ? lease.ttlMs : DEFAULT_TTL_MS;
  const idleMs = Number.isFinite(lease.idleMs) ? lease.idleMs : DEFAULT_IDLE_MS;
  const lastUsedAt = status?.lastUsedAt ?? lease.lastUsedAt ?? lease.startedAt;
  return {
    name: lease.name,
    pid: lease.pid,
    supervisorPid: lease.supervisorPid ?? null,
    cdpPort: lease.cdpPort,
    rendererPort: lease.rendererPort,
    cdpUrl: `http://127.0.0.1:${lease.cdpPort}`,
    rendererUrl: `http://127.0.0.1:${lease.rendererPort}/`,
    ...(pageUrl ? { pageUrl } : {}),
    relayUrl: status?.relayUrl ?? lease.relayUrl ?? 'off',
    mode: lease.mode ?? 'hmr',
    profile: lease.profile,
    dataDir: lease.profile ? join(lease.profile, 'data') : null,
    instanceDir: lease.instanceDir,
    logPath: lease.logPath ?? null,
    lease: lease.leasePath ?? null,
    ownerPid: lease.ownerPid ?? null,
    sessionId: lease.sessionId ?? null,
    startedAt: lease.startedAt,
    lastUsedAt,
    idleMs,
    idleExpiresAt:
      status?.idleExpiresAt !== undefined
        ? status.idleExpiresAt
        : idleMs > 0
          ? new Date(Date.parse(lastUsedAt) + idleMs).toISOString()
          : null,
    expiresAt: new Date(Date.parse(lease.startedAt) + ttlMs).toISOString(),
    reused,
    copiedAuth,
    carriedAuth,
    ...(keptAuthHeldBy ? { keptAuthHeldBy } : {}),
    ...(coreStaleWarning ? { coreStaleWarning } : {}),
  };
}

function normalizePassEnvSignature(passEnv = [], env = process.env) {
  return [...passEnv]
    .sort()
    .map((key) => `${key}=${env[key] ?? ''}`)
    .join('\0');
}

function configMatches(lease, want) {
  const cfg = lease.instanceConfig;
  if (!cfg) return false;
  if (cfg.mode !== want.mode) return false;
  if (want.phoneRelay && !LOOPBACK_RELAY.test(lease.relayUrl || '')) return false;
  if (want.relay !== 'off' && lease.relayUrl !== want.relay) return false;
  if (want.relay === 'off' && !want.phoneRelay && cfg.relay !== 'off' && !cfg.phoneRelay) return false;
  if (Boolean(cfg.copyAuth) !== Boolean(want.copyAuth)) return false;
  if (Boolean(cfg.skipOnboarding) !== Boolean(want.skipOnboarding)) return false;
  if ((cfg.configOverlay ?? null) !== (want.configOverlay ? resolve(want.configOverlay) : null)) return false;
  if ((cfg.passEnvSig ?? '') !== want.passEnvSig) return false;
  if ((cfg.inspectMain ?? null) !== (want.inspectMain ?? null)) return false;
  return true;
}

function requiredBuildTargets({ mode, phoneRelay, relayUrl }) {
  const targets = ['main', 'preload', 'native'];
  const hasRelay = phoneRelay || LOOPBACK_RELAY.test(relayUrl || '');
  if (mode === 'capture' || hasRelay) targets.push('renderer');
  if (hasRelay) targets.push('relay');
  return targets;
}

function sourcesAreFresh(lease, { mode, phoneRelay, currentCoreStamp, checkBuildInputs = areBuildInputsFresh }) {
  const targets = requiredBuildTargets({ mode, phoneRelay, relayUrl: lease.relayUrl });
  const check = checkBuildInputs(lease.buildInputsPath, { targets });
  if (!check?.fresh) return false;
  if (currentCoreStamp) {
    const recCore = lease.coreSourceStamp;
    if (
      !recCore ||
      recCore.path !== currentCoreStamp.path ||
      recCore.size !== currentCoreStamp.size ||
      recCore.mtimeMs !== currentCoreStamp.mtimeMs
    ) {
      return false;
    }
  }
  return true;
}

async function removeLockIfMatches(file, holder) {
  const current = await readJson(file).catch(() => null);
  if (!current) return true;
  if (current.token === holder.token && current.startedAt === holder.startedAt && current.pid === holder.pid) {
    await rm(file, { force: true }).catch(() => {});
    return true;
  }
  return false;
}

function lockStillMatches(current, holder) {
  return Boolean(
    current &&
      current.token === holder.token &&
      current.startedAt === holder.startedAt &&
      current.pid === holder.pid
  );
}

/** Event-driven wait until `file` is released/replaced OR `holder.pid` exits (whichever happens first),
 *  bounded by `remainingMs`. Handles holders like `capture` that release the lock while staying alive. */
function waitForLockReleaseOrHolderExit(
  file,
  holder,
  remainingMs,
  { watchExit = watchProcessExit } = {}
) {
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    let timer = null;
    let procWatcher = { cancel() {} };
    let fsWatcher = null;
    let checking = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      procWatcher.cancel();
      try {
        fsWatcher?.close();
      } catch {
        // Ignore close error.
      }
      fn(value);
    };

    const recheckLock = () => {
      if (settled || checking) return;
      checking = true;
      readJson(file)
        .catch(() => null)
        .then((current) => {
          checking = false;
          if (!lockStillMatches(current, holder)) finish(resolveWait, 'lock-released');
        });
    };

    if (Number.isFinite(remainingMs) && remainingMs > 0) {
      timer = setTimeout(
        () => finish(rejectWait, new Error(`Timed out waiting for lock ${file} held by PID ${holder.pid}.`)),
        remainingMs
      );
    } else if (Number.isFinite(remainingMs) && remainingMs <= 0) {
      finish(rejectWait, new Error(`Timed out waiting for lock ${file} held by PID ${holder.pid}.`));
      return;
    }

    try {
      const lockBase = basename(file);
      fsWatcher = watch(dirname(file), (_event, filename) => {
        if (!filename || String(filename) === lockBase) recheckLock();
      });
      fsWatcher.on('error', () => {});
    } catch {
      // Directory watch unavailable; process-exit watch and timeout remain active.
    }

    if (holder.pid !== process.pid) {
      try {
        procWatcher = watchExit(holder.pid, (why) => finish(resolveWait, `holder-${why}`));
      } catch (error) {
        if (!fsWatcher) {
          finish(rejectWait, error);
          return;
        }
      }
    }

    // Close the window between installing fs.watch and the lock already being removed.
    recheckLock();
  });
}

/** Waits for the lock holder's `/wait` endpoint with no built-in headers/request timeout unless `remainingMs` is finite. */
function waitOnLockEndpoint(port, token, remainingMs) {
  return new Promise((resolveWait) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveWait(result);
    };
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/wait',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
      },
      (res) => {
        res.resume();
        res.once('end', () => {
          const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
          finish(ok ? { ok: true, error: null } : { ok: false, error: `HTTP ${res.statusCode}` });
        });
        res.once('error', (error) => finish({ ok: false, error: error?.message || String(error) }));
      }
    );
    req.setTimeout(0);
    req.once('error', (error) => finish({ ok: false, error: error?.message || String(error) }));
    if (Number.isFinite(remainingMs)) {
      if (remainingMs <= 0) {
        req.destroy();
        finish({ ok: false, error: 'timed out' });
        return;
      }
      timer = setTimeout(() => {
        req.destroy();
        finish({ ok: false, error: 'timed out' });
      }, remainingMs);
    }
    req.end();
  });
}

/** Coordinates concurrent `ensureInstance` calls for the same session/name with zero polling and no spin:
 *  records `{ pid, created, port, token }` in an exclusive lockfile; stale locks whose holder exited or whose
 *  PID was reused are reclaimed safely; live holders are awaited via `GET /wait`, lock-release fs event, or
 *  holder process exit. Waits have no artificial deadline unless a caller supplies a finite `timeoutMs`. */
export async function withEnsureLock(
  root,
  name,
  fn,
  {
    timeoutMs = Infinity,
    alive = isPidAlive,
    getCreated = getProcessCreationTimeMs,
    watchExit = watchProcessExit,
  } = {}
) {
  await mkdir(locksDir(root), { recursive: true });
  const file = lockPath(root, name);
  const selfCreated = getCreated(process.pid);
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;

  for (;;) {
    const token = randomBytes(16).toString('hex');
    const waiters = [];
    let settled = null;
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}` || req.url !== '/wait') {
        res.writeHead(401, { Connection: 'close' });
        res.end();
        return;
      }
      if (settled) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(settled));
        return;
      }
      waiters.push(res);
    });
    server.setTimeout(0);
    server.requestTimeout = 0;
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
    });
    const port = server.address().port;
    const lockRecord = {
      pid: process.pid,
      created: selfCreated,
      port,
      token,
      startedAt: new Date().toISOString(),
    };
    let acquired = false;
    try {
      await writeFile(file, JSON.stringify(lockRecord), { flag: 'wx' });
      acquired = true;
    } catch (error) {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      if (error.code !== 'EEXIST') throw error;
    }
    if (acquired) {
      const finish = async (payload) => {
        settled = payload;
        for (const res of waiters.splice(0)) {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify(payload));
        }
        server.closeAllConnections?.();
        await new Promise((resolveClose) => server.close(() => resolveClose()));
        await removeLockIfMatches(file, lockRecord);
      };
      try {
        const result = await fn();
        await finish({ ok: true });
        return result;
      } catch (error) {
        await finish({ ok: false, error: error.message });
        throw error;
      }
    }

    // Another process holds the lock: verify holder identity (PID + creation time) before waiting.
    const holder = await readJson(file).catch(() => null);
    if (!holder) continue;
    if (!isSameProcess(holder.pid, holder.created, { alive, getCreated })) {
      await removeLockIfMatches(file, holder);
      continue;
    }

    const remainingBeforeWait = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
    if (remainingBeforeWait <= 0) {
      throw new Error(`Timed out waiting for ensure lock ${file} held by PID ${holder.pid}.`);
    }

    let waitOk = false;
    let waitError = null;
    if (Number.isInteger(holder.port) && holder.port > 0 && holder.token) {
      const result = await waitOnLockEndpoint(holder.port, holder.token, remainingBeforeWait);
      waitOk = result.ok;
      waitError = result.error;
    } else {
      waitError = 'lock record missing wait endpoint';
    }
    if (waitOk) continue;

    // /wait did not complete cleanly: re-check lock and holder identity; never spin on a refused port.
    const after = await readJson(file).catch(() => null);
    if (!lockStillMatches(after, holder)) continue;
    if (!isSameProcess(holder.pid, holder.created, { alive, getCreated })) {
      await removeLockIfMatches(file, holder);
      continue;
    }
    if (holder.pid === process.pid) {
      throw new Error(`Ensure lock ${file} is already held by this process (${process.pid}); cannot wait on self.`);
    }
    const remainingAfterWait = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
    if (remainingAfterWait <= 0) {
      throw new Error(
        `Ensure lock ${file} is held by live PID ${holder.pid} whose /wait server did not complete (${waitError}).`
      );
    }
    // Wait for either the lock file to be released/changed (holder keeps running) or the holder process to exit.
    let outcome;
    try {
      outcome = await waitForLockReleaseOrHolderExit(file, holder, remainingAfterWait, { watchExit });
    } catch (error) {
      throw new Error(
        `Ensure lock ${file} is held by live PID ${holder.pid} whose /wait server failed (${waitError}); ${error.message}`
      );
    }
    if (outcome !== 'lock-released') {
      await removeLockIfMatches(file, holder);
    }
  }
}

/** Reuses the calling session's compatible, source-fresh live instance (never another session's)
 *  or builds and starts one. Concurrent calls from the same session wait on the first and reuse it. */
export async function ensureInstance({
  name,
  ttlMs = DEFAULT_TTL_MS,
  idleMs = DEFAULT_IDLE_MS,
  copyAuth = false,
  skipOnboarding = true,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  root = isolatedRoot(),
  relay = 'off',
  phoneRelay = false,
  hmr = false,
  requireFreshCore = false,
  devProfileDir = persistentDevProfileDir('default'),
  configOverlay = null,
  passEnv = [],
  inspectMain = null,
  ownerPid,
  foreground = false,
  caller,
  checkBuildInputs = areBuildInputsFresh,
  coreSourceStamp,
  startFn = startInstance,
} = {}) {
  const session =
    caller ??
    resolveCallerSession(process.env, { processes: listProcesses(), selfPid: process.pid, ownerPid });
  const targetName = name || session.defaultName;
  assertName(targetName);
  const mode = hmr ? 'hmr' : 'capture';
  const passEnvSig = normalizePassEnvSignature(passEnv);
  const wantConfig = { mode, phoneRelay, relay, copyAuth, skipOnboarding, configOverlay, passEnvSig, inspectMain };

  return withEnsureLock(
    root,
    targetName,
    async () => {
      await sweep(root, { devProfileDir });
      let currentCoreStamp = coreSourceStamp ?? null;
      let coreStaleWarning = null;
      if (!currentCoreStamp && coreSourceStamp === undefined) {
        const resolved = resolveDevCore(process.env, {
          checkFreshness: true,
          requireFreshCore,
        });
        coreStaleWarning = resolved.staleWarning;
        if (resolved.binary && existsSync(resolved.binary)) {
          const st = statSync(resolved.binary);
          currentCoreStamp = { path: resolve(resolved.binary), size: st.size, mtimeMs: st.mtimeMs };
        }
      }

      if (!foreground) {
        const leases = await readLeases(root);
        const ownLeases = leases
          .filter((lease) => leaseBelongsToSession(lease, session) && !leaseIsStale(lease))
          .sort((a, b) => (a.name === targetName ? -1 : b.name === targetName ? 1 : 0));

        for (const lease of ownLeases) {
          if (
            configMatches(lease, wantConfig) &&
            sourcesAreFresh(lease, { mode, phoneRelay, currentCoreStamp, checkBuildInputs })
          ) {
            const touched = await querySupervisor(lease, '/touch', { method: 'POST' });
            if (touched?.ok) {
              if (coreStaleWarning) console.error(`Warning: ${coreStaleWarning.message}`);
              return formatLeaseInfo(
                { ...lease, leasePath: leasePath(root, lease.name) },
                { reused: true, status: touched, coreStaleWarning }
              );
            }
          }
        }

        // If this session already has an outdated or differently-configured live instance under `targetName`,
        // stop it cleanly before rebuilding so one session never piles up multiple instances.
        const existingSameName = ownLeases.find((lease) => lease.name === targetName);
        if (existingSameName) {
          const stopped = await stopInstance(root, existingSameName, { devProfileDir });
          if (stopped.unsaved) {
            throw new Error(`Could not replace outdated instance "${targetName}": ${stopped.unsaved}`);
          }
        }
      }

      const info = await startFn({
        name: targetName,
        ttlMs,
        idleMs,
        copyAuth,
        skipOnboarding,
        timeoutMs,
        root,
        relay,
        phoneRelay,
        hmr,
        requireFreshCore,
        devProfileDir,
        configOverlay,
        passEnv,
        inspectMain,
        ownerPid: session.ownerPid,
        foreground,
        caller: session,
      });
      return { ...info, reused: false };
    }
  );
}

export async function startInstance({
  name,
  ttlMs = DEFAULT_TTL_MS,
  idleMs = DEFAULT_IDLE_MS,
  copyAuth = false,
  skipOnboarding = true,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  root = isolatedRoot(),
  relay = 'off',
  phoneRelay = false,
  hmr = false,
  requireFreshCore = false,
  devProfileDir = persistentDevProfileDir('default'),
  configOverlay = null,
  passEnv = [],
  inspectMain = null,
  ownerPid,
  foreground = false,
  caller,
}) {
  if (relay !== 'off' && phoneRelay) {
    throw new Error('Use either --relay <url> or --phone-relay, not both.');
  }
  if (relay !== 'off' && !LOOPBACK_RELAY.test(relay))
    throw new Error('--relay must be a ws://127.0.0.1:<port> or ws://localhost:<port> URL.');
  assertSupportedUnitPlatform();
  await sweep(root, { devProfileDir });
  const lease = await acquireLease(root, name, { ttlMs, devProfileDir });
  let current = lease;
  try {
    const { cdpPort, rendererPort } = await allocatePorts(root, name);
    const instanceDir = join(instancesDir(root), `${name}-${randomBytes(3).toString('hex')}`);
    const profile = join(instanceDir, 'profile');
    const mode = hmr ? 'hmr' : 'capture';
    const session =
      caller ??
      resolveCallerSession(process.env, { processes: listProcesses(), selfPid: process.pid, ownerPid });
    const controlToken = randomBytes(24).toString('hex');
    const passEnvSig = normalizePassEnvSignature(passEnv);
    const instanceConfig = {
      mode,
      phoneRelay,
      relay,
      copyAuth,
      skipOnboarding,
      configOverlay: configOverlay ? resolve(configOverlay) : null,
      passEnvSig,
      inspectMain,
    };
    current = {
      ...lease,
      cdpPort,
      rendererPort,
      instanceDir,
      profile,
      mode,
      copyAuth,
      idleMs,
      lastUsedAt: lease.startedAt,
      ownerPid: session.ownerPid,
      sessionId: session.sessionId,
      sessionDir: session.sessionDir,
      controlToken,
      instanceConfig,
      authCarry: null,
    };
    // Lease first, directory second: a concurrent sweep never sees an unowned directory.
    await replaceJson(leasePath(root, name), current);
    await mkdir(instanceDir, { recursive: true });
    const appDir = await prepareAppDir(instanceDir);
    const env = await instanceEnv({ instanceDir, cdpPort, rendererPort, appDir, relay });
    applyPassEnv(env, passEnv);
    const holder = { root: resolve(root), name, startedAt: lease.startedAt };
    const kept = await seedInstanceAuth(env.MIXDOG_DATA_DIR, { devProfileDir, ttlMs, holder, copyAuth });
    const { copied: copiedAuth, carried: carriedAuth, heldBy: keptAuthHeldBy } = kept;
    current = { ...current, authCarry: { seeded: kept.seeded } };
    await replaceJson(leasePath(root, name), current);
    if (keptAuthHeldBy) console.error(`Started without the kept sign-ins: ${keptAuthHeldBy}.`);
    if (copyAuth || skipOnboarding) {
      await seedReadyConfig(env.MIXDOG_DATA_DIR, {
        withRoutes: copyAuth,
        skipOnboarding,
        devDataDir: join(devProfileDir, 'data'),
      });
    }
    await restoreProviderConfig(env.MIXDOG_DATA_DIR, kept.providerConfigs, kept.developerOptions);
    if (configOverlay) await applyConfigOverlay(env.MIXDOG_DATA_DIR, configOverlay);
    const { binary: resolvedCore, staleWarning: coreStaleWarning } = resolveDevCore(env, {
      checkFreshness: true,
      requireFreshCore,
    });
    if (coreStaleWarning) console.error(`Warning: ${coreStaleWarning.message}`);
    if (resolvedCore) env.MIXDOGD_BIN = resolvedCore;
    const sourceCoreBinary = assertCoreBinary(env);
    const { stagedExe: coreBinary, sourceStamp: coreSourceStamp } = await stageInstanceCore({
      sourceExe: sourceCoreBinary,
      instanceDir,
    });
    env.MIXDOGD_BIN = coreBinary;
    // Source checkouts prefer native/*/target/release over the pinned download;
    // never launch against a binary older than its sources.
    await refreshStaleLocalBinaries();
    await buildWindowLibrary();
    await buildMainNativeModule();
    // Electron 42+ has no install script; electron-vite only reads path.txt, so
    // download the binary on first use and hand it over.
    const electronExecPath = electronBinary();
    env.ELECTRON_EXEC_PATH = electronExecPath;
    const logPath = join(instanceDir, 'launcher.log');
    const buildInputsPath = join(instanceDir, 'build-inputs.json');
    await recordNativeBuildInputs(buildInputsPath);
    if (mode === 'capture') {
      await buildIsolatedDevBundle(appDir, env, { rendererOnly: false, logPath, buildInputsPath });
    } else if (phoneRelay) {
      await buildIsolatedDevBundle(appDir, env, { rendererOnly: true, logPath, buildInputsPath });
    }

    const configPath = join(instanceDir, 'supervisor-config.json');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          root,
          name,
          instanceDir,
          profile,
          appDir,
          desktopDir,
          cdpPort,
          rendererPort,
          mode,
          relayMode: phoneRelay ? 'builtin' : 'off',
          relayUrl: relay,
          idleMs,
          ttlMs,
          ownerPid: session.ownerPid,
          sessionDir: session.sessionDir,
          sessionId: session.sessionId,
          controlToken,
          devProfileDir,
          inspectMain,
          electronExecPath,
          electronViteBin: join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
          logPath,
          startedAt: lease.startedAt,
          buildInputsPath,
          env,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    const { supervisor, ready } = await launchSupervisor(configPath, { foreground, timeoutMs });
    current = {
      ...current,
      pid: ready.appPid,
      appCreated: ready.appCreated ?? getProcessCreationTimeMs(ready.appPid),
      supervisorPid: ready.supervisorPid,
      supervisorCreated: ready.supervisorCreated ?? getProcessCreationTimeMs(ready.supervisorPid),
      controlPort: ready.controlPort,
      relayUrl: ready.relayUrl,
      coreBinary,
      sourceCoreBinary,
      coreSourceStamp,
      buildInputsPath,
      logPath,
      appDir,
    };
    await replaceJson(leasePath(root, name), current);
    const page = await waitForRenderer({ cdpPort, rendererPort, launcher: supervisor, timeoutMs, logPath });
    if (!foreground) supervisor.unref();
    return formatLeaseInfo(
      { ...current, leasePath: leasePath(root, name) },
      { pageUrl: page.url, copiedAuth, carriedAuth, keptAuthHeldBy, reused: false, coreStaleWarning }
    );
  } catch (error) {
    const stopped = await stopInstance(root, current, { devProfileDir }).catch(() => null);
    if (stopped?.unsaved) throw new Error(`${error.message}\nThe instance was not cleaned up: ${stopped.unsaved}`);
    throw error;
  }
}

/** Lists all leased instances with live status, idle deadlines, and process-tree memory usage. */
export async function listInstances(root = isolatedRoot(), { list = () => listProcesses({ withMemory: true }) } = {}) {
  const leases = await readLeases(root);
  const processes = leases.length ? list() : [];
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const getCreated = (pid) => {
    const row = byPid.get(pid);
    return typeof row?.created === 'number' ? row.created : getProcessCreationTimeMs(pid);
  };
  return Promise.all(
    leases.map(async (lease) => {
      const deadOrReused = leaseIsStale(lease, { alive: (pid) => byPid.has(pid), getCreated });
      const liveStatus = deadOrReused ? null : await querySupervisor(lease, '/status');
      const stale = liveStatus?.ok ? false : deadOrReused;
      const minCreatedAt = lease.startedAt ? Date.parse(lease.startedAt) : undefined;
      const pids = instanceProcessIds(processes, {
        needle: lease.instanceDir && join(lease.instanceDir, sep),
        minCreatedAt: Number.isFinite(minCreatedAt) ? minCreatedAt : undefined,
      });
      const memoryBytes = pids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0);
      const { controlToken: _secret, ...safeLease } = lease;
      const lastUsedAt = liveStatus?.lastUsedAt ?? lease.lastUsedAt ?? lease.startedAt;
      return {
        ...safeLease,
        status: stale ? 'stale' : 'running',
        stale,
        mode: lease.mode ?? 'hmr',
        relayUrl: liveStatus?.relayUrl ?? lease.relayUrl ?? 'off',
        lastUsedAt,
        idlePaused: liveStatus?.idlePaused ?? false,
        activeCdpClients: liveStatus?.activeCdpClients ?? 0,
        idleExpiresAt:
          liveStatus?.idleExpiresAt !== undefined
            ? liveStatus.idleExpiresAt
            : Number.isFinite(lease.idleMs) && lease.idleMs > 0
              ? new Date(Date.parse(lastUsedAt) + lease.idleMs).toISOString()
              : null,
        expiresAt: new Date(
          Date.parse(lease.startedAt) + (Number.isFinite(lease.ttlMs) ? lease.ttlMs : DEFAULT_TTL_MS)
        ).toISOString(),
        processCount: pids.length,
        memoryMB: Math.round((memoryBytes / (1024 * 1024)) * 10) / 10,
      };
    })
  );
}

function runProbeScript(scriptPath, args) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: desktopDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0) resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
      else rejectRun(new Error(`Capture script exited (${code}): ${stderr || stdout}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log(HELP_TEXT);
    return;
  }
  const [command = 'start', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      all: { type: 'boolean', default: false },
      'all-sessions': { type: 'boolean', default: false },
      'copy-auth': { type: 'boolean', default: false },
      onboarding: { type: 'boolean', default: false },
      'ttl-minutes': { type: 'string', default: String(DEFAULT_TTL_MS / 60_000) },
      'idle-minutes': { type: 'string', default: String(DEFAULT_IDLE_MS / 60_000) },
      'timeout-seconds': { type: 'string', default: String(DEFAULT_START_TIMEOUT_MS / 1000) },
      relay: { type: 'string', default: 'off' },
      'phone-relay': { type: 'boolean', default: false },
      hmr: { type: 'boolean', default: false },
      reuse: { type: 'boolean', default: false },
      'require-fresh-core': { type: 'boolean', default: false },
      foreground: { type: 'boolean', default: false },
      'owner-pid': { type: 'string' },
      'config-overlay': { type: 'string' },
      'pass-env': { type: 'string' },
      'inspect-main': { type: 'string' },
      out: { type: 'string' },
      phone: { type: 'boolean', default: false },
      eval: { type: 'string', multiple: true, default: [] },
      url: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      scale: { type: 'string' },
      chrome: { type: 'string' },
    },
  });
  const root = isolatedRoot();
  const parseTimingAndOwner = () => {
    const ttlMs = Number(values['ttl-minutes']) * 60_000;
    if (!(ttlMs > 0)) throw new Error('--ttl-minutes must be a positive number.');
    const idleMinutes = Number(values['idle-minutes']);
    if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
      throw new Error('--idle-minutes must be 0 (disabled) or a positive number.');
    }
    const idleMs = idleMinutes * 60_000;
    const inspectMain = values['inspect-main'] === undefined ? null : Number(values['inspect-main']);
    if (inspectMain !== null && !(Number.isInteger(inspectMain) && inspectMain > 0 && inspectMain < 65536)) {
      throw new Error('--inspect-main must be a port number.');
    }
    const ownerPid =
      values['owner-pid'] === undefined
        ? undefined
        : values['owner-pid'] === 'none'
          ? null
          : Number(values['owner-pid']);
    if (ownerPid !== undefined && ownerPid !== null && !(Number.isInteger(ownerPid) && ownerPid > 0)) {
      throw new Error('--owner-pid must be a positive integer or "none".');
    }
    return { ttlMs, idleMs, inspectMain, ownerPid };
  };

  if (command === 'start' || command === 'ensure') {
    const isEnsure = command === 'ensure' || values.reuse;
    const { ttlMs, idleMs, inspectMain, ownerPid } = parseTimingAndOwner();
    if (!isEnsure) assertName(values.name);
    const runner = isEnsure ? ensureInstance : startInstance;
    const info = await runner({
      ...(values.name ? { name: values.name } : {}),
      ttlMs,
      idleMs,
      copyAuth: values['copy-auth'],
      skipOnboarding: !values.onboarding,
      timeoutMs: Number(values['timeout-seconds']) * 1000,
      root,
      relay: values.relay,
      phoneRelay: values['phone-relay'],
      hmr: values.hmr,
      requireFreshCore: values['require-fresh-core'],
      configOverlay: values['config-overlay'] ?? null,
      passEnv: parsePassEnv(values['pass-env']),
      inspectMain,
      ownerPid,
      foreground: values.foreground,
    });
    console.log(JSON.stringify(info));
    if (!values.foreground) process.exit(0);
    return;
  }
  if (command === 'capture') {
    if (!values.out) throw new Error('capture requires --out <png-file-or-dir>.');
    const { ttlMs, idleMs, inspectMain, ownerPid } = parseTimingAndOwner();
    const info = await ensureInstance({
      ...(values.name ? { name: values.name } : {}),
      ttlMs,
      idleMs,
      copyAuth: values['copy-auth'],
      skipOnboarding: !values.onboarding,
      timeoutMs: Number(values['timeout-seconds']) * 1000,
      root,
      relay: values.relay,
      phoneRelay: values.phone || values['phone-relay'],
      hmr: values.hmr,
      requireFreshCore: values['require-fresh-core'],
      configOverlay: values['config-overlay'] ?? null,
      passEnv: parsePassEnv(values['pass-env']),
      inspectMain,
      ownerPid,
    });
    const warningField = info.coreStaleWarning ? { coreStaleWarning: info.coreStaleWarning } : {};
    if (values.phone) {
      const args = [
        `--port=${info.cdpPort}`,
        `--out=${resolve(values.out)}`,
        ...values.eval.map((file) => `--eval=${file}`),
        ...(values.width ? [`--width=${values.width}`] : []),
        ...(values.height ? [`--height=${values.height}`] : []),
        ...(values.scale ? [`--scale=${values.scale}`] : []),
        ...(values.chrome ? [`--chrome=${values.chrome}`] : []),
      ];
      const { stdout } = await runProbeScript(join(desktopDir, 'scripts', 'probes', 'phone-shot.mjs'), args);
      const result = JSON.parse(stdout.split(/\r?\n/).reverse().find((line) => line.startsWith('{')) || '{}');
      console.log(JSON.stringify({ reused: info.reused, ...warningField, instance: info, capture: result }));
    } else {
      const args = [String(info.cdpPort), resolve(values.out), ...(values.url ? [`--url=${values.url}`] : [])];
      await runProbeScript(join(desktopDir, 'scripts', 'probes', 'dev-window-shot.mjs'), args);
      console.log(JSON.stringify({ reused: info.reused, ...warningField, instance: info, out: resolve(values.out) }));
    }
    process.exit(0);
  }
  if (command === 'stop') {
    if (values.all || values['all-sessions']) {
      const leases = await readLeases(root);
      const allSessions = values['all-sessions'];
      const caller = allSessions
        ? null
        : resolveCallerSession(process.env, { processes: listProcesses(), selfPid: process.pid });
      const targets = allSessions ? leases : leases.filter((lease) => leaseBelongsToSession(lease, caller));
      const stopped = [];
      for (const lease of targets) stopped.push(await stopInstance(root, lease));
      console.log(JSON.stringify({ stopped }));
      if (stopped.some((result) => result.remaining.length || !result.removed)) process.exitCode = 1;
      return;
    }
    assertName(values.name);
    const lease = await readJson(leasePath(root, values.name));
    if (!lease) throw new Error(`No isolated instance named "${values.name}".`);
    const result = await stopInstance(root, lease);
    console.log(JSON.stringify(result));
    if (result.remaining.length || !result.removed) process.exitCode = 1;
    return;
  }
  if (command === 'sweep') {
    const results = await sweep(root, { all: values.all || values['all-sessions'], allSessions: values['all-sessions'] });
    console.log(JSON.stringify({ swept: results }));
    if (results.some((result) => result.remaining.length || !result.removed)) process.exitCode = 1;
    return;
  }
  if (command === 'list') {
    console.log(JSON.stringify(await listInstances(root)));
    return;
  }
  throw new Error(`Unknown command "${command}" (start, ensure, capture, stop, sweep, list, help).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
