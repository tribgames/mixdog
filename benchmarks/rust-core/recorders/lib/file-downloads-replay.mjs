// The replay of benchmarks/rust-core/recorders/record-file-downloads.mjs: every step of Node's recording (native/core/fixtures/
// file-downloads/file-downloads.json, b6f10295a) played against a freshly started mixdogd, and every phone call of it sent through the
// phone's router and the files adapter (apps/desktop/src/renderer/remote-protocol-files.ts) over a paired phone's relay connection, its reply
// compared whole with the frame Node's phone received. Nothing is filtered or skipped: a step this harness cannot make is a listed difference.
//
// The core must be built with the `replay-controls` feature (an explicit opt-in forwarded to mixdog-workspace; no ordinary build has it):
//   cargo build -p mixdog-cli --bin mixdogd --features replay-controls
// It is told a folder (`MIXDOG_DOWNLOAD_REPLAY_DIR`) it talks to this harness through (native/core/crates/mixdog-workspace/src/
// replay_controls.rs): the harness writes the clock and the holds, the core writes how many files its downloads hold open, where the
// 15 s sweeper counts from and the tick it has swept at. So the recording's clock moves only by its `advance` steps, a call is held inside
// the core while the recording's event happens, and every `handles` step is compared with the core's own count of the files it holds.
//
// The world: each scenario runs on devices of its own (a paired credential each) over two conversations of the core (s1 in a registered
// project, s2 a task conversation); a deleted conversation is a deleted thread, a publication of the catalog a `thread/list`. An unpair is
// the desktop's `remoteAccess/revokeClient` against a relay that does not confirm it (the phone's connection stays, without the device's
// grants). Node's `revokeAll` is the relay handle's close (remote-relay.ts:652); the core's is remote access switched off, which ends every
// phone connection this replay holds, so here the recording's `revokeAll` is played as the unpair of each device of the scenario (the
// close itself is replayed over the relay by the daemon's `switching_remote_access_off_ends_every_download_of_the_phones`).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';
import { coreRequests } from './file-download-requests.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const RELAY_CAPABILITIES = { textFrames: 1, maxFrameBytes: 1048576 };
const SWEEP_INTERVAL = 15_000;
/** Scenarios whose world a spawned core cannot be given here, and why. Their replies are replayed on the workspace service
 *  (`transfer::replay`), over a stand-in for the attachment domain. */
const WORLD_GAPS = {
  attachments:
    'a conversation that names an attachment needs a stored user turn carrying it, which a core without a signed-in model cannot make (owner: phone-download-grant)',
};
/** The point of the core's download call each of Node's test gates is held at. */
const POINTS = { read: 'read.read', stat: 'begin.verify', afterResolve: 'authorize.resolved', zipOpen: 'zip.open' };

