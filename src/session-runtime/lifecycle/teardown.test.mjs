import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withFileLock } from '../../runtime/shared/file-lock.mjs';
import { exitFlushCount } from '../services/agent-tool/helpers.mjs';
import { createWorkerIndex } from '../services/agent-tool/worker-index.mjs';
import { createCloseAll } from '../services/agent-tool/close-flow/close-all.mjs';
import { createTeardown } from './teardown.mjs';

function fixture({
  session = { id: 's1', messages: [{ role: 'user', content: 'hi' }] },
  flushConfig,
  onCloseSurface,
  agentTool,
  withTeardownDeadline,
} = {}) {
  const calls = [];
  const state = { session, closeRequested: false };
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  const deps = {
    getSession: () => state.session,
    setSession: (value) => {
      state.session = value;
    },
    getMcpScopeId: () => 'scope-1',
    setCloseRequested: (value) => {
      state.closeRequested = value;
    },
    getMemoryModPromise: () => null,
    setMemoryModPromise: () => {},
    hooks: { dispatch: record('hooks.dispatch'), flushRules: record('hooks.flushRules') },
    hookCommonPayload: (payload) => payload,
    mgr: {
      closeSession: (...args) => {
        calls.push(['mgr.closeSession', ...args]);
        return true;
      },
      abortSessionTurn: (...args) => {
        calls.push(['mgr.abortSessionTurn', ...args]);
        return true;
      },
    },
    statusRoutes: { clearGatewaySessionRoute: record('clearGatewaySessionRoute') },
    channels: {
      stop: (...args) => {
        calls.push(['channels.stop', ...args]);
        return Promise.resolve();
      },
    },
    agentTool: agentTool || { closeAll: record('agentTool.closeAll') },
    mcpClient: { disconnectAll: record('mcp.disconnectAll') },
    warmupTimers: { providerWarmupTimer: setTimeout(() => {}, 60_000) },
    prewarmTimers: { channelStartTimer: setTimeout(() => {}, 60_000) },
    flushAllConfigSavesAsync: flushConfig || (async () => calls.push(['flushConfig'])),
    withTeardownDeadline: withTeardownDeadline || (async (work) => await work),
    closePatchRuntimeIfLoaded: (...args) => {
      calls.push(['closePatchRuntime', ...args]);
      return null;
    },
    closeNativeToolTransports: record('closeNativeToolTransports'),
    stopSelfUpdateBootCheck: record('stopSelfUpdateBootCheck'),
    invalidateContextStatusCache: record('invalidateContextStatusCache'),
    notificationListeners: new Set(),
    clearRuntimeNotifications: record('clearRuntimeNotifications'),
    goalRuntime: { close: () => calls.push(['goal.close']) },
    disposeSessionTitles: record('disposeSessionTitles'),
    disposeInternalTools: record('disposeInternalTools'),
    disposeGlobalExtensionSubscription: record('disposeGlobalExtensionSubscription'),
    abortActiveTurns: (error) => {
      calls.push(['abortActiveTurns', error.reason]);
      return false;
    },
    getReservedSessionId: () => 'reserved-1',
  };
  const teardown = createTeardown(deps, {
    ingestSessionIntoMemory: async (s) => calls.push(['ingest', s?.id ?? null]),
    closeSurfaceSession: (s, reason, opts) => {
      calls.push(['closeSurfaceSession', s.id, reason, opts]);
      onCloseSurface?.(s);
      return true;
    },
    cancelBackgroundTasks: record('cancelBackgroundTasks'),
  });
  const named = (name) => calls.filter(([n]) => n === name);
  const cleanup = () => {
    clearTimeout(deps.warmupTimers.providerWarmupTimer);
    clearTimeout(deps.prewarmTimers.channelStartTimer);
  };
  return { teardown, deps, calls, state, named, cleanup };
}

