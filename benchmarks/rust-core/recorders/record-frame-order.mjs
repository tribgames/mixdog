#!/usr/bin/env node
// The order in which Node's phone path (b6f10295a) writes answers and notifications to one phone, recorded from an exact export: the
// real `startRemoteRelay` (the desktop service's relay leg) against a local `ws` server that plays the relay, over a real `SessionHost`
// and the real desktop operations (`createDesktopOperations`, whose TerminalManager runs a scripted PTY), with a phone that completes
// the real E2EE handshake. Per scenario a cause (a terminal close, a room rename, a favorite) is sent, then a marker call; the phone
// keeps every frame it gets from the cause's send until the marker's answer, whole and in arrival order.
//
// Modes: `transport` (the phone opts into the MXT stream: the coordinator's one outbound queue, coordinator.ts:1083-1172) and `legacy`
// (no transport: the E2EE channel's send queue, remote-e2ee.ts:589-639, then the relay socket). The two order a frame by different code
// (both are reached through `deliverEncryptedFrame`, remote-relay-delivery.ts:81-155), so both are recorded. Each runs with a prompt
// phone and with a stalled one: the relay stops reading the desktop's socket before the cause is sent and reads again only once the
// desktop has entered the marker's handler (every frame the cause produced is queued by then); the phone drains afterwards.
//
// Every run is a fresh phone on the same desktop. The order of a scenario is recorded over `--runs` runs per mode (default 10); where
// runs differ, every distinct order is kept with its count, none is picked.
//
// Time: Node's timers run on a virtual queue (due time, then registration order) that a window never advances, so no product timer
// fires inside a window. Every wait is on an event (a frame the phone decodes, a handler entered) under a deadline naming it.
//
// The Rust replay (replay-frame-order-live.mjs) drives the same causes through a built mixdogd. The desktop's HTTP + SSE link is not
// recorded: Node defines no order there (answers on their own `/call` sockets, call-route.mjs:118-136; events on the SSE stream,
// session-frame-stream.mjs:277-291), as the manifest notes.
//
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-frame-order.mjs --tree <exact export of b6f10295a with node_modules> \
//        --work <scratch dir> [--runs N] [--only <scenario>]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIXTURES_ROOT,
  REPO_ROOT,
  commitStage,
  exactProductIdentity,
  importFrom,
  parseArgs,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-frame-order.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const RUNS = Number(args.get('runs') ?? 10);
const ONLY = args.get('only') ?? null;
const WORK_ROOT = args.get('work');
if (!WORK_ROOT) throw new Error('--work <scratch dir> is required');
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`--runs must be a positive integer, got ${args.get('runs')}`);

// ---- the virtual timer queue -------------------------------------------------------------------------------------------------------
// Installed before the product loads. The recorder's own deadlines (`within`) keep the real timer, taken first.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const clock = { now: 0, seq: 0, timers: new Map() };
const virtualTimer = (repeat) => (fn, ms = 0, ...rest) => {
  const id = ++clock.seq;
  clock.timers.set(id, { due: clock.now + Math.max(0, Number(ms) || 0), fn: () => fn(...rest), repeat: repeat ? Math.max(1, Number(ms) || 0) : 0 });
  return { id, unref() { return this; }, ref() { return this; }, hasRef: () => false, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
};
const cancel = (handle) => {
  if (handle == null) return;
  clock.timers.delete(typeof handle === 'object' ? handle.id : Number(handle));
};
globalThis.setTimeout = virtualTimer(false);
globalThis.setInterval = virtualTimer(true);
globalThis.clearTimeout = cancel;
globalThis.clearInterval = cancel;
/** `promise`, or a rejection naming `label` when it has not settled within `ms` of real time (a failure bound, never a wait the
 *  recording relies on; `within` of lib/common.mjs on the real timer). */
const deadline = async (label, promise, ms = 30_000) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${label}: not done within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    realClearTimeout(timer);
  }
};

