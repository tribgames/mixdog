import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HostRpcError } from '../connection.ts';
import { registerInputBatch } from './input-batch.ts';

const METHOD = 'host/browser/input/batch';

/**
 * A page whose debugger records every input event. `script(event, n)` may answer 'dialog'
 * for the n-th event, abort the call, or change the page; the default answer is 'completed'.
 */
function harness({ script, guardVerdict = { blocked: false } } = {}) {
  const handlers = new Map();
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = {
    getURL: () => 'https://a.example/',
    isDestroyed: () => false,
    isOffscreen: () => false,
    isLoading: () => false,
    getZoomFactor: () => 1,
  };
  const state = {
    pageId: 'p1',
    documentGeneration: 1,
    cdpSessions: new Map(),
    pendingDialog: null,
    accessibilityRefs: { snapshotId: 's1', refs: new Map([['e1', { backendNodeId: 7 }]]) },
  };
  const sent = [];
  const cdp = {
    guestDebugger: async () => ({}),
    sendCdpInput: async (_guest, _debugger, method, params, signal, _session, guard) => {
      signal?.throwIfAborted();
      guard?.();
      sent.push({ method, ...params });
      return (await script?.({ method, ...params }, sent.length, state)) ?? 'completed';
    },
    call: async (_guest, method, params) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'o1' } };
      if (method === 'Runtime.callFunctionOn') {
        const stopping = params.arguments[1].value === true;
        return { result: { value: stopping ? guardVerdict : { blocked: false } } };
      }
      return {};
    },
  };
  let seq = 0;
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp,
    events: { flush: () => undefined, facts: (pageId) => ({ pageId, seq: ++seq }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  registerInputBatch(connection, ctx);
  const call = (params, signal = new AbortController().signal) =>
    handlers.get(METHOD)({ pageId: 'p1', stopOnDialog: true, timeoutMs: 0, expect: { documentId: 'p1:1' }, ...params }, signal);
  return { call, sent, state };
}

const keys = (sent) => sent.filter((event) => event.type === 'keyDown').map((event) => event.key).join('');

test('a dialog stops the batch: the keys after it are never sent', async () => {
  const h = harness({ script: (event) => (event.type === 'keyDown' && event.key === 'c' ? 'dialog' : undefined) });
  const result = await h.call({
    steps: [
      { op: 'type', text: 'abcxdefgh' },
      { op: 'press', key: 'Enter' },
    ],
  });
  assert.equal(keys(h.sent), 'abc');
  assert.equal(result.outcome, 'dialog');
  assert.equal(result.completedSteps, 0);
  assert.equal(h.sent.some((event) => event.key === 'Enter'), false);
  assert.equal(result.facts.pageId, 'p1');
});

test('a dialog already open stops the batch before anything is sent', async () => {
  const h = harness();
  h.state.pendingDialog = { type: 'alert' };
  const result = await h.call({ steps: [{ op: 'type', text: 'a' }] });
  assert.deepEqual([result.outcome, result.completedSteps, h.sent.length], ['dialog', 0, 0]);
});

test('stopOnDialog false lets the remaining steps run', async () => {
  const h = harness({ script: (event) => (event.type === 'rawKeyDown' && event.key === 'a' ? 'dialog' : undefined) });
  const result = await h.call({ stopOnDialog: false, steps: [{ op: 'press', key: 'a' }, { op: 'press', key: 'b' }] });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.completedSteps, 2);
  assert.equal(h.sent.some((event) => event.key === 'b'), true);
});

test('a cancel in the middle of the batch reports how far it got', async () => {
  const controller = new AbortController();
  const h = harness({
    script: (event) => {
      if (event.type === 'keyUp' && event.key === 'b') controller.abort(new Error('cancelled by the core'));
    },
  });
  const result = await h.call(
    { steps: [{ op: 'type', text: 'ab' }, { op: 'type', text: 'cd' }, { op: 'press', key: 'Enter' }] },
    controller.signal
  );
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.completedSteps, 1);
  assert.equal(keys(h.sent), 'ab');
});

test('a person taking the page (abort reason -32012) is outcome userInput', async () => {
  const controller = new AbortController();
  const h = harness({ script: () => controller.abort(new HostRpcError(-32012, 'the person holds the page')) });
  const result = await h.call({ steps: [{ op: 'press', key: 'a' }, { op: 'press', key: 'b' }] }, controller.signal);
  assert.equal(result.outcome, 'userInput');
  assert.equal(result.completedSteps, 0);
});