/** A wait on something the replay needs to happen: it ends, after `ms` of real time, in an error naming what did not happen. */
const within = (promise, what, ms = 60_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the replay waited ${ms} ms for ${what}, which did not happen`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });

/** Ends a process and everything it started; a process that is already gone is fine, any other failure is an error. */
const killTree = (child) => {
  const ended = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', timeout: 30_000 });
  if (ended.error || (ended.status !== 0 && ended.status !== 128)) throw new Error(`could not end the core (pid ${child.pid}): ${ended.error?.message ?? `taskkill exited ${ended.status}`}`);
};

/** The core, started on a data dir of its own with the relay it dials and the folder it talks to this replay through; up when it has
 *  written its discovery file and the controls' first answer (a core built without them never writes one). */
async function startCore(exe, root, relayPort, talk) {
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(root, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DATA_DIR: join(root, 'data'),
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_CONFIG_DIR: join(root, 'config'),
    MIXDOG_DOWNLOAD_REPLAY_DIR: talk.dir,
    MIXDOG_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
  });
  writeFileSync(join(root, 'data', 'remote-activated.json'), '{"activatedAt":1}');
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  const { parseDiscovery } = await here('apps/desktop/src/main/protocol/discovery.ts');
  const child = spawn(exe, ['serve'], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const file = join(root, 'runtime', 'daemon.json');
  const up = () => {
    if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
    if (talk.read('held') === null) return undefined;
    try {
      return { child, endpoint: parseDiscovery(readFileSync(file, 'utf8')), dataDir: join(root, 'data') };
    } catch {
      return undefined;
    }
  };
  child.once('exit', () => talk.poke());
  try {
    return await talk.waitFor('the core to write its discovery file and the replay controls\' first answer (is mixdogd built with mixdog-workspace/replay-controls?)', up, 120_000, [join(root, 'runtime')]);
  } catch (error) {
    killTree(child);
    throw error;
  }
}

/** The folder the replay and the core talk through, and the waits on it: a wait is a watch of the folder (and any other named) that
 *  looks again at each change, with its own deadline. */
function talkFolder(dir) {
  mkdirSync(dir, { recursive: true });
  const waiting = new Set();
  const poke = () => waiting.forEach((look) => look());
  return {
    dir,
    poke,
    read: (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : null),
    write: (name, text) => writeFileSync(join(dir, name), String(text)),
    remove: (name) => rmSync(join(dir, name), { force: true }),
    async waitFor(what, check, ms = 30_000, also = []) {
      const watchers = [];
      try {
        return await within(
          new Promise((resolve, reject) => {
            const look = () => {
              try {
                const found = check();
                if (found !== undefined) resolve(found);
              } catch (error) {
                reject(error);
              }
            };
            waiting.add(look);
            for (const place of [dir, ...also]) watchers.push(watch(place, look));
            look();
          }),
          what,
          ms
        );
      } finally {
        for (const watcher of watchers) watcher.close();
      }
    },
  };
}

/** A relay the core dials: the desktop leg, with a roster of the paired devices, that does not confirm an unpair (the phone's connection
 *  stays, as in Node's recording where `revokeDevice` ended nothing but the device's downloads). The server exists when this returns, so
 *  the caller can close it whatever `ready` does. */
function startRelay(clients) {
  const { WebSocketServer } = createRequire(join(REPO_ROOT, 'apps', 'desktop', 'package.json'))('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const state = { socket: null, phones: new Map(), legWaiters: [] };
  const ready = within(new Promise((resolve) => server.once('listening', resolve)), 'the relay to listen', 30_000);
  server.on('connection', (socket) => {
    state.socket = socket;
    socket.send(JSON.stringify({ type: 'relay-capabilities', ...RELAY_CAPABILITIES }));
    for (const waiter of state.legWaiters.splice(0)) waiter();
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.type === 'list-clients') return socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients }));
      if (frame.type === 'revoke-client') return socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: false, error: 'The relay could not unpair the device.' }));
      if (frame.type === 'frame' || frame.type === 'close-client') state.phones.get(frame.clientId)?.arrived(frame);
    });
  });
  /** One phone behind the relay as `credential`: client-open, challenge, hello, ready; then a `Connector` over the sealed channel. */
  async function openPhone(E2EE, clientId, credential, pairing) {
    const inbox = [];
    const waiting = [];
    state.phones.set(clientId, {
      arrived(frame) {
        const next = waiting.shift();
        if (next) next(frame);
        else inbox.push(frame);
      },
    });
    const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve)));
    const take = () => within(next(), `a frame for the phone ${clientId} from the core`);
    state.socket.send(JSON.stringify({ type: 'client-open', clientId, browserClientId: credential }));
    const challenge = JSON.parse((await take()).data);
    const { hello, channel } = await E2EE.createRelayE2EEClientHandshake(pairing, challenge);
    state.socket.send(JSON.stringify({ type: 'frame', clientId, data: JSON.stringify(hello) }));
    const answer = await channel.decryptJson((await take()).data);
    if (answer?.type !== 'e2ee-ready') throw new Error(`the core did not answer the hello with e2ee-ready: ${JSON.stringify(answer)}`);
    let sending = Promise.resolve();
    return {
      async open(_target, sink) {
        let receiving = Promise.resolve();
        void (async () => {
          for (;;) {
            const frame = await next();
            if (frame.type === 'close-client') return sink.closed(1000, frame.reason ?? '');
            receiving = receiving.then(async () => sink.frame(JSON.stringify(await channel.decryptJson(frame.data))));
          }
        })();
        return {
          send(text) {
            sending = sending.then(async () => state.socket.send(JSON.stringify({ type: 'frame', clientId, data: await channel.encryptJson(JSON.parse(text)) })));
          },
          close() {},
        };
      },
    };
  }
  return {
    ready,
    port: () => server.address().port,
    leg: () => (state.socket ? Promise.resolve() : within(new Promise((resolve) => state.legWaiters.push(resolve)), 'the core to dial the relay', 120_000)),
    openPhone,
    close: () => server.close(),
  };
}

/** The recording's `<kind#n>` tokens: bound to the value of this run at first sight, equal to it at every later one. */
class Tokens {
  bound = new Map();
  static is = (text) => typeof text === 'string' && /^<[a-zA-Z]+#\d+>$/.test(text);
  resolve(node) {
    if (Tokens.is(node)) {
      if (!this.bound.has(node)) throw new Error(`${node} is not bound yet`);
      return this.bound.get(node);
    }
    if (Array.isArray(node)) return node.map((item) => this.resolve(item));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, this.resolve(value)]));
    return node;
  }
  /** The recorded token of a value this run bound, if it is one. */
  tokenOf(value) {
    for (const [token, bound] of this.bound) if (bound === value) return token;
    return undefined;
  }
  /** The paths at which `got` is not what was `recorded`. */
  differences(recorded, got, path = '') {
    if (Tokens.is(recorded)) {
      if (!this.bound.has(recorded)) this.bound.set(recorded, got);
      return this.bound.get(recorded) === got ? [] : [`${path}: ${recorded} was ${this.bound.get(recorded)}, now ${got}`];
    }
    if (recorded && got && typeof recorded === 'object' && typeof got === 'object' && Array.isArray(recorded) === Array.isArray(got)) {
      const keys = new Set([...Object.keys(recorded), ...Object.keys(got)]);
      return [...keys].flatMap((key) => this.differences(recorded[key], got[key], `${path}.${key}`));
    }
    return recorded === got ? [] : [`${path}: Node ${JSON.stringify(recorded)}, core ${JSON.stringify(got)}`];
  }
}