// ---- the world: nothing of the signed-in profile is read or written -------------------------------------------------------------------
// One fixed folder under the scratch root (its paths appear in the frames, so two recordings are byte-identical); this recorder's own.
const work = join(WORK_ROOT, 'frame-order-world');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const userData = join(work, 'userData');
for (const [name, dir] of Object.entries({
  APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', HOME: 'home-dir', USERPROFILE: 'home-dir', MIXDOG_DESKTOP_USER_DATA: 'userData',
  MIXDOG_DATA_DIR: 'data', MIXDOG_HOME: 'home', MIXDOG_CONFIG_DIR: 'config', MIXDOG_RUNTIME_ROOT: 'runtime', TEMP: 'tmp', TMP: 'tmp',
})) {
  process.env[name] = join(work, dir);
  mkdirSync(process.env[name], { recursive: true });
}
process.env.MIXDOG_PROJECTS_FILE = join(work, 'projects.json');
process.env.MIXDOG_REMOTE_METER = '0';

// The inputs: the sessions the daemon lists, the room on disk, the terminal the phone opens. Fixed, so every frame is the same each run.
const INPUTS = {
  sessions: [
    { id: 'sess_order_fav', title: 'Order favorite', cwd: join(work, 'workspace'), createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, messageCount: 2 },
    { id: 'sess_room_orderroom', title: 'Order room', cwd: join(work, 'workspace'), createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, messageCount: 0 },
  ],
  room: { id: 'orderroom', name: 'Order room', members: ['lead', 'botorder'], createdAt: 1_700_000_000_000, cursors: {}, running: null },
  terminalId: 'term_order',
};
for (const dir of ['workspace', 'userData/transport', 'userData/legacy']) mkdirSync(join(work, dir), { recursive: true });
writeFileSync(join(userData, 'agent-rooms.json'), JSON.stringify({ rooms: { [INPUTS.room.id]: INPUTS.room } }));

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { TerminalManager } = await main('terminal-manager');
const { SessionHost } = await main('session-host');
const { createDesktopOperations } = await main('desktop-operations');
const { startRemoteRelay } = await main('remote-relay');
const e2ee = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const mxt = await importFrom(tree, 'apps/desktop/src/shared/remote-transport.ts');
const { encodeRelayBinaryFrame, decodeRelayBinaryFrame } = await importFrom(tree, 'apps/relay/lib/relay-binary-frame.mjs');
const store = await importFrom(tree, 'src/runtime/shared/projects.mjs');
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);

// The PTY is scripted where the manager loads node-pty: it prints what the scenario tells it; a kill ends it on the virtual clock (a
// real shell's exit arrives after the kill returns), which a window never reaches.
const ptys = new Map();
TerminalManager.prototype.loadPtyBindings = () =>
  Promise.resolve({
    spawn: () => {
      const pty = { data: () => {}, exit: () => {}, onData: (cb) => (pty.data = cb), onExit: (cb) => (pty.exit = cb), write() {}, resize() {}, pause() {}, resume() {}, kill: () => setTimeout(() => pty.exit({ exitCode: 0 }), 0) };
      ptys.set(ptys.size, pty);
      return pty;
    },
  });

