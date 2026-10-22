// Disposable, fully isolated dev apps for parallel agents. Each instance gets
// its own CDP and renderer ports, profile, data dir, daemon, build output and
// Vite cache under one instance directory, plus a lease that a later start or
// sweep reclaims when the owner died or the TTL ran out. The 9342 dev app, the
// kept dev profiles and the installed app's ~/.mixdog are never touched.
//
//   npm run dev:isolated -- --name <tag> [--copy-auth] [--skip-onboarding] [--ttl-minutes=120]
//
// --copy-auth starts signed in and ready: the kept dev profile's sign-ins and
// model routes, with onboarding and the getting-started guide marked done.
// --skip-onboarding marks only those done (no sign-ins).
//   npm run dev:isolated:stop -- --name <tag>
//   npm run dev:isolated:sweep [-- --all]
//   npm run dev:isolated:list
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { refreshStaleLocalBinaries } from '../../../scripts/native-release-status.mjs';
import { ONBOARDING_VERSION } from '../../../src/session-runtime/quick-web-search-models.mjs';

import {
  assertDebugPortAvailable,
  createPersistentDevEnv,
  DEV_DEBUG_PORT,
  devRendererPortFor,
  persistentDevProfileDir,
} from './dev-profile.mjs';

const desktopDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = resolve(desktopDir, '..', '..');
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/i;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
/** The only relay an isolated instance may dial: one on this machine. */
const LOOPBACK_RELAY = /^ws:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/;
export const CDP_PORT_RANGE = Object.freeze([9400, 9899]);
const RESERVED_PORTS = new Set([DEV_DEBUG_PORT, devRendererPortFor(DEV_DEBUG_PORT)]);

/** Every isolated instance lives below this root; nothing else is ever deleted. */
export function isolatedRoot(env = process.env) {
  if (env.MIXDOG_DEV_ISOLATED_ROOT) return resolve(env.MIXDOG_DEV_ISOLATED_ROOT);
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'mixdog-dev-isolated') : join(homedir(), '.mixdog-dev-isolated');
}

const leasesDir = (root) => join(root, 'leases');
const portsDir = (root) => join(root, 'ports');
const instancesDir = (root) => join(root, 'instances');
const leasePath = (root, name) => join(leasesDir(root), `${name}.json`);

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

/** A lease is stale once its owner pid is gone or it outlived its TTL. */
export function leaseIsStale(lease, { now = Date.now(), alive = isPidAlive } = {}) {
  const owner = lease.pid ?? lease.starterPid;
  const ttl = Number.isFinite(lease.ttlMs) ? lease.ttlMs : DEFAULT_TTL_MS;
  return !alive(owner) || now - Date.parse(lease.startedAt) > ttl;
}

/** Claim the name atomically (exclusive create); a stale holder is reclaimed once. */
export async function acquireLease(
  root,
  name,
  { ttlMs = DEFAULT_TTL_MS, now = Date.now(), alive = isPidAlive, list } = {}
) {
  assertName(name);
  await mkdir(leasesDir(root), { recursive: true });
  const lease = { name, starterPid: process.pid, startedAt: new Date(now).toISOString(), ttlMs };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(leasePath(root, name), JSON.stringify(lease, null, 2), { flag: 'wx' });
      return lease;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readJson(leasePath(root, name));
      if (holder && !leaseIsStale(holder, { now, alive })) {
        throw new Error(
          `Isolated instance "${name}" is running (pid ${holder.pid ?? holder.starterPid}). ` +
            'Stop it with dev:isolated:stop -- --name ' +
            name +
            ', or pick another --name.'
        );
      }
      if (holder) await stopInstance(root, holder, list ? { list } : {});
      else await rm(leasePath(root, name), { force: true });
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
  if (env.MIXDOG_RELAY_URL !== 'off' && !LOOPBACK_RELAY.test(env.MIXDOG_RELAY_URL || '')) {
    throw new Error('An isolated instance must not dial the relay (only a loopback --relay).');
  }
}

// ── processes ────────────────────────────────────────────────────────────────

export function listProcesses() {
  if (process.platform === 'win32') {
    const raw = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    );
    return [JSON.parse(raw || '[]')].flat().map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      cmd: row.CommandLine ?? '',
    }));
  }
  const raw = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3] }] : [];
  });
}

