import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-eager-scoped-generation-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { processToolBatch } = await import('../tool-batch.mjs');
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');
const { createEagerEntry, runEagerEntry } = await import('../eager-dispatch/entry.mjs');
const { invalidateBuiltinResultCache } = await import('../../tools/builtin/cache-layers.mjs');
const { createScopedCacheOutcome } = await import('./scoped-cache-outcome.mjs');
const { clearScopedToolsForSession, scopedCacheGeneration, tryScopedToolCached } = await import('./scoped-cache.mjs');
// Imported runtimes flush their fixture state before this exit listener.
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const tools = [{ name: 'grep', annotations: { readOnlyHint: true } }];
const call = (pattern = 'needle') => ({
  id: randomUUID(), name: 'grep', arguments: { path: root, pattern },
});
const cacheSpec = (fx, target) => ({
  sessionId: fx.sessionId, toolName: target.name, args: target.arguments, cwd: root,
});

function fixture(t) {
  const fx = {
    sessionId: randomUUID(), sessionRef: { schemaAllowedTools: null, _scopedCacheOutcomeByCallId: new Map() },
    crossTurnCalls: new Map(), messages: [], iterations: 0, dedupStubTotal: 0, editCount: 0,
    revision: 'before', counts: new Map(),
  };
  fx.leaf = async () => fx.revision;
  fx.executeToolFn = async (_name, args, _cwd, _sessionId, sessionRef, options) => {
    fx.counts.set(args.pattern, (fx.counts.get(args.pattern) || 0) + 1);
    sessionRef._scopedCacheOutcomeByCallId.set(options.toolCallId, createScopedCacheOutcome());
    return fx.leaf(args);
  };
  t.after(() => clearScopedToolsForSession(fx.sessionId));
  return fx;
}

// Only the search leaf is injected. Admission, execution/collection,
// invalidation, deferred cache writes and cross-turn receipts are real.
// Streaming starts before collection; fallback starts inside the first
// executeBatchCall, allowing a slow first call to delay later collection.
function round(fx, calls, mode, opts = {}) {
  fx.iterations += 1;
  const dispatcher = createEagerDispatcher({
    tools, cwd: root, sessionId: fx.sessionId, sessionRef: fx.sessionRef,
    signal: null, opts, crossTurnCalls: fx.crossTurnCalls,
    getIterations: () => fx.iterations, getNextIteration: () => fx.iterations,
    repeatFailLimit: 3, executeToolFn: fx.executeToolFn,
  });
  if (mode === 'streaming') for (const item of calls) dispatcher.onToolCall(item);
  let collected;
  return {
    dispatcher,
    collect() {
      if (!collected) {
        const results = [];
        collected = processToolBatch({
          calls, messages: fx.messages, tools, cwd: root,
          sessionId: fx.sessionId, sessionRef: fx.sessionRef, signal: null, opts,
          iterations: fx.iterations,
          assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
          pending: dispatcher.pending, epoch: dispatcher.epoch,
          startEagerRun: mode === 'serial' ? () => {} : dispatcher.startEagerRun,
          crossTurnCalls: fx.crossTurnCalls, crossTurnCap: 100, sessionAgent: null,
          pushToolResultMessage: (message) => { results.push(message); fx.messages.push(message); },
          throwIfAborted: () => {}, repeatFailLimit: 3,
          dedupStubTotal: fx.dedupStubTotal, editCount: fx.editCount,
          executeToolFn: fx.executeToolFn,
        }).then((stats) => {
          Object.assign(fx, stats);
          assert.equal(fx.sessionRef._scopedCacheOutcomeByCallId.size, 0, 'outcome records are reclaimed');
          return results;
        });
      }
      return collected;
    },
  };
}

async function assertFreshThenReusable(fx, mode) {
  fx.leaf = async () => fx.revision;
  const fresh = (await round(fx, [call()], mode).collect())[0];
  assert.equal(fresh.content, 'after');
  assert.equal(fresh.toolKind, 'normal');
  assert.equal(fx.counts.get('needle'), 2, 'refresh executes exactly once');
  assert.equal(tryScopedToolCached(cacheSpec(fx, call()))?.content, 'after');
  const reused = (await round(fx, [call()], mode).collect())[0];
  assert.equal(reused.toolKind, 'skipped');
  assert.match(reused.content, /cross-turn-dedup/);
  assert.equal(fx.counts.get('needle'), 2, 'unchanged fresh results remain reusable');
}

