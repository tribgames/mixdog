import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAccessibilitySnapshot } from '../../browser/accessibility.ts';
import { snapshotTextLimit } from '../../browser/command.ts';
import { createBrowserSnapshotCapture } from '../../browser/snapshot-capture.ts';
import { registerRefCall } from './ref-call.ts';
import { registerSnapshot, revisionNumber } from './snapshot.ts';

const SECRET = 'hunter2hunter2hunter2';
const property = (name, value) => ({ name, value: { value } });

const PAGE_INFO = {
  url: 'https://shop.example/cart',
  title: 'Cart',
  scrollY: 0,
  scrollHeight: 1400,
  viewportHeight: 600,
  viewportWidth: 800,
  text: 'Your cart',
};

/** A recorded accessibility tree: a link, a button named with a secret, a password box, a far-down button. */
const MAIN_NODES = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Cart' }, backendDOMNodeId: 1 },
  { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Your cart' }, backendDOMNodeId: 2 },
  {
    nodeId: '3',
    parentId: '1',
    role: { value: 'link' },
    name: { value: 'Continue shopping' },
    backendDOMNodeId: 3,
    properties: [property('url', 'https://shop.example/')],
  },
  { nodeId: '4', parentId: '1', role: { value: 'button' }, name: { value: `Pay ${SECRET}` }, backendDOMNodeId: 4 },
  {
    nodeId: '5',
    parentId: '1',
    role: { value: 'textbox' },
    name: { value: 'Password' },
    value: { value: SECRET },
    backendDOMNodeId: 5,
  },
  { nodeId: '6', parentId: '1', role: { value: 'button' }, name: { value: 'Footer help' }, backendDOMNodeId: 6 },
];
const FRAME_NODES = [
  { nodeId: 'f1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 90 },
];
const DOM_SNAPSHOT = {
  strings: ['INPUT', 'type', 'password', '#document'],
  documents: [
    {
      nodes: { backendNodeId: [1, 5], nodeName: [3, 0], attributes: [[], [1, 2]] },
      layout: {
        nodeIndex: [0, 1],
        bounds: [
          [0, 0, 800, 1400],
          [10, 300, 100, 20],
        ],
      },
    },
  ],
};

function harness({ cdpFails = false, destroyed = false, answer = () => ({ ok: true, value: 'from-dom' }), call: callResponse } = {}) {
  const handlers = new Map();
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = { getURL: () => PAGE_INFO.url, isDestroyed: () => destroyed };
  const state = {
    pageId: 'p1',
    snapshotGeneration: 0,
    documentGeneration: 3,
    cdpSessions: new Map([['S-frame', { frameId: 'F1', ready: Promise.resolve() }]]),
    fault: '',
  };
  const cdpCalls = [];
  const cdp = {
    call: async (_guest, method, params, _signal, options) => {
      cdpCalls.push({ method, params, sessionId: options?.sessionId });
      if (cdpFails) throw new Error('Accessibility domain unavailable');
      if (method === 'Accessibility.getFullAXTree') return { nodes: options?.sessionId ? FRAME_NODES : MAIN_NODES };
      if (method === 'DOMSnapshot.captureSnapshot') {
        return options?.sessionId ? { documents: [], strings: [] } : DOM_SNAPSHOT;
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${params.backendNodeId}` } };
      if (method === 'Runtime.callFunctionOn') return callResponse ? callResponse(params) : { result: { value: 'clicked' } };
      throw new Error(`unexpected ${method}`);
    },
    releaseObject: (_guest, objectId, sessionId) => cdpCalls.push({ method: 'release', objectId, sessionId }),
  };
  const evaluations = [];
  const evaluate = async (_guest, expression) => {
    evaluations.push(expression);
    if (expression.includes('textClipped: raw.length')) return PAGE_INFO;
    return answer(expression);
  };
  const slot = (key) => ({
    get: () => state[key],
    set: (_guest, value) => {
      state[key] = value;
    },
    has: () => state[key] !== undefined,
    delete: () => {
      state[key] = undefined;
      return true;
    },
  });
  const capture = createBrowserSnapshotCapture({
    evaluate,
    cdp,
    diagnostics: () => ({ cdpSessions: state.cdpSessions, fault: state.fault }),
    visualGrounding: slot('visualGrounding'),
    snapshotTextLimit,
    nextSnapshotId: () => `p1-s${++state.snapshotGeneration}`,
    documentGeneration: () => state.documentGeneration,
    revision: async () => 'origin:4:800:600:0:0:7:0:0|origin:2:800:600:0:0:5:0:0',
    accessibilityRefs: slot('accessibilityRefs'),
    refSets: slot('refSet'),
    maxElements: 160,
  });
  const commands = [];
  const host = {
    captureSnapshotPayload: (target, command, signal) => {
      commands.push(command);
      return capture.captureSnapshotPayload(target, command, signal);
    },
    evaluate,
  };
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp,
    events: { flush: () => {}, facts: (pageId) => ({ pageId, seq: 1, url: PAGE_INFO.url }) },
    redactKnown: (_pageId, text) => text.replaceAll(SECRET, '[SECRET]'),
    isEngineMode: () => true,
  };
  registerSnapshot(connection, ctx, host);
  registerRefCall(connection, ctx, host);
  const call = (method, params) => handlers.get(method)(params, new AbortController().signal);
  return { call, state, cdpCalls, commands, evaluations };
}

test('the payload is the one the in-process builder gives for the recorded trees, with secrets masked and no tree sent', async () => {
  const h = harness();
  const result = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  const direct = buildAccessibilitySnapshot({
    pageInfo: PAGE_INFO,
    snapshotId: 'p1-s1',
    maxElements: 160,
    textChars: 2400,
    targets: [
      {
        nodes: MAIN_NODES,
        bounds: new Map([
          [1, [0, 0, 800, 1400]],
          [5, [10, 300, 100, 20]],
        ]),
        fileInputs: new Map(),
        passwordInputs: new Set([5]),
      },
      { sessionId: 'S-frame', frameId: 'F1', nodes: FRAME_NODES, bounds: new Map(), fileInputs: new Map() },
    ],
  });
  const expected = JSON.parse(JSON.stringify(direct.payload).replaceAll(SECRET, '[SECRET]'));
  assert.deepEqual(result.payload, expected);
  assert.equal(result.snapshotId, 'p1-s1');
  assert.equal(result.documentId, 'p1:3');
  assert.deepEqual(result.facts, { pageId: 'p1', seq: 1, url: PAGE_INFO.url });
  const password = result.payload.elements.find((element) => element.name === 'Password');
  assert.equal(password.sensitive, true);
  assert.equal(password.filled, true);
  assert.equal(password.value, undefined);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!JSON.stringify(result).includes('nodes'));
});

test('the revision is the sum of the DOM-change counters across frames', async () => {
  assert.equal(revisionNumber('o:4:800:600:0:0:7:0:0|o:2:800:600:0:0:5:0:0'), 12);
  assert.equal(revisionNumber(undefined), 0);
  assert.equal(revisionNumber('garbage'), 0);
  const h = harness();
  const result = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'interactive' });
  assert.equal(result.revision, 12);
});

test('modes and limits become the capture command', async () => {
  const h = harness();
  await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'viewport', maxElements: 5, textChars: 100 });
  await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'query', query: 'pay' });
  await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'interactive' });
  assert.deepEqual(h.commands, [
    { action: 'snapshot', viewportOnly: true, maxElements: 5, maxChars: 100 },
    { action: 'snapshot', query: 'pay' },
    { action: 'snapshot' },
  ]);
  const queried = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'query', query: 'pay' });
  assert.deepEqual(
    queried.payload.elements.map((element) => element.name),
    ['Pay [SECRET]', 'Pay now']
  );
  assert.equal(queried.payload.unfilteredElements, 5);
});

test('bad params are -32602 and a bad query pattern is named', async () => {
  const h = harness();
  const code = (params) => (error) => error.code === -32602 && (params === undefined || error.message.includes(params));
  await assert.rejects(h.call('host/browser/snapshot', { pageId: 'p1', mode: 'all' }), code('mode'));
  await assert.rejects(h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full', maxElements: 0 }), code('maxElements'));
  await assert.rejects(h.call('host/browser/snapshot', { pageId: 'p1', mode: 'query', query: '/(/' }), code('invalid'));
  await assert.rejects(h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full', frame: 'x' }), code('frame'));
});

test('a frame session narrows the list to that frame, and a frameId alone says it cannot', async () => {
  const h = harness();
  const narrowed = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full', frame: { sessionId: 'S-frame' } });
  assert.deepEqual(
    narrowed.payload.elements.map((element) => element.name),
    ['Pay now']
  );
  assert.equal(narrowed.payload.totalElements, 1);
  assert.match(narrowed.warnings[0], /frame session S-frame/);
  const whole = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full', frame: { frameId: 'F1' } });
  assert.ok(whole.payload.elements.length > 1);
  assert.match(whole.warnings.at(-1), /frameId alone/);
});

test('with no accessibility tree the DOM fallback payload is returned with its warning', async () => {
  const fallback = {
    snapshotId: 'p1-s2',
    url: PAGE_INFO.url,
    title: 'Cart',
    scrollY: 0,
    scrollHeight: 1,
    viewportWidth: 800,
    viewportHeight: 600,
    elements: [{ ref: 'p1-s2-e1', role: 'button', name: 'Pay', tag: 'button' }],
    totalElements: 1,
    scanned: 1,
    scanCapped: false,
    crossOriginFrames: 0,
    headings: [],
    text: '',
    query: '',
  };
  const h = harness({ cdpFails: true, answer: () => structuredClone(fallback) });
  const result = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  assert.equal(result.payload.elements[0].name, 'Pay');
  assert.match(result.warnings[0], /^CDP accessibility unavailable; using DOM fallback: CDP accessibility tree is unavailable/);
  assert.equal(h.state.accessibilityRefs, undefined);
  assert.equal(h.state.refSet.snapshotId, 'p1-s2');
});

test('ref/call on an accessibility ref resolves the node in its session, calls, releases and returns the value', async () => {
  const h = harness();
  const snap = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  const frameRef = snap.payload.elements.find((element) => element.name === 'Pay now').ref;
  h.cdpCalls.length = 0;
  const result = await h.call('host/browser/ref/call', {
    pageId: 'p1',
    snapshotId: snap.snapshotId,
    ref: frameRef,
    functionDeclaration: 'function(a){ this.click(); return a; }',
    args: ['x'],
    timeoutMs: 900,
  });
  assert.equal(result.value, 'clicked');
  assert.equal(result.facts.pageId, 'p1');
  assert.deepEqual(
    h.cdpCalls.map((call) => [call.method, call.sessionId]),
    [
      ['DOM.resolveNode', 'S-frame'],
      ['Runtime.callFunctionOn', 'S-frame'],
      ['release', 'S-frame'],
    ]
  );
  assert.deepEqual(h.cdpCalls[1].params.arguments, [{ value: 'x' }]);
  assert.equal(h.cdpCalls[1].params.returnByValue, true);
});

test('a snapshot that is no longer current, or a ref it never minted, is -32013 and nothing is sent', async () => {
  const h = harness();
  const first = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  const ref = first.payload.elements[0].ref;
  await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  h.cdpCalls.length = 0;
  const base = { pageId: 'p1', functionDeclaration: 'function(){}' };
  await assert.rejects(
    h.call('host/browser/ref/call', { ...base, snapshotId: first.snapshotId, ref }),
    (error) => error.code === -32013
  );
  await assert.rejects(
    h.call('host/browser/ref/call', { ...base, snapshotId: 'p1-s2', ref: 'p1-s2-e999' }),
    (error) => error.code === -32013 && /stale or unknown/.test(error.message)
  );
  assert.deepEqual(h.cdpCalls, []);
});

test('a refused expect is -32010 before anything is sent', async () => {
  const h = harness();
  const snap = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  const params = {
    pageId: 'p1',
    snapshotId: snap.snapshotId,
    ref: snap.payload.elements[0].ref,
    functionDeclaration: 'function(){}',
  };
  h.cdpCalls.length = 0;
  await assert.rejects(
    h.call('host/browser/ref/call', { ...params, expect: { documentId: 'p1:2' } }),
    (error) => error.code === -32010 && error.data.reason === 'document'
  );
  assert.deepEqual(h.cdpCalls, []);
});

test('bad ref/call params are -32602', async () => {
  const h = harness();
  const bad = (params) => assert.rejects(h.call('host/browser/ref/call', { pageId: 'p1', ...params }), (e) => e.code === -32602);
  await bad({ ref: 'r', functionDeclaration: 'function(){}' });
  await bad({ snapshotId: 's', functionDeclaration: 'function(){}' });
  await bad({ snapshotId: 's', ref: 'r' });
  await bad({ snapshotId: 's', ref: 'r', functionDeclaration: 'function(){}', args: 'x' });
});

test('a page exception of an accessibility ref is returned as data with its position, secrets masked', async () => {
  const h = harness({
    call: () => ({
      exceptionDetails: { text: 'Uncaught', lineNumber: 2, columnNumber: 5, exception: { description: `Error: bad ${SECRET}` } },
    }),
  });
  const snap = await h.call('host/browser/snapshot', { pageId: 'p1', mode: 'full' });
  const result = await h.call('host/browser/ref/call', {
    pageId: 'p1',
    snapshotId: snap.snapshotId,
    ref: snap.payload.elements[0].ref,
    functionDeclaration: 'function(){ throw 1 }',
  });
  assert.deepEqual(result.exception, { text: 'Error: bad [SECRET]', line: 2, column: 5 });
  assert.equal(result.value, undefined);
  assert.equal(h.cdpCalls.at(-1).method, 'release');
});

test('a ref of a DOM-fallback snapshot is called through the page; a page-side failure is an exception, a gone element is -32013', async () => {
  let answer = { ok: true, value: 42 };
  const h = harness({ answer: () => answer });
  h.state.accessibilityRefs = undefined;
  h.state.refSet = { snapshotId: 'p1-s9', refs: new Map() };
  const call = () =>
    h.call('host/browser/ref/call', {
      pageId: 'p1',
      snapshotId: 'p1-s9',
      ref: 'p1-s9-e1',
      functionDeclaration: 'function(n){ return n }',
      args: [1],
    });
  assert.equal((await call()).value, 42);
  assert.match(h.evaluations[0], /__mixdogAgentSnapshot/);
  assert.match(h.evaluations[0], /\.apply\(element, \[1\]\)/);
  answer = { ok: false, text: 'x is not a function' };
  assert.deepEqual((await call()).exception, { text: 'x is not a function' });
  answer = { ok: false, text: 'stale ref' };
  await assert.rejects(call(), (error) => error.code === -32013);
});