test("close on process exit reaps every session's work and tombstones only a scratch session", async () => {
  const f = fixture();
  assert.equal(await f.teardown.close('cli-exit'), true);
  assert.equal(f.state.closeRequested, true);
  assert.equal(f.state.session, null);
  // The exit cuts the work off: the next process tells each owner (restart-notify).
  assert.deepEqual(f.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'cli-exit', notify: false, terminalReason: 'process-restart' }],
  ]);
  assert.deepEqual(f.named('agentTool.closeAll'), [['agentTool.closeAll', 'cli-exit', { processExit: true }]]);
  assert.deepEqual(f.named('closeSurfaceSession'), [['closeSurfaceSession', 's1', 'cli-exit', { tombstone: false }]]);
  assert.deepEqual(f.named('hooks.dispatch'), [['hooks.dispatch', 'SessionEnd', { session_id: 's1', reason: 'exit' }]]);
  assert.deepEqual(f.named('mcp.disconnectAll'), [['mcp.disconnectAll', { scopeId: 'scope-1' }]]);
  assert.deepEqual(f.named('closeNativeToolTransports'), [['closeNativeToolTransports', 'cli-exit']]);
  assert.equal(f.deps.warmupTimers.providerWarmupTimer, null);
  assert.equal(f.deps.prewarmTimers.channelStartTimer, null);
  // Order: SessionEnd hook → memory ingest → config flush → session close.
  const order = f.calls.map(([n]) => n);
  assert.ok(order.indexOf('hooks.dispatch') < order.indexOf('ingest'));
  assert.ok(order.indexOf('ingest') < order.indexOf('flushConfig'));
  assert.ok(order.indexOf('flushConfig') < order.indexOf('closeSurfaceSession'));
  f.cleanup();
});

function rowFor(id, owner) {
  return (byKey) =>
    byKey.set(id, {
      tag: id,
      sessionId: id,
      ownerSessionId: owner,
      agent: 'worker',
      status: 'idle',
      stage: 'idle',
      updatedAt: new Date().toISOString(),
    });
}

function realWorkerIndex() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-teardown-'));
  mkdirSync(join(root, 'sessions'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const worker = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const file = join(root, 'agent-workers.json');
  const readRows = () => JSON.parse(readFileSync(file, 'utf8')).workers;
  // Hold this process's index lock with an async holder until released.
  const holdLock = async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let locked;
    const lockTaken = new Promise((resolve) => {
      locked = resolve;
    });
    const holder = withFileLock(`${file}.lock`, async () => {
      locked();
      await gate;
    });
    await lockTaken;
    return async () => {
      release();
      await holder;
    };
  };
  const restore = () => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  };
  const cleanup = () => {
    worker.dispose();
    restore();
  };
  // Waits for the index to drain before the environment and directory go away,
  // so a test that failed mid-write cannot leave a writer for the next test.
  const cleanupAsync = async () => {
    try {
      await worker.disposeAsync();
    } finally {
      restore();
    }
  };
  return { worker, readRows, holdLock, cleanup, cleanupAsync };
}

