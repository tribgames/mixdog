// The replay of lib/phone-files-script.mjs: the phone's router and adapter (apps/desktop/src/renderer/remote-protocol-files.ts) against a freshly
// started, built mixdogd, every answer compared whole with what Node gave (apps/mobile/fixtures/phone-files/golden.json). A stand-in
// window (a second connection that claims the host role) answers the OS trash, the snapshot and the local page as the script scripts it.
//
// The main scenario runs here, on the loopback connection every client of this core has. The relay scenario (what only a paired phone
// meets: the registered-projects rule and one-file permissions) needs a relay-origin connection, which only the relay leg opens: it runs
// behind a scripted relay and a paired phone (lib/phone-relay-core.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { FIXED_NOW_MS, filesRelayScript, filesScript, play, treeOf, windowAnswers } from './phone-files-script.mjs';
import { startRelay } from './phone-relay-core.mjs';

/** The cores' data dirs (postgres included) live on the idle SSD: the shared build disk's queue made postgres's shutdown checkpoint outlast
 *  the core's stop limit (Node's, unchanged). Removed when the replay ends. */
const REPLAY_WORLDS = 'C:\\Users\\tempe\\.mixdog\\data\\scratch\\rust-core\\replay-worlds\\w5';

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
async function killTree(child) {
  const exited = child.exitCode === null && child.signalCode === null ? new Promise((resolve) => child.once('exit', resolve)) : null;
  spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  // taskkill returns when the kill is requested; the folder may be removed only after the core has let go of its files (an open
  // `daemon-owner.json.claim.lock` made that removal fail with EBUSY).
  await exited;
}

async function startCore(exe, coreRoot, relay, fresh = true) {
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
  });
  // An install that has used remote access before: the core dials its relay at start.
  if (relay) writeFileSync(join(coreRoot, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  // The install layout: the manifest beside the binary names the JS runtime (a build output has none of its own).
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  // The core is up when it has written its discovery file. The watch is registered before the first look, so a write between the look and
  // the wait still wakes it; the wait ends on the directory's change or on the child's exit, never on a timer.
  const dir = join(coreRoot, 'runtime');
  const file = join(dir, 'daemon.json');
  let stirred = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  const watcher = watch(dir, stir);
  child.once('exit', stir);
  try {
    for (;;) {
      stirred = false;
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
      try {
        return { child, env, endpoint: parseDiscovery(readFileSync(file, 'utf8')), dataDir: join(coreRoot, 'data') };
      } catch {
        if (!stirred) await new Promise((resolve) => (wake = resolve));
      }
    }
  } catch (error) {
    await killTree(child);
    throw error;
  } finally {
    watcher.close();
  }
}

/** The PC's window: a second connection that claims the host role and answers what the core asks of it. */
async function openWindow(connect, base) {
  const asked = [];
  const client = await connect({
    ...base,
    clientInfo: { ...base.clientInfo, name: 'mixdog-replay-window', kind: 'desktop' },
    capabilities: {
      optOutNotificationMethods: [],
      experimentalApi: false,
      host: { browser: false, visualize: false, notifications: false, systemProxy: false, power: false, media: false, updater: false, files: true },
    },
  });
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
  await client.call('host/claim', { hostId: 'replay-window' });
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
      await relay.leg();
      const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
      phoneConnector = await relay.openPhone('client-files', PHONE_ID, relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8'))));
    }
    client = await connect({ ...base, connector: phoneConnector });
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
          const value = await router.call(name, params);
          frame = { ok: true, value: value === undefined ? null : clone(value) };
        } catch (error) {
          frame = { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
        }
        return { frame, hostCalls: window ? window.asked.splice(0) : [] };
      },
      // The core stops and starts again over the same data dir (the loopback phone only: a relay leg would have to be re-paired).
      restart: async () => {
        if (relay || window) throw new Error('restart is replayed on a loopback phone with no window');
        client.close?.();
        // A stop the app itself performs (its own quit): the memory database shuts down cleanly, so the next start does not run crash recovery.
        const { execFileSync } = await import('node:child_process');
        const exited = new Promise((resolve) => core.child.once('exit', resolve));
        execFileSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'userStop'], { env: core.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        await exited;
        Object.assign(core, await startCore(exe, coreRoot, relay, false));
        base.connector = createWsConnector(async () => core.endpoint);
        client = await connect({ ...base, connector: base.connector });
      },
      // The one-file permission a paired phone holds for a path outside every project (`transfer/grant/mint`, relay origin).
      grant: async (path) => (await client.call('transfer/grant/mint', { path })).accessToken,
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
    const rows = (await client.call('project/list', {})).projects;
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
    await killTree(core.child);
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