const invalidations = {
  watcher: () => invalidateBuiltinResultCache([join(root, 'changed.txt')]),
  'session clear': (fx) => clearScopedToolsForSession(fx.sessionId),
};
for (const mode of ['streaming', 'fallback']) {
  for (const phase of ['running', 'settled']) {
    for (const [label, invalidate] of Object.entries(invalidations)) {
      test(`${mode}: ${label} after search is ${phase} prevents stale cache repopulation`, { timeout: 10_000 }, async (t) => {
        const fx = fixture(t);
        const started = Promise.withResolvers();
        const releaseSearch = Promise.withResolvers();
        const releaseFirst = Promise.withResolvers();
        fx.leaf = async (args) => {
          if (args.pattern === 'blocker') return releaseFirst.promise;
          const snapshot = fx.revision;
          started.resolve();
          if (phase === 'running') await releaseSearch.promise;
          return snapshot;
        };
        const target = call();
        const run = round(fx, mode === 'fallback' ? [call('blocker'), target] : [target], mode);
        let collecting = mode === 'fallback' ? run.collect() : null;
        try {
          await started.promise;
          const entry = run.dispatcher.pending.get(target.id);
          assert.ok(entry, 'the target is genuinely eager, not a serial stand-in');
          if (phase === 'settled') await entry.promise;
          const before = scopedCacheGeneration();
          fx.revision = 'after';
          invalidate(fx);
          assert.ok(scopedCacheGeneration() > before);
          releaseSearch.resolve();
          releaseFirst.resolve('blocker result');
          collecting ??= run.collect();
          const results = await collecting;
          assert.equal(results.at(-1).content, 'before', 'the active caller retains its original observation');
          assert.equal(fx.counts.get('needle'), 1, 'invalidation does not replay the active call');
          assert.equal(tryScopedToolCached(cacheSpec(fx, target)), null, 'old results must not acquire the new generation');
          await assertFreshThenReusable(fx, mode);
        } finally {
          releaseSearch.resolve();
          releaseFirst.resolve('blocker result');
          if (collecting) await collecting;
          else await Promise.all([...run.dispatcher.pending.values()].map((entry) => entry.promise));
        }
      });
    }
  }
}

for (const mode of ['serial', 'fallback', 'streaming']) {
  test(`${mode}: invalidation during the pre-execution hook does not disqualify a later fresh search`, { timeout: 10_000 }, async (t) => {
    const fx = fixture(t);
    const waiting = Promise.withResolvers();
    const release = Promise.withResolvers();
    const target = call();
    const run = round(fx, [target], mode, {
      beforeToolExecution: async () => { waiting.resolve(); await release.promise; },
    });
    const collecting = run.collect();
    try {
      await waiting.promise;
      assert.equal(fx.counts.get('needle'), undefined);
      fx.revision = 'after';
      clearScopedToolsForSession(fx.sessionId);
      release.resolve();
      const results = await collecting;
      assert.equal(results[0].content, 'after');
      assert.equal(tryScopedToolCached(cacheSpec(fx, target))?.content, 'after');
      const reused = (await round(fx, [call()], mode).collect())[0];
      assert.equal(reused.toolKind, 'skipped');
      assert.equal(fx.counts.get('needle'), 1);
    } finally {
      release.resolve();
      await collecting;
    }
  });
}

test('serial: invalidation during execution still rejects the old result', { timeout: 10_000 }, async (t) => {
  const fx = fixture(t);
  fx.leaf = async () => {
    const snapshot = fx.revision;
    fx.revision = 'after';
    clearScopedToolsForSession(fx.sessionId);
    return snapshot;
  };
  const target = call();
  const results = await round(fx, [target], 'serial').collect();
  assert.equal(results[0].content, 'before');
  assert.equal(tryScopedToolCached(cacheSpec(fx, target)), null);
  await assertFreshThenReusable(fx, 'serial');
});

test('eager generation is sampled after ordering barriers, not admission', { timeout: 10_000 }, async (t) => {
  const fx = fixture(t);
  const waiting = Promise.withResolvers();
  const release = Promise.withResolvers();
  const entry = createEagerEntry({ mutationEpoch: 0 });
  const promise = runEagerEntry({
    call: call(), entry, preceding: {}, opts: {}, sessionId: fx.sessionId, cwd: root,
    waitForPreceding: async () => { waiting.resolve(); await release.promise; return null; },
    execute: async () => 'after',
  });
  try {
    await waiting.promise;
    const admittedGeneration = scopedCacheGeneration();
    clearScopedToolsForSession(fx.sessionId);
    const executionGeneration = scopedCacheGeneration();
    assert.ok(executionGeneration > admittedGeneration);
    release.resolve();
    assert.equal((await promise).value, 'after');
    assert.equal(entry.scopedGeneration, executionGeneration);
  } finally {
    release.resolve();
    await promise;
  }
});

test('an eager result without execution-generation evidence cannot populate the scoped cache', async (t) => {
  const fx = fixture(t);
  const target = call();
  const run = round(fx, [target], 'streaming');
  const entry = run.dispatcher.pending.get(target.id);
  await entry.promise;
  delete entry.scopedGeneration;
  assert.equal((await run.collect())[0].content, 'before');
  assert.equal(tryScopedToolCached(cacheSpec(fx, target)), null);
});