let opCount = 0;
const opId = () => `018f0000-0000-7000-8000-${(++opCount).toString(16).padStart(12, '0')}`;

/** @returns {Promise<{ code: number, notRun: string[], left: string[] }>} code 0 when every step is as Node's; the scenarios recorded for
 *  another system, not run; and those `only` left out (`--only <name>`, while a finding is fixed: the full run is the default).
 *  `failSetup` is the replay's own test of its cleanup: the setup throws right after the work folder is made, before any process starts. */
export async function replayDownloads({ exe, recording, only = null, failSetup = false }) {
  // A folder of this run's own, removed once at the end, after the processes that use it have ended.
  const WORLDS = realpathSync.native(mkdtempSync(join(tmpdir(), 'downloads-replay-')));
  const left = [];
  // Everything from the allocation on is inside the one protected region, so a throw anywhere after it still removes the folder.
  let relay = null;
  let core = null;
  const clients = [];
  const problems = [];
  const accounted = { calls: 0, held: 0, handles: 0, staged: 0, direct: 0 };
  /** The scenarios recorded for another system: not run here, and said so. */
  const notRun = [];
  try {
    if (failSetup) throw new Error(`the setup failed on purpose after making ${WORLDS}`);
    const talk = talkFolder(join(WORLDS, 'talk'));
    talk.write('clock', recording.clockStart);
    const credentials = [];
    const credential = (n, who) => {
      const id = `${who === 'phone' ? 'a' : who === 'tablet' ? 'b' : 'c'}${n.toString(16).padStart(7, '0')}`;
      credentials.push({ id, name: `${who} ${n}`, browser: 'Chrome' });
      return id;
    };
    // The roster is read when the core's relay leg opens: every device any scenario uses is listed up front.
    const plan = recording.scenarios.map((scenario, n) => ({
      scenario,
      devices: Object.fromEntries([...new Set(scenario.steps.flatMap((step) => [step.device].filter(Boolean)))].map((device) => [device, credential(n, device.startsWith('connection') ? 'connection' : device)])),
    }));
    relay = startRelay(credentials);
    // Every recorded call carries the id of its request: one counter, one id per call sent, in the recording's order, none skipped.
    let expectedId = null;
    await relay.ready;
    core = await startCore(exe, join(WORLDS, 'core'), relay.port(), talk);
    await relay.leg();
    const E2EE = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const { adapter, failure } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const base = (connector, kind, name) => ({
      target: { id: 'core' },
      connector,
      clientInfo: { name, title: name, version: '1.4.5', kind },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    });
    const pairing = E2EE.relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    // The desktop: registers projects, starts and deletes conversations, publishes the catalog, unpairs.
    const desktop = await connect(base(createWsConnector(async () => core.endpoint), 'desktop', 'mixdog-replay-desktop'));
    clients.push(desktop);
    const ask = (method, params) => within(desktop.call(method, params), `the core to answer ${method}`);

    for (const [n, { scenario, devices }] of plan.entries()) {
      const label = scenario.name;
      const steps = scenario.steps;
      const callsOf = steps.filter((step) => step.op === 'call' || step.op === 'send').length;
      if (WORLD_GAPS[label]) {
        // A world this replay cannot build on a real core: named, with why, in the list the caller asserts.
        notRun.push(label);
        if (expectedId !== null) expectedId += callsOf;
        console.log(`file-downloads ${label}: not run: ${WORLD_GAPS[label]}`);
        continue;
      }
      if (scenario.platform && scenario.platform !== process.platform) {
        // A recording of this host's own path rules is not a statement about another host's: named as not run (the caller asserts the list).
        notRun.push(label);
        if (expectedId !== null) expectedId += callsOf;
        console.log(`file-downloads ${label}: recorded on ${scenario.platform}, not run on ${process.platform} (${callsOf} calls)`);
        continue;
      }
      if (only && label !== only) {
        left.push(label);
        if (expectedId !== null) expectedId += callsOf;
        continue;
      }
      // The first scenario run may come after left-out ones: its own first call sets the counter.
      if (only) expectedId = null;
      const world = realpathSync.native(mkdtempSync(join(WORLDS, 'w-')));
      // The recorder's world: `project/sub` exists from the start too.
      for (const folder of ['project', 'project/sub', 'task', 'outside']) mkdirSync(join(world, folder), { recursive: true });
      talk.write('clock', recording.clockStart);
      let now = recording.clockStart;
      await ask('project/create', { opId: opId(), path: join(world, 'project') });
      // A conversation needs a main model on its route (no provider is signed in here): the draft names one, which is never called.
      const route = { provider: 'openai', model: 'gpt-5' };
      // A conversation the recording had published in a catalog before its first call is a row of the core's catalog: a name makes the empty
      // conversation one, as a turn does, and only a listed conversation can be seen gone.
      const publishedFirst = steps.findIndex((step) => step.op === 'sessions');
      const firstCall = steps.findIndex((step) => step.op === 'call' || step.op === 'hold');
      const listed = publishedFirst !== -1 && publishedFirst < firstCall;
      const started = async (kind, extra) => {
        const id = (await ask('thread/start', { opId: opId(), kind, draft: { route }, ...extra })).thread.id;
        if (listed) await ask('thread/name/set', { threadId: id, opId: opId(), title: `replay ${id}` });
        return id;
      };
      const conversations = { s1: await started('project', { projectPath: join(world, 'project') }), s2: await started('task', {}) };
      // The recorder's task conversation works in the world's `task` folder (a path relative to it names a file there).
      await ask('thread/setCwd', { opId: opId(), threadId: conversations.s2, path: join(world, 'task') });
      const alive = new Set(['s1', 's2']);
      const sessionOf = (node) => {
        if (Array.isArray(node)) return node.map(sessionOf);
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === 'sessionId' && conversations[value] ? conversations[value] : sessionOf(value)]));
        return node;
      };
      const tokens = new Tokens();
      const forward = (text) => text.replaceAll('\\', '/');
      /** A request the adapter made, in the recording's terms: its conversations, its tokens, its folder. */
      const normalized = (node) => {
        if (Array.isArray(node)) return node.map(normalized);
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, normalized(value)]));
        if (typeof node !== 'string') return node;
        const session = Object.entries(conversations).find(([, id]) => id === node);
        if (session) return session[0];
        const slashed = forward(node);
        return tokens.tokenOf(node) ?? (slashed.includes(forward(world)) ? slashed.replaceAll(forward(world), '<dir>') : node);
      };
      const routers = new Map();
      /** Each device's own client, to call the core directly (not counted as a request of the adapter). */
      const phones = new Map();
      const requested = [];
      const gaps = [];
      for (const [device, id] of Object.entries(devices)) {
        // A `connection:*` device is a relay connection the relay named no credential for: its own device (Node's `downloadRequester`).
        const named = device.startsWith('connection') ? '' : id;
        let client;
        try {
          client = await connect(base(await relay.openPhone(E2EE, `p${n}-${device}`, named, pairing), 'phone', 'mixdog-phone'));
        } catch (error) {
          gaps.push(`${device}: ${error.message}`);
          continue;
        }
        clients.push(client);
        const call = client.call.bind(client);
        phones.set(device, { call });
        client.call =(method, params) => (requested.push({ method, params: normalized(params) }), call(method, params));
        const host = { ctx: { browserId: `p${n}-${device}` }, client: () => client, declareLane() {} };
        routers.set(device, createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false }));
      }
      const unexpected = [...gaps];
      /** An answer in the recording's terms, as the recorder wrote Node's: a text naming the world's folder names `<dir>`, with forward slashes. */
      const unswapDir = (node) =>
        typeof node === 'string'
          ? node.includes(world)
            ? node.replaceAll(world, '<dir>').replaceAll('\\', '/')
            : node.replaceAll(forward(world), '<dir>')
          : Array.isArray(node)
            ? node.map(unswapDir)
            : node && typeof node === 'object'
              ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, unswapDir(v)]))
              : node;
      const swapDir = (node) => (typeof node === 'string' ? node.replaceAll('<dir>', forward(world)) : Array.isArray(node) ? node.map(swapDir) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swapDir(v)])) : node);
      const sendFrame = (device, method, params) => {
        const sent = within(routers.get(device).call(method, sessionOf(swapDir(tokens.resolve(params)))), `the answer to ${method}`);
        return sent.then(
          (value) => ({ ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }),
          (error) => ({ ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) })
        );
      };
      /** One call: the id it takes, the requests it makes, the frame it gets. */
      const issue = (step, recordedId) => {
        if (expectedId === null) expectedId = recordedId;
        if (recordedId !== expectedId) unexpected.push(`#${index} ${step.method}: the recording gives this call id ${recordedId}, the replay's next call is ${expectedId} (a call was skipped or repeated)`);
        expectedId += 1;
        return requested.length;
      };
      /** The requests the adapter made since `from` are those derived from the service calls Node's table made for this call. */
      const settleRequests = (from, step, at) => {
        const made = requested.slice(from);
        const wanted = coreRequests(step.service ?? []);
        if (JSON.stringify(wanted) !== JSON.stringify(made)) unexpected.push(`#${at + 1} the adapter's requests: Node's service calls give ${JSON.stringify(wanted)}, the adapter made ${JSON.stringify(made)}`);
      };
      const compare = (step, recorded, got, at) => {
        const { id: _id, ...node } = recorded;
        const found = tokens.differences(node, unswapDir(got));
        accounted.calls += 1;
        if (found.length) unexpected.push(`#${at + 1} ${step.device} ${step.method}: ${found.join('; ')}`);
      };
      const publish = async (ids) => {
        for (const id of [...alive]) {
          if (ids.includes(id)) continue;
          alive.delete(id);
          await ask('thread/delete', { threadId: conversations[id], opId: opId() });
        }
        await ask('thread/list', {});
      };
      // The relay does not confirm, so the call is refused after the core ended the device's downloads (`unpaired` runs first).
      const unpair = (device) => ask('remoteAccess/revokeClient', { opId: opId(), clientId: plan[n].devices[device] }).catch(() => undefined);
      /** Files and folders: the same operations the recorder made. */
      const fileOp = (step) => {
        // The media store is the core's own, in its data dir; every other file is in the scenario's world.
        const at = (name) => (name.startsWith('media/') ? join(core.dataDir, name) : join(world, name));
        if (step.op === 'write') (mkdirSync(join(at(step.file), '..'), { recursive: true }), writeFileSync(at(step.file), step.text));
        else if (step.op === 'append') appendFileSync(at(step.file), step.text);
        else if (step.op === 'size') truncateSync(at(step.file), step.bytes);
        else if (step.op === 'remove') rmSync(at(step.file), { force: true });
        else if (step.op === 'mkdir') mkdirSync(at(step.file), { recursive: true });
        else if (step.op === 'rename') renameSync(at(step.file), at(step.to));
        else if (step.op === 'junction') (rmSync(at(step.file), { recursive: true, force: true }), symlinkSync(at(step.target), at(step.file), 'junction'));
        else return false;
        return true;
      };
      /** The clock moves to `now + ms`, one sweeper tick at a time as Node's virtual queue ran them: to a tick, wait for the core to have
       *  swept at it, on; the last leg is plain time. */
      const advance = async (ms) => {
        const target = now + ms;
        for (;;) {
          const anchorText = talk.read('anchor');
          const anchor = anchorText === 'none' || anchorText === null ? null : Number(anchorText);
          const tick = anchor === null ? null : anchor + SWEEP_INTERVAL * (Math.floor((now - anchor) / SWEEP_INTERVAL) + 1);
          if (tick === null || tick > target) {
            talk.write('clock', target);
            now = target;
            return;
          }
          talk.remove('swept');
          talk.write('clock', tick);
          now = tick;
          await talk.waitFor(`the core's sweeper to sweep at ${tick}`, () => (talk.read('swept') === String(tick) ? true : undefined));
        }
      };
      // A deleted conversation's downloads end in the step the deletion lands, so the count is read as it stands.
      const held = async () => Number(talk.read('held'));
      /** The host's media store: the core's own store, in its data dir, gets the asset's file and its index entry. */
      const store = join(core.dataDir, 'media');
      const writeIndex = (entries) => (mkdirSync(store, { recursive: true }), writeFileSync(join(store, 'index.json'), JSON.stringify({ version: 2, assets: entries })));
      const assetsHeld = [];
      rmSync(store, { recursive: true, force: true });
      let index = 0;
      try {
        for (let at = 0; at < steps.length; at += 1) {
          const step = steps[at];
          index = at + 1;
          if (fileOp(step)) continue;
          switch (step.op) {
            case 'media': {
              const file = join(store, 'assets', step.name);
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, step.text);
              assetsHeld.push({ id: step.id, kind: 'image', mime: step.mime, file: step.name, bytes: step.text.length, createdAt: 1 });
              writeIndex(assetsHeld);
              break;
            }
            case 'mediaRoot': {
              // The core's own store, given an index entry whose file is empty: it resolves to the assets folder, as Node's does.
              mkdirSync(join(store, 'assets'), { recursive: true });
              assetsHeld.push({ id: step.id, kind: 'image', mime: '', file: '', bytes: 0, createdAt: 1 });
              writeIndex(assetsHeld);
              break;
            }
            case 'unmedia': {
              const at = assetsHeld.findIndex((entry) => entry.id === step.id);
              rmSync(join(store, 'assets', assetsHeld[at].file));
              break;
            }
            case 'advance':
              await advance(step.ms);
              break;
            case 'revokeDevice':
              await unpair(step.device);
              break;
            case 'revokeAll':
              for (const device of Object.keys(devices)) if (!device.startsWith('connection')) await unpair(device);
              break;
            case 'sessions':
              await publish(step.ids);
              break;
            case 'handles': {
              const open = await held();
              accounted.handles += 1;
              if (open !== step.open) unexpected.push(`#${index} handles: Node held ${step.open} files open, the core holds ${open}`);
              break;
            }
            case 'staged': {
              const count = Number(talk.read('staged'));
              accounted.staged += 1;
              if (count !== step.count) unexpected.push(`#${index} staged: Node had ${step.count} staged downloads on disk, the core has ${count}`);
              break;
            }
            case 'call': {
              if (!routers.has(step.device)) {
                unexpected.push(`#${index} ${step.method}: no connection for ${step.device}`);
                break;
              }
              const from = issue(step, step.frame.id);
              compare(step, step.frame, await sendFrame(step.device, step.method, step.params), at);
              settleRequests(from, step, at);
              // An asset id Node's table refused is the core's to refuse too (the core is the boundary): the same id sent straight to the
              // core, past the adapter's own check, answers the phone the frame Node's did once the adapter reads the core's error.
              const source = step.params?.[0]?.source;
              if (step.method === 'fileDownloadAuthorize' && source?.kind === 'media' && step.service.length === 0) {
                const direct = { sessionId: conversations[source.sessionId] ?? source.sessionId, source: { kind: 'mediaAsset', assetId: source.assetId }, purpose: step.params[0].purpose };
                const got = await within(phones.get(step.device).call('transfer/authorizeRead', direct), 'the core to answer an asset id past the adapter').then(
                  (value) => ({ ok: true, value }),
                  (error) => {
                    const read = failure(error);
                    return { ok: false, error: read.message, ...(typeof read.code === 'string' && read.code ? { errorCode: read.code } : {}) };
                  }
                );
                accounted.direct += 1;
                const { id: _id, ...node } = step.frame;
                const found = tokens.differences(node, got);
                if (found.length) unexpected.push(`#${index} ${step.method} sent to the core past the adapter: ${found.join('; ')}`);
              }
              break;
            }
            case 'hold': {
              // hold, send, the event, release, answer: the call is held inside the core at the point the gate names while the event happens.
              const [sent, event, release, answered] = [steps[at + 1], steps[at + 2], steps[at + 3], steps[at + 4]];
              if (sent.op !== 'send' || release.op !== 'release' || answered.op !== 'answer') throw new Error(`${label} #${index}: a hold is not followed by send, event, release, answer`);
              const point = POINTS[step.gate];
              accounted.held += 1;
              talk.write(`hold-${point}`, '1');
              const from = issue(sent, answered.frame.id);
              const pending = sendFrame(sent.device, sent.method, sent.params);
              await talk.waitFor(`a call to reach ${point} in the core`, () => (talk.read(`reached-${point}`) !== null ? true : undefined));
              settleRequests(from, sent, at + 1);
              if (event.op === 'revokeDevice') await unpair(event.device);
              else if (event.op === 'revokeAll') {
                for (const device of Object.keys(devices)) if (!device.startsWith('connection')) await unpair(device);
              }
              else if (event.op === 'sessions') await publish(event.ids);
              else if (!fileOp(event)) throw new Error(`${label} #${index}: a held call's event ${event.op}`);
              talk.remove(`hold-${point}`);
              compare(sent, answered.frame, await pending, at + 4);
              at += 4;
              break;
            }
            default:
              throw new Error(`${label} #${index}: an unknown step ${step.op}`);
          }
        }
      } catch (error) {
        unexpected.push(`#${index} the replay stopped: ${error.message}`);
      }
      // What the scenario made in the core goes with it: every device unpaired and its connections closed, the core's count back to
      // nothing held and its sweeper stopped, so the next scenario starts as the first did.
      for (const device of Object.keys(devices)) if (!device.startsWith('connection')) await unpair(device);
      for (const id of alive) await ask('thread/delete', { threadId: conversations[id], opId: opId() });
      // A relay connection without a credential cannot be unpaired (Node's `downloadRequester`): what it holds ends by its lease, so the
      // clock moves past the transfer lease's absolute lifetime (30 minutes), tick by tick.
      if (Number(talk.read('held')) > 0) await advance(31 * 60_000).catch((error) => unexpected.push(`the replay stopped: ${error.message}`));
      await ask('project/delete', { path: join(world, 'project'), opId: opId() });
      for (const client of clients.splice(1)) client.close?.();
      await talk
        .waitFor('the core to hold nothing and stop its sweeper', () => (talk.read('held') === '0' && talk.read('anchor') === 'none' ? true : undefined), 15_000)
        .catch(() => unexpected.push(`the scenario left the core holding ${talk.read('held')} files (sweeper ${talk.read('anchor')})`));
      console.log(`file-downloads ${label}: ${steps.length} steps, ${unexpected.length} unexpected`);
      for (const line of unexpected) console.log(`  DIFF ${line}`);
      problems.push(...unexpected.map((line) => `${label} ${line}`));
    }
  } finally {
    // The core is ended first and its exit awaited, then the relay closed, then the work folder removed once: a failure of any is an error.
    const failures = [];
    for (const client of clients) client.close?.();
    try {
      if (core) {
        const gone = new Promise((resolve) => (core.child.exitCode === null ? core.child.once('exit', resolve) : resolve()));
        killTree(core.child);
        await within(gone, 'the core to exit', 30_000);
      }
    } catch (error) {
      failures.push(error);
    }
    relay?.close();
    try {
      rmSync(WORLDS, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, `cleanup of the replay failed: ${failures.map((error) => error.message).join('; ')}`);
  }
  if (only && left.length === recording.scenarios.length - notRun.length) problems.push(`--only ${only}: no scenario of that name`);
  console.log(`file-downloads replay over ${exe}: ${accounted.calls} calls compared, ${accounted.held} held calls, ${accounted.handles} handle counts, ${accounted.staged} staged counts, ${accounted.direct} asset ids sent past the adapter, ${problems.length} unexpected, not run on this system: ${JSON.stringify(notRun)}${only ? `, left out by --only: ${left.length}` : ''}`);
  return { code: problems.length ? 1 : 0, notRun, left };
}
