// Submit delivery across the daemon seam. A view's submit() answers
// Session submit is acknowledged asynchronously by the daemon. Product
// clients do not keep a second pending/retry queue; transport call IDs provide
// idempotence and an engine-side rejection is reported directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-engine-submit-delivery-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;
// This test hosts its own in-process daemon service; the seam must not attach
// to (or spawn) the machine-global one.
process.env.MIXDOG_ENGINE_DAEMON = '0';

const { createEngineDaemonTransport } = await import('../src/standalone/engine-daemon-transport.mjs');
const { createEngineDaemonService } = await import('../src/standalone/engine-daemon-service.mjs');
const { createRemoteEngineSession } = await import('../src/standalone/engine-daemon-client.mjs');
const { createSessionFlow } = await import('../src/tui/engine/session-flow.mjs');

function waitFor(predicate, message, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (err) { reject(err); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`timeout: ${message}`)); return; }
      setTimeout(tick, 10).unref?.();
    };
    tick();
  });
}

/** Stub engine whose first `failures` submits throw, mimicking a hop that dies
 *  between the view and the daemon-hosted engine. */
function createFlakyEngine(failures) {
  let state = { sessionId: 'stub-session', items: [], busy: false };
  const listeners = new Set();
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit(text, options) {
      attempts += 1;
      if (attempts <= failures) throw new Error('transport fault');
      state = {
        ...state,
        items: [...state.items, { id: String(options?.id || attempts), text: String(text) }],
      };
      for (const listener of [...listeners]) listener();
      return true;
    },
    async dispose() {},
  };
}

async function withDaemon(run, engineFactory) {
  const service = createEngineDaemonService({
    createEngine: engineFactory,
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args, ctx) => service.handleCall(name, args, ctx),
    discoveryPath: join(RUNTIME_ROOT, 'engine-daemon.json'),
    clientGraceMs: 50,
    sweepMs: 50,
  });
  const { port, token } = await transport.start();
  writeFileSync(
    join(RUNTIME_ROOT, 'engine-daemon.json'),
    JSON.stringify({ pid: process.pid, port, token }),
  );
  try {
    await run({ service });
  } finally {
    await service.stop('test end');
    await transport.stop();
  }
}

test('submitAsync reports a backend rejection without a client retry loop', async () => {
  let engine = null;
  await withDaemon(async () => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    try {
      await assert.rejects(
        () => view.submitAsync('rejected prompt', { id: 'submission-1' }),
        /transport fault/,
      );
      assert.equal(engine.attempts, 1, 'the client does not replay an engine rejection');
      assert.equal(view.getState().items.length, 0);
    } finally {
      await view.dispose('test');
    }
  }, async () => (engine = createFlakyEngine(2)));
});

test('a fresh daemon view reuses its first reservation for New task', async () => {
  let engineCreations = 0;
  await withDaemon(async () => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    try {
      const reservedSessionId = String(view.getState().sessionId || '');
      assert.ok(reservedSessionId);
      assert.equal(engineCreations, 1);
      assert.equal(await view.newSession({ reuseReservation: true }), true);
      assert.equal(view.getState().sessionId, reservedSessionId);
      assert.equal(engineCreations, 1, 'reservation reuse creates no second engine');

      assert.equal(await view.newSession(), true);
      assert.notEqual(view.getState().sessionId, reservedSessionId);
      assert.equal(engineCreations, 2, 'an explicit ordinary new session still creates a fresh entry');
    } finally {
      await view.dispose('test');
    }
  }, async () => {
    engineCreations += 1;
    let state = { sessionId: '', items: [], busy: false };
    return {
      getState: () => state,
      subscribe: () => () => {},
      reserveSession(id) {
        state = { ...state, sessionId: String(id) };
        return true;
      },
      async dispose() {},
    };
  });
});

test('a re-delivered submission id is queued exactly once', () => {
  const pending = [];
  const state = { busy: false, commandBusy: true, queued: [] };
  const flow = createSessionFlow({
    runtime: { id: 'test-session' },
    nextId: (() => { let seq = 0; return () => `auto-${seq += 1}`; })(),
    tuiDebug: () => {},
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    flushEmitImmediate: () => {},
  });

  assert.equal(flow.enqueue('first delivery', { id: 'submission-9' }), true);
  // The transport re-sent the SAME submission after a lost response.
  assert.equal(flow.enqueue('first delivery', { id: 'submission-9' }), false);
  assert.equal(pending.length, 1, 'the duplicate never reaches the queue');

  // A different submission is unaffected, and so is an id-less local submit.
  assert.equal(flow.enqueue('second delivery', { id: 'submission-10' }), true);
  assert.equal(flow.enqueue('typed locally'), true);
  assert.equal(pending.length, 3);
});