/** Root pids, every process naming the instance directory, and all their descendants. */
// `ancestorPids` (already killed) only adopt their orphaned children; a reused
// pid of theirs is never a target itself.
export function instanceProcessIds(processes, { rootPids = [], ancestorPids = [], needle, self = process.pid }) {
  const fold = (text) => (process.platform === 'win32' ? text.toLowerCase() : text);
  const marker = needle ? fold(needle) : null;
  const ids = new Set(rootPids.filter(Number.isInteger));
  for (const row of processes) if (marker && fold(row.cmd).includes(marker)) ids.add(row.pid);
  const parents = new Set([...ids, ...ancestorPids]);
  for (let size = -1; size !== parents.size; ) {
    size = parents.size;
    for (const row of processes) {
      if (parents.has(row.ppid) && !parents.has(row.pid)) {
        parents.add(row.pid);
        ids.add(row.pid);
      }
    }
  }
  ids.delete(self);
  const live = new Set(processes.map((row) => row.pid));
  return [...ids].filter((pid) => live.has(pid));
}

// The launcher and Electron name the instance directory on their command line
// (--outDir, the app entry, --user-data-dir), so the needle finds them; a pid
// recorded in a file is only a hint for a daemon whose parent already died.
async function instanceRootPids(lease) {
  const pids = [];
  if (lease.profile) {
    for (const file of [
      join(lease.profile, 'runtime', 'daemon.json'),
      join(lease.profile, 'data', 'daemon-owner.json'),
    ]) {
      const record = await readJson(file).catch(() => null);
      if (Number.isInteger(record?.pid)) pids.push(record.pid);
    }
  }
  return pids.filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const DAEMON_COMMAND = /standalone[\\/]daemon\.mjs/;

/** Kill the whole tree until nothing survives (a dying main can still spawn a daemon). */
export async function killInstanceProcesses(lease, { list = listProcesses } = {}) {
  const recorded = await instanceRootPids(lease);
  const killed = new Set();
  let remaining = [];
  for (let round = 0; round < 20; round += 1) {
    const processes = list();
    // A recorded pid counts only while it still runs a Mixdog daemon, never a reused pid.
    const daemons = new Set(processes.filter((row) => DAEMON_COMMAND.test(row.cmd)).map((row) => row.pid));
    const rootPids = recorded.filter((pid) => daemons.has(pid) && !killed.has(pid));
    remaining = instanceProcessIds(processes, {
      rootPids,
      ancestorPids: [...killed],
      needle: lease.instanceDir && join(lease.instanceDir, sep),
    });
    if (remaining.length === 0) break;
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.add(pid);
      } catch {
        // Already gone.
      }
    }
    await sleep(500);
  }
  return { killed: [...killed], remaining };
}

