import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { beginEdit, BrowserGuestStateStore } from '../../browser/host-state.ts';
import { BrowserSessionRegistry } from '../../browser/session-registry.ts';
import { createBrowserTaskLifecycle } from '../../browser/task-lifecycle.ts';
import { createBrowserCommandHost } from '../browser-command.ts';
import {
  createBrowserEngine,
  ENGINE_NOTIFICATION_METHODS,
  ENGINE_REQUEST_METHODS,
  serveBrowserEngine,
} from './index.ts';
import { createInterceptTable } from './session.ts';

function harness() {
  const requests = new Map();
  const notifications = new Map();
  const sent = [];
  const closers = [];
  const connection = {
    request: async () => ({}),
    notify: (method, params) => sent.push([method, params]),
    sendBinary: () => {},
    handleRequest: (method, handler) => requests.set(method, handler),
    handleNotification: (method, handler) => notifications.set(method, handler),
    servedMethods: () => [...requests.keys(), ...notifications.keys()].sort(),
    onClose: (listener) => closers.push(listener),
  };
  let bound = null;
  let unbound = 0;
  const guests = [];
  const state = {
    onChange: () => () => {},
    pageId: (guest) => guest.pageId,
    for: (guest) => ({ pageId: guest.pageId }),
    slot: () => ({}),
    redactText: (_guest, text) => text,
  };
  const ports = {
    base: {
      state,
      sessions: {
        visibleGuests: () => guests,
        allBackgroundEntries: () => [],
        backgroundPages: () => new Map(),
        sessionIdForGuest: () => undefined,
      },
      cdp: {},
      display: { isShown: () => true },
      documents: { collect: Object.assign(async () => [], { byFrame: async () => [] }) },
      urls: { validatedAgentUrl: async (raw) => raw },
      urlPolicy: {},
      partition: { session: {}, downloadLedger: { downloadsForSession: () => [] } },
      engineIntercept: createInterceptTable(),
      engineLane: {
        bind: (binding) => {
          bound = binding;
          return () => {
            unbound += 1;
          };
        },
      },
    },
    tools: {
      dialogs: { handleDialog: async () => ({}) },
      input: {},
      snapshots: {},
      screenshots: {},
      refPoints: {},
    },
    lifecycle: {},
    tabs: {},
    taskLifecycle: {},
    signIn: {},
    emulation: {},
    traceDirectory: () => '/traces',
    processMemoryMb: () => undefined,
  };
  return {
    connection,
    requests,
    notifications,
    sent,
    closers,
    ports,
    guests,
    bound: () => bound,
    unbound: () => unbound,
  };
}

test('a lane registers exactly the methods the connection is told to serve', () => {
  const h = harness();
  const engine = createBrowserEngine(h.connection, h.ports);
  assert.deepEqual([...engine.requests.keys()].sort(), [...ENGINE_REQUEST_METHODS].sort());
  assert.deepEqual([...engine.notifications.keys()], [...ENGINE_NOTIFICATION_METHODS]);
  assert.deepEqual([...h.requests.keys()], []);
  assert.ok(h.bound(), 'the browser holds the lane');
});

test('every method is served before the browser exists, and the lane is built by the first call', async () => {
  const h = harness();
  let built = 0;
  const served = serveBrowserEngine(h.connection, () => {
    built += 1;
    return h.ports;
  });
  assert.deepEqual(h.connection.servedMethods(), [...ENGINE_REQUEST_METHODS, ...ENGINE_NOTIFICATION_METHODS].sort());
  assert.equal(built, 0);
  assert.equal(served.engineMode(), false);
  assert.equal(h.bound(), null);
  await assert.rejects(h.requests.get('host/browser/snapshot')({ pageId: 'p9' }, new AbortController().signal));
  assert.equal(built, 1);
  assert.equal(served.engineMode(), true);
  assert.equal(h.bound().sink.active(), true);
  assert.equal(h.bound().ctx.isEngineMode(), true);
});

test('the lane ends with the link and a new link starts a new one', async () => {
  const h = harness();
  const served = serveBrowserEngine(h.connection, () => h.ports);
  const call = () =>
    h.requests
      .get('host/browser/snapshot')({ pageId: 'p9' }, new AbortController().signal)
      .catch(() => {});
  await call();
  const first = h.bound();
  for (const close of h.closers) close();
  assert.equal(h.unbound(), 1);
  assert.equal(served.engineMode(), false);
  await call();
  assert.notEqual(h.bound(), first);
  assert.equal(served.engineMode(), true);
});