const shortDeadline = (work, _ms, fallback) =>
  Promise.race([Promise.resolve(work), new Promise((resolve) => setTimeout(() => resolve(fallback), 20))]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('close waits for agent closing to finish before draining the index writers', async () => {
  const events = [];
  let finishClose;
  const f = fixture({
    agentTool: {
      closeAll: () =>
        new Promise((resolve) => {
          events.push('closeAll:start');
          finishClose = () => {
            events.push('closeAll:final-write');
            resolve();
          };
        }),
      flushIndexWrites: async () => {
        events.push('drain');
      },
      disposeAsync: async () => {
        events.push('disposeAsync');
      },
    },
  });
  const closing = f.teardown.close('cli-exit', { detach: true });
  await sleep(20);
  assert.deepEqual(events, ['closeAll:start'], 'no drain while closing is still producing writes');
  finishClose();
  await closing;
  assert.deepEqual(
    events,
    ['closeAll:start', 'closeAll:final-write', 'drain', 'disposeAsync'],
    'drain only after closing, then release'
  );
  f.cleanup();
});

test('a close that outlives the teardown deadline drains only after it settles', async () => {
  const events = [];
  let finishClose;
  let disposed;
  const disposalDone = new Promise((resolve) => {
    disposed = resolve;
  });
  const f = fixture({
    withTeardownDeadline: shortDeadline,
    agentTool: {
      closeAll: () =>
        new Promise((resolve) => {
          events.push('closeAll:start');
          finishClose = () => {
            events.push('closeAll:final-write');
            resolve();
          };
        }),
      flushIndexWrites: async () => {
        events.push('drain');
      },
      disposeAsync: async () => {
        events.push('disposeAsync');
        disposed();
      },
    },
  });
  await f.teardown.close('cli-exit', { detach: true });
  await sleep(40);
  assert.deepEqual(events, ['closeAll:start'], 'teardown returned past the deadline without draining or disposing');
  finishClose();
  await disposalDone;
  assert.deepEqual(events, ['closeAll:start', 'closeAll:final-write', 'drain', 'disposeAsync']);
  f.cleanup();
});

test('overlapping closes each run their own closeAll and their rows reach disk', async () => {
  const idx = realWorkerIndex();
  let closeCalls = 0;
  const closes = [];
  const f = fixture({
    withTeardownDeadline: shortDeadline,
    agentTool: {
      closeAll: () => {
        closeCalls += 1;
        const id = `row${closeCalls}`;
        const run = (async () => {
          await sleep(closeCalls === 1 ? 60 : 0); // close #1 outlives its deadline
          idx.worker.queueWorkerIndexMutation(rowFor(id, 'lead-a'));
        })();
        closes.push(run);
        return run;
      },
      flushIndexWrites: () => idx.worker.flushWorkerIndexWrites(),
      disposeAsync: () => idx.worker.disposeAsync(),
    },
  });
  try {
    await f.teardown.close('cli-exit', { detach: true }); // returns past its deadline
    await f.teardown.close('cli-exit', { detach: true });
    assert.equal(closeCalls, 2, 'each close ran its own closeAll');
    // A close that returned past its deadline keeps writing: read the disk only
    // once both closeAll bodies finished and their queued rows were flushed.
    await Promise.all(closes);
    await idx.worker.flushWorkerIndexWrites();
    const rows = idx.readRows();
    assert.equal(rows.row1?.sessionId, 'row1');
    assert.equal(rows.row2?.sessionId, 'row2');
  } finally {
    // A failed assertion must not restore the environment under a live writer.
    await Promise.allSettled(closes);
    f.cleanup();
    await idx.cleanupAsync();
  }
});

test("a process-exit close after a Lead A scoped close still closes Lead B's worker", async () => {
  const idx = realWorkerIndex();
  const before = exitFlushCount();
  const entries = [
    { tag: 'wa', session: { id: 'wa' }, owner: 'lead-a' },
    { tag: 'wb', session: { id: 'wb' }, owner: 'lead-b' },
  ];
  const closedSessions = [];
  const registry = {
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
    reapTimers: new Map(),
    clearScheduledReaps: () => {},
    refreshTagsFromSessions: () => {},
    agentSessionEntries: ({ context }) =>
      entries.filter((entry) => !context?.callerSessionId || entry.owner === context.callerSessionId),
    flushWorkerIndexMutations: idx.worker.flushWorkerIndexMutations,
    writeWorkerRows: idx.worker.writeWorkerRows,
  };
  const closeAll = createCloseAll({
    registry,
    close: async ({ sessionId }) => {
      closedSessions.push(sessionId);
      return { closed: true, sessionId };
    },
  });
  const f = fixture({
    session: { id: 'lead-a', messages: [{ role: 'user', content: 'hi' }] },
    agentTool: {
      closeAll,
      flushIndexWrites: () => idx.worker.flushWorkerIndexWrites(),
      disposeAsync: () => idx.worker.disposeAsync(),
    },
  });
  let releaseLock = null;
  let scoped;
  let exit;
  try {
    idx.worker.queueWorkerIndexMutation(rowFor('wa', 'lead-a'));
    idx.worker.queueWorkerIndexMutation(rowFor('wb', 'lead-b'));
    await idx.worker.flushWorkerIndexWrites();
    releaseLock = await idx.holdLock(); // the scoped close's drain blocks on the lock
    idx.worker.queueWorkerIndexMutation(rowFor('wa', 'lead-a'));
    scoped = f.teardown.close('dispose', { detach: true }); // Lead A's scoped teardown
    await sleep(50);
    f.state.session = { id: 'lead-b', messages: [] };
    exit = f.teardown.close('cli-exit'); // process exit while the scoped drain is blocked
    await sleep(30);
    assert.equal(exitFlushCount(), before, 'exit hook kept until the final drain');
    await releaseLock();
    releaseLock = null;
    await Promise.all([scoped, exit]);
    assert.deepEqual(closedSessions, ['wa', 'wb'], 'only process exit closes delegated sessions');
    // The next process lists them (finished) or settles them (cut off).
    assert.deepEqual(Object.keys(idx.readRows()).sort(), ['wa', 'wb'], 'the exit keeps the worker rows');
    assert.equal(exitFlushCount(), before - 1, 'exit hook released at final shutdown');
  } finally {
    // A failed assertion still frees the held lock and lets both closes finish.
    if (releaseLock) await releaseLock();
    await Promise.allSettled([scoped, exit]);
    f.cleanup();
    await idx.cleanupAsync();
  }
});
test('repeated idle evictions leave no growth in exit callbacks or registrations', async () => {
  const idx = realWorkerIndex();
  const baseline = exitFlushCount() - 1; // the helper's own worker index
  const exitListeners = process.listenerCount('exit');
  const fixtures = [];
  const indexes = [];
  try {
    for (let i = 0; i < 30; i += 1) {
      const evicted = createWorkerIndex({
        dataDir: process.env.MIXDOG_DATA_DIR,
        cfgMod: { loadConfig: () => ({}) },
        mgr: { getSessionRuntime: () => null },
        tags: new Map(),
        tagAgents: new Map(),
        tagCwds: new Map(),
      });
      indexes.push(evicted);
      evicted.queueWorkerIndexMutation(rowFor(`evicted${i}`, 'lead-a'));
      const f = fixture({
        agentTool: {
          closeAll: () => {},
          flushIndexWrites: () => evicted.flushWorkerIndexWrites(),
          disposeAsync: () => evicted.disposeAsync(),
        },
      });
      fixtures.push(f);
      await f.teardown.close('idle-evict', { keepBackgroundWork: true });
    }
    assert.equal(exitFlushCount(), baseline + 1, 'evicted runtimes released their exit callbacks');
    assert.equal(process.listenerCount('exit'), exitListeners, 'no per-runtime process exit listeners');
    assert.equal(Object.keys(idx.readRows()).length, 30, 'every evicted runtime drained its rows first');
  } finally {
    for (const f of fixtures) f.cleanup();
    for (const evicted of indexes) evicted.dispose();
    idx.cleanup();
  }
});

test('a failed drain keeps the registrations until a later drain succeeds', async () => {
  const idx = realWorkerIndex();
  const before = exitFlushCount();
  let failDrain = true;
  const f = fixture({
    agentTool: {
      closeAll: () => {},
      flushIndexWrites: async () => {},
      disposeAsync: async () => {
        if (failDrain) throw new Error('drain failed');
        return idx.worker.disposeAsync();
      },
    },
  });
  try {
    await f.teardown.close('idle-evict', { keepBackgroundWork: true });
    assert.equal(exitFlushCount(), before, 'kept after a failed drain');
    failDrain = false;
    await f.teardown.close('idle-evict', { keepBackgroundWork: true });
    assert.equal(exitFlushCount(), before - 1, 'released by the later successful drain');
  } finally {
    f.cleanup();
    idx.cleanup();
  }
});

test('two overlapping timed-out process-exit closes dispose once, after both settle', async () => {
  const idx = realWorkerIndex();
  const before = exitFlushCount();
  const finishers = [];
  let disposals = 0;
  // Resolves once the (single) disposal has finished: the assertions wait on
  // the disposal itself, not on a guess of how long the drain takes.
  let disposed;
  const disposalDone = new Promise((resolve) => {
    disposed = resolve;
  });
  const f = fixture({
    withTeardownDeadline: shortDeadline,
    agentTool: {
      closeAll: () =>
        new Promise((resolve) => {
          const n = finishers.length + 1;
          finishers.push(() => {
            idx.worker.queueWorkerIndexMutation(rowFor(`exit${n}`, 'lead-a'));
            resolve();
          });
        }),
      flushIndexWrites: () => idx.worker.flushWorkerIndexWrites(),
      disposeAsync: () => {
        disposals += 1;
        return idx.worker.disposeAsync().finally(disposed);
      },
    },
  });
  try {
    await f.teardown.close('cli-exit', { detach: true }); // times out
    await f.teardown.close('cli-exit', { detach: true }); // times out
    assert.equal(finishers.length, 2);
    finishers[0]();
    await sleep(60);
    assert.equal(disposals, 0, 'no disposal while the second close is still pending');
    assert.equal(exitFlushCount(), before, 'exit hook kept while a close is outstanding');
    finishers[1]();
    await disposalDone;
    await sleep(60); // a second, erroneous disposal would land in this window
    assert.equal(disposals, 1, 'disposal ran exactly once');
    assert.equal(exitFlushCount(), before - 1);
    const rows = idx.readRows();
    assert.equal(rows.exit1?.sessionId, 'exit1');
    assert.equal(rows.exit2?.sessionId, 'exit2', "the second close's final write reached disk");
  } finally {
    // Release any close a failed assertion left pending before tearing down.
    for (const finish of finishers) finish();
    f.cleanup();
    await idx.cleanupAsync();
  }
});
test('a synchronous dispose (or none) does not wedge later closes behind a stale disposal slot', async () => {
  const events = [];
  const f = fixture({
    agentTool: {
      closeAll: () => {},
      dispose: () => {
        events.push('dispose');
      },
    },
  });
  await f.teardown.close('idle-evict', { keepBackgroundWork: true });
  await f.teardown.close('idle-evict', { keepBackgroundWork: true });
  assert.deepEqual(events, ['dispose', 'dispose']);
  f.cleanup();
  const none = fixture({ agentTool: { closeAll: () => {} } });
  await none.teardown.close('idle-evict', { keepBackgroundWork: true });
  await none.teardown.close('cli-exit');
  none.cleanup();
});
test("a non-exit close reaps only this session's work, with notification", async () => {
  const f = fixture();
  await f.teardown.close('dispose', { detach: true });
  assert.deepEqual(f.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'dispose', notify: true, executionSessionId: 's1' }],
  ]);
  assert.deepEqual(f.named('agentTool.closeAll'), []);
  assert.deepEqual(f.named('closePatchRuntime'), [['closePatchRuntime', { waitForExit: false }]]);
  assert.deepEqual(f.named('channels.stop'), [
    ['channels.stop', 'dispose', { waitForExit: false, preserveRemoteIntent: true }],
  ]);
  assert.deepEqual(f.named('closeNativeToolTransports'), []);
  assert.deepEqual(f.named('hooks.dispatch'), [
    ['hooks.dispatch', 'SessionEnd', { session_id: 's1', reason: 'other' }],
  ]);
  f.cleanup();
});

