import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserCdpEventRouter } from '../../browser/cdp-event-router.ts';
import { BrowserGuestStateStore } from '../../browser/guest-state.ts';
import { createEngineEvents, createEngineEventSink, MAX_BATCH_BYTES } from './events.ts';

const SECRET = 'hunter2hunter2hunter2';

function harness() {
  const sent = [];
  const connection = { notify: (method, params) => sent.push({ method, params }) };
  const seqs = new Map();
  const scheduled = [];
  const events = createEngineEvents(connection, {
    nextSeq: (pageId) => {
      const next = (seqs.get(pageId) ?? 0) + 1;
      seqs.set(pageId, next);
      return next;
    },
    redact: (_pageId, text) => text.replaceAll(SECRET, '[SECRET]'),
    facts: (pageId) => ({ pageId }),
    schedule: (run) => {
      scheduled.push(run);
      return () => scheduled.splice(scheduled.indexOf(run), 1);
    },
    now: () => 5,
  });
  return { events, sent, scheduled };
}

test('events leave in arrival order with a gap-free seq per page', () => {
  const { events, sent, scheduled } = harness();
  events.push('p1', { method: 'Log.entryAdded', params: { n: 1 } });
  events.push('p2', { method: 'Log.entryAdded', params: { n: 9 } });
  events.push('p1', { sessionId: 'c1', method: 'Runtime.consoleAPICalled', params: { n: 2 } });
  assert.equal(sent.length, 0, 'nothing leaves before the flush');
  while (scheduled.length) scheduled.shift()();
  events.push('p1', { method: 'Log.entryAdded', params: { n: 3 } });
  events.flush('p1');
  const p1 = sent.filter((m) => m.params.pageId === 'p1');
  assert.deepEqual(
    p1.map((m) => m.params.seq),
    [1, 2]
  );
  assert.deepEqual(
    p1[0].params.events.map((e) => e.params.n),
    [1, 2]
  );
  assert.equal(p1[0].params.events[1].sessionId, 'c1');
  assert.equal(p1[1].params.events[0].params.n, 3);
  assert.equal(sent.find((m) => m.params.pageId === 'p2').params.seq, 1);
  assert.equal(sent[0].method, 'host/browser/events');
});

test('flush sends at once, and a flush with nothing queued sends nothing', () => {
  const { events, sent } = harness();
  events.flush('p1');
  assert.equal(sent.length, 0);
  events.push('p1', { method: 'Log.entryAdded', params: {} });
  events.flush('p1');
  assert.equal(sent.length, 1);
  events.flush('p1');
  assert.equal(sent.length, 1);
});

test('a large run splits into batches under the limit and keeps the order', () => {
  const { events, sent } = harness();
  const text = 'x'.repeat(30_000);
  for (let n = 0; n < 20; n += 1) events.push('p1', { method: 'Network.dataReceived', params: { n, text } });
  events.flush('p1');
  assert.ok(sent.length > 1);
  for (const message of sent) assert.ok(Buffer.byteLength(JSON.stringify(message.params)) < 200 * 1024);
  assert.ok(sent.every((m) => Buffer.byteLength(JSON.stringify(m.params.events)) <= MAX_BATCH_BYTES));
  assert.deepEqual(
    sent.flatMap((m) => m.params.events.map((e) => e.params.n)),
    [...Array(20).keys()]
  );
  assert.deepEqual(
    sent.map((m) => m.params.seq),
    sent.map((_, i) => i + 1)
  );
});

test('a secret typed into the page is masked in console text, request bodies and headers', () => {
  const { events, sent } = harness();
  events.push('p1', { method: 'Runtime.consoleAPICalled', params: { args: [{ value: `pw ${SECRET}` }] } });
  events.push('p1', {
    method: 'Network.requestWillBeSent',
    params: { request: { postData: `a=${SECRET}`, headers: { Authorization: `Bearer ${SECRET}` } } },
  });
  events.flush('p1');
  assert.ok(!JSON.stringify(sent).includes(SECRET));
  assert.ok(JSON.stringify(sent).includes('[SECRET]'));
});

test('the sink forwards only the allowlisted events and reports the lane state', () => {
  const { events, sent } = harness();
  let engine = false;
  const sink = createEngineEventSink(
    events,
    () => 'p1',
    () => engine
  );
  assert.equal(sink.active(), false);
  engine = true;
  assert.equal(sink.carries('Log.entryAdded'), true);
  assert.equal(sink.carries('Network.webSocketFrameSent'), false);
  sink.forward({}, 'Network.webSocketFrameSent', {}, undefined);
  sink.forward({}, 'Log.entryAdded', { entry: {} }, 's1');
  events.flush('p1');
  assert.equal(sent[0].params.events.length, 1);
  assert.equal(sent[0].params.events[0].sessionId, 's1');
});

function routerHarness(engine) {
  const state = new BrowserGuestStateStore();
  const forwarded = [];
  const sink = {
    active: () => engine,
    carries: () => true,
    forward: (_guest, method, params) => forwarded.push([method, params]),
  };
  const route = createBrowserCdpEventRouter({
    state,
    engine: sink,
    sendCdp: async () => ({}),
    targetDetached: () => undefined,
    matchInterceptRule: () => undefined,
    permissionRefused: () => undefined,
    initializeTargetSession: async () => undefined,
    lifetimeSignal: () => new AbortController().signal,
  });
  return { state, forwarded, route, guest: { isDestroyed: () => false } };
}

test('engine mode forwards console, network and log events instead of recording them', () => {
  const { state, forwarded, route, guest } = routerHarness(true);
  route(guest, {}, 'Runtime.consoleAPICalled', { type: 'log', args: [] }, undefined);
  route(guest, {}, 'Network.requestWillBeSent', { requestId: '1' }, undefined);
  route(guest, {}, 'Log.entryAdded', { entry: { level: 'error', text: 'x' } }, undefined);
  assert.deepEqual(
    forwarded.map(([method]) => method),
    ['Runtime.consoleAPICalled', 'Network.requestWillBeSent', 'Log.entryAdded']
  );
  assert.equal(state.for(guest).console.errorCount(), 0);
});

test('engine mode keeps the host record of a dialog and tells the observer', () => {
  const { state, forwarded, route, guest } = routerHarness(true);
  const changes = [];
  state.onChange((_guest, event) => changes.push(event));
  route(guest, {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'hi' }, undefined);
  assert.equal(state.for(guest).pendingDialog.message, 'hi');
  assert.deepEqual(
    forwarded.map(([method]) => method),
    ['Page.javascriptDialogOpening']
  );
  assert.deepEqual(changes, [{ kind: 'changed', reason: 'dialog' }]);
});

test('host mode records locally and forwards nothing', () => {
  const { state, forwarded, route, guest } = routerHarness(false);
  route(guest, {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'boom' } }, undefined);
  assert.deepEqual(forwarded, []);
  assert.equal(state.for(guest).console.errorCount(), 1);
});

test('the host records its own internal console entries and refusals for the observer', () => {
  const state = new BrowserGuestStateStore();
  const guest = {};
  const seen = [];
  state.onChange((_guest, event) => seen.push(event));
  state.for(guest).console.recordInternal('CDP call timed out');
  state.recordRefusedRequest(guest, 'https://x.example/', 'blocked by policy');
  assert.deepEqual(seen, [
    { kind: 'internalConsole', text: 'CDP call timed out' },
    { kind: 'requestRefused', url: 'https://x.example/', reason: 'blocked by policy' },
  ]);
  assert.equal(state.nextSeq(guest), 1);
  assert.equal(state.nextSeq(guest), 2);
});
