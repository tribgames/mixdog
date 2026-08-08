// Agent shard spread (MIXDOG_AGENT_SHARD_SPREAD): shard placement avoidance,
// session.create passthrough of the agent session spec, the raw-messages read
// action, and the remote worker mgr facade driving one full
// submit -> state frames -> peekSessionMessages turn against a stub daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), 'mixdog-agent-shard-spread-'));
process.env.MIXDOG_RUNTIME_ROOT = RUNTIME_ROOT;
process.env.MIXDOG_DATA_DIR = RUNTIME_ROOT;
process.env.MIXDOG_AGENT_SHARD_SPREAD = '1';

const { chooseShardIndex } = await import('../src/standalone/session-runtime-pool.mjs');
const {
  SESSION_READ_ACTIONS,
} = await import('../src/standalone/session-protocol.mjs');
const { createSessionTransport } = await import('../src/standalone/session-transport.mjs');
const { createSessionService } = await import('../src/standalone/session-service.mjs');
const {
  agentShardSpreadEnabled,
  createAgentShardSpread,
  dispatchHiddenAgentRemote,
} = await import('../src/standalone/agent-tool/shard-spread.mjs');

test.after(() => {
  rmSync(RUNTIME_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('placement avoids the caller shard when the pool has an alternative', () => {
  const alive = (busy, resident = 1) => ({ alive: true, busy, resident });
  const cold = { alive: false, busy: 0, resident: 0 };
  // A live hash shard loses to avoidance: the worker lands on the peer.
  assert.equal(chooseShardIndex({ hashIndex: 0, shards: [alive(0), alive(1)], avoidIndex: 0 }), 1);
  // Cold hash elsewhere: boot the hash shard rather than share the avoided loop.
  assert.equal(chooseShardIndex({ hashIndex: 1, shards: [alive(0), cold], avoidIndex: 0 }), 1);
  // Hash IS the avoided shard and no live alternative fits: boot the next one.
  assert.equal(chooseShardIndex({ hashIndex: 0, shards: [alive(2, 4), cold], avoidIndex: 0 }), 1);
  // A single-shard pool keeps working (nothing to avoid).
  assert.equal(chooseShardIndex({ hashIndex: 0, shards: [alive(0)], avoidIndex: 0 }), 0);
  // No avoidIndex: prior behavior byte-for-byte (live hash always wins).
  assert.equal(chooseShardIndex({ hashIndex: 1, shards: [alive(0), alive(2, 4)] }), 1);
});

test('the read surface carries the raw-messages action', () => {
  assert.ok(SESSION_READ_ACTIONS.includes('peekSessionMessages'));
  assert.ok(SESSION_READ_ACTIONS.includes('peekSessionTranscript'));
  assert.equal(agentShardSpreadEnabled(), true);
});

test('spread default is scoped to shard children with explicit opt-out', () => {
  const savedFlag = process.env.MIXDOG_AGENT_SHARD_SPREAD;
  const savedShard = process.env.MIXDOG_SESSION_SHARD_PID;
  try {
    delete process.env.MIXDOG_AGENT_SHARD_SPREAD;
    delete process.env.MIXDOG_SESSION_SHARD_PID;
    assert.equal(agentShardSpreadEnabled(), false, 'plain processes stay in-process by default');
    process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid);
    assert.equal(agentShardSpreadEnabled(), true, 'shard children default ON');
    process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid + 1);
    assert.equal(agentShardSpreadEnabled(), false,
      'an inherited marker from a parent shard never enables a grandchild');
    process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid);
    process.env.MIXDOG_AGENT_SHARD_SPREAD = '0';
    assert.equal(agentShardSpreadEnabled(), false, 'opt-out wins inside a shard');
    delete process.env.MIXDOG_SESSION_SHARD_PID;
    process.env.MIXDOG_AGENT_SHARD_SPREAD = '1';
    assert.equal(agentShardSpreadEnabled(), true, 'opt-in wins in a plain process');
  } finally {
    if (savedFlag === undefined) delete process.env.MIXDOG_AGENT_SHARD_SPREAD;
    else process.env.MIXDOG_AGENT_SHARD_SPREAD = savedFlag;
    if (savedShard === undefined) delete process.env.MIXDOG_SESSION_SHARD_PID;
    else process.env.MIXDOG_SESSION_SHARD_PID = savedShard;
  }
});