test('near-simultaneous same-text busy prompts queue once', () => {
  const pending = [];
  const state = { busy: true, commandBusy: false, queued: [] };
  const flow = createSessionFlow({
    runtime: { id: 'test-session' },
    nextId: (() => { let seq = 0; return () => `auto-${seq += 1}`; })(),
    tuiDebug: () => {},
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    flushEmitImmediate: () => {},
  });

  // Root identity is the submission id — the same text may be intentional.
  // A transport re-delivery reuses the id and is dropped.
  assert.equal(flow.enqueue('same follow-up', { id: 'a' }), true);
  assert.equal(flow.enqueue('same follow-up', { id: 'a' }), false);
  assert.equal(flow.enqueue('same follow-up', { id: 'b' }), true);
  assert.equal(pending.length, 2);
  assert.equal(state.queued.length, 2);
});
// ── Session-addressed delivery ───────────────────────────────────────────────
// A view is a RENDERER: the desktop pane (or a TUI tab) showing a session it
// holds no engine for must still be able to hand the backend a prompt. The
// daemon owns the pool, so it resolves — or loads — that session's engine.

/** Stub engine that boots empty and can resume a stored session. */
function createSessionEngine() {
  let state = { sessionId: '', items: [], busy: false };
  const listeners = new Set();
  const submits = [];
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    get submits() { return submits; },
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async resume(sessionId) {
      state = { ...state, sessionId: String(sessionId), items: [{ id: 'resumed', text: `resumed ${sessionId}` }] };
      publish();
      return true;
    },
    submit(text) {
      submits.push(String(text));
      state = { ...state, items: [...state.items, { id: `item-${submits.length}`, text: String(text) }] };
      publish();
      return true;
    },
    async dispose() {},
  };
}

test('a session no view holds still receives the prompt through the daemon', async () => {
  const opened = [];
  const service = createEngineDaemonService({
    createEngine: async () => {
      const engine = createSessionEngine();
      opened.push(engine);
      return engine;
    },
    publishIntervalMs: 5,
  });
  try {
    const first = await service.handleCall('session.invoke', {
      sessionId: 'stored-session', method: 'submit', args: ['wake up'],
    });
    assert.equal(first.value, true, 'the prompt is accepted without a view owning the session');
    assert.equal(first.sessionId, 'stored-session');
    assert.equal(opened.length, 1, 'the daemon loaded the session exactly once');
    assert.deepEqual(opened[0].submits, ['wake up']);

    // Single writer: a second session-addressed call converges on that engine.
    const second = await service.handleCall('session.invoke', {
      sessionId: 'stored-session', method: 'submit', args: ['and again'],
    });
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].submits, ['wake up', 'and again']);

    const subscribed = await service.handleCall('session.subscribe', {
      sessionId: 'stored-session',
    });
    assert.equal(subscribed.subscribed, true);
    assert.equal(opened.length, 1, 'a subscriber joins the existing session owner');
  } finally {
    await service.stop('test end');
  }
});

test('two panes submitting at once load the session once', async () => {
  const opened = [];
  const service = createEngineDaemonService({
    createEngine: async () => {
      const engine = createSessionEngine();
      opened.push(engine);
      // A real load is not instantaneous; the second caller must wait it out
      // instead of starting its own.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return engine;
    },
    publishIntervalMs: 5,
  });
  try {
    const [left, right] = await Promise.all([
      service.handleCall('session.invoke', { sessionId: 'shared-session', method: 'submit', args: ['left'] }),
      service.handleCall('session.invoke', { sessionId: 'shared-session', method: 'submit', args: ['right'] }),
    ]);
    assert.equal(left.sessionId, right.sessionId, 'both panes address one session');
    assert.equal(opened.length, 1, 'the concurrent load is deduped');
    assert.deepEqual([...opened[0].submits].sort(), ['left', 'right']);
  } finally {
    await service.stop('test end');
  }
});