test('keepBackgroundWork leaves jobs and agent workers to the re-materialized owner', async () => {
  const f = fixture();
  await f.teardown.close('idle-evict', { keepBackgroundWork: true });
  assert.deepEqual(f.named('cancelBackgroundTasks'), []);
  assert.deepEqual(f.named('agentTool.closeAll'), []);
  assert.equal(f.named('goal.close').length, 1);
  f.cleanup();
});

test('a scratch session is tombstoned and an empty runtime closes without a session', async () => {
  const scratch = fixture({ session: { id: 's2', messages: [] } });
  await scratch.teardown.close('cli-exit');
  assert.deepEqual(scratch.named('closeSurfaceSession'), [
    ['closeSurfaceSession', 's2', 'cli-exit', { tombstone: true }],
  ]);
  scratch.cleanup();

  const empty = fixture({ session: null });
  assert.equal(await empty.teardown.close('cli-exit'), false);
  assert.deepEqual(empty.named('hooks.dispatch'), []);
  assert.deepEqual(empty.named('cancelBackgroundTasks'), [
    ['cancelBackgroundTasks', { reason: 'cli-exit', notify: false, terminalReason: 'process-restart' }],
  ]);
  empty.cleanup();
});

test('closeCanonicalSession fences execution without tombstoning a conversation', () => {
  const f = fixture();
  assert.equal(f.teardown.closeCanonicalSession(), true);
  assert.deepEqual(f.named('mgr.closeSession'), [
    ['mgr.closeSession', 's1', 'canonical-session-close', { tombstone: false }],
  ]);
  assert.equal(f.state.session, null);
  assert.deepEqual(f.named('channels.stop'), []);
  f.cleanup();
});