test("a core link's live turn ends when the link closes, and the next link's turn 1 is live again", async () => {
  const sessions = new BrowserSessionRegistry();
  const tasks = createBrowserTaskLifecycle({
    close() {},
    canClose: () => true,
    turnFinished: (sessionId, turn) => sessions.finishTurn(sessionId, turn),
    turnForgotten: (sessionId) => sessions.forgetTurn(sessionId),
  });
  const store = new BrowserGuestStateStore();
  const filled = {};
  beginEdit(store.for(filled), 'agentEdits')();
  const held = () => store.holdsUnfinishedWork(filled, sessions.turnLive('s1'));
  const signIn = {
    beginTurn: (sessionId, turn) => sessions.beginTurn(sessionId, turn),
    finishTurn: (sessionId, turn, aborted) => tasks.finish(sessionId, turn, { aborted }),
    forget: (sessionId) => tasks.forget(sessionId),
    endTurns: (sessionId) => {
      sessions.endLinkTurns(sessionId);
      tasks.renumber(sessionId);
    },
  };
  const link = () => {
    const h = harness();
    serveBrowserEngine(h.connection, () => ({ ...h.ports, signIn }));
    const turn = (params) =>
      h.requests.get('host/browser/turn')({ sessionId: 's1', ...params }, new AbortController().signal);
    return { turn, close: () => h.closers.forEach((close) => close()) };
  };

  const first = link();
  await first.turn({ op: 'begin', turn: 7 });
  assert.equal(held(), true, 'the agent waits on the user with its form filled');
  // The core goes away (an update, a crash) in the middle of the turn.
  first.close();
  assert.equal(held(), false, 'the turn ended with the link that told it');
  assert.equal(typeof sessions.turnFinishedAt('s1'), 'number', 'it is a finished turn for the idle reclaim');

  const next = link();
  await next.turn({ op: 'begin', turn: 1 });
  assert.equal(held(), true, 'the new core counts from 1, and its turn is live');
  assert.doesNotThrow(() => tasks.begin('s1', 1), 'no old turn number is compared with it');
  await next.turn({ op: 'end', turn: 1 });
  assert.equal(held(), false);
});

test('the lane volunteers nothing before the core uses it', async () => {
  const h = harness();
  createBrowserEngine(h.connection, h.ports);
  const { visibilityChanged } = h.bound();
  const guest = {
    pageId: 'p1',
    isDestroyed: () => false,
    once: () => {},
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  visibilityChanged(guest);
  assert.deepEqual(h.sent, []);
});

test('host/browser/command refuses a tool action in engine mode and serves the rest', async () => {
  const h = harness();
  let engine = false;
  const ran = [];
  createBrowserCommandHost(
    h.connection,
    { execute: async (command) => ran.push(command.action), begin() {}, ready() {}, inactive() {}, end() {} },
    { remoteBrowserControl: async () => null, remote: async (method) => `remote ${method}` },
    () => engine
  );
  const command = h.requests.get('host/browser/command');
  const signal = new AbortController().signal;
  await command({ action: 'snapshot', threadId: 't1' }, signal);
  assert.deepEqual(ran, ['snapshot']);
  engine = true;
  await assert.rejects(command({ action: 'snapshot', threadId: 't1' }, signal), /engine methods/);
  assert.equal(await command({ action: 'importSources', threadId: 't1' }, signal), 'remote importSources');
  assert.deepEqual(ran, ['snapshot']);
});

/** A page as the lane follows it: an emitter with the getters the facts read, destroyed when the test says so. */
function fakeGuest() {
  let destroyed = false;
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    getURL: () => '',
    getTitle: () => '',
    isLoading: () => false,
    isLoadingMainFrame: () => false,
    getZoomFactor: () => 1,
    destroy() {
      destroyed = true;
      guest.emit('destroyed');
    },
  });
  return guest;
}

test('a host console entry recorded for a page that already closed is dropped by the flush, not thrown from its timer', async (t) => {
  const h = harness();
  const state = new BrowserGuestStateStore();
  h.ports.base.state = state;
  const engine = createBrowserEngine(h.connection, h.ports);
  engine.engage();
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));

  const guest = fakeGuest();
  state.for(guest);
  h.bound().guestAppeared(guest);
  guest.destroy();
  h.sent.length = 0;
  state.for(guest).console.recordInternal('CDP initialization failed: browser page is unavailable');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(uncaught, [], 'the flush of a closed page throws nothing');
  assert.deepEqual(
    h.sent.filter(([method]) => method === 'host/browser/events'),
    [],
    'and sends nothing: no seq is taken for a page that is gone'
  );

  // A page that is still open keeps its entry: it leaves with the page's next seq.
  const live = fakeGuest();
  state.for(live);
  h.bound().guestAppeared(live);
  state.for(live).console.recordInternal('child frame unreachable');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const batches = h.sent.filter(([method]) => method === 'host/browser/events');
  assert.equal(batches.length, 1);
  assert.equal(batches[0][1].pageId, state.pageId(live));
  assert.equal(batches[0][1].events[0].method, 'Mixdog.internalConsole');
  assert.deepEqual(uncaught, []);
});

test('a command of the core drives the page it leases through the host, and lets go with the lease', () => {
  const h = harness();
  const guest = {
    pageId: 'p1',
    isDestroyed: () => false,
    once: () => {},
    on: () => {},
    off: () => {},
    removeListener: () => {},
  };
  h.guests.push(guest);
  const log = [];
  h.ports.drivePage = (driven) => {
    log.push(['drive', driven]);
    return () => log.push(['release', driven]);
  };
  createBrowserEngine(h.connection, h.ports);
  const { leases } = h.bound();
  const lease = leases.acquire('p1', 'c1', 5_000);
  assert.deepEqual(log, [['drive', guest]], 'the host is told an agent command works on the page');
  leases.release('p1', lease);
  assert.deepEqual(log, [
    ['drive', guest],
    ['release', guest],
  ]);
  // A page that is gone is not leased, and nothing is driven for it.
  assert.throws(() => leases.acquire('p9', 'c2', 5_000));
  assert.equal(log.length, 2);
});