test('remote create rejects cleanly when no daemon is discoverable', async () => {
  const savedRoot = process.env.MIXDOG_RUNTIME_ROOT;
  const emptyRoot = mkdtempSync(join(tmpdir(), 'mixdog-spread-nodaemon-'));
  try {
    process.env.MIXDOG_RUNTIME_ROOT = emptyRoot;
    const spread = createAgentShardSpread({ mgr: { getSession: () => null } });
    await assert.rejects(
      () => spread.createRemoteSession({
        spec: { agent: 'worker' }, provider: 'p', model: 'm', cwd: emptyRoot,
      }),
      /no live daemon discovery/,
    );
  } finally {
    process.env.MIXDOG_RUNTIME_ROOT = savedRoot;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

function createWorkerStubRuntime(options, log = []) {
  let state = { sessionId: '', items: [], busy: false, queued: [] };
  const listeners = new Set();
  const messages = [];
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    receivedOptions: options,
    messages,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reserveSession(id) {
      state = { ...state, sessionId: String(id) };
      publish();
      return true;
    },
    async submitAsync(text, opts) {
      log.push(['submit', String(text)]);
      state = { ...state, busy: true };
      publish();
      setTimeout(() => {
        messages.push({ role: 'user', content: String(text) });
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: `echo: ${String(text).split('\n')[0]}` }],
        });
        state = {
          ...state,
          busy: false,
          items: [
            ...state.items,
            { id: String(opts?.id || messages.length), kind: 'assistant' },
            {
              id: `${String(opts?.id || messages.length)}-done`,
              kind: 'turndone',
              ...(String(text).includes('__CAP__')
                ? { terminationReason: 'iteration_cap', iterations: 6, toolCallsTotal: 9, maxLoopIterations: 6 }
                : {}),
            },
          ],
        };
        publish();
      }, 40);
      return true;
    },
    peekSessionMessages(id, opts = {}) {
      const start = Math.max(0, Math.floor(Number(opts.start) || 0));
      return {
        sessionId: state.sessionId || String(id),
        messageCount: messages.length,
        messages: start > 0 ? messages.slice(start) : messages,
        agent: 'worker',
        status: state.busy ? 'running' : 'idle',
      };
    },
    async abort() {
      state = { ...state, busy: false };
      publish();
      return { aborted: true };
    },
    async dispose() {},
  };
}

async function withStubDaemon(run, sessionFactory) {
  let transport;
  const service = createSessionService({
    createSessionRuntime: sessionFactory,
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport.broadcast(frame, targetTokens),
  });
  transport = createSessionTransport({
    handleCall: (name, args, ctx) => service.handleCall(name, args, ctx),
    clientGraceMs: 50,
    sweepMs: 50,
  });
  const { port, token } = await transport.start();
  writeFileSync(
    join(RUNTIME_ROOT, 'daemon.json'),
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      endpoints: { session: { port, token } },
    }),
  );
  try {
    await run({ service });
  } finally {
    await service.stop('test end');
    await transport.stop();
  }
}

test('session.create forwards the agent session spec and shard avoidance', async () => {
  let captured = null;
  await withStubDaemon(async ({ service }) => {
    const created = await service.handleCall('session.create', {
      cwd: RUNTIME_ROOT,
      provider: 'prov',
      model: 'mod',
      agentSession: { agent: 'worker', agentTag: 'w-passthrough' },
      avoidShardIndex: 3,
    }, null);
    assert.ok(String(created?.sessionId || ''));
    assert.equal(captured?.agentSession?.agent, 'worker');
    assert.equal(captured?.agentSession?.agentTag, 'w-passthrough');
    assert.equal(captured?.avoidShardIndex, 3);
  }, async (options) => {
    captured = options;
    return createWorkerStubRuntime(options);
  });
});

function waitFor(predicate, message, timeoutMs = 4000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = predicate(); } catch (error) { rejectPromise(error); return; }
      if (value) { resolvePromise(value); return; }
      if (Date.now() - started > timeoutMs) { rejectPromise(new Error(`timeout: ${message}`)); return; }
      // Referenced timer on purpose: this poll may be the only thing keeping
      // the test event loop alive while the service sweep (unref'd) runs.
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('idle agent-hosted sessions evict sooner than interactive ones', async () => {
  const disposed = [];
  let transport;
  const service = createSessionService({
    createSessionRuntime: async (options) => {
      const runtime = createWorkerStubRuntime(options);
      runtime.dispose = async (reason) => {
        disposed.push(options.agentSession ? 'agent' : 'lead');
        void reason;
      };
      return runtime;
    },
    publishIntervalMs: 5,
    onFrame: (frame, targetTokens) => transport?.broadcast?.(frame, targetTokens),
    evictSweepMs: 40,
    idleEvictMs: 60_000,
    agentIdleEvictMs: 120,
  });
  try {
    const agentCreated = await service.handleCall('session.create', {
      cwd: RUNTIME_ROOT,
      agentSession: { agent: 'worker', agentTag: 'w-evict' },
    }, null);
    const leadCreated = await service.handleCall('session.create', { cwd: RUNTIME_ROOT }, null);
    assert.ok(String(agentCreated?.sessionId || '') && String(leadCreated?.sessionId || ''));
    await waitFor(() => disposed.includes('agent'), 'the idle agent runtime is evicted fast');
    assert.ok(!disposed.includes('lead'), 'the interactive runtime keeps the long idle window');
  } finally {
    await service.stop('test end');
  }
});