test('a hit guard that did not hit its element is outcome hitGuard and the step is not counted', async () => {
  const h = harness({ guardVerdict: { blocked: true } });
  const step = { op: 'pointer', kind: 'click', x: 10, y: 20, hitGuard: { snapshotId: 's1', ref: 'e1' } };
  const result = await h.call({ steps: [step, { op: 'press', key: 'Enter' }] });
  assert.equal(result.outcome, 'hitGuard');
  assert.equal(result.completedSteps, 0);
  assert.equal(h.sent.some((event) => event.key === 'Enter'), false);
  const clean = await harness().call({ steps: [step] });
  assert.deepEqual([clean.outcome, clean.completedSteps], ['completed', 1]);
});

test('a hit guard naming another snapshot is -32010 and nothing is sent', async () => {
  const h = harness();
  const step = { op: 'pointer', kind: 'click', x: 1, y: 1, hitGuard: { snapshotId: 'old', ref: 'e1' } };
  await assert.rejects(h.call({ steps: [step] }), (e) => e.code === -32010 && e.data.reason === 'snapshot');
  assert.equal(h.sent.length, 0);
});

test('expect is checked again right before a pointer press', async () => {
  const h = harness({ script: (event, _n, state) => void (event.type === 'keyUp' && (state.documentGeneration += 1)) });
  await assert.rejects(
    h.call({
      expect: { documentId: 'p1:1' },
      steps: [{ op: 'press', key: 'a' }, { op: 'pointer', kind: 'click', x: 5, y: 5 }],
    }),
    (e) => e.code === -32010 && e.data.reason === 'document'
  );
  assert.equal(h.sent.some((event) => event.type === 'mousePressed'), false);
});

test('non-ASCII text goes in by insertText per character, ASCII by key events, and the counts are reported', async () => {
  const h = harness();
  const result = await h.call({ steps: [{ op: 'type', text: 'a한' }, { op: 'insertText', text: 'x' }, { op: 'pointer', kind: 'click', x: 3, y: 4 }] });
  assert.deepEqual(
    h.sent.map((event) => event.method + (event.text ? `:${event.text}` : '')).filter((entry) => entry.startsWith('Input.insertText')),
    ['Input.insertText:한', 'Input.insertText:x']
  );
  assert.equal(result.timing.keyEvents, 4);
  assert.equal(result.timing.mouseEvents, 3);
  assert.equal(result.completedSteps, 3);
  assert.equal(typeof result.timing.inputMs, 'number');
});

test('down, move and up carry the held button, and a malformed step is -32602', async () => {
  const h = harness();
  await h.call({
    steps: [
      { op: 'pointer', kind: 'down', x: 1, y: 1 },
      { op: 'pointer', kind: 'move', x: 9, y: 9 },
      { op: 'pointer', kind: 'up', x: 9, y: 9 },
    ],
  });
  assert.deepEqual(h.sent.map((event) => [event.type, event.buttons]), [['mousePressed', 1], ['mouseMoved', 1], ['mouseReleased', 0]]);
  await assert.rejects(h.call({ steps: [{ op: 'pointer', kind: 'dragTo', x: 1, y: 1 }] }), (e) => e.code === -32602);
  await assert.rejects(h.call({ steps: [{ op: 'swipe' }] }), (e) => e.code === -32602);
});

test('press with modifiers and repeat sends the chord repeat times', async () => {
  const h = harness();
  const result = await h.call({ steps: [{ op: 'press', key: 'a', modifiers: ['Control'], repeat: 2 }] });
  assert.equal(h.sent.filter((event) => event.type === 'rawKeyDown').length, 2);
  assert.equal(h.sent[0].modifiers, 2);
  assert.equal(result.completedSteps, 1);
});

test('a batch bound to no state is refused as document in engine mode, and nothing is sent', async () => {
  const h = harness();
  await assert.rejects(h.call({ steps: [{ op: 'press', key: 'Enter' }], expect: undefined }), (e) => e.code === -32010 && e.data.reason === 'document');
  assert.equal(h.sent.length, 0);
});
