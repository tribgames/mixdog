// The replay of lib/phone-files-script.mjs: the phone's router and adapter (apps/desktop/src/renderer/remote-protocol-files.ts) against a freshly
// started, built mixdogd, every answer compared whole with what Node gave (apps/mobile/fixtures/phone-files/golden.json). A stand-in
// window (a second connection that claims the host role) answers the OS trash, the snapshot and the local page as the script scripts it.
//
// The main scenario runs here, on the loopback connection every client of this core has. The relay scenario (what only a paired phone
// meets: the registered-projects rule and one-file permissions) needs a relay-origin connection, which only the relay leg opens: it runs
// behind a scripted relay and a paired phone (lib/phone-relay-core.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { endCore, spawnCore } from './core-stop.mjs';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { FIXED_NOW_MS, filesRelayScript, filesScript, play, treeOf, windowAnswers } from './phone-files-script.mjs';
import { startRelay } from './phone-relay-core.mjs';

/** The cores' data dirs (postgres included), one folder per checkout: the replay removes it at its start and end, so two checkouts
 *  replaying at once must not share it (a fixed folder let one slot's replay delete another's live core). `PHONE_FILES_REPLAY_WORLDS`
 *  moves it, e.g. to an idle SSD when the build disk's queue makes postgres's shutdown checkpoint outlast the core's stop limit. */
const REPLAY_WORLDS = process.env.PHONE_FILES_REPLAY_WORLDS ?? join('D:\\mixdog-build\\tmp', `${basename(REPO_ROOT)}-phone-files-replay`);

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

/** What the relay declares to the core's desktop leg (the settings replay's relay declares the same, less native push). */
const RELAY_CAPABILITIES = { textFrames: 1, maxFrameBytes: 1048576 };

function differences(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => differences(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return [path];
}

/** The core and the database it started, ended by the process tree of the one pid this replay spawned (a pid already gone is no error). */
export async function killTree(child) {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  if (gone()) return;
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (ended.error) throw new Error(`taskkill of the core's tree (pid ${child.pid}) did not finish within 60 s: ${ended.error.message}`);
  // 128: no such process (it ended between the look above and the kill).
  if (ended.status !== 0 && ended.status !== 128 && !gone()) {
    throw new Error(`taskkill of the core's tree (pid ${child.pid}) failed (exit ${ended.status}): ${(ended.stderr || ended.stdout).trim()}`);
  }
  await exitWithin(child, 60_000, `the core (pid ${child.pid}), ended with taskkill`);
}

/** Resolves when `child` has exited; fails with a message naming `what` after `ms`. */
export const exitWithin = (child, ms, what) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not exit within ${ms} ms`)), ms);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

/** How long one call to a core (a connection, a request) may take before the replay fails instead of waiting. */
export const CALL_DEADLINE_MS = 60_000;

/** A call's deadline passed: the replay fails with it, it is never recorded as the call's answer. */
export class NoAnswer extends Error {}

/** `promise`, or a failure (`NoAnswer`) naming `what` (the method called) once `ms` have passed without its answer. */
export function answered(what, promise, ms = CALL_DEADLINE_MS) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NoAnswer(`${what}: no answer from the core within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A Windows job, closed when its last handle closes, that ends every process in it (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0x2000). */
const JOB = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ReplayJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Limits; public Io Counters; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static IntPtr held;
  public static void Confine(int pid) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended info = new Extended();
    info.Limits.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    IntPtr process = OpenProcess(0x0101, false, pid);
    if (process == IntPtr.Zero || !AssignProcessToJobObject(job, process)) throw new Win32Exception();
    held = job;
  }
}`;

let confined = null;

/** Puts this replay's own process into a job that ends with it, so every core it starts afterwards (and the database each starts) is in
 *  the job too and cannot outlive the replay, however the replay ends: a Ctrl-C, a caller's timeout ending its process, a crash. The
 *  job's one handle is held by a PowerShell started first (so outside the job), which exits when its stdin, a pipe from this process,
 *  closes: when this process ends for any reason, the handle closes and Windows ends every process left in the job. Node's own job
 *  (libuv src/win/process.c `uv__init_global_job_handle`) ends only this process's direct children: it allows silent breakaway, so what
 *  they start (the core's database, the crashed core's survivors) outlives it; this job allows none. Neither mixdogd nor pg_ctl starts a
 *  process with CREATE_BREAKAWAY_FROM_JOB. The replay runs only on Windows (taskkill, PowerShell, pg_ctl.exe), so there is no other
 *  system to hold this on. */
function confineToReplay() {
  confined ??= new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${JOB}\n'@\n[ReplayJob]::Confine(${process.pid})\n[Console]::Out.WriteLine('confined')\n[Console]::Out.Flush()\n[void][Console]::In.ReadToEnd()\n`;
    const guard = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => fail(new Error(`the replay's job was not set up within 60 s:\n${err}`)), 60_000);
    const fail = (error) => {
      clearTimeout(timer);
      guard.kill();
      reject(error);
    };
    guard.stderr.on('data', (chunk) => (err += chunk));
    guard.once('error', (error) => fail(new Error(`the replay's job guard did not start: ${error.message}`)));
    guard.once('exit', (code) => fail(new Error(`the replay's job guard exited ${code} before it held the job:\n${err}`)));
    guard.stdout.on('data', (chunk) => {
      out += chunk;
      if (!out.includes('confined')) return;
      clearTimeout(timer);
      guard.removeAllListeners('exit');
      // Held for the life of this process, which it must not keep alive.
      guard.unref();
      for (const stream of [guard.stdin, guard.stdout, guard.stderr]) stream.unref();
      resolve();
    });
  });
  return confined;
}