/** Stop an instance: processes, instance directory, port reservation, then the lease. */
export async function stopInstance(root, lease, options = {}) {
  const { killed, remaining } = await killInstanceProcesses(lease, options);
  let removed = true;
  if (lease.instanceDir) {
    if (
      !insideDir(lease.instanceDir, instancesDir(root)) ||
      resolve(lease.instanceDir) === resolve(instancesDir(root))
    ) {
      throw new Error(`Refusing to delete ${lease.instanceDir}: not an isolated instance directory.`);
    }
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
  return { name: lease.name, killed, remaining, removed };
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

/** Reclaim stale leases, then reservations and directories no lease owns. */
export async function sweep(root, { all = false, now = Date.now(), alive = isPidAlive, list = listProcesses } = {}) {
  const results = [];
  for (const lease of await readLeases(root)) {
    if (all || leaseIsStale(lease, { now, alive })) results.push(await stopInstance(root, lease, { list }));
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

const CREDENTIAL_FILE = /^(provider-accounts\.json|[a-z0-9-]+-oauth(-credentials)?\.json)$/;

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

/** lstat of `path` after proving every component from the trusted root down to it is a real
 *  entry. The trusted root is resolved first (its own ancestors may be links); below it lstat
 *  rejects symlinks and junctions, and each realpath must equal its expected location, which
 *  also catches a junction lstat did not flag. Null when optional and `path` is absent. */
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

/** Opt-in: copy provider sign-ins from the kept dev profile (never ~/.mixdog). Source is only read.
 *  A missing or unreadable profile, or any link from the trusted root down to a source, fails
 *  instead of copying nothing or copying from outside the kept dev tree. */
export async function copyDevAuth(
  dataDir,
  { devProfileDir = persistentDevProfileDir('default'), trustedRoot = devTrustedRoot(devProfileDir) } = {}
) {
  const source = join(devProfileDir, 'data');
  for (const dir of [devProfileDir, source]) {
    const stat = await lstatTrusted(trustedRoot, dir);
    if (!stat.isDirectory()) throw new Error(`--copy-auth: ${dir} is not a directory.`);
  }
  const copied = [];
  for (const entry of (await readDevDir(source)).filter((name) => CREDENTIAL_FILE.test(name))) {
    await assertDevFile(trustedRoot, join(source, entry));
    await copyFile(join(source, entry), join(dataDir, entry));
    copied.push(entry);
  }
  const secretsDir = join(source, 'secrets');
  if (await lstatTrusted(trustedRoot, secretsDir, { optional: true })) {
    const secrets = (await readDevDir(secretsDir)).filter((name) => name.endsWith('.dpapi'));
    if (secrets.length) await mkdir(join(dataDir, 'secrets'), { recursive: true });
    for (const entry of secrets) {
      await assertDevFile(trustedRoot, join(secretsDir, entry));
      await copyFile(join(secretsDir, entry), join(dataDir, 'secrets', entry));
      copied.push(`secrets/${entry}`);
    }
  }
  if (!copied.length) {
    throw new Error(`--copy-auth: the kept dev profile at ${devProfileDir} has no provider sign-ins to copy.`);
  }
  return copied;
}

/** A ready profile's config: onboarding and the getting-started guide done,
 *  on top of the kept dev profile's config (its model routes) when signed in.
 *  The source is only read. */
export async function seedReadyConfig(
  dataDir,
  { withRoutes = false, devDataDir = join(persistentDevProfileDir('default'), 'data') } = {}
) {
  if (withRoutes) {
    await assertDevFile(devTrustedRoot(resolve(devDataDir, '..')), join(devDataDir, 'mixdog-config.json'), {
      optional: true,
    });
  }
  const source = withRoutes ? await readJson(join(devDataDir, 'mixdog-config.json')) : null;
  const config = source && typeof source === 'object' ? source : {};
  const agent = config.agent && typeof config.agent === 'object' ? config.agent : {};
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

// Electron's app path is the entry directory, and the unpackaged main resolves
// the runtime as <appPath>/../../src and helpers as <appPath>/../../native. The
// instance mirrors that layout with links into the working tree, so its main,
// preload and daemon bundle build into the instance and the shared out/ stays
// untouched.
async function prepareAppDir(instanceDir) {
  const appDir = join(instanceDir, 'app', 'desktop');
  await mkdir(appDir, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
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

async function waitForRenderer({ cdpPort, rendererPort, launcher, timeoutMs, logPath }) {
  const deadline = Date.now() + timeoutMs;
  const rendererOrigin = `http://127.0.0.1:${rendererPort}/`;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) {
      throw new Error(`Dev launcher exited (${launcher.exitCode}) before the window loaded.\n${logTail(logPath)}`);
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

export async function startInstance({
  name,
  ttlMs = DEFAULT_TTL_MS,
  copyAuth = false,
  skipOnboarding = false,
  timeoutMs = 300_000,
  root = isolatedRoot(),
  relay = 'off',
  devProfileDir = persistentDevProfileDir('default'),
}) {
  if (relay !== 'off' && !LOOPBACK_RELAY.test(relay))
    throw new Error('--relay must be a ws://127.0.0.1:<port> or ws://localhost:<port> URL.');
  await sweep(root);
  const lease = await acquireLease(root, name, { ttlMs });
  let current = lease;
  try {
    const { cdpPort, rendererPort } = await allocatePorts(root, name);
    const instanceDir = join(instancesDir(root), `${name}-${randomBytes(3).toString('hex')}`);
    const profile = join(instanceDir, 'profile');
    current = { ...lease, cdpPort, rendererPort, instanceDir, profile };
    // Lease first, directory second: a concurrent sweep never sees an unowned directory.
    await replaceJson(leasePath(root, name), current);
    await mkdir(instanceDir, { recursive: true });
    const appDir = await prepareAppDir(instanceDir);
    const env = await instanceEnv({ instanceDir, cdpPort, rendererPort, appDir, relay });
    const copiedAuth = copyAuth ? await copyDevAuth(env.MIXDOG_DATA_DIR, { devProfileDir }) : [];
    if (copyAuth || skipOnboarding) {
      await seedReadyConfig(env.MIXDOG_DATA_DIR, { withRoutes: copyAuth, devDataDir: join(devProfileDir, 'data') });
    }
    // Source checkouts prefer native/*/target/release over the pinned download;
    // never launch against a binary older than its sources.
    await refreshStaleLocalBinaries();
    const logPath = join(instanceDir, 'launcher.log');
    const log = openSync(logPath, 'a');
    const launcher = spawn(
      process.execPath,
      [
        join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
        'dev',
        '--remoteDebuggingPort',
        String(cdpPort),
        '--outDir',
        join(appDir, 'out'),
        '--clearScreen',
        'false',
      ],
      { cwd: desktopDir, env, detached: true, windowsHide: true, stdio: ['ignore', log, log] }
    );
    closeSync(log);
    current = { ...current, pid: launcher.pid, logPath, appDir };
    await replaceJson(leasePath(root, name), current);
    const page = await waitForRenderer({ cdpPort, rendererPort, launcher, timeoutMs, logPath });
    launcher.unref();
    return {
      name,
      pid: launcher.pid,
      cdpPort,
      rendererPort,
      cdpUrl: `http://127.0.0.1:${cdpPort}`,
      rendererUrl: `http://127.0.0.1:${rendererPort}/`,
      pageUrl: page.url,
      profile,
      dataDir: env.MIXDOG_DATA_DIR,
      instanceDir,
      logPath,
      lease: leasePath(root, name),
      startedAt: lease.startedAt,
      expiresAt: new Date(Date.parse(lease.startedAt) + ttlMs).toISOString(),
      copiedAuth,
    };
  } catch (error) {
    await stopInstance(root, current).catch(() => {});
    throw error;
  }
}

async function main() {
  const [command = 'start', ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      all: { type: 'boolean', default: false },
      'copy-auth': { type: 'boolean', default: false },
      'skip-onboarding': { type: 'boolean', default: false },
      'ttl-minutes': { type: 'string', default: String(DEFAULT_TTL_MS / 60_000) },
      'timeout-seconds': { type: 'string', default: '300' },
      relay: { type: 'string', default: 'off' },
    },
  });
  const root = isolatedRoot();
  if (command === 'start') {
    assertName(values.name);
    const ttlMs = Number(values['ttl-minutes']) * 60_000;
    if (!(ttlMs > 0)) throw new Error('--ttl-minutes must be a positive number.');
    const info = await startInstance({
      name: values.name,
      ttlMs,
      copyAuth: values['copy-auth'],
      skipOnboarding: values['skip-onboarding'],
      timeoutMs: Number(values['timeout-seconds']) * 1000,
      root,
      relay: values.relay,
    });
    console.log(JSON.stringify(info));
    // The detached launcher keeps running; only this starter exits.
    process.exit(0);
  }
  if (command === 'stop') {
    assertName(values.name);
    const lease = await readJson(leasePath(root, values.name));
    if (!lease) throw new Error(`No isolated instance named "${values.name}".`);
    const result = await stopInstance(root, lease);
    console.log(JSON.stringify(result));
    if (result.remaining.length || !result.removed) process.exitCode = 1;
    return;
  }
  if (command === 'sweep') {
    const results = await sweep(root, { all: values.all });
    console.log(JSON.stringify({ swept: results }));
    if (results.some((result) => result.remaining.length || !result.removed)) process.exitCode = 1;
    return;
  }
  if (command === 'list') {
    const leases = await readLeases(root);
    console.log(JSON.stringify(leases.map((lease) => ({ ...lease, stale: leaseIsStale(lease) }))));
    return;
  }
  throw new Error(`Unknown command "${command}" (start, stop, sweep, list).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
