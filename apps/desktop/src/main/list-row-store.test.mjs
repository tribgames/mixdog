// The daemon → main → renderer chain on row frames, end to end: the daemon's
// own feed (src/standalone/list-row-feed.mjs) behind the service's publisher,
// main's DesktopServiceClient, the window's state bridge and the renderer pool
// store. The oracle is today's whole-list path, handed the list after EVERY
// change; publications arrive in bursts within one task.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

import { createListRowFeed } from '../../../../src/standalone/list-row-feed.mjs';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { agentPoolStore, startAgentPool } from '../renderer/agent-activity-model.ts';
import { DesktopServiceClient } from './desktop-service-client.ts';
import { createGlobalListPublisher } from './global-list-publisher.ts';
import { DesktopStateBridge } from './ipc-state-bridge.ts';
import { registerDesktopIpc } from './ipc.ts';
import { ListRowStore } from './list-row-store.ts';

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Resolves once `ready()` holds, checked now and on each `event` of
 *  `emitter`; rejects naming `what` if it has not held within `ms`. */
function when(emitter, event, ready, what, ms = 5_000) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      emitter.off(event, check);
    };
    const check = () => {
      if (!ready()) return;
      stop();
      resolve();
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what}`));
    }, ms);
    emitter.on(event, check);
    check();
  });
}

/** Resolves with the pool store once its first list has been published. */
function loaded(store) {
  return new Promise((resolve, reject) => {
    if (store.rows !== null) return resolve(store);
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for the pool store to load'));
    }, 5_000);
    const unsubscribe = store.subscribe(() => {
      if (store.rows === null) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(store);
    });
  });
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const row = (id, status, turnStartedAt, extra = {}) => ({
  sessionId: `s${id}`,
  tag: `agent-${id}`,
  status,
  stage: status,
  startedAt: 1_000,
  ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
  ...extra,
});

function mutate(list, random, clock, nextId) {
  const next = list.map((entry) => ({ ...entry }));
  const target = next[Math.floor(random() * next.length)];
  const op = next.length === 0 ? 0 : Math.floor(random() * 9);
  if (op === 0) {
    const id = random() < 0.3 ? Math.floor(random() * nextId.value) : nextId.value++;
    if (!next.some((entry) => entry.sessionId === `s${id}`)) {
      next.splice(Math.floor(random() * (next.length + 1)), 0, row(id, 'running', clock));
    }
  } else if (op === 1) Object.assign(target, { status: 'done', stage: 'done' });
  else if (op === 2) Object.assign(target, { status: 'cancelled', stage: 'cancelled' });
  else if (op === 3) Object.assign(target, { status: 'running', stage: 'running', turnStartedAt: clock - 50_000 });
  else if (op === 4) Object.assign(target, { status: 'running', stage: 'running', turnStartedAt: clock });
  else if (op === 5) next.splice(next.indexOf(target), 1);
  else if (op === 6) next.unshift(...next.splice(next.indexOf(target), 1));
  else if (op === 7) target.toolCalls = (target.toolCalls || 0) + 1;
  return next;
}

/** An independent applier of the wire's frames (array splices), for the oracle. */
function applyFrame(list, frame) {
  const next = list.filter((entry) => entry.sessionId !== frame.id);
  if (frame.removed) return next;
  const at = frame.after === null ? 0 : next.findIndex((entry) => entry.sessionId === frame.after) + 1;
  next.splice(at, 0, structuredClone(frame.row));
  return next;
}

/** The service's transport into main: a client for each epoch, with or without per-client routing. */
class ServiceTransport extends EventEmitter {
  constructor(answer, { open = true } = {}) {
    super();
    this.answer = answer;
    this.requests = [];
    this.autoOpen = open;
    this.opened = false;
    this.exited = false;
  }

  postMessage(message) {
    if (message.kind === 'init') {
      if (this.autoOpen) queueMicrotask(() => this.open());
      return;
    }
    if (message.kind !== 'request') return;
    this.requests.push(message);
    this.emit('request', message);
    void Promise.resolve(this.answer(message, this)).then((value) => {
      if (!this.exited && value !== undefined) this.emit('message', { kind: 'response', id: message.id, ok: true, value });
    });
  }

  open() {
    this.opened = true;
    this.emit('message', { kind: 'ready' });
  }

  /** The connection drops: main restarts at once and dials a new transport. */
  exit() {
    this.exited = true;
    this.emit('exit', 1);
  }

  async close() {}
}

function client(transport) {
  return new DesktopServiceClient({
    connect: typeof transport === 'function' ? transport : () => transport,
    sessionOptions: () => ({
      userDataPath: 'C:/tmp/mixdog',
      packaged: true,
      resourcesPath: 'C:/tmp/resources',
      appPath: 'C:/tmp/resources/app.asar',
    }),
    startupTimeoutMs: 5_000,
    restartBaseDelayMs: 0,
  });
}

const poolFeed = (list) =>
  createListRowFeed(list, list === 'sessions' ? (entry) => entry?.id : (entry) => entry?.sessionId);

/** Service publisher → main client (epoch 2) → bridge → renderer store, and the
 *  oracle store; main can lose its connection and the daemon can restart. */
async function chain(initial, { routed = true } = {}) {
  let daemon = initial;
  let oracleList = [];
  const changeChecks = [];
  const transports = [];
  // While away, a dialled transport stays unopened and nothing reaches main.
  let away = false;
  // Today's path, fed from the daemon's own output and nothing of main's: a
  // whole-list client on main's connection, which receives every list the
  // daemon publishes from the moment the connection is up (subscription), and
  // nothing while it is down — changes while disconnected are lost to it as
  // to main. It has no read at subscription: after a reconnect its first list
  // is the first publication, or, if none comes first, its reconcile read,
  // modelled as landing when the service handles main's read.
  const oracleListeners = new Set();
  const toOracle = () => {
    for (const listener of oracleListeners) listener(structuredClone(oracleList));
  };
  const readEvents = new EventEmitter();
  /** The connection drops; the service releases main's client epoch, as the
   *  registry does when a subscriber leaves (desktop-service-registry.mjs). */
  const drop = (transport) => {
    if (!transport) return;
    transport.exit();
    publisher.releaseClient(2);
  };
  const live = () => transports.findLast((candidate) => candidate.opened && !candidate.exited);
  const makePublisher = () =>
    createGlobalListPublisher({
      emit(message, delivery) {
        if (routed && delivery && ((delivery.to && !delivery.to.includes(2)) || delivery.except?.includes(2))) return;
        const transport = live();
        if (!transport) return;
        transport.emit('message', structuredClone(message));
      },
      listRowFeed: poolFeed,
    });
  /** One publication of the daemon: main gets it as the service routes it;
   *  today's path gets the list itself if the connection is up; then every
   *  check runs (after EVERY publication, inside a burst too). */
  const publishDaemon = (list) => {
    daemon = list;
    publisher.publish('agent-pool', list);
    if (!live()) return;
    oracleList = structuredClone(list);
    for (const check of changeChecks) check(oracleList);
  };
  let publisher = makePublisher();
  // Holding a read: 'answer' — the service handles it on arrival and its
  // answer is delivered late (older than frames sent meanwhile); 'arrival' —
  // the read reaches the service late, so main's subscription is up but the
  // service does not yet know it reads rows.
  let holdReads = false;
  let holdMode = 'answer';
  const heldReads = [];
  const answer = (request, transport) => {
    if (request.method !== 'readListRows') return null;
    const list = request.args[0];
    const arrive = () => {
      if (list === 'agent-pool') {
        oracleList = structuredClone(daemon);
        toOracle();
      }
      return publisher.read(list, 2, async () => daemon).then((value) => structuredClone(value));
    };
    if (!holdReads) return arrive();
    const answered = holdMode === 'answer' ? arrive() : null;
    return new Promise((resolve) => {
      // A read whose connection dropped before it arrived never reaches the service.
      heldReads.push(Object.assign(() => !transport.exited && resolve(answered ?? arrive()), { list }));
      readEvents.emit('held');
    });
  };
  const connect = () => {
    const transport = new ServiceTransport(answer, { open: !away });
    transports.push(transport);
    return transport;
  };
  publishDaemon(initial);
  const main = client(connect);
  const wholeListCalls = [];
  main.subscribeAgentPool((rows) => wholeListCalls.push(rows.map((entry) => entry.sessionId)));
  const handlers = new Map();
  const toRenderer = new Set();
  const rendererMessages = [];
  const bridge = new DesktopStateBridge({
    window: {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        mainFrame: {},
        send(channel, value) {
          if (channel !== DESKTOP_IPC.agentPoolChanged) return;
          rendererMessages.push(value);
          for (const listener of toRenderer) listener(structuredClone(value));
        },
      },
    },
    host: main,
    ipcMain: new EventEmitter(),
    handle: (channel, handler) => handlers.set(channel, handler),
  });
  /** A renderer window (a fresh one on each reload): its pool store over the bridge. */
  const renderer = async () => {
    const store = agentPoolStore({
      subscribeAgentPoolRows(listener) {
        toRenderer.add(listener);
        return () => toRenderer.delete(listener);
      },
      readAgentPoolRows: async () => structuredClone(await handlers.get(DESKTOP_IPC.readAgentPoolRows)({})),
    });
    startAgentPool(store);
    return loaded(store);
  };
  const notified = await renderer();
  oracleList = structuredClone(notified.rows);
  /** Today's whole-list path for a window that starts now: its first list is
   *  what main has delivered, then the whole list after every change. */
  const makeOracle = async () => {
    const store = agentPoolStore({
      subscribeAgentPool(listener) {
        oracleListeners.add(listener);
        return () => oracleListeners.delete(listener);
      },
      listAgentPool: async () => structuredClone(oracleList),
    });
    startAgentPool(store);
    return loaded(store);
  };
  const oracle = await makeOracle();
  /** Every renderer window with its own oracle. */
  const windows = [{ store: notified, oracle }];
  // Today's path: the whole list, after every change.
  changeChecks.push(toOracle);
  return {
    main,
    bridge,
    notified,
    oracle,
    wholeListCalls,
    rendererMessages,
    onChange: (check) => changeChecks.push(check),
    publish: publishDaemon,
    renderer,
    /** A window reloaded now (main connected or not), and today's path for it. */
    async reload() {
      const store = await renderer();
      windows.push({ store, oracle: await makeOracle() });
      return store;
    },
    windows: () => windows,
    /** Main loses the daemon; it redials at once, but nothing answers until `reconnect`. */
    async disconnect() {
      away = true;
      drop(live());
      await settle();
    },
    /** The daemon restarts while main is away: a new feed (epoch) holding `list`. */
    restartDaemon(list) {
      publisher = makePublisher();
      publishDaemon(list);
    },
    /** The redialled transport answers; main re-reads (today's path subscribes with that read). */
    async reconnect() {
      away = false;
      transports.findLast((candidate) => !candidate.exited).open();
      await main.readAgentPoolRowList();
      await settle();
    },
    holdReads(value, { reverse = false, mode = 'answer' } = {}) {
      holdReads = value;
      holdMode = mode;
      if (value) return;
      const released = heldReads.splice(0);
      for (const release of reverse ? released.reverse() : released) release();
    },
    /** The redialled transport answers, without waiting for main's read. */
    openAway() {
      away = false;
      transports.findLast((candidate) => !candidate.exited).open();
    },
    /** Main's reads have landed. */
    async settleRead() {
      await main.readAgentPoolRowList();
      await settle();
    },
    heldReadCount: () => heldReads.length,
    heldPoolReads: () => heldReads.filter((release) => release.list === 'agent-pool').length,
    /** Resolves once `count` pool reads are held (each read arrives as its own event). */
    poolReadsHeld: (count) =>
      when(readEvents, 'held', () => heldReads.filter((release) => release.list === 'agent-pool').length >= count, `${count} held pool read(s)`),
    exitLive: () => drop(live()),
    openLatest: () => transports.findLast((candidate) => !candidate.exited).open(),
    daemonList: () => daemon,
    async dispose() {
      bridge.dispose();
      await main.dispose();
    },
  };
}

test('1,000 random burst histories: every change reaches the reducers, as on the whole-list path after each one', async () => {
  for (let sequence = 0; sequence < 1_000; sequence += 1) {
    const random = mulberry32(sequence + 11);
    const nextId = { value: 0 };
    let list = [];
    for (let count = Math.floor(random() * 5); count > 0; count -= 1) list = mutate(list, random, 0, nextId);
    const f = await chain(list);
    let changes = 0;
    f.onChange(() => {
      changes += 1;
      assert.deepEqual(f.notified.rows, f.oracle.rows, `seed ${sequence + 11}, change ${changes}`);
    });
    const expectedWhole = [];
    for (let tick = 1; tick <= 1 + Math.floor(random() * 6); tick += 1) {
      // Several publications in one task: same rows and different rows.
      for (let burst = 1 + Math.floor(random() * 5); burst > 0; burst -= 1) {
        list = mutate(list, random, tick * 1_000 + burst, nextId);
        f.publish(list);
        expectedWhole.push(list.map((entry) => entry.sessionId));
      }
      await settle();
    }
    // The whole-list consumers in main: once per publication, at its boundary.
    assert.deepEqual(f.wholeListCalls.slice(-expectedWhole.length), expectedWhole, `seed ${sequence + 11}`);
    await f.dispose();
  }
});

test("the review's counter-example and an add-then-remove inside one task reach the reducers one by one", async () => {
  const f = await chain([row(1, 'done', 1_000)]);
  const seen = [];
  f.onChange(() => {
    seen.push(f.notified.rows.map((entry) => `${entry.sessionId}:${entry.status}:${entry.turnStartedAt ?? ''}`));
    assert.deepEqual(f.notified.rows, f.oracle.rows);
  });
  f.publish([row(1, 'running', 2_000)]);
  f.publish([row(1, 'running', 1_500)]);
  f.publish([row(1, 'running', 1_500), row(2, 'running', 3_000)]);
  f.publish([row(1, 'running', 1_500)]);
  assert.deepEqual(seen, [
    ['s1:running:2000'],
    ['s1:running:2000'],
    ['s1:running:2000', 's2:running:3000'],
    ['s1:running:2000'],
  ]);
  assert.deepEqual(
    f.rendererMessages.map(({ changes }) => changes.map((change) => (change.removed ? `-${change.id}` : `+${change.id}`))),
    [['+s1'], ['+s1'], ['+s2'], ['-s2']]
  );
  await f.dispose();
});

test('an older-style client and a row client on one service both keep the list, routed or not', async () => {
  for (const routed of [true, false]) {
    let daemon = [row(1, 'running', 1_000)];
    const oldClientMessages = [];
    let rowTransport;
    const publisher = createGlobalListPublisher({
      emit(message, delivery) {
        const reaches = (epoch) =>
          !routed || !delivery || ((!delivery.to || delivery.to.includes(epoch)) && !delivery.except?.includes(epoch));
        if (reaches(1)) oldClientMessages.push(structuredClone(message));
        if (reaches(2)) rowTransport.emit('message', structuredClone(message));
      },
      listRowFeed: (list) => createListRowFeed(list, (entry) => entry?.sessionId ?? entry?.id),
    });
    rowTransport = new ServiceTransport(async (request) =>
      request.method === 'readListRows' ? structuredClone(await publisher.read(request.args[0], 2, async () => daemon)) : null
    );
    publisher.publish('agent-pool', daemon);
    const rowClient = client(rowTransport);
    const rowWholeLists = [];
    rowClient.subscribeAgentPool((rows) => rowWholeLists.push(rows.map((entry) => entry.sessionId)));
    await rowClient.readAgentPoolRowList();
    const lists = [
      [row(1, 'done', 1_000), row(2, 'running', 2_000)],
      [row(2, 'running', 2_000)],
      [row(3, 'queued', 3_000), row(2, 'cancelled', 2_000)],
    ];
    for (const next of lists) {
      daemon = next;
      publisher.publish('agent-pool', next);
    }
    // The older client gets exactly today's whole-list messages, one per publication.
    const wholeLists = oldClientMessages.filter((message) => message.kind === 'agent-pool');
    assert.deepEqual(wholeLists.map((message) => message.agents), [[row(1, 'running', 1_000)], ...lists]);
    if (routed) assert.equal(oldClientMessages.length, wholeLists.length, 'no frames for the older client');
    // The row client keeps the list from frames and tells its consumers once per publication.
    assert.deepEqual(await rowClient.listAgentPool(), lists.at(-1));
    assert.deepEqual(rowWholeLists.slice(-3), lists.map((next) => next.map((entry) => entry.sessionId)));
    await rowClient.dispose();
  }
});

test('a read before any publication never overwrites a newer one, and two racing reads share one host read', async () => {
  let hostReads = 0;
  let finishHostRead;
  const emitted = [];
  const publisher = createGlobalListPublisher({
    emit: (message) => emitted.push(message),
    listRowFeed: (list) => createListRowFeed(list, (entry) => entry?.id),
  });
  const readHost = () => {
    hostReads += 1;
    return new Promise((resolve) => (finishHostRead = resolve));
  };
  const first = publisher.read('sessions', 1, readHost);
  const second = publisher.read('sessions', 2, readHost);
  publisher.publish('sessions', [{ id: 'newer' }]);
  finishHostRead([{ id: 'older' }]);
  const answers = await Promise.all([first, second]);
  assert.equal(hostReads, 1);
  for (const answer of answers) assert.deepEqual(answer.rows, [{ id: 'newer' }]);
  assert.equal(emitted.filter((message) => message.kind === 'sessions').length, 1, 'the older read was not published');
});

test('an answer older than what the store holds is dropped; held frames above it still apply', async () => {
  const answers = [];
  const changes = [];
  const store = new ListRowStore({
    read: () => new Promise((resolve) => answers.push(resolve)),
    onChange: (change) => changes.push(change.id),
    onPublication: () => {},
  });
  const frame = (seq, id) => ({ list: 'sessions', epoch: 'e', seq, change: { id, after: null, row: { id } } });
  const load = store.currentList();
  answers.shift()({ epoch: 'e', seq: 2, ids: ['a'], rows: [{ id: 'a' }] });
  await load;
  store.receive(frame(3, 'b'));
  store.receive(frame(4, 'c'));
  const stale = store.resync();
  store.receive(frame(5, 'd'));
  answers.shift()({ epoch: 'e', seq: 3, ids: ['b', 'a'], rows: [{ id: 'b' }, { id: 'a' }] });
  assert.deepEqual((await stale).ids, ['d', 'c', 'b', 'a']);
  assert.deepEqual(changes, ['a', 'b', 'c', 'd']);
});

for (const olderFirst of [false, true]) {
test(`frames an answer covers reach the reducers one by one: done(1000) → running(2000) → running(1500) keeps origin 2000${
  olderFirst ? ' (an older frame held first is skipped, not a stop)' : ''
}`, async () => {
  const answers = [];
  // The renderer pool store, handed the list after every change main delivers.
  let list = [];
  const listeners = new Set();
  const store = agentPoolStore({
    subscribeAgentPool(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listAgentPool: async () => structuredClone(list),
  });
  const rows = new ListRowStore({
    read: () => new Promise((resolve) => answers.push(resolve)),
    onChange(change) {
      list = applyFrame(list, change);
      for (const listener of listeners) listener(structuredClone(list));
    },
    onPublication: () => {},
  });
  const frame = (seq, value) => ({ list: 'agent-pool', epoch: 'e', seq, change: { id: 's1', after: null, row: value } });
  const load = rows.currentList();
  answers.shift()({ epoch: 'e', seq: 1, ids: ['s1'], rows: [row(1, 'done', 1_000)] });
  await load;
  startAgentPool(store);
  await loaded(store);
  // A reconnect: the read is in flight while both changes arrive, and its
  // answer already contains them.
  rows.disconnect();
  rows.reconnected();
  // A frame downstream already holds (seq 1), redelivered ahead of the new ones.
  if (olderFirst) rows.receive(frame(1, row(1, 'done', 1_000)));
  rows.receive(frame(2, row(1, 'running', 2_000)));
  rows.receive(frame(3, row(1, 'running', 1_500)));
  answers.shift()({ epoch: 'e', seq: 3, ids: ['s1'], rows: [row(1, 'running', 1_500)] });
  await rows.currentList();
  assert.equal(store.rows[0].status, 'running');
  assert.equal(store.rows[0].turnStartedAt, 2_000);
});
}

test('a cancel and a stale "running" published after the subscription resumes, before the service handles the read, reach the reducers', async () => {
  const f = await chain([row(1, 'running', 1_000), row(2, 'running', 1_000)]);
  await f.disconnect();
  // Main's connection is up again; its read has not reached the service, so
  // the service sends it whole lists.
  f.holdReads(true, { mode: 'arrival' });
  f.openAway();
  await f.poolReadsHeld(1);
  f.publish([row(1, 'cancelled', 1_000), row(2, 'running', 1_000)]);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  f.publish([row(1, 'running', 1_000), row(2, 'running', 1_000)]);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  f.holdReads(false);
  await f.settleRead();
  // The ledger holds the stale report at cancelled, on both paths.
  assert.deepEqual(
    f.notified.rows.map((entry) => `${entry.sessionId}:${entry.status}`),
    ['s1:cancelled', 's2:running']
  );
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  // Then row frames continue from the answer.
  f.publish([row(1, 'done', 1_000), row(2, 'running', 1_000)]);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  await f.dispose();
});

// The real preload bridge, bundled as the window loads it, with `electron` supplied by the test.
const preloadBundle = await build({
  entryPoints: [fileURLToPath(new URL('../preload/index.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

/** One window: the real preload over ONE ordered main → renderer channel that
 *  carries both `webContents.send` messages and invoke replies, in the order
 *  main produced them (or a chosen order, for what Electron does not promise).
 *  Each delivery is its own task, as an IPC message is. */
function windowOverPipe(handlers, webContents) {
  const queue = [];
  const events = new EventEmitter();
  const enqueue = (entry) => {
    queue.push(entry);
    events.emit('queued');
  };
  const ipc = new EventEmitter();
  ipc.send = () => {};
  ipc.invoke = (channel, ...args) =>
    new Promise((resolve, reject) => {
      Promise.resolve()
        .then(() => handlers.get(channel)({ sender: webContents, senderFrame: webContents.mainFrame }, ...structuredClone(args)))
        .then(
          (value) => enqueue({ what: `reply ${channel}`, deliver: () => resolve(structuredClone(value)) }),
          (error) => enqueue({ what: `reply ${channel}`, deliver: () => reject(error) })
        );
    });
  webContents.send = (channel, value) =>
    enqueue({ what: `${channel} ${value.seq}`, deliver: () => ipc.emit(channel, {}, structuredClone(value)) });
  let api;
  runInNewContext(preloadBundle.outputFiles[0].text, {
    process: { argv: [], env: {} },
    window: { addEventListener() {} },
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: { exposeInMainWorld: (_name, value) => (api = value) },
      sharedTexture: { setSharedTextureReceiver() {} },
      webUtils: {},
    }),
  });
  return {
    api,
    queued: () => queue.map((entry) => entry.what),
    /** Resolves once the queue satisfies `ready` (checked as each message is queued). */
    queuedWhen: (ready, what) => when(events, 'queued', () => ready(queue.map((entry) => entry.what)), what),
    /** Delivers everything queued, as sent or in `order` (indexes into the queue). */
    async deliver(order) {
      const batch = queue.splice(0);
      for (const index of order ?? batch.keys()) {
        batch[index].deliver();
        await settle();
      }
    },
  };
}

/** A service, main's client and its window registration (registerDesktopIpc). */
function wiredWindow(t, initial) {
  const transport = new ServiceTransport(() => undefined);
  const publisher = createGlobalListPublisher({
    emit: (message) => transport.emit('message', structuredClone(message)),
    listRowFeed: poolFeed,
  });
  publisher.publish('agent-pool', initial);
  transport.answer = (request) =>
    request.method === 'readListRows'
      ? publisher.read(request.args[0], 2, async () => initial).then((answer) => structuredClone(answer))
      : undefined;
  const main = client(transport);
  const handlers = new Map();
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  });
  const webContents = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send() {} });
  const remove = registerDesktopIpc({ webContents, isDestroyed: () => false }, main, {
    app: { quit() {} },
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder() {}, trashItem: async () => {} },
  });
  t.after(async () => {
    remove();
    await main.dispose();
  });
  return { transport, publisher, handlers, webContents };
}

/** The renderer pool store over the preload, loaded through the pipe. */
async function rendererStore(window) {
  const store = agentPoolStore(window.api);
  startAgentPool(store);
  await window.queuedWhen((queued) => queued.some((what) => what.startsWith('reply')), 'the pool read reply');
  await window.deliver();
  return loaded(store);
}

test('the renderer sees a change the service sent before a reply before that reply, over one ordered channel', async (t) => {
  const w = wiredWindow(t, [row(1, 'running', 1_000)]);
  const window = windowOverPipe(w.handlers, w.webContents);
  const store = await rendererStore(window);
  // What the renderer-side code observes, in the order it runs.
  const seen = [];
  store.subscribe(() => seen.push(`pool ${store.rows.map((entry) => entry.status).join(',')}`));
  const reply = window.api.getQuotaAutoResume().then((value) => seen.push(`reply ${value}`));
  const isQuota = (request) => request.method === 'getQuotaAutoResume';
  await when(w.transport, 'request', () => w.transport.requests.some(isQuota), 'the quota request at the service');
  const pending = w.transport.requests.find(isQuota);
  // The service publishes, then answers: in that order on the wire, in one task.
  w.publisher.publish('agent-pool', [row(1, 'done', 1_000)]);
  w.transport.emit('message', { kind: 'response', id: pending.id, ok: true, value: true });
  await window.queuedWhen((queued) => queued.length === 2, 'the change and the reply in the pipe');
  await window.deliver();
  await reply;
  assert.deepEqual(seen, ['pool done', 'reply true']);
});

// Electron documents no order between a `webContents.send` message and an
// invoke reply (messages sent on one webContents keep theirs). The one reply a row change depends on is the list read; it
// carries the seq it covers, so the renderer is right in either arrival order.
// The history makes a double application and a lost change both visible in
// the reducers' state: s1 is cancelled, then reported running again with the
// same turn (a stale report the cancellation ledger holds at cancelled). A
// window that read after both shows s1 running (its history starts at the
// read); re-applying the covered changes after the read would show it
// cancelled. A window that read before both shows it cancelled; losing the
// cancel would show it running.
for (const mainOrder of ['change, then read', 'read, then change']) {
  for (const arrival of ['as sent', 'reversed']) {
    test(`a reloading window reads the pool while changes are in flight (${mainOrder}; ${arrival}): each applied exactly once`, async (t) => {
      const w = wiredWindow(t, [row(1, 'running', 1_000), row(2, 'running', 1_000)]);
      await rendererStore(windowOverPipe(w.handlers, w.webContents));
      // The window reloads: a fresh preload and store on the same webContents.
      const window = windowOverPipe(w.handlers, w.webContents);
      const store = agentPoolStore(window.api);
      const changes = () => {
        w.publisher.publish('agent-pool', [row(1, 'cancelled', 1_000), row(2, 'running', 1_000)]);
        w.publisher.publish('agent-pool', [row(1, 'running', 1_000), row(2, 'running', 1_000)]);
      };
      if (mainOrder === 'change, then read') changes();
      startAgentPool(store);
      await window.queuedWhen((queued) => queued.some((what) => what.startsWith('reply')), 'the pool read reply');
      if (mainOrder === 'read, then change') changes();
      const queued = window.queued();
      assert.equal(queued.length, 3, queued.join(' | '));
      // Messages on one channel keep their order; only the reply moves to the
      // other side of them.
      const reply = queued.findIndex((what) => what.startsWith('reply'));
      const frames = [0, 1, 2].filter((index) => index !== reply);
      const replyFirst = (reply === 0) === (arrival === 'as sent');
      await window.deliver(replyFirst ? [reply, ...frames] : [...frames, reply]);
      assert.deepEqual(
        store.rows.map((entry) => `${entry.sessionId}:${entry.status}`),
        [mainOrder === 'change, then read' ? 's1:running' : 's1:cancelled', 's2:running']
      );
    });
  }
}

test('a daemon that comes back with fewer, no or reordered rows is followed downstream, removals included', async () => {
  const ids = (rows) => rows.map((entry) => entry.sessionId);
  const f = await chain([row(1, 'running', 1_000), row(2, 'running', 1_000), row(3, 'done', 1_000)]);
  // The review's probe: downstream holds rows; the daemon restarts empty.
  await f.disconnect();
  f.restartDaemon([]);
  await f.reconnect();
  assert.deepEqual(ids(f.notified.rows), []);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  f.publish([row(1, 'running', 2_000), row(2, 'running', 2_000), row(3, 'running', 2_000)]);
  // Same daemon, changes lost while away: reordered and fewer.
  await f.disconnect();
  f.publish([row(3, 'running', 2_000), row(1, 'done', 2_000)]);
  await f.reconnect();
  assert.deepEqual(ids(f.notified.rows), ['s3', 's1']);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  await f.disconnect();
  f.restartDaemon([row(2, 'queued', 4_000)]);
  await f.reconnect();
  assert.deepEqual(ids(f.notified.rows), ['s2']);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  await f.dispose();
});

test('a reconnect while a read is in flight and two reconnects in a row end on the daemon list', async () => {
  const ids = (rows) => rows.map((entry) => entry.sessionId);
  const f = await chain([row(1, 'running', 1_000), row(2, 'running', 1_000)]);
  await f.disconnect();
  f.restartDaemon([row(3, 'running', 3_000)]);
  f.holdReads(true);
  f.openLatest();
  await f.poolReadsHeld(1);
  // The read is in flight on this connection when it drops.
  f.exitLive();
  await settle();
  f.restartDaemon([row(4, 'running', 4_000), row(2, 'done', 4_000)]);
  f.holdReads(false);
  await f.reconnect();
  assert.deepEqual(ids(f.notified.rows), ['s4', 's2']);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  // Two reconnects back to back, the daemon changing in between.
  await f.disconnect();
  f.openLatest();
  f.exitLive();
  await settle();
  f.restartDaemon([row(5, 'queued', 5_000)]);
  await f.reconnect();
  assert.deepEqual(ids(f.notified.rows), ['s5']);
  assert.deepEqual(f.notified.rows, f.oracle.rows);
  await f.dispose();
});

test('a renderer reloaded while main is disconnected starts from what main delivered and follows the reconnect', async () => {
  const f = await chain([row(1, 'running', 1_000), row(2, 'running', 1_000)]);
  await f.disconnect();
  const reloaded = await f.renderer();
  assert.deepEqual(reloaded.rows, f.notified.rows);
  f.restartDaemon([row(2, 'cancelled', 1_000)]);
  await f.reconnect();
  for (const store of [f.notified, reloaded]) {
    assert.deepEqual(
      store.rows.map((entry) => entry.sessionId),
      ['s2']
    );
  }
  assert.deepEqual(reloaded.rows, f.oracle.rows);
  await f.dispose();
});

test('300 random histories with disconnects, changes between the subscription resuming and the read, reloads and stale or overlapping reads match the whole-list path after every step', async () => {
  for (let sequence = 0; sequence < 300; sequence += 1) {
    const seed = sequence + 101;
    const random = mulberry32(seed);
    const nextId = { value: 0 };
    let list = [];
    for (let count = Math.floor(random() * 5); count > 0; count -= 1) list = mutate(list, random, 0, nextId);
    const f = await chain(list);
    const compare = (label) => {
      for (const [index, window] of f.windows().entries()) {
        assert.deepEqual(window.store.rows, window.oracle.rows, `seed ${seed}, ${label}, window ${index}`);
        assert.deepEqual(
          window.store.rows.map((entry) => entry.sessionId),
          f.daemonList().map((entry) => entry.sessionId),
          `seed ${seed}, ${label}, window ${index}: downstream follows the daemon`
        );
      }
    };
    // Per change, while main is current (a read in flight holds frames back
    // from main but not from today's path: compared once the read lands).
    let readInFlight = false;
    let changes = 0;
    f.onChange(() => {
      changes += 1;
      if (readInFlight) return;
      for (const [index, window] of f.windows().entries()) {
        assert.deepEqual(window.store.rows, window.oracle.rows, `seed ${seed}, change ${changes}, window ${index}`);
      }
    });
    for (let step = 1; step <= 1 + Math.floor(random() * 12); step += 1) {
      const event = random();
      if (event < 0.25) {
        // Away: the daemon changes or restarts, a window may reload meanwhile.
        await f.disconnect();
        for (let away = Math.floor(random() * 4); away > 0; away -= 1) {
          list = mutate(list, random, step * 1_000 + away, nextId);
          if (random() < 0.3) f.restartDaemon(list);
          else f.publish(list);
        }
        if (random() < 0.2) {
          list = [];
          f.restartDaemon(list);
        }
        if (random() < 0.4) await f.reload();
        await f.reconnect();
      } else if (event < 0.4) {
        // The subscription resumes before the service handles main's read:
        // what is published meanwhile reaches main as whole lists, compared
        // after each publication; a window may reload meanwhile.
        await f.disconnect();
        for (let away = Math.floor(random() * 3); away > 0; away -= 1) {
          list = mutate(list, random, step * 1_000 + away, nextId);
          if (random() < 0.3) f.restartDaemon(list);
          else f.publish(list);
        }
        f.holdReads(true, { mode: 'arrival' });
        f.openAway();
        await f.poolReadsHeld(1);
        for (let during = Math.floor(random() * 4); during > 0; during -= 1) {
          list = mutate(list, random, step * 1_000 + 10 + during, nextId);
          f.publish(list);
          if (random() < 0.2) await f.reload();
        }
        f.holdReads(false);
        await f.settleRead();
      } else if (event < 0.55) {
        // A stale read: answered at request, delivered after newer frames.
        // Sometimes overlapped: that connection drops with its read still
        // held and a second one reads; the answers land in either order, and
        // a later read may cover frames main already holds.
        await f.disconnect();
        f.holdReads(true);
        readInFlight = true;
        f.openAway();
        await f.poolReadsHeld(1);
        const overlap = random() < 0.5;
        if (random() < 0.5) {
          list = mutate(list, random, step * 1_000 + 9, nextId);
          f.publish(list);
        }
        if (overlap) {
          f.exitLive();
          await settle();
          f.openAway();
          await f.poolReadsHeld(2);
        }
        for (let during = 1 + Math.floor(random() * 3); during > 0; during -= 1) {
          list = mutate(list, random, step * 1_000 + during, nextId);
          f.publish(list);
        }
        f.holdReads(false, { reverse: overlap && random() < 0.5 });
        await f.settleRead();
        readInFlight = false;
      } else {
        list = mutate(list, random, step * 1_000, nextId);
        f.publish(list);
        await settle();
      }
      compare(`step ${step}`);
    }
    await f.dispose();
  }
});
