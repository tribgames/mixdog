// The replay of benchmarks/rust-core/recorders/record-file-downloads.mjs: every phone call of Node's recording (native/core/fixtures/
// file-downloads/file-downloads.json, b6f10295a) sent through the phone's router and the files adapter
// (apps/desktop/src/renderer/remote-protocol-files.ts) over a paired phone's relay connection to a freshly started, built mixdogd, its reply
// compared whole, in order, with the frame Node's phone received. Nothing is filtered or skipped: a call this harness cannot make, or
// a step the core cannot be given, is a listed difference that fails the run, naming whose it is.
//
// The world: each scenario runs on devices of its own (a paired credential each, so what an earlier scenario left held is another
// device's) over two conversations of the core (s1 in a registered project, s2 a task conversation); a deleted conversation is a deleted
// thread, a publication of the catalog a `thread/list`. The recording's clock moves only by its `advance` steps: the core reads the
// instant from the file named by `MIXDOG_DOWNLOAD_CLOCK_FILE` (a debug build only), which this replay writes. An unpair is the desktop's
// `remoteAccess/revokeClient` against a relay that does not confirm it (the phone's connection stays, without the device's grants).
//
// What a spawned core cannot show is proved elsewhere and counted here: a call held in the middle of the core while something else
// happens (`hold` steps) and the files it holds open (`handles` steps) are replayed by the workspace crate's
// `transfer::replay` test on the production service dispatch, which holds a call at the point it names and counts the held files.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './common.mjs';

const WORLDS = 'D:\\mixdog-build\\tmp\\w25-downloads-replay';
const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const RELAY_CAPABILITIES = { textFrames: 1, maxFrameBytes: 1048576 };

/** A wait on something the replay needs to happen: it ends, after `ms` of real time, in an error naming what did not happen. */
const within = (promise, what, ms = 60_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the replay waited ${ms} ms for ${what}, which did not happen`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });

const killTree = (child) => void spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });

/** The core, started on a data dir of its own with the relay it dials and the clock file it reads; up when it has written its discovery file. */
async function startCore(exe, root, relayPort, clockFile) {
  rmSync(root, { recursive: true, force: true });
  for (const dir of ['runtime', 'data', 'home', 'config']) mkdirSync(join(root, dir), { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MIXDOG_')) delete env[key];
  Object.assign(env, {
    MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
    MIXDOG_DATA_DIR: join(root, 'data'),
    MIXDOG_HOME: join(root, 'home'),
    MIXDOG_CONFIG_DIR: join(root, 'config'),
    MIXDOG_DOWNLOAD_CLOCK_FILE: clockFile,
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
  let stirred = false;
  let wake = null;
  const stir = () => {
    stirred = true;
    wake?.();
  };
  const watcher = watch(join(root, 'runtime'), stir);
  child.once('exit', stir);
  try {
    return await within(
      (async () => {
        for (;;) {
          stirred = false;
          if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}:\n${stderr}`);
          try {
            return { child, endpoint: parseDiscovery(readFileSync(file, 'utf8')), dataDir: join(root, 'data') };
          } catch {
            if (!stirred) await new Promise((resolve) => (wake = resolve));
          }
        }
      })(),
      'the core to write its discovery file',
      120_000
    );
  } catch (error) {
    killTree(child);
    throw error;
  } finally {
    watcher.close();
  }
}

/** A relay the core dials: the desktop leg, with a roster of the paired devices, that does not confirm an unpair (the phone's connection
 *  stays, as in Node's recording where `revokeDevice` ended nothing but the device's downloads). */
