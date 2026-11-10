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
// phone and with a stalled one. The stall is a barrier on the desktop leg's own socket writes: from before the cause until the
// cause's answer has its place in the desktop's outbound order (the marker sent too), every `write` of the desktop's leg socket is
// held with its completion callback, so the
// producer's write never completes (legacy: `sendRawAndWait` waits on it, remote-e2ee.ts:155, and every later frame waits in the
// E2EE send queue behind it; transport: the coordinator's records wait at the socket and in its queue, coordinator.ts:1083-1172).
// Each stalled run records how many writes were held (`heldAtBarrier`, never 0: a run without one fails). Then the held writes are
// released in order and the phone drains.
//
// Scenarios: a cause whose event Node queues while it handles the call (terminal-dispose, room-rename, thread-favorite); events
// queued after an answer, several of a never-dropped kind in a row (activity-after-answer); successive droppable states while one
// is in flight, with an answer behind them (state-latest-wins).
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
import net from 'node:net';
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
// `listProjects` is the marker (and in two scenarios the cause too): each entry takes the next hook of `projectEntries`, given the
// promise of the host's answer. The marker's entry proves the desktop has handled every frame the phone sent before it.
const projectEntries = [];
// The relay's subscribers of the host's state (remote-relay-session-wiring.ts:193): state-latest-wins publishes through them.
const stateListeners = new Set();
// `handled(name)`: settles with the result (a promise) of the next call of the host method or desktop operation `name`.
const handlers = new Map();
const handled = (name) => new Promise((resolve) => handlers.set(name, [...(handlers.get(name) ?? []), resolve]));
const entering = (name, result) => {
  const waiting = handlers.get(name);
  if (waiting?.length) waiting.shift()(result);
  return result;
};
const host = new Proxy(sessionHost, {
  get(target, prop) {
    if (prop === 'invokeDesktopOperation') return (name, operationArgs) => entering(name, operations.invoke(name, operationArgs));
    if (prop === 'agentRoomAction' || prop === 'setSessionFavorite') return (...rest) => entering(prop, target[prop](...rest));
    if (prop === 'subscribeDesktopEvents') return (listener) => (listeners.add(listener), () => listeners.delete(listener));
    if (prop === 'subscribe')
      return (listener) => {
        stateListeners.add(listener);
        const unsubscribe = target.subscribe(listener);
        return () => (stateListeners.delete(listener), unsubscribe());
      };
    if (prop === 'listProjects')
      return (...rest) => {
        const answered = target.listProjects(...rest);
        projectEntries.shift()?.(answered);
        return answered;
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
  // The desktop's own end of this leg: the socket whose local port is the one the relay sees it from.
  handles[mode].desktopPort = leg._socket.remotePort;
}

// ---- the barrier on the desktop leg's socket writes ---------------------------------------------------------------------------------
// Armed for one leg: each `write` of the desktop's socket of that leg is held (bytes, encoding, completion callback) instead of
// written, so the write the producer waits on does not complete. `release` writes the held calls in their order, then disarms.
const realWrite = net.Socket.prototype.write;
const barrier = {
  port: null,
  held: [],
  onHeld: null,
  arm(port) {
    this.port = port;
    this.held = [];
  },
  /** Settles once the barrier holds a write (at once if it holds one already). */
  holding() {
    return this.held.length ? Promise.resolve() : new Promise((resolve) => (this.onHeld = resolve));
  },
  release() {
    const held = this.held;
    this.port = null;
    this.held = [];
    for (const { socket, args } of held) realWrite.apply(socket, args);
    return held.length;
  },
};
net.Socket.prototype.write = function write(...args) {
  if (barrier.port !== null && this.localPort === barrier.port && this.remotePort === wss.address().port) {
    barrier.held.push({ socket: this, args });
    barrier.onHeld?.();
    barrier.onHeld = null;
    return true;
  }
  return realWrite.apply(this, args);
};

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
// setup(phone, run) runs before the window; cause(phone, state) sends the call whose effects are recorded and answers its id.
/** A terminal tab whose command runs (OSC 697;C from the scripted shell), seen by the phone; its id and its PTY. */
async function runningTab(phone, id) {
  const ensured = await phone.call('termEnsure', [id, join(work, 'workspace')]);
  await phone.answer(ensured);
  const pty = ptys.get(ptys.size - 1);
  pty.data('\x1b]697;C\x07');
  await phone.payload('the running dot', (p) => p?.event === 'termActivity' && p.payload?.id === id && p.payload.state === 'running');
  return { id, pty };
}
/** Settles once `answered` (the host's answer to a `listProjects` entry) has and every microtask after it ran: by then Node has
 *  taken the call's answer's place in its outbound order (remote-relay-client-calls.ts:487,501 → remote-relay-delivery.ts:81-101,
 *  where the coordinator's queue or the E2EE send queue is entered synchronously). `setImmediate` runs after the microtask queue
 *  drained; it is not a timer and no product timer runs (they are on the virtual clock). */
const afterAnswerQueued = (answered) => Promise.resolve(answered).then(() => new Promise((resolve) => setImmediate(resolve)));
const SCENARIOS = {
  'terminal-dispose': {
    what: 'termDispose of a tab whose command is running: its termActivity (null) is published while the call is handled',
    setup: async (phone, run) => (await runningTab(phone, `${INPUTS.terminalId}_${run}`)).id,
    handler: 'termDispose',
    cause: (phone, id) => phone.call('termDispose', [id]),
  },
  'activity-after-answer': {
    what:
      "a call answered (listProjects), then, once its answer has its place, three activity changes of a running tab (finished, running, finished: OSC 697;D;0, C, D;0): never-dropped events queued after an answer, one after another",
    // A tab of its own per window (the tabs stay open).
    setup: async (phone) => runningTab(phone, `${INPUTS.terminalId}_after_${++afterTabs}`),
    cause: async (phone, tab) => {
      const entered = new Promise((resolve) => projectEntries.push(resolve));
      const id = await phone.call('listProjects', []);
      await afterAnswerQueued(await deadline('the cause entering its handler', entered));
      // Published synchronously (terminal-manager.ts:341 → desktop-operations.ts:530-531 → the bus → remote-relay-delivery.ts
      // broadcastEncrypted), before the marker is sent.
      for (const marker of ['\x1b]697;D;0\x07', '\x1b]697;C\x07', '\x1b]697;D;0\x07']) tab.pty.data(marker);
      return id;
    },
  },
  'state-latest-wins': {
    what:
      "three successive host states published to the relay's state lane (remote-relay-session-wiring.ts:104-107), then a call: one state frame in flight, the later ones collapsed to the newest (desktop-service-protocol.ts:57-99), the answer queued behind the first",
    setup: async () => null,
    cause: async (phone) => {
      for (let step = 1; step <= 3; step += 1) {
        const snapshot = { ...sessionHost.getSnapshot(), frameOrderStep: step };
        for (const listener of stateListeners) listener(snapshot);
      }
      const entered = new Promise((resolve) => projectEntries.push(resolve));
      const id = await phone.call('listProjects', []);
      await afterAnswerQueued(await deadline('the cause entering its handler', entered));
      return id;
    },
  },
  'room-rename': {
    what: "agentRoomAction update of the room's name: the room log's catalog row is republished while the call is handled",
    setup: async () => null,
    handler: 'agentRoomAction',
    // Every window renames the room: a new name each time, so each one changes the row.
    cause: (phone) => phone.call('agentRoomAction', ['update', [INPUTS.room.id, { name: `Order room ${++renames}` }]]),
  },
  'thread-favorite': {
    what: "setSessionFavorite of a listed session: its catalog row is republished while the call is handled",
    setup: async () => null,
    handler: 'setSessionFavorite',
    // Every window flips the flag, so each one changes the row.
    cause: (phone) => phone.call('setSessionFavorite', [INPUTS.sessions[0].id, ++favorites % 2 === 1]),
  },
};
let renames = 0;
let favorites = 0;
let afterTabs = 0;

async function window(mode, stalled, name, run) {
  const scenario = SCENARIOS[name];
  const phone = await openPhone(mode);
  const state = await scenario.setup(phone, run);
  const from = phone.payloads.length;
  if (stalled) barrier.arm(handles[mode].desktopPort);
  // The cause's handler, awaited below; a scenario whose cause is a `listProjects` settles it itself.
  const causeHandled = scenario.handler ? handled(scenario.handler) : null;
  const cause = await scenario.cause(phone, state, run);
  projectEntries.push(() => {});
  const marker = await phone.call('listProjects', []);
  // The stall ends once the cause's answer has its place in Node's outbound order (every frame the cause made is queued by then).
  // Not at the marker's entry: Node's call queue runs a read behind a mutation only once the mutation's answer was delivered
  // (remote-relay-client-calls.ts:481-505 awaits sendEncryptedFrame inside the run), which the barrier withholds.
  if (causeHandled) await afterAnswerQueued(await deadline(`${mode} ${name}: the cause's handler`, causeHandled));
  // And the producer is writing: a write of the window is held (the transport's coordinator seals before it writes).
  if (stalled) await deadline(`${mode} ${name}: a write of the desktop leg held at the barrier`, barrier.holding());
  // Nothing of the window has reached the phone while the barrier held (counted before the release, which is synchronous).
  const reachedBeforeRelease = phone.payloads.length - from;
  const writesHeld = stalled ? barrier.release() : null;
  if (stalled && (writesHeld === 0 || reachedBeforeRelease !== 0)) {
    throw new Error(`${mode} ${name} run ${run}: ${writesHeld} writes held, ${reachedBeforeRelease} frames reached the phone before the release`);
  }
  await phone.answer(cause);
  await phone.answer(marker);
  // Everything the cause, the scenario and the marker queued has been sent by the marker's answer, except a state the mailbox
  // still holds behind the one in flight (desktop-service-protocol.ts:57-99): its last publication is awaited too.
  if (name === 'state-latest-wins') await phone.payload('the newest state', (p, at) => at >= from && stateStep(p) === 3);
  const frames = phone.payloads.slice(from);
  closePhone(mode, phone);
  // Stalled: every frame of the window was queued while the desktop's write was withheld (the count of held socket writes is
  // checked, not kept: it depends on how `ws` splits a frame into writes).
  return { cause, marker, ...(stalled ? { queuedBehindBarrier: frames.length, reachedBeforeRelease } : {}), frames };
}

/** The `frameOrderStep` a state frame carries (state-latest-wins), or null. */
const stateStep = (frame) => {
  const text = JSON.stringify(frame?.event === 'state' ? frame.payload : frame?.e === 'S' ? frame.w : null);
  const step = text?.match(/"frameOrderStep":(\d)/);
  return step ? Number(step[1]) : null;
};

// A frame's place in the order: the call it answers, or the event it carries.
const kindOf = (frame, { cause, marker }) => {
  if (frame?.id === cause) return 'answer:cause';
  if (frame?.id === marker) return 'answer:marker';
  if (frame?.event === 'state' || frame?.e === 'S') return `event:state${stateStep(frame) ? `#${stateStep(frame)}` : ''}`;
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
    // Every script that made the bytes: the recorder, the module it imports, and the loader its command line registers.
    scripts: [RECORDER, 'benchmarks/rust-core/recorders/lib/common.mjs', 'benchmarks/rust-core/recorders/lib/ts-register.mjs', 'benchmarks/rust-core/recorders/lib/ts-resolve-hooks.mjs'].map((path) => ({
      path,
      sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex'),
    })),
    nodeVersion: process.version,
    runsPerMode: RUNS,
    causality: {
      'terminal-dispose': 'the activity frame is published inside the call: terminal-manager.ts:536-541 (dispose → TerminalActivity.exit, :541) → terminal-activity.ts:137-155 → desktop-operations.ts:530-531 → the bus → remote-relay-delivery.ts:171-186; the answer is queued only after the handler settled, remote-relay-client-calls.ts:487,501',
      'room-rename': 'the catalog row is republished inside the call: agent-rooms.ts:311-312 → session-host-lifecycle.ts:311 → remote-relay-catalog.ts:89 (never droppable); the answer after the handler, remote-relay-client-calls.ts:487,501',
      'thread-favorite': 'the catalog row is republished inside the call: session-host-lifecycle.ts:311 → remote-relay-catalog.ts:89; the answer after the handler, remote-relay-client-calls.ts:487,501',
    },
    rules: {
      eventBeforeAnswer: 'an event queued while a call is handled is written before its answer: one FIFO per phone, remote-relay-delivery.ts:81-101, coordinator.ts:483,1083-1172 (transport), remote-e2ee.ts:589-639 (legacy); scenarios terminal-dispose, room-rename, thread-favorite',
      eventAfterAnswer: 'an event queued after an answer is written after it: the same FIFO; scenario activity-after-answer',
      neverDroppedUnderCongestion: 'never-dropped events queued behind a withheld write are all written, in order, none merged: termActivity is not droppable (remote-relay-push-lanes.ts:150-152); a non-droppable frame waits in the coordinator queue (coordinator.ts:1097) or the E2EE send queue; scenario activity-after-answer, stalled',
      droppableStateLatestWins: 'one state frame in flight; later publications collapse to the newest and are sent once it is delivered (desktop-service-protocol.ts:57-99, remote-state-lane.ts:18-26), droppable when not critical (remote-relay-client-lifecycle.ts:273-278); scenario state-latest-wins',
      answerWhileStateRecovers:
        "core-only: Node never drops a state lane to recover it from a snapshot, it coalesces (desktop-service-protocol.ts:57-99), so a recovery snapshot has no Node counterpart; the core's rule (an answer does not wait for a lagged lane's recovery snapshot) is tested in mixdog-app-server-transport order::an_answer_does_not_wait_for_a_lagged_lanes_recovery_snapshot. Node's nearest counterpart, an answer passing the newest state held behind the one in flight, is recorded in state-latest-wins",
    },
    stall:
      "stalled: every write of the desktop leg's socket is held with its completion callback from before the cause until the marker's handler is entered, then released in order (heldAtBarrier per run). A backlog of calls ahead of the cause is not used: Node closes a phone with more than 256 inbound calls not yet answered (remote-relay-clients.ts:23,214-218,349-352; a call's frame is released only after its answer was delivered, remote-relay-client-lifecycle.ts:329-339, remote-relay-client-calls.ts:501)",
    replayLeftOut: {
      'core/health/updated': "the core's stall monitor, sent on any connection when its runtime stalls; Node's phone path has no counterpart frame and no cause of this recording makes one",
    },
    desktopLinkNotRecorded:
      "Node's desktop link has no order between an answer and an event: each call is its own HTTP /call answered on its own socket (src/standalone/session-transport/call-route.mjs:118-136), events are SSE frames written at once or, on a stalled stream, merged latest-wins per key (src/standalone/session-frame-stream.mjs:199-291, desktop-service-registry.mjs:31-49).",
  },
});
commitStage(out, finalDir);
rmSync(work, { recursive: true, force: true });
console.log(`frame-order: ${names.length} scenarios x ${MODES.length * 2} modes x ${RUNS} runs`);
process.exit(0);