// The daemon behind the host: it lists INPUTS.sessions and answers the control actions the scenarios reach.
const CONTROL = { renameSessionTitle: true, listAgents: [], agentDefinitionPresence: {}, getLeadStatus: { created: true } };
const snapshotOf = (sessionId) => ({ sessionId, revision: 1, items: [], status: 'idle' });
const sessionClient = {
  list: async () => ({ sessions: INPUTS.sessions }),
  create: async (params) => ({ sessionId: params?.sessionId ?? 'sess_control', snapshot: snapshotOf(params?.sessionId ?? 'sess_control') }),
  read: async (params) => ({ snapshot: snapshotOf(params.sessionId), value: CONTROL[params.action] ?? null }),
  configure: async (params) => ({ snapshot: snapshotOf(params.sessionId), value: CONTROL[params.action] ?? null }),
  close: async () => {},
};
const sessionHost = await SessionHost.create(
  { userDataPath: userData, resourcesPath: work, appPath: join(tree, 'apps', 'desktop'), packaged: false },
  {
    attachSessionClient: async () => sessionClient,
    loadProjects: async () => store,
    loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
    loadStatuslineSegments: async () => ({}),
  }
);
// The service's event bus as desktop-service.ts:719-735 builds it: each event to every in-process subscriber, at once.
const listeners = new Set();
const operations = createDesktopOperations({
  userDataPath: userData, packaged: false, resourcesPath: '', appPath: join(tree, 'apps', 'desktop'), loadConfig: async () => ({}),
  emit: ({ name, value }) => {
    for (const listener of listeners) listener({ name, value });
  },
});
// The marker: a host read whose entry proves the desktop has handled every frame the phone sent before it.
let markerEntered = null;
const host = new Proxy(sessionHost, {
  get(target, prop) {
    if (prop === 'invokeDesktopOperation') return (name, operationArgs) => operations.invoke(name, operationArgs);
    if (prop === 'subscribeDesktopEvents') return (listener) => (listeners.add(listener), () => listeners.delete(listener));
    if (prop === 'listProjects')
      return (...rest) => {
        markerEntered?.();
        return target.listProjects(...rest);
      };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

// ---- the relay stand-in ------------------------------------------------------------------------------------------------------------
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await deadline('the relay stand-in listening', new Promise((resolve) => wss.once('listening', resolve)));
let leg = null;
const phones = new Map();
const legWaiters = [];
wss.on('connection', (ws) => {
  leg = ws;
  ws.on('message', (raw, binary) => {
    if (binary) {
      const frame = decodeRelayBinaryFrame(raw);
      if (frame) phones.get(frame.clientId)?.arrived({ binary: true, data: frame.text ? frame.data.toString('utf8') : frame.data });
      return;
    }
    const envelope = JSON.parse(String(raw));
    if (process.env.FRAME_ORDER_DEBUG) console.error('relay <-', envelope.type);
    if (envelope.type === 'list-clients') return ws.send(JSON.stringify({ type: 'clients-list', requestId: envelope.requestId, clients: [] }));
    if (envelope.type === 'frame') phones.get(envelope.clientId)?.arrived({ binary: false, data: envelope.data });
    for (const waiter of [...legWaiters]) if (waiter(envelope)) legWaiters.splice(legWaiters.indexOf(waiter), 1);
  });
});
const MODES = ['transport', 'legacy'];
let relayMode = null;
const relayCaps = (mode) => ({ type: 'relay-capabilities', ...(mode === 'transport' ? { binaryFrames: 1 } : {}), maxFrameBytes: 64 * 1024 * 1024, uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 1_000_000, uplinkTextCeilingBytes: 1_000_000 });
// A peer host that never connects: transport sessions stay on the relay (remote-relay.ts:352-357 offers transport only with one).
const peerHost = { create: () => ({ offer: async () => ({ sdp: '', fingerprints: [] }), answer: async () => {}, candidate: async () => {}, send: () => false, bufferedAmount: () => 0, close: () => {} }) };
const handles = {};
for (const mode of MODES) {
  const legOpen = new Promise((resolve) => legWaiters.push((envelope) => envelope.type === 'set-client-token' && (resolve(), true)));
  relayMode = mode;
  handles[mode] = await startRemoteRelay({
    relayUrl: `ws://127.0.0.1:${wss.address().port}`,
    userDataPath: join(userData, mode),
    host,
    // As desktop-service.ts:1171-1178 wires them.
    terminals: operations.terminals,
    subscribeTerminalData: operations.subscribeTerminalData,
    appVersion: '0.0.0-fixture',
    hostName: () => 'FIXTURE-PC',
    onClientClaim: async () => ({ approved: false }),
    ...(mode === 'transport' ? { transportPeerHost: peerHost } : {}),
  });
  await deadline(`the ${mode} desktop leg registering`, legOpen);
  leg.send(JSON.stringify(relayCaps(mode)));
  handles[mode].leg = leg;
}

// ---- a phone ------------------------------------------------------------------------------------------------------------------------
async function openPhone(mode) {
  const relay = handles[mode].leg;
  const clientId = crypto.randomUUID();
  const inbox = [];
  const waiters = new Set();
  const received = [];
  const phone = { clientId, received, arrived: (frame) => (inbox.push(frame), wake()) };
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  phones.set(clientId, phone);
  const nextRaw = () =>
    new Promise((resolve) => {
      const take = () => {
        if (!inbox.length) return;
        waiters.delete(take);
        resolve(inbox.shift());
      };
      waiters.add(take);
      take();
    });
  relay.send(JSON.stringify({ type: 'client-open', clientId, browserClientId: crypto.randomUUID().replaceAll('-', '') }));
  const challenge = JSON.parse((await deadline(`${mode}: the challenge`, nextRaw())).data);
  const { hello, channel } = await e2ee.createRelayE2EEClientHandshake(handles[mode].pairing, challenge, mode === 'transport' ? { transportWebrtc: true } : {});
  if (mode === 'transport' && hello.transportWebrtc !== 1) throw new Error('the challenge did not offer the transport');
  relay.send(JSON.stringify({ type: 'frame', clientId, data: JSON.stringify(hello) }));
  // Every application payload, in the order the phone opens them.
  const payloads = [];
  const payloadWaiters = new Set();
  const push = (payload) => {
    payloads.push(payload);
    for (const waiter of [...payloadWaiters]) waiter();
  };
  if (mode === 'transport') {
    const receiver = new mxt.RemoteTransportReceiver();
    const assembler = new mxt.RemoteTransportMessageAssembler(new mxt.RemoteTransportAssemblyPool());
    const sender = new mxt.RemoteTransportSender();
    let confirmed = false;
    phone.sendCall = async (payload) => {
      const box = await channel.encryptBinary(payload);
      sender.push(box);
      for (const message of mxt.encodeRemoteTransportRecord(box)) relay.send(encodeRelayBinaryFrame({ clientId, data: message }));
    };
    (async () => {
      for (;;) {
        const raw = await nextRaw();
        const message = mxt.decodeRemoteTransportMessage(raw.data);
        if (message.kind === 'control') continue;
        receiver.accept(message, 0);
        for (let next = receiver.next(); next; next = receiver.next()) {
          const value = await channel.decryptJson(next.box);
          if (!confirmed) {
            channel.confirmHandshake(value);
            confirmed = true;
          }
          receiver.commit(next.sequence, 0);
          const done = assembler.accept(value, 0);
          if (done.state === 'complete') push(done.payload);
        }
      }
    })();
  } else {
    phone.sendCall = async (payload) => relay.send(JSON.stringify({ type: 'frame', clientId, data: await channel.encryptJson(payload) }));
    (async () => {
      for (;;) push(await channel.decryptJson((await nextRaw()).data));
    })();
  }
  phone.payload = (label, match) =>
    deadline(
      `${mode}: ${label}`,
      new Promise((resolve) => {
        const look = () => {
          const at = payloads.findIndex(match);
          if (at < 0) return;
          payloadWaiters.delete(look);
          resolve(payloads[at]);
        };
        payloadWaiters.add(look);
        look();
      })
    );
  phone.payloads = payloads;
  let nextId = 0;
  phone.call = async (method, params) => {
    const id = ++nextId;
    await phone.sendCall({ id, method, params });
    return id;
  };
  phone.answer = (id) => phone.payload(`the answer to call ${id}`, (p) => p?.id === id);
  await phone.payload('e2ee-ready', (p) => p?.type === 'e2ee-ready');
  // The join frames (both rosters, browser-approval sessions) arrive before any window opens.
  await phone.payload('the sessions roster of the join', (p) => p?.event === 'sessions');
  await phone.payload('the agent roster of the join', (p) => p?.event === 'agentPool');
  return phone;
}
const closePhone = (mode, phone) => {
  handles[mode].leg.send(JSON.stringify({ type: 'client-close', clientId: phone.clientId }));
  phones.delete(phone.clientId);
};

// ---- the scenarios ------------------------------------------------------------------------------------------------------------------
// setup(phone) runs before the window; cause(phone, run) is the call whose effects are recorded.
const SCENARIOS = {
  'terminal-dispose': {
    what: 'termDispose of a tab whose command is running: its termActivity (null) is published while the call is handled',
    setup: async (phone, run) => {
      const id = `${INPUTS.terminalId}_${run}`;
      const ensured = await phone.call('termEnsure', [id, join(work, 'workspace')]);
      await phone.answer(ensured);
      // The scripted shell reports a command started (OSC 697;C): the tab's activity is `running`.
      const pty = ptys.get(ptys.size - 1);
      pty.data('\x1b]697;C\x07');
      await phone.payload('the running dot', (p) => p?.event === 'termActivity' && p.payload?.id === id && p.payload.state === 'running');
      return id;
    },
    cause: (phone, id) => phone.call('termDispose', [id]),
  },
  'room-rename': {
    what: "agentRoomAction update of the room's name: the room log's catalog row is republished while the call is handled",
    setup: async () => null,
    // Every window renames the room: a new name each time, so each one changes the row.
    cause: (phone) => phone.call('agentRoomAction', ['update', [INPUTS.room.id, { name: `Order room ${++renames}` }]]),
  },
  'thread-favorite': {
    what: "setSessionFavorite of a listed session: its catalog row is republished while the call is handled",
    setup: async () => null,
    // Every window flips the flag, so each one changes the row.
    cause: (phone) => phone.call('setSessionFavorite', [INPUTS.sessions[0].id, ++favorites % 2 === 1]),
  },
};
let renames = 0;
let favorites = 0;

async function window(mode, stalled, name, run) {
  const scenario = SCENARIOS[name];
  const phone = await openPhone(mode);
  const state = await scenario.setup(phone, run);
  const from = phone.payloads.length;
  const socket = handles[mode].leg._socket;
  if (stalled) socket.pause();
  const entered = new Promise((resolve) => (markerEntered = resolve));
  const cause = await scenario.cause(phone, state, run);
  const marker = await phone.call('listProjects', []);
  await deadline(`${mode} ${name}: the marker's handler entered`, entered);
  markerEntered = null;
  if (stalled) socket.resume();
  await phone.answer(cause);
  await phone.answer(marker);
  const frames = phone.payloads.slice(from);
  closePhone(mode, phone);
  return { cause, marker, frames };
}

// A frame's place in the order: the call it answers, or the event it carries.
const kindOf = (frame, { cause, marker }) => {
  if (frame?.id === cause) return 'answer:cause';
  if (frame?.id === marker) return 'answer:marker';
  if (typeof frame?.event === 'string') return `event:${frame.event}`;
  throw new Error(`a frame that is neither an answer of the window nor an event: ${JSON.stringify(frame)}`);
};

const names = ONLY ? [ONLY] : Object.keys(SCENARIOS);
for (const name of names) if (!SCENARIOS[name]) throw new Error(`no scenario ${name}; one of ${Object.keys(SCENARIOS).join(', ')}`);
const scenarios = {};
for (const name of names) {
  const modes = {};
  for (const mode of MODES) {
    for (const reader of ['prompt', 'stalled']) {
      const runs = [];
      for (let run = 1; run <= RUNS; run += 1) runs.push(await window(mode, reader === 'stalled', name, run));
      const orders = new Map();
      for (const run of runs) {
        const order = run.frames.map((frame) => kindOf(frame, run));
        const key = JSON.stringify(order);
        orders.set(key, { order, runs: (orders.get(key)?.runs ?? 0) + 1 });
      }
      modes[`${mode}/${reader}`] = { orders: [...orders.values()], runs };
    }
  }
  scenarios[name] = { what: SCENARIOS[name].what, modes };
  console.log(`${name}: ${Object.entries(modes).map(([mode, { orders }]) => `${mode} ${orders.map((o) => `${o.order.join('>')} x${o.runs}`).join(' | ')}`).join('; ')}`);
}

for (const mode of MODES) await handles[mode].close();
for (const client of wss.clients) client.terminate();
await deadline('the relay stand-in closing', new Promise((resolve) => wss.close(resolve)));
await sessionHost.dispose();
await operations.dispose();

if (ONLY) {
  await new Promise((done, failed) => process.stdout.write(`${JSON.stringify(scenarios, null, 2)}\n`, (error) => (error ? failed(error) : done())));
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
const finalDir = join(FIXTURES_ROOT, 'frame-order');
const out = stageSet(finalDir);
writeJson(join(out, 'golden.json'), {
  note: "Node's phone path: every frame one phone got from a cause's send to a marker's answer, per scenario, mode and reader, over every run; `orders` is the set of distinct orders with their counts.",
  inputs: { ...INPUTS, runs: RUNS, marker: 'listProjects', modes: MODES, readers: ['prompt', 'stalled'] },
  scenarios,
});
writeSetManifest(out, {
  set: 'frame-order',
  recorder: RECORDER,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${RECORDER} --tree <exact export of ${REF} with node_modules> --work <scratch dir> --runs ${RUNS}`,
  identity,
  extra: {
    recorderSha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, RECORDER))).digest('hex'),
    nodeVersion: process.version,
    runsPerMode: RUNS,
    desktopLinkNotRecorded:
      "Node's desktop link has no order between an answer and an event: each call is its own HTTP /call answered on its own socket (src/standalone/session-transport/call-route.mjs:118-136), events are SSE frames written at once or, on a stalled stream, merged latest-wins per key (src/standalone/session-frame-stream.mjs:199-291, desktop-service-registry.mjs:31-49).",
  },
});
commitStage(out, finalDir);
rmSync(work, { recursive: true, force: true });
console.log(`frame-order: ${names.length} scenarios x ${MODES.length * 2} modes x ${RUNS} runs`);
process.exit(0);