/** How long a core may take to write its discovery file (its own start deadlines, the database's 30 s among them, are inside it). */
const START_DEADLINE_MS = 120_000;

export async function startCore(exe, coreRoot, relay, fresh = true, extraEnv = {}) {
  await confineToReplay();
  if (fresh) rmSync(coreRoot, { recursive: true, force: true });
  rmSync(join(coreRoot, 'runtime', 'daemon.json'), { force: true });
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(coreRoot, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(coreRoot, 'runtime'),
    MIXDOG_DATA_DIR: join(coreRoot, 'data'),
    MIXDOG_HOME: join(coreRoot, 'home'),
    MIXDOG_CONFIG_DIR: join(coreRoot, 'config'),
    MIXDOG_FIXED_NOW_MS: String(FIXED_NOW_MS),
    ...(relay ? { MIXDOG_RELAY_URL: `ws://127.0.0.1:${relay.port}` } : {}),
    ...extraEnv,
  });
  // An install that has used remote access before: the core dials its relay at start.
  if (relay) writeFileSync(join(coreRoot, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  // The install layout: the manifest beside the binary names the JS runtime (a build output has none of its own).
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const { child, job } = await spawnCore(exe, ['serve'], { env });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  // The core is up when it has written its discovery file. The watch is registered before the first look, so a write between the look and
  // the wait still wakes it; the wait ends on the directory's change, on the child's exit, or at the start deadline, which fails it.
  const dir = join(coreRoot, 'runtime');
  const file = join(dir, 'daemon.json');
  let stirred = false;
  let late = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  let watcher = null;
  let deadline = null;
  // Owned from the spawn: a throw from here on (the watch included) ends the child.
  try {
    watcher = watch(dir, stir);
    child.once('exit', stir);
    deadline = setTimeout(() => {
      late = true;
      stir();
    }, START_DEADLINE_MS);
    for (;;) {
      stirred = false;
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
      try {
        return { exe, child, job, env, endpoint: parseDiscovery(readFileSync(file, 'utf8')), dataDir: join(coreRoot, 'data') };
      } catch {
        if (late) throw new Error(`mixdogd did not write its discovery file ${file} within ${START_DEADLINE_MS / 1000} s:\n${stderr}`);
        if (!stirred) await new Promise((resolve) => (wake = resolve));
      }
    }
  } catch (error) {
    // What could not be ended cleanly is reported with the start's own failure.
    await endCore({ exe, child, job, env }).catch((ending) => {
      error.message += `\nand ending it: ${ending.message}`;
    });
    throw error;
  } finally {
    clearTimeout(deadline);
    watcher?.close();
  }
}

/** The PC's window: a second connection that claims the host role and answers what the core asks of it. */
async function openWindow(connect, base) {
  const asked = [];
  const client = await answered('the window\'s connection (initialize)', connect({
    ...base,
    clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
    capabilities: {
      optOutNotificationMethods: [],
      experimentalApi: false,
      host: { browser: false, visualize: false, notifications: false, systemProxy: false, power: false, media: false, updater: false, files: true },
    },
  }));
  const served = {
    'host/capture/fileSnapshot': (p) => ['captureFileSnapshot', [p.root, p.rel, p.grant === true]],
    'host/localPage/url': (p) => ['localPageUrl', [p.root, p.rel, p.scope === 'file' ? 'file' : 'project']],
    'host/files/trashItem': (p) => ['trashItem', [p.path]],
  };
  client.on((event) => {
    if (event.type !== 'serverRequest') return;
    const { id, method, params } = event.request;
    const entry = served[method]?.(params ?? {});
    if (!entry) return client.respond(id, { error: { code: -32601, message: `${method} is not served` } });
    const [name, args] = entry;
    asked.push({ method: name, args: clone(args) });
    try {
      // The real window answers the trash with `{}` (apps/desktop/src/main/host/files.ts), never with nothing.
      client.respond(id, { result: windowAnswers[name](...args) ?? {} });
    } catch (error) {
      client.respond(id, { error: { code: -32000, message: error.message } });
    }
  });
  await answered('host/claim', client.call('host/claim', { hostId: 'replay-window' }));
  return { client, asked };
}

const PHONE_ID = '0123456789abcdef0123456789abcdef';

/** One scenario on a freshly started core; `relay` makes the phone a paired device behind a relay the core dials (what a relay-origin
 *  connection is), otherwise the phone is the loopback connection every client of this core has. */
async function replayScenario({ exe, world, name, make, expected, relay }) {
  const coreRoot = join(REPLAY_WORLDS, `core-${name}`);
  const core = await startCore(exe, coreRoot, relay);
  let client = null;
  let window = null;
  try {
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const base = {
      target: { id: 'core' },
      connector: createWsConnector(async () => core.endpoint),
      clientInfo: { name: 'mixdog-phone', title: 'Mixdog Phone', version: '1.4.5', kind: 'phone' },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      // The client sleeps only on its reconnect ladder (packages/protocol-client/src/client.ts:346), after a dropped transport. The replay
      // never drops one, so no call's timing depends on this clock; a drop fails the replay instead of waiting.
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    };
    let phoneConnector = base.connector;
    if (relay) {
      await answered("the core's relay leg", relay.leg());
      const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
      phoneConnector = await answered("the paired phone's relay connection", relay.openPhone('client-files', PHONE_ID, relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')))));
    }
    client = await answered("the phone's connection (initialize)", connect({ ...base, connector: phoneConnector }));
    const host = { ctx: relay ? { browserId: PHONE_ID } : {}, client: () => client, declareLane() {} };
    // The phone's own entry: every call goes through the router, which queues it (remote-protocol-queue.ts) as it does for every adapter.
    // The router arms a per-call deadline on the page's window timers; the replay compares answers, so its window never fires one.
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const router = createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false });
    let compared = 0;

    world.build();
    const scenario = make(world);
    const driver = {
      async call(name, params) {
        window?.asked.splice(0);
        let frame;
        try {
          // The page's own arguments: what the relay's JSON turned into null is undefined on the page (an argument the app left out);
          // the router hands it to the adapter as Node's PC received it.
          // The router's own per-call deadline runs on the stubbed window timers above; this one is real.
          const value = await answered(name, router.call(name, params.map((value) => (value === null ? undefined : value))));
          frame = { ok: true, value: value === undefined ? null : clone(value) };
        } catch (error) {
          if (error instanceof NoAnswer) throw error;
          frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
        }
        return { frame, hostCalls: window ? window.asked.splice(0) : [] };
      },
      // The core stops and starts again over the same data dir (the loopback phone only: a relay leg would have to be re-paired).
      restart: async () => {
        if (relay || window) throw new Error('restart is replayed on a loopback phone with no window');
        client.close?.();
        // A stop the app itself performs (its own quit): the memory database shuts down cleanly, so the next start does not run crash recovery.
        await endCore({ ...core, ms: 120_000 });
        Object.assign(core, await startCore(exe, coreRoot, relay, false));
        base.connector = createWsConnector(async () => core.endpoint);
        client = await answered("the phone's connection after the restart (initialize)", connect({ ...base, connector: base.connector }));
      },
      // The one-file permission a paired phone holds for a path outside every project (`transfer/grant/mint`, relay origin).
      grant: async (path) => (await answered('transfer/grant/mint', client.call('transfer/grant/mint', { path }))).accessToken,
      host: async (on) => {
        if (on && !window) window = await openWindow(connect, base);
        if (!on && window) {
          window.client.close?.();
          window = null;
        }
      },
      pin: (path, ms) => utimesSync(path, ms / 1000, ms / 1000),
      write: (path, text) => writeFileSync(path, text),
      remove: (path) => rmSync(path, { recursive: true, force: true }),
      mkdir: (path) => mkdirSync(path, { recursive: true }),
    };
    const trace = await play(scenario, driver);
    const unexpected = [];
    if (trace.steps.length !== expected.steps.length) unexpected.push({ step: 'count', node: expected.steps.length, core: trace.steps.length });
    expected.steps.forEach((node, index) => {
      const core = trace.steps[index];
      compared += 1;
      // `fileMtimeMs` is the OS stamp of a write: the answer's `{$fileMtime}` already says it is the file's own (play checks it against the
      // disk), and each side's stamp is its own clock's, so the two numbers are not compared.
      const { fileMtimeMs: _node, ...nodeStep } = node;
      const { fileMtimeMs: _core, ...coreStep } = core ?? {};
      if (differences(nodeStep, core === undefined ? undefined : coreStep).length) unexpected.push({ index, call: node.call, params: node.params, node, core });
    });
    // The whole final state, field by field. The world's project folders are compared file by file. What Node keeps under `userdata` is
    // compared as the state it holds, through the core's own reads:
    //  - desktop-projects.json -> aliases and hidden tombstones (below); the `.bak`
    //    beside it is a write-safety copy only a damaged primary is restored from (atomic-file.mjs:359-378, :615-645), not state;
    //  - editor-backups/ -> the core's `<data>/userdata/editor-backups/` (the same files under a different root);
    //  - editor-recovery/<digest>/ -> the core's `<data>/recovery/<digest>/` (the same digest of the project root, a different root).
    //  - desktop-projects.json is read from the core's own rows (`state/core.sqlite` `projects`, the table DS §4.1 converts it into): `aliases`
    //    is every row's alias, `hidden` the hidden rows in `hidden_rank` order (Node's array order, newest removal first);
    //  - new-task-receipts/ -> the core's `<data>/userdata/new-task-receipts/` (the same name under the core's root, as editor-backups). These
    //    files are Node's `startTask` ids, a chat concern no call of this script makes; both sides are read from disk, so a receipt either side
    //    wrote fails the comparison.
    const byPath = (a, b) => (a.path < b.path ? -1 : 1);
    const filesUnder = (dir) => (existsSync(dir) ? treeOf(dir).filter((row) => !row.dir) : []);
    const tree = treeOf(world.root, (rel) => rel.startsWith('userdata'));
    if (!isDeepStrictEqual(tree, expected.finalTree)) unexpected.push({ step: 'finalTree', paths: differences(expected.finalTree, tree), node: expected.finalTree, core: tree });
    const rows = (await answered('project/list', client.call('project/list', {}))).projects;
    const db = new DatabaseSync(join(core.dataDir, 'state', 'core.sqlite'), { readOnly: true });
    const stored = db.prepare('SELECT path, alias, hidden FROM projects ORDER BY hidden_rank, path').all();
    db.close();
    const preferences = {
      aliases: Object.fromEntries(stored.filter((row) => row.alias).map((row) => [row.path, row.alias]).sort(([a], [b]) => (a < b ? -1 : 1))),
      hidden: stored.filter((row) => row.hidden).map((row) => row.path),
    };
    const nodePreferences = { aliases: Object.fromEntries(Object.entries(expected.userdata.preferences.aliases).sort(([a], [b]) => (a < b ? -1 : 1))), hidden: expected.userdata.preferences.hidden };
    const state = {
      preferences,
      editorBackups: filesUnder(join(core.dataDir, 'userdata', 'editor-backups')),
      editorRecovery: filesUnder(join(core.dataDir, 'recovery')),
      newTaskReceipts: filesUnder(join(core.dataDir, 'userdata', 'new-task-receipts')),
    };
    const nodeState = { preferences: nodePreferences, editorBackups: expected.userdata.editorBackups, editorRecovery: expected.userdata.editorRecovery, newTaskReceipts: expected.userdata.newTaskReceipts };
    if (!isDeepStrictEqual(state, nodeState)) unexpected.push({ step: 'userdata', paths: differences(nodeState, state), node: nodeState, core: state });
    // The registry, with its timestamps. Node's rows are `{name, path, addedAt, lastSelectedAt?}`, shown under the alias when there is one; the
    // core keeps one `lastUsedAt` per row, which is the recency Node orders by (`projectRecency`, projects.mjs:121-126: `lastSelectedAt`, else
    // `addedAt`) and the only thing that reads either (nothing else in the product does: projects.mjs, desktop-project-registry.ts:173).
    const registry = rows.filter((row) => !row.hidden).map(({ path, name, lastUsedAt }) => ({ path, name, recency: lastUsedAt })).sort(byPath);
    const nodeRegistry = (expected.registry?.projects ?? []).map(({ path, name, addedAt, lastSelectedAt }) => ({ path, name: nodePreferences.aliases[path] ?? name, recency: lastSelectedAt ?? addedAt })).sort(byPath);
    if (!isDeepStrictEqual(registry, nodeRegistry)) unexpected.push({ step: 'registry', paths: differences(nodeRegistry, registry), node: nodeRegistry, core: registry });
    console.log(`phone-files ${name} replay over ${exe}: ${compared} compared, ${unexpected.length} unexpected`);
    const show = (value) => JSON.stringify(value?.frame ?? value).slice(0, 360);
    for (const entry of unexpected) {
      console.log(`DIFF #${entry.index ?? entry.step} ${entry.call ?? ''} ${JSON.stringify(entry.params ?? entry.paths ?? '').slice(0, 160)}`);
      console.log(`   node: ${show(entry.node)}`);
      console.log(`   core: ${show(entry.core)}`);
    }
    return unexpected.length ? 1 : 0;
  } finally {
    client?.close?.();
    window?.client.close?.();
    // The core is stopped as the app's quit stops it, with its PostgreSQL; one that needed force fails the replay naming what was forced.
    await endCore(core);
  }
}

export async function replayFiles({ exe, world, golden }) {
  let relay = null;
  try {
    const main = await replayScenario({ exe, world, name: 'main', make: filesScript, expected: golden.scenarios.main });
    relay = await startRelay({ repoRoot: REPO_ROOT, clients: [], capabilities: RELAY_CAPABILITIES });
    const paired = await replayScenario({ exe, world, name: 'relay', make: filesRelayScript, expected: golden.scenarios.relay, relay });
    return main || paired;
  } finally {
    // Every process is gone by here (each scenario ends its own core), so the directories can be removed.
    relay?.close();
    rmSync(REPLAY_WORLDS, { recursive: true, force: true });
  }
}
