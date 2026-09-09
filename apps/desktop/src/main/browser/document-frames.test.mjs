import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBrowserFrameCollector } from './document-frames.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('ready frames start without a slow sibling and collected output keeps frame order under bounded concurrency', async () => {
  const readiness = deferred();
  const frameIds = ['root', 'a', 'b', 'c', 'd', 'e'];
  const sessions = new Map(frameIds.slice(1).map(id => [
    id, { type: 'iframe', frameId: id, ready: id === 'a' ? readiness.promise : Promise.resolve() },
  ]));
  const trees = [];
  const gates = new Map();
  let active = 0;
  let peak = 0;
  const collect = createBrowserFrameCollector({
    sessions: () => sessions,
    cdp: {
      guestDebugger: async () => new EventEmitter(),
      call: async (_guest, method, args, _signal, options) => {
        if (method === 'Page.getFrameTree') {
          const id = options.sessionId || 'root';
          trees.push(id);
          return { frameTree: { frame: { id } } };
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: args.frameId };
        active++; peak = Math.max(peak, active);
        const gate = deferred();
        gates.set(args.contextId, gate);
        try {
          await gate.promise;
          return { result: { value: args.contextId } };
        } finally { active--; }
      },
    },
  });
  const pending = collect(new EventEmitter(), 'test-expression');
  await tick();
  assert.deepEqual(trees, ['root', 'b', 'c', 'd', 'e']);
  readiness.resolve();
  await tick();
  assert.equal(active, 4);
  gates.get('c').resolve(); gates.get('b').resolve();
  await tick();
  for (const gate of gates.values()) gate.resolve();
  assert.deepEqual(await pending, frameIds);
  assert.equal(peak, 4);
});

test('a failed frame drains in-flight sibling reads and never becomes empty page text', async () => {
  const sibling = deferred();
  const failure = new Error('frame lost');
  let finished = false;
  const collect = createBrowserFrameCollector({
    sessions: () => new Map(),
    cdp: {
      guestDebugger: async () => new EventEmitter(),
      call: async (_guest, method, args) => {
        if (method === 'Page.getFrameTree') return { frameTree: {
          frame: { id: 'root' }, childFrames: [{ frame: { id: 'child' } }],
        } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: args.frameId };
        if (args.contextId === 'root') throw failure;
        await sibling.promise;
        return { result: { value: 'child text' } };
      },
    },
  });
  const pending = collect(new EventEmitter(), 'test-expression');
  void pending.then(() => { finished = true; }, () => { finished = true; });
  await tick();
  assert.equal(finished, false);
  sibling.resolve();
  await assert.rejects(pending, error => error === failure);
});

test('cancelled frame collection dispatches no frame reads', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let calls = 0;
  const collect = createBrowserFrameCollector({
    sessions: () => new Map(),
    cdp: { guestDebugger: async () => {}, call: async () => { calls++; } },
  });
  await assert.rejects(collect({}, 'text', controller.signal), /cancelled/);
  assert.equal(calls, 0);
});

test('routing reuse keeps text fresh and discards contexts on navigation, detach, and context loss', async () => {
  const guest = new EventEmitter();
  const port = new EventEmitter();
  let generation = 1;
  let text = 'first';
  let metadataReads = 0;
  const collect = createBrowserFrameCollector({
    sessions: () => new Map(),
    cdp: {
      guestDebugger: async () => port,
      call: async (_guest, method, args) => {
        if (method === 'Page.getFrameTree') {
          metadataReads++;
          return { frameTree: { frame: { id: `root-${generation}` } } };
        }
        if (method === 'Page.createIsolatedWorld') {
          metadataReads++;
          assert.equal(args.frameId, `root-${generation}`);
          return { executionContextId: generation };
        }
        assert.equal(args.contextId, generation, 'stale contexts must never be used');
        return { result: { value: text } };
      },
    },
  });
  assert.deepEqual(await collect(guest, 'text'), ['first']);
  const initialReads = metadataReads;
  text = 'updated';
  assert.deepEqual(await collect(guest, 'text'), ['updated']);
  assert.equal(metadataReads, initialReads, 'warm reads need no routing roundtrips');
  for (const event of [
    'Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached',
    'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
    'Target.attachedToTarget', 'Target.detachedFromTarget', 'detach',
  ]) {
    generation++;
    if (event === 'detach') port.emit('detach');
    else port.emit('message', {}, event, {});
    assert.deepEqual(await collect(guest, 'text'), ['updated']);
  }
  guest.emit('destroyed');
  assert.equal(port.listenerCount('message'), 0);
  assert.equal(port.listenerCount('detach'), 0);
});

test('a navigation during a read discards the old result and observes the new document once', async () => {
  const port = new EventEmitter();
  let generation = 1;
  let reads = 0;
  const collect = createBrowserFrameCollector({
    sessions: () => new Map(),
    cdp: {
      guestDebugger: async () => port,
      call: async (_guest, method) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `root-${generation}` } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: generation };
        reads++;
        if (generation === 1) {
          generation++;
          port.emit('message', {}, 'Page.frameNavigated', {});
          return { result: { value: 'obsolete document' } };
        }
        return { result: { value: 'current document' } };
      },
    },
  });
  assert.deepEqual(await collect(new EventEmitter(), 'read'), ['current document']);
  assert.equal(reads, 2);
});