test('the spread mgr runs a remote worker turn end to end', async () => {
  const runtimes = [];
  await withStubDaemon(async () => {
    const fakeMgr = {
      getSession: () => null,
      listSessions: () => [],
      askSession: async () => { throw new Error('in-process ask must not run'); },
      closeSession: () => false,
      enqueuePendingMessage: () => 0,
    };
    const spread = createAgentShardSpread({ mgr: fakeMgr });
    try {
      const spec = {
        agent: 'worker',
        presetName: 'stub',
        preset: { provider: 'prov', model: 'mod', effort: 'high' },
        runtimeSpec: { scopeKey: 'scope', lane: 'agent' },
        agentTag: 'w-e2e',
        cwd: RUNTIME_ROOT,
        ownerSessionId: 'sess_lead',
        clientHostPid: process.pid,
      };
      const handle = await spread.createRemoteSession({
        spec,
        provider: 'prov',
        model: 'mod',
        cwd: RUNTIME_ROOT,
      });
      const sessionId = handle.facade.id;
      assert.ok(sessionId, 'remote create returns a durable session id');
      assert.equal(runtimes.length, 1);
      assert.equal(runtimes[0].receivedOptions?.agentSession?.agentTag, 'w-e2e');

      const mgr = spread.mgr;
      assert.equal(mgr.getSession(sessionId), handle.facade, 'getSession routes to the facade');
      assert.ok(mgr.listSessions().includes(handle.facade), 'listSessions merges remote facades');
      assert.equal(mgr.getSessionProgressSnapshot(sessionId), null);
      assert.equal(typeof mgr.getSessionLastProgressAt(sessionId), 'number');

      let terminal = null;
      const result = await mgr.askSession(
        sessionId, 'do the thing', 'caller context block', null, null, null,
        { onTerminalResult: (value) => { terminal = value; } },
      );
      assert.equal(result.content, 'echo: do the thing');
      assert.equal(terminal?.content, 'echo: do the thing');
      assert.ok(handle.facade.messages.length >= 2, 'raw messages land on the facade');
      assert.match(String(runtimes[0].messages[0]?.content || ''), /caller context block/,
        'the ask context folds into the remote prompt');
      assert.equal(mgr.getSession(sessionId).status, 'idle');
      assert.equal(result.terminationReason, undefined, 'a normal finish carries no abnormal tag');

      // Abnormal finish parity: terminal metadata rides the turndone marker so
      // the Lead-side classifier sees the same terminationReason in-process
      // asks return.
      const capped = await mgr.askSession(sessionId, 'retry __CAP__ case', null, null, null, null, {});
      assert.equal(capped.terminationReason, 'iteration_cap');
      assert.equal(capped.maxLoopIterations, 6);
      assert.equal(capped.toolCallsTotal, 9);

      mgr.closeSession(sessionId, 'test close');
      assert.equal(handle.facade.closed, true);
      assert.equal(handle.facade.status, 'closed');
    } finally {
      await spread.close('test end');
    }
  }, async (options) => {
    const runtime = createWorkerStubRuntime(options);
    runtimes.push(runtime);
    return runtime;
  });
});

test('a hidden-role remote dispatch is ephemeral end to end', async () => {
  const runtimes = [];
  await withStubDaemon(async () => {
    const spread = createAgentShardSpread({ mgr: { getSession: () => null } });
    try {
      const raw = await dispatchHiddenAgentRemote({
        spec: {
          agent: 'explorer',
          presetName: 'stub',
          preset: { provider: 'prov', model: 'mod', effort: 'low' },
          runtimeSpec: { scopeKey: 'scope', lane: 'agent' },
          maxLoopIterations: 6,
        },
        provider: 'prov',
        model: 'mod',
        cwd: RUNTIME_ROOT,
        prompt: 'locate the anchor',
        watchdogPolicy: { idleStaleMs: 60_000 },
      });
      assert.equal(raw, 'echo: locate the anchor');
      assert.equal(runtimes[0].receivedOptions?.agentSession?.agent, 'explorer');
      assert.equal(spread.handles.size, 0, 'ephemeral dispatch leaves no registered handle');
    } finally {
      await spread.close('test end');
    }
  }, async (options) => {
    const runtime = createWorkerStubRuntime(options);
    runtimes.push(runtime);
    return runtime;
  });
});
