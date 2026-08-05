// Submit delivery across the daemon seam. A view's submit() answers
// SYNCHRONOUSLY (the store contract EngineHost depends on), so the surface has
// already told the user the prompt was accepted by the time the hop happens.
// Losing it there is invisible: no transcript row, no error (user: 입력이
// 씹힘). These tests pin the two halves of the guarantee — a failed hop is
// retried until it lands, and a retry that crosses a lost response is deduped
// by submission id instead of double-posting.
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
    onFrame: (frame) => transport.broadcast(frame),
  });
  const transport = createEngineDaemonTransport({
    handleCall: (name, args) => service.handleCall(name, args),
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

test('a view submit that fails the hop is retried until the engine takes it', async () => {
  let engine = null;
  await withDaemon(async () => {
    const view = await createRemoteEngineSession({ cwd: process.cwd() });
    try {
      // The caller is answered immediately — the surface may paint the prompt.
      assert.equal(view.submit('retried prompt', { id: 'submission-1' }), true);
      await waitFor(() => view.getState().items?.length === 1,
        'the retried submit eventually lands in the engine transcript');
      assert.ok(engine.attempts >= 3, 'the failed attempts were actually retried');
      assert.equal(view.getState().items[0].text, 'retried prompt');
    } finally {
      await view.dispose('test');
    }
  }, async () => (engine = createFlakyEngine(2)));
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
    const first = await service.handleCall('engine.session', {
      sessionId: 'stored-session', method: 'submit', args: ['wake up'],
    });
    assert.equal(first.value, true, 'the prompt is accepted without a view owning the session');
    assert.equal(first.sessionId, 'stored-session');
    assert.equal(opened.length, 1, 'the daemon loaded the session exactly once');
    assert.deepEqual(opened[0].submits, ['wake up']);

    // Single writer: a second session-addressed call converges on that engine.
    const second = await service.handleCall('engine.session', {
      sessionId: 'stored-session', method: 'submit', args: ['and again'],
    });
    assert.equal(second.engineId, first.engineId);
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].submits, ['wake up', 'and again']);

    // A view resuming the same session ADOPTS that engine instead of loading a
    // second copy of it — the split brain the daemon exists to remove.
    const view = await service.handleCall('engine.open', { cwd: process.cwd() });
    const adopted = await service.handleCall('engine.call', {
      engineId: view.engineId, method: 'resume', args: ['stored-session'],
    });
    assert.equal(adopted.adoptEngineId, first.engineId,
      'the view is pointed at the engine the daemon already loaded');
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
      service.handleCall('engine.session', { sessionId: 'shared-session', method: 'submit', args: ['left'] }),
      service.handleCall('engine.session', { sessionId: 'shared-session', method: 'submit', args: ['right'] }),
    ]);
    assert.equal(left.engineId, right.engineId, 'both panes address one engine');
    assert.equal(opened.length, 1, 'the concurrent load is deduped');
    assert.deepEqual([...opened[0].submits].sort(), ['left', 'right']);
  } finally {
    await service.stop('test end');
  }
});