test('a config flush failure at teardown is reported instead of silently losing the write', async () => {
  const f = fixture({
    flushConfig: async () => {
      throw new Error('config lock busy');
    },
  });
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    assert.equal(await f.teardown.close('cli-exit'), true, 'teardown still completes');
    await new Promise((resolve) => setImmediate(resolve));
    const flushWarnings = warnings.filter((warning) => warning.code === 'TEARDOWN_CONFIG_FLUSH_FAILED');
    assert.equal(flushWarnings.length, 1);
    assert.match(flushWarnings[0].message, /config lock busy/);
    assert.deepEqual(f.named('closeSurfaceSession'), [['closeSurfaceSession', 's1', 'cli-exit', { tombstone: false }]]);
  } finally {
    process.off('warning', onWarning);
    f.cleanup();
  }
});

test('concurrent teardowns close their sessions one per event-loop turn, in order', async () => {
  // A heartbeat that re-queues itself runs once per loop iteration; the
  // value it has reached when a close runs identifies that close's turn.
  let turn = 0;
  let beating = true;
  const beat = () => {
    turn += 1;
    if (beating) setImmediate(beat);
  };
  setImmediate(beat);
  const closes = [];
  const fixtures = Array.from({ length: 6 }, (_, i) =>
    fixture({
      session: { id: `evict-${i}`, messages: [{ role: 'user', content: 'hi' }] },
      onCloseSurface: (s) => closes.push({ id: s.id, turn }),
    })
  );
  try {
    const results = await Promise.all(
      fixtures.map((f) => f.teardown.close('idle and unwatched', { keepBackgroundWork: true }))
    );
    assert.deepEqual(
      results,
      fixtures.map(() => true)
    );
    assert.deepEqual(
      closes.map((c) => c.id),
      fixtures.map((_, i) => `evict-${i}`)
    );
    const perTurn = new Map();
    for (const { turn: t } of closes) perTurn.set(t, (perTurn.get(t) || 0) + 1);
    assert.equal(Math.max(...perTurn.values()), 1, 'never two session closes in one loop turn');
    for (const f of fixtures) assert.equal(f.state.session, null);
  } finally {
    beating = false;
    for (const f of fixtures) f.cleanup();
  }
});

test('abort reports whether the outer turn or the manager turn was aborted', () => {
  const f = fixture();
  assert.equal(f.teardown.abort('cli-abort'), true);
  assert.deepEqual(f.named('abortActiveTurns'), [['abortActiveTurns', 'cli-abort']]);
  assert.deepEqual(f.named('mgr.abortSessionTurn'), [['mgr.abortSessionTurn', 's1', 'cli-abort']]);
  const empty = fixture({ session: null });
  assert.equal(empty.teardown.abort(), false);
  empty.cleanup();
  f.cleanup();
});
