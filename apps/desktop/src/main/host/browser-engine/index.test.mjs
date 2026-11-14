import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserCommandHost } from '../browser-command.ts';
import { createBrowserEngine, ENGINE_NOTIFICATION_METHODS, ENGINE_REQUEST_METHODS, serveBrowserEngine } from './index.ts';
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
    emulation: {},
    traceDirectory: () => '/traces',
    processMemoryMb: () => undefined,
  };
  return { connection, requests, notifications, sent, closers, ports, guests, bound: () => bound, unbound: () => unbound };
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
  const call = () => h.requests.get('host/browser/snapshot')({ pageId: 'p9' }, new AbortController().signal).catch(() => {});
  await call();
  const first = h.bound();
  for (const close of h.closers) close();
  assert.equal(h.unbound(), 1);
  assert.equal(served.engineMode(), false);
  await call();
  assert.notEqual(h.bound(), first);
  assert.equal(served.engineMode(), true);
});

test('the lane volunteers nothing before the core uses it', async () => {
  const h = harness();
  createBrowserEngine(h.connection, h.ports);
  const { visibilityChanged } = h.bound();
  const guest = { pageId: 'p1', isDestroyed: () => false, once: () => {}, on: () => {}, off: () => {}, removeListener: () => {} };
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
