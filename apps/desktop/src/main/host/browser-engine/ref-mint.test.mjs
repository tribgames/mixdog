import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerRefMint } from './ref-mint.ts';

function harness({ nodes = [], queryError = null } = {}) {
  const handlers = new Map();
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = { getURL: () => 'https://shop.example/cart', isDestroyed: () => false };
  const state = {
    pageId: 'p1',
    documentGeneration: 3,
    cdpSessions: new Map(),
    fault: '',
    // The snapshot listed one node (backend 5) and bound another to a frame session (backend 90).
    accessibilityRefs: {
      snapshotId: 'p1-s2',
      refs: new Map([
        ['p1-s2-e1', { backendNodeId: 5 }],
        ['p1-s2-e2', { backendNodeId: 90, sessionId: 'S-frame' }],
      ]),
    },
    refSet: { snapshotId: 'p1-s2', refs: new Map([['p1-s2-e1', { ref: 'p1-s2-e1', role: 'button', name: 'Cancel' }]]) },
  };
  const cdpCalls = [];
  const cdp = {
    call: async (_guest, method, params) => {
      cdpCalls.push({ method, params });
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') {
        if (queryError) throw new Error(queryError);
        return { nodeIds: nodes.map((node) => node.nodeId) };
      }
      if (method === 'DOM.describeNode') return { node: nodes.find((node) => node.nodeId === params.nodeId).node };
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp,
    events: { flush: () => {}, facts: (pageId) => ({ pageId, seq: 1, url: 'https://shop.example/cart' }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  registerRefMint(connection, ctx);
  const call = (params) => handlers.get('host/browser/ref/mint')(params, new AbortController().signal);
  return { call, state, cdpCalls };
}

const params = { pageId: 'p1', snapshotId: 'p1-s2', selector: 'button, div', limit: 50 };

test('a listed node keeps its ref and an unlisted one gets a ref minted from its backend node', async () => {
  const h = harness({
    nodes: [
      { nodeId: 11, node: { backendNodeId: 5, nodeName: 'BUTTON' } },
      { nodeId: 12, node: { backendNodeId: 77, nodeName: 'DIV', attributes: ['id', 'consent', 'role', 'group', 'aria-label', '  Consent   row '] } },
      { nodeId: 13, node: { backendNodeId: 78, nodeName: 'SECTION' } },
    ],
  });
  const result = await h.call(params);
  assert.equal(result.count, 3);
  assert.deepEqual(result.matches, [
    { ref: 'p1-s2-e1', role: 'button', name: 'Cancel' },
    { ref: 'p1-s2-t77', role: 'group', name: 'Consent row' },
    { ref: 'p1-s2-t78', role: 'section', name: '' },
  ]);
  // The minted refs resolve like a listed one: bound to the top document's backend node, no frame session.
  assert.deepEqual(h.state.accessibilityRefs.refs.get('p1-s2-t77'), { backendNodeId: 77 });
  assert.equal(result.facts.pageId, 'p1');
});

test('a node bound to a frame session is not the top document node of the same backend id', async () => {
  const h = harness({ nodes: [{ nodeId: 21, node: { backendNodeId: 90, nodeName: 'A', attributes: ['title', 'Pay'] } }] });
  const result = await h.call(params);
  assert.deepEqual(result.matches, [{ ref: 'p1-s2-t90', role: 'a', name: 'Pay' }]);
});

test('more matches than the limit answer only the count, and a selector the page rejects is reported as invalid', async () => {
  const many = harness({ nodes: Array.from({ length: 3 }, (_, index) => ({ nodeId: 30 + index, node: { backendNodeId: 100 + index } })) });
  const counted = await many.call({ ...params, limit: 2 });
  assert.equal(counted.count, 3);
  assert.deepEqual(counted.matches, []);
  assert.ok(!many.cdpCalls.some((call) => call.method === 'DOM.describeNode'), 'nothing is described past the limit');
  const bad = harness({ queryError: 'bad( is not a valid selector' });
  const rejected = await bad.call({ ...params, selector: 'bad(' });
  assert.equal(rejected.count, 0);
  assert.match(rejected.invalid, /not a valid selector/);
});