async function startRelay(clients) {
  const { WebSocketServer } = createRequire(join(REPO_ROOT, 'apps', 'desktop', 'package.json'))('ws');
  const E2EE = await here('apps/desktop/src/shared/remote-e2ee.ts');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const state = { socket: null, phones: new Map(), legWaiters: [] };
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
  async function openPhone(clientId, credential, pairing) {
    const inbox = [];
    const waiting = [];
    state.phones.set(clientId, {
      arrived(frame) {
        const next = waiting.shift();
        if (next) next(frame);
        else inbox.push(frame);
      },
    });
    const take = () => within(inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve)), `a frame for the phone ${clientId} from the core`);
    state.socket.send(JSON.stringify({ type: 'client-open', clientId, browserClientId: credential }));
    const challenge = JSON.parse((await take()).data);
    const { hello, channel } = await E2EE.createRelayE2EEClientHandshake(pairing, challenge);
    state.socket.send(JSON.stringify({ type: 'frame', clientId, data: JSON.stringify(hello) }));
    const ready = await channel.decryptJson((await take()).data);
    if (ready?.type !== 'e2ee-ready') throw new Error(`the core did not answer the hello with e2ee-ready: ${JSON.stringify(ready)}`);
    let sending = Promise.resolve();
    return {
      async open(_target, sink) {
        let receiving = Promise.resolve();
        void (async () => {
          for (;;) {
            const frame = await new Promise((resolve) => (inbox.length ? resolve(inbox.shift()) : waiting.push(resolve)));
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
    port: server.address().port,
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

/** @returns {Promise<number>} the exit code: 0 when every step is as Node's */
export async function replayDownloads({ exe, recording }) {
  rmSync(WORLDS, { recursive: true, force: true });
  mkdirSync(WORLDS, { recursive: true });
  const clockFile = join(WORLDS, 'download-clock');
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
  const relay = await startRelay(credentials);
  let core = null;
  const clients = [];
  const problems = [];
  const accounted = { calls: 0, held: 0, handles: 0 };
  try {
    core = await startCore(exe, join(WORLDS, 'core'), relay.port, clockFile);
    await relay.leg();
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-files.ts');
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    const { relayE2EEPairingMaterial } = await here('apps/desktop/src/shared/remote-e2ee.ts');
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
    const pairing = relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
    // The desktop: registers projects, starts and deletes conversations, publishes the catalog, unpairs.
    const desktop = await connect(base(createWsConnector(async () => core.endpoint), 'desktop', 'mixdog-replay-desktop'));
    clients.push(desktop);
    const ask = (method, params) => within(desktop.call(method, params), `the core to answer ${method}`);

    for (const [n, { scenario, devices }] of plan.entries()) {
      const label = scenario.name;
      const world = realpathSync.native(mkdtempSync(join(WORLDS, 'w-')));
      for (const folder of ['project', 'task', 'outside']) mkdirSync(join(world, folder), { recursive: true });
      writeFileSync(clockFile, String(recording.clockStart));
      let elapsed = 0;
      await ask('project/create', { opId: opId(), path: join(world, 'project') });
      // A conversation needs a main model on its route (no provider is signed in here): the draft names one, which is never called.
      const route = { provider: 'openai', model: 'gpt-5' };
      // A conversation the recording had published in a catalog before its first call is a row of the core's catalog: a name makes the empty
      // conversation one, as a turn does, and only a listed conversation can be seen gone.
      const publishedFirst = scenario.steps.findIndex((step) => step.op === 'sessions');
      const firstCall = scenario.steps.findIndex((step) => step.op === 'call' || step.op === 'hold');
      const listed = publishedFirst !== -1 && publishedFirst < firstCall;
      const started = async (kind, extra) => {
        const id = (await ask('thread/start', { opId: opId(), kind, draft: { route }, ...extra })).thread.id;
        if (listed) await ask('thread/name/set', { threadId: id, opId: opId(), title: `replay ${id}` });
        return id;
      };
      const conversations = { s1: await started('project', { projectPath: join(world, 'project') }), s2: await started('task', {}) };
      const alive = new Set(['s1', 's2']);
      const sessionOf = (node) => {
        if (Array.isArray(node)) return node.map(sessionOf);
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === 'sessionId' && conversations[value] ? conversations[value] : sessionOf(value)]));
        return node;
      };
      const routers = new Map();
      const gaps = [];
      for (const [device, id] of Object.entries(devices)) {
        // A `connection:*` device is a relay connection the relay named no credential for: its own device (Node's `downloadRequester`).
        const named = device.startsWith('connection') ? '' : id;
        let client;
        try {
          client = await connect(base(await relay.openPhone(`p${n}-${device}`, named, pairing), 'phone', 'mixdog-phone'));
        } catch (error) {
          gaps.push(`${device}: ${error.message}`);
          continue;
        }
        clients.push(client);
        const host = { ctx: { browserId: `p${n}-${device}` }, client: () => client, declareLane() {} };
        routers.set(device, createProtocolRouter([adapter], { host, started: async () => {}, synced: async () => {}, probe() {}, silentSince: () => false }));
      }
      const tokens = new Tokens();
      const unexpected = [...gaps];
      const swapDir = (node) => (typeof node === 'string' ? node.replaceAll('<dir>', world.replaceAll('\\', '/')) : Array.isArray(node) ? node.map(swapDir) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swapDir(v)])) : node);
      const frameOf = async (device, method, params) => {
        try {
          const value = await within(routers.get(device).call(method, sessionOf(swapDir(tokens.resolve(params)))), `the answer to ${method}`);
          return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
        } catch (error) {
          return { ok: false, error: error.message, ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}) };
        }
      };
      const compare = async (step, recorded, index) => {
        if (!routers.has(step.device)) return void unexpected.push(`#${index} ${step.method}: no connection for ${step.device}`);
        const got = await frameOf(step.device, step.method, step.params);
        const { id: _id, ...node } = recorded;
        const found = tokens.differences(node, got);
        accounted.calls += 1;
        if (found.length) unexpected.push(`#${index} ${step.device} ${step.method}: ${found.join('; ')}`);
      };
      const publish = async (ids) => {
        for (const id of [...alive]) {
          if (ids.includes(id)) continue;
          alive.delete(id);
          await ask('thread/delete', { threadId: conversations[id], opId: opId() });
        }
        const listed = await ask('thread/list', {});
        if (process.env.DL_DEBUG) console.log('LIST', listed.data.map((row) => row.id), Object.values(conversations));
      };
      // The relay does not confirm, so the call is refused after the core ended the device's downloads (`unpaired` runs first).
      const unpair = (step) => ask('remoteAccess/revokeClient', { opId: opId(), clientId: plan[n].devices[step.device] }).catch(() => undefined);
      const steps = scenario.steps;
      let index = 0;
      try {
      for (let at = 0; at < steps.length; at += 1) {
        const step = steps[at];
        index = at + 1;
        switch (step.op) {
          case 'write':
            mkdirSync(join(world, step.file, '..'), { recursive: true });
            writeFileSync(join(world, step.file), step.text);
            break;
          case 'append':
            appendFileSync(join(world, step.file), step.text);
            break;
          case 'size':
            truncateSync(join(world, step.file), step.bytes);
            break;
          case 'remove':
            rmSync(join(world, step.file), { force: true });
            break;
          case 'mkdir':
            mkdirSync(join(world, step.file), { recursive: true });
            break;
          case 'advance':
            elapsed += step.ms;
            writeFileSync(clockFile, String(recording.clockStart + elapsed));
            break;
          case 'revokeDevice':
            await unpair(step);
            break;
          case 'revokeAll':
            unexpected.push(`#${index} revokeAll: the core has no event for the relay leg closing or every device being revoked, so a revoke-all ends no download (owner: mixdog-remote RemoteEvents / domain_seams/remote DeviceCleanup, Node remote-relay.ts:643 and :652)`);
            break;
          case 'sessions':
            await publish(step.ids);
            break;
          case 'handles':
            accounted.handles += 1;
            break;
          case 'call':
            await compare(step, step.frame, index);
            break;
          case 'hold': {
            // hold, send, the event, release, answer: a spawned core cannot be held inside a call, so the event happens and the held
            // call's own reply is proved by the workspace crate's transfer::replay; what the event leaves behind is compared here.
            accounted.held += 1;
            const event = steps[at + 2];
            if (event.op === 'revokeDevice') await unpair(event);
            else if (event.op === 'sessions') await publish(event.ids);
            else throw new Error(`${label} #${index}: a held call's event ${event.op}`);
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
      // What the scenario made in the core goes with it, so the next one starts as light as the first.
      for (const id of alive) await desktop.call('thread/delete', { threadId: conversations[id], opId: opId() }).catch(() => undefined);
      await desktop.call('project/delete', { path: join(world, 'project'), opId: opId() }).catch(() => undefined);
      console.log(`file-downloads ${label}: ${steps.length} steps, ${unexpected.length} unexpected`);
      for (const line of unexpected) console.log(`  DIFF ${line}`);
      problems.push(...unexpected.map((line) => `${label} ${line}`));
    }
  } finally {
    for (const client of clients) client.close?.();
    if (core) {
      const gone = new Promise((resolve) => (core.child.exitCode === null ? core.child.once('exit', resolve) : resolve()));
      killTree(core.child);
      await within(gone, 'the core to exit', 30_000);
    }
    relay.close();
    // The database the core started may outlive it a moment: the folder is removed by the next run's start, which clears it first.
    try {
      rmSync(WORLDS, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* removed at the next run's start */
    }
  }
  console.log(`file-downloads replay over ${exe}: ${accounted.calls} calls compared, ${accounted.held} held calls and ${accounted.handles} handle counts proved by the workspace crate's transfer::replay, ${problems.length} unexpected`);
  return problems.length ? 1 : 0;
}
