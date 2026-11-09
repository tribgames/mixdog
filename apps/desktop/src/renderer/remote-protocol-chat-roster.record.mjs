// Records what Node's phone holds as its thread list, action by action, and through a desktop restart: Node's own attach baseline
// (remote-view-sync.ts registerAndSynchronizeRelayViews, view-synchronizer.ts) run unchanged from the exact export of b6f10295a,
// with the phone's own roster decoder and cache (shared/list-delta.ts, shared/remote-roster-cache.ts) and its catalog
// (shared/remote-catalog.ts). The desktop host is scripted; its rosters are Node's `desktopSessionSummaries` over raw rows.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-roster.record.mjs <export dir> <out file>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [exportDir, outFile] = process.argv.slice(2);
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const NODE_CHECKOUT = 'C:/Project/mixdog';

// The export is exact only if every file of the commit's tree is in it: byte for byte (git blob ids), or, for a text file the archive\n// wrote with CRLF (* text=auto), the same bytes once CRLF is read as the LF the repository stores.
const listing = execFileSync('git', ['-C', NODE_CHECKOUT, 'ls-tree', '-r', COMMIT], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
let checked = 0;
let eolOnly = 0;
const blobId = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const mismatched = [];
for (const line of listing) {
  const [meta, path] = line.split('\t');
  const [mode, , sha] = meta.split(' ');
  if (mode === '160000' || mode === '120000') continue;
  let body;
  try { body = readFileSync(join(exportDir, path)); } catch { mismatched.push(`${path} (missing)`); continue; }
  checked += 1;
  if (blobId(body) === sha) continue;
  if (blobId(Buffer.from(body.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) === sha) eolOnly += 1;
  else mismatched.push(path);
}
if (mismatched.length) throw new Error(`the export is not b6f10295a: ${mismatched.length} files differ, e.g. ${mismatched.slice(0, 3).join(', ')}`);

const load = (path) => import(pathToFileURL(join(exportDir, 'apps/desktop/src', path)).href);
const { registerAndSynchronizeRelayViews } = await load('main/remote-view-sync.ts');
const { createRelayClientRegistry } = await load('main/remote-relay-clients.ts');
const { createRelayCatalogs } = await load('main/remote-relay-catalog.ts');
const { createKeyedListDeltaDecoder } = await load('shared/list-delta.ts');
const { createRemoteRosterCache, readRosterStamp } = await load('shared/remote-roster-cache.ts');
const { createRemoteCatalog } = await load('shared/remote-catalog.ts');
const { byActivityThenId } = await import(pathToFileURL(join(exportDir, 'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs')).href);

const plain = (value) => JSON.parse(JSON.stringify(value));

// ── The scenario: the same actions remote-protocol-chat-live.record.mjs makes against a running mixdogd ─────────────────────────────
// Everything here is Node's own product code from the exact export, run for real: the Node daemon (`ensureDaemon`) in the harness's isolated
// env with its fake provider, and Node's SessionHost (session-host.ts, run unchanged) attached to it. A thread is made the way the desktop
// makes a new task (`submitNewTask`: reserve, `configureDraft` with the draft route, first prompt), named, favorited, read, forked
// (`inheritSession`), archived and deleted through the host; the roster of an action is what the host's `listSessions` answers after it. Times
// are the real clock's, so the comparison maps them by order (remote-protocol-chat-parity.mjs). A thread with no prompt is never stored
// (Node refuses to name it: "Session is not available."), so a first prompt is part of making one.
const PROJECT = { a: 'C:\\proj\\a', b: 'C:\\proj\\b' };
const harness = process.argv[4];
if (!harness) throw new Error('usage: <export dir> <out file> <real-turn-harness dir>');
const { createHash: sha } = await import('node:crypto');
const { mkdirSync, rmSync } = await import('node:fs');
process.env.HARNESS_ENV_ROOT = join(harness, 'run', 'env-ph2-chat-node');
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { startFakeProvider } = await hload('fake-provider.mjs');
const { createDeadline, latch } = await hload('deadline.mjs');
const PINNED = ['env.mjs', 'fake-provider.mjs', 'deadline.mjs', 'scenarios.mjs'];
const envPaths = isolatedPaths();
rmSync(envPaths.envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
for (const d of [envPaths.dataDir, envPaths.runtimeRoot, envPaths.appData, envPaths.localAppData, envPaths.tmp, envPaths.workspace]) mkdirSync(d, { recursive: true });
const projects = { a: join(envPaths.workspace, 'a'), b: join(envPaths.workspace, 'b') };
for (const p of Object.values(projects)) mkdirSync(p, { recursive: true });
const provider = await startFakeProvider({ workspace: envPaths.workspace });
writeFileSync(join(envPaths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
const route = { provider: 'custom-harness', model: 'harness-model' };
for (const key of Object.keys(process.env)) if (/^MIXDOG_/i.test(key)) delete process.env[key];
Object.assign(process.env, daemonEnv(envPaths));
// The daemon is forked with this process's flags; it runs as a plain script.
process.execArgv = [];
const { SessionHost } = await load('main/session-host.ts');
const sessionClient = await import(pathToFileURL(join(exportDir, 'src/standalone/session-client.mjs')).href);
const { createSessionProtocolClient } = await import(pathToFileURL(join(exportDir, 'src/standalone/session-protocol.mjs')).href);
const { createDesktopRuntime } = await import(pathToFileURL(join(exportDir, 'src/standalone/daemon-desktop-runtime.mjs')).href);

// In production the host runs inside the daemon and reaches it through the daemon-local session bridge (daemon-local-session-bridge.mjs:30
// calls `handleCall` with no revision), which the daemon reads as revision 0 (session-action.mjs:221): at revision 0 a read action such as
// `agentDefinitionPresence` (session-protocol.mjs:12) is accepted on the configure lane, where this host sends it (session-host-transport.ts
// callAction: READ_CAPABILITIES lacks it). This recorder's client reaches the daemon over TCP, so it registers as revision 0 too -- the one
// digit of the register body (session-client.mjs:577 `revision: SESSION_REVISION`, 6); every Node module runs unchanged.
{
  const http = (await import('node:http')).default;
  const request = http.request;
  http.request = function (...args) {
    const req = request.apply(this, args);
    if (args.find((a) => a && typeof a === 'object' && a.path)?.path === '/client/register') {
      const write = req.write;
      req.write = (chunk, ...rest) => write.call(req, String(chunk).replace('"revision":6', '"revision":0'), ...rest);
    }
    return req;
  };
}
const deadline = createDeadline(300_000, () => 'node roster recording');
const discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: envPaths.workspace, attempts: 2, readyTimeoutMs: 60_000 }), 'the Node daemon');
const turnsDone = new Map();
const waiters = new Set();
const wake = () => waiters.forEach((check) => check());
const hasTurnDone = (v) => (Array.isArray(v) ? v.some(hasTurnDone) : v && typeof v === 'object' ? v.kind === 'turndone' || Object.values(v).some(hasTurnDone) : false);
const runtime = {
  ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
  attachSessionClient: async (options) => {
    const attached = await sessionClient.attachSession({
      discovery,
      cwd: envPaths.workspace,
      onFrame: (frame) => {
        if (frame?.sessionId && hasTurnDone(frame)) turnsDone.set(frame.sessionId, (turnsDone.get(frame.sessionId) || 0) + 1);
        options.onFrame(frame);
        wake();
      },
      onFatal: options.onFatal,
    });
    return createSessionProtocolClient({ call: (name, args, callOptions) => attached.call(name, args, callOptions), close: (reason) => attached.close(reason) });
  },
};
const userData = envPaths.appData;
const host = await SessionHost.create({ userDataPath: userData, resourcesPath: envPaths.workspace, appPath: envPaths.workspace, packaged: false }, runtime);
/** Resolves when `ready()` holds, checked again at each frame and each catalog publication. */
const until = (ready, what) => {
  const done = latch();
  const check = () => { if (ready()) { waiters.delete(check); done.resolve(); } };
  waiters.add(check);
  check();
  return deadline.race(done.promise, what);
};
/** Resolves at the next frame or catalog publication. */
const nextEvent = (what) => {
  const done = latch();
  const check = () => { waiters.delete(check); done.resolve(); };
  waiters.add(check);
  return deadline.race(done.promise, what);
};
host.subscribeSessions(() => wake());
const listed = async () => plain(await host.listSessions());
/** The rows are settled when `ok(rows)` holds; a catalog publication re-checks. */
async function settled(ok, what) {
  let rows = await listed();
  while (!ok(rows)) {
    await nextEvent(what);
    rows = await listed();
  }
}
const made = {};
const notes = [];
const originalWarn = console.warn;
const retireWarned = latch();
console.warn = (...args) => {
  const text = args.map((a) => String(a?.stack ?? a)).join(' ');
  if (/Could not archive the threads of removed agents/.test(text)) { notes.push(text.split('\n')[0]); retireWarned.resolve(); }
  else originalWarn(...args);
};
const turn = async (id, count, send) => {
  await send();
  await until(() => turnsDone.get(id) >= count, `the turn ${count} of ${id}`);
  await settled((rows) => { const row = rows.find((r) => r.id === id); return row && row.messageCount === count * 2 && row.activityAt === row.updatedAt; }, `the row of ${id}`);
};
const newTask = async (name, project) => {
  await host.startProject(projects[project]);
  const accepted = await host.submitNewTask(`hello ${name}`, { id: `sub-${name}` }, { projectPath: projects[project], route });
  made[name] = accepted.sessionId;
  await turn(made[name], 1, async () => {});
};
const turns = {};
const second = async (name) => { turns[name] = (turns[name] || 1) + 1; await turn(made[name], turns[name], () => host.submitToSession(made[name], `again ${name}`, { id: `sub-${name}-${turns[name]}` })); };
const saveBot = async (name) => (await host.invokeCapability('saveAgentDefinition', [{ kind: 'bot', name, description: `${name} bot`, body: `You are ${name}.`, route }])).value.id;

const ACTIONS = [
  ['created', async () => {
    for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
      await newTask(name, project);
      await host.renameSession(made[name], `Title ${name.slice(-1)}`);
    }
    made.sess_2 = (await host.inheritSession(made.sess_0, null)).sessionId;
    await host.renameSession(made.sess_2, 'Title 2');
    await host.setSessionFavorite(made.sess_2, true);
    await host.markSessionRead(made.sess_1, 0, true);
  }],
  ['turns', async () => { for (const name of ['sess_1', 'sess_0']) await second(name); }],
  ['archive', async () => { await host.setSessionArchived(made.sess_3, true); }],
  ['unarchive', async () => { await host.setSessionArchived(made.sess_3, false); }],
  ['archive-again', async () => { await host.setSessionArchived(made.sess_3, true); }],
  ['delete', async () => {
    await newTask('sess_5', 'a');
    await host.renameSession(made.sess_5, 'Title 5');
    await host.deleteSession(made.sess_5);
  }],
  // An agent's home thread: opened, then spoken in.
  ['agent-home', async () => {
    made.botOne = await saveBot('Bot One');
    made.botTwo = await saveBot('Bot Two');
    made.botOneHome = (await host.openAgentHome(made.botOne)).sessionId;
    await turn(made.botOneHome, 1, () => host.submitToSession(made.botOneHome, 'hello Bot One', { id: 'sub-home' }));
  }],
  // A group room of both bots (its log is a stored session the catalog stamps with `agentRoom`).
  ['room', async () => {
    const created = await host.agentRoomAction('create', [{ name: 'Room One', members: [made.botOne, made.botTwo] }]);
    made.room = created.roomId;
    made.roomLog = created.sessionId;
  }],
  // The agent is deleted: the host proves it through `agentDefinitionPresence`, then archives the agent's home (agent-home-sessions.ts
  // archiveDeleted), names it, and drops the bot from its rooms (agent-rooms.ts forgetMember). It runs after the delete's reply (`void
  // retireAgentHomes`, session-host-lifecycle.ts:1171), so the action ends when the home row says it was retired.
  ['agent-delete', async () => {
    await host.invokeCapability('deleteAgentDefinition', [made.botOne]);
    await settled((rows) => rows.find((row) => row.id === made.botOneHome)?.agentDeleted === true && !rows.find((row) => row.id === made.roomLog)?.agentRoom?.members.includes(made.botOne), 'the deleted agent\'s home to be retired and the bot to leave its room');
  }],];
const roster = () => listed();
function desktop(rows) {
  const listeners = new Set();
  let gate = null;
  let reached = null;
  const host = {
    rows,
    listSessions: async () => {
      if (gate) {
        reached?.();
        await gate;
      }
      return host.rows;
    },
    getSnapshot: () => ({ sessionId: null, status: 'idle', items: [], streamingTail: null }),
    listAgentPool: async () => [],
    subscribeSessions: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    subscribeAgentPool: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (_ids, deliver) => deliver([]),
  };
  const registry = createRelayClientRegistry({ host, sendEnvelope: () => {}, frameBudgetBytes: 1 << 20, onClientCountChanged: () => {}, onEmpty: () => {}, now: () => 0 });
  const clients = new Map();
  let deliver = null;
  const catalogs = createRelayCatalogs({ host, clients, live: () => true, sendEncryptedFrame: async (_id, frame) => deliver?.(frame) });
  let legs = 0;
  return {
    host,
    /** A catalog change: the host's own listeners hear it, then the relay's live frame. */
    publish(next) {
      host.rows = next;
      for (const listener of [...listeners]) listener(next);
      catalogs.publishSessions(next);
    },
    /** Holds the host's roster read; rrived resolves when a read has reached the hold. */
    hold() {
      let release;
      gate = new Promise((r) => (release = r));
      const arrived = new Promise((r) => (reached = r));
      return { arrived, release: () => { gate = null; release(); } };
    },
    connect(phone) {
      const clientId = `client-${++legs}`;
      const state = registry.open(clientId, {});
      clearTimeout(state.handshakeTimer);
      Object.assign(state, { channel: {}, viewSync: true, compactWire: true, listDelta: true, stateLane: null });
      clients.clear();
      clients.set(clientId, state);
      deliver = (frame) => phone.apply(plain(frame));
      return async (rosterParam) => {
        const frames = [];
        await registerAndSynchronizeRelayViews(host, clientId, state, [[], null, undefined, rosterParam], () => true, async (frame) => {
          frames.push(plain(frame));
          deliver(frame);
        });
        return frames;
      };
    },
  };
}

const storage = (() => {
  let record;
  const saved = [];
  return {
    load: async () => (record === undefined ? undefined : structuredClone(record)),
    save: async (v) => {
      record = structuredClone(v);
      saved.splice(0).forEach((resolve) => resolve());
    },
    clear: async () => { record = undefined; },
    /** Resolves when the phone's roster cache has persisted its next roster (the completion of its debounced save). */
    nextSave: () => new Promise((resolve) => saved.push(resolve)),
  };
})();

/** The phone as remote-shim-dispatch.ts runs it: a `sessions` frame decodes and publishes to the catalog. */
function phone() {
  const decoder = createKeyedListDeltaDecoder();
  const cache = createRemoteRosterCache({ storage, scope: () => 'relay\ndevice\nkey\nsecret', decoder, saveDelayMs: 0, onMismatch: () => {} });
  const catalog = createRemoteCatalog();
  const published = [];
  catalog.subscribe((rows) => published.push(plain(rows)));
  return {
    published,
    claim: () => cache.claim(),
    get rows() { return catalog.get(); },
    apply(frame) {
      if (frame.event !== 'sessions') return;
      const decoded = decoder.decode(frame.payload);
      if (!decoded.ok) throw new Error('a sessions frame did not apply');
      catalog.publish(decoded.items);
      cache.observe(frame.payload);
    },
    stamped: () => readRosterStamp,
  };
}
const kind = (frames) => frames.filter((f) => f.event === 'sessions').map((f) => (f.payload.__listCatch ? 'catch-up' : f.payload.rows ? 'baseline' : 'delta'));


const steps = [];
const note = (name, p, frames, extra = {}) => steps.push({ name, ...extra, frames: frames ? kind(frames) : undefined, published: p.published.splice(0), roster: plain(p.rows) });

// The desktop and phone that stay connected through every action: each action ends with the host publishing its roster, as Node's catalog did.
let live = desktop([]);
let livePhone = phone();
await live.connect(livePhone)(await livePhone.claim());
livePhone.published.splice(0);
const rosters = [{ name: 'start', roster: [] }];
for (const [name, act] of ACTIONS) {
  await act();
  const next = await roster();
  rosters.push({ name, roster: next });
  live.publish(next);
  note(`action:${name}`, livePhone, undefined);
}

// Per state: a fresh phone's baseline, a phone that restarts into it holding the previous state's persisted roster, and a change that
// arrives while the baseline's read is still held.
const withRows = (name) => rosters.find((r) => r.name === name).roster;
for (let i = 1; i < rosters.length; i += 1) {
  const { name } = rosters[i];
  const prev = rosters[i - 1];
  await storage.clear();
  let d = desktop(withRows(name));
  let p = phone();
  note(`attach:${name}`, p, await d.connect(p)(await p.claim()));
  if (i === 1) continue;
  // The desktop restarts into this state; the phone holds the roster it persisted from the previous one.
  await storage.clear();
  d = desktop(withRows(prev.name));
  p = phone();
  const persisted = storage.nextSave();
  await d.connect(p)(await p.claim());
  await deadline.race(persisted, `the phone to persist the roster of ${prev.name}`);
  d = desktop(withRows(name));
  p = phone();
  note(`restart:${prev.name}>${name}`, p, await d.connect(p)(await p.claim()));
  // A change between the baseline's subscribe and its list: the host publishes the next state while the read is held.
  await storage.clear();
  d = desktop(withRows(prev.name));
  p = phone();
  const { arrived, release } = d.hold();
  const syncing = d.connect(p)(await p.claim());
  await deadline.race(arrived, `the host's roster read for ${name} to reach the hold`);
  d.publish(withRows(name));
  release();
  note(`between:${prev.name}>${name}`, p, await deadline.race(syncing, `the phone's baseline read of ${name} to finish`));
}

// Publishing a roster the phone already has: Node's catalog skips an unchanged roster, so nothing reaches the phone.
live.publish(rosters.at(-1).roster);
note('unchanged:delete', livePhone, undefined);

// Node's catalog order over ties, lastUsedAt over updatedAt, and rows with no activity at all (schema.mjs byActivityThenId): the rows are
// Node store rows (inputs); `order` is what Node's own comparator gives.
const tieRows = [
  { id: 'sess_10', updatedAt: 500 }, { id: 'sess_11', updatedAt: 500 }, { id: 'sess_09', updatedAt: 500 }, { id: 'sess_13', updatedAt: 100, lastUsedAt: 900 },
  { id: 'sess_14', updatedAt: 900 }, { id: 'sess_15', updatedAt: 0 }, { id: 'sess_A', updatedAt: 0 }, { id: 'sess_a', updatedAt: 0, lastUsedAt: 0 },
].map((row) => ({ preview: '', title: row.id, messageCount: 0, cwd: PROJECT.a, classification: 'project', projectPath: PROJECT.a, ...row, activityAt: Number(row.lastUsedAt) || row.updatedAt }));
steps.push({ name: 'order-ties', coreRows: plain(tieRows), order: [...tieRows].sort(byActivityThenId).map((r) => r.id) });

// A prompt with no display text: the submission intake refuses it (submission.mjs `submission`, promptDisplayText), and the host answers
// false / not accepted. Asked of the real host on a real session, so the phone's refusal is Node's own answer.
const refusals = {};
for (const prompt of ['', '   ']) {
  refusals[`submitToSession ${JSON.stringify(prompt)}`] = await deadline.race(host.submitToSession(made.sess_1, prompt, { id: `sub-blank-${prompt.length}` }), `Node's host to answer a blank submitToSession (${prompt.length} chars)`);
  refusals[`submitNewTask ${JSON.stringify(prompt)}`] = await deadline.race(host.submitNewTask(prompt, { id: `sub-new-blank-${prompt.length}` }, { projectPath: projects.a, route }), `Node's host to answer a blank submitNewTask (${prompt.length} chars)`);
}

console.warn = originalWarn;
await host.dispose().catch(() => {});
await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
await provider.close();
const sha256 = (file) => sha('sha256').update(readFileSync(file)).digest('hex');
const manifest = { exact: true, commit: COMMIT, tree: execFileSync('git', ['-C', NODE_CHECKOUT, 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(), filesCompared: checked, crlfOnlyDifferences: eolOnly, source: 'git archive of the whole tree, every file compared with its git blob id; the Node daemon (session-client.mjs ensureDaemon) and session-host.ts run unchanged for the actions; remote-view-sync.ts, remote-relay-catalog.ts, view-synchronizer.ts, list-delta.ts, remote-roster-cache.ts run unchanged for the phone side', harness: Object.fromEntries(PINNED.map((name) => [`lib/${name}`, sha256(join(harness, 'lib', name))])), hostNotes: notes, actions: ACTIONS.map(([name]) => name) };
writeFileSync(outFile, `${JSON.stringify({ manifest, made, projects, refusals, states: rosters, steps }, null, 2)}\n`);
console.log(`recorded ${steps.length} steps over ${checked} verified files`);
process.exit(0);