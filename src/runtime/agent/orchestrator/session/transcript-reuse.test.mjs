// A transcript rebuild can remove delivered bodies even when no compaction
// runs. Exercise the real request boundary, cache and both dispatch paths.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-transcript-reuse-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { beginIteration } = await import('./loop/send-phase.mjs');
const { createLoopState } = await import('./loop/loop-state.mjs');
const { processToolBatch } = await import('./tool-batch.mjs');
const { createEagerDispatcher } = await import('./eager-dispatch.mjs');
const { clearReadDedupSession } = await import('./cache/read-cache.mjs');
const { tryScopedToolCached } = await import('./cache/scoped-cache.mjs');
const { createScopedCacheOutcome } = await import('./cache/scoped-cache-outcome.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const tools = [{ name: 'glob', annotations: { readOnlyHint: true } }];

function fixture(t, mode = 'serial') {
  const cwd = mkdtempSync(join(root, 'case-'));
  const sessionId = `transcript-reuse-${randomUUID()}`;
  const session = {
    id: sessionId, owner: 'agent', provider: 'transcript-reuse', model: 'fake-model', cwd,
    tools: [], compaction: { auto: false }, schemaAllowedTools: null,
  };
  const provider = { name: 'transcript-reuse', async send() { throw new Error('no model request expected'); } };
  const state = createLoopState({
    provider, messages: [{ role: 'user', content: 'Inspect the files.' }], model: 'fake-model', tools, cwd,
    sendOpts: { session, sessionId },
  });
  t.after(() => clearReadDedupSession(sessionId));
  return { state, mode, args: { path: cwd, pattern: '*.txt', sort: 'natural', limit: 25 }, executions: 0 };
}

const cached = (fx) => tryScopedToolCached({
  sessionId: fx.state.sessionId, toolName: 'glob', cwd: fx.state.cwd, args: fx.args, touch: false,
});

async function globRound(fx) {
  const { state, args } = fx;
  const call = { id: randomUUID(), name: 'glob', arguments: args };
  const assistant = { role: 'assistant', content: '', toolCalls: [call] };
  const results = [];
  state.iterations += 1;
  // Only the search leaf is injected. Call/result pairing, outcome ownership,
  // deferred cache insertion and receipt recording use production code.
  const executeToolFn = async (_name, _args, _cwd, _sid, session, options) => {
    fx.executions += 1;
    session._scopedCacheOutcomeByCallId ??= new Map();
    session._scopedCacheOutcomeByCallId.set(options.toolCallId, createScopedCacheOutcome());
    return `snapshot-${fx.executions}.txt`;
  };
  const dispatcher = createEagerDispatcher({
    tools, cwd: state.cwd, sessionId: state.sessionId, sessionRef: state.sessionRef,
    signal: null, opts: {}, crossTurnCalls: state.crossTurnCalls,
    getIterations: () => state.iterations, getNextIteration: () => state.iterations,
    repeatFailLimit: 3, executeToolFn,
  });
  if (fx.mode === 'streaming') {
    dispatcher.onToolCall(call);
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
  }
  state.messages.push(assistant);
  const stats = await processToolBatch({
    calls: [call], messages: state.messages, tools, cwd: state.cwd,
    sessionId: state.sessionId, sessionRef: state.sessionRef, signal: null, opts: {},
    iterations: state.iterations, assistantTurnMsg: assistant,
    pending: dispatcher.pending, epoch: dispatcher.epoch,
    startEagerRun: fx.mode === 'serial' ? () => {} : dispatcher.startEagerRun,
    crossTurnCalls: state.crossTurnCalls, crossTurnCap: 100, sessionAgent: null,
    pushToolResultMessage: (message) => { results.push(message); state.messages.push(message); },
    throwIfAborted: () => {}, repeatFailLimit: 3,
    dedupStubTotal: state.dedupStubTotal, editCount: state.editCount, executeToolFn,
  });
  Object.assign(state, stats);
  assert.equal(results.length, 1);
  return results[0];
}

function orphanDeliveredResult(state) {
  const index = state.messages.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length);
  assert.ok(index >= 0);
  state.messages.splice(index, 1);
}

function removeDeliveredBody(state) {
  const index = state.messages.findIndex((m) => m.role === 'tool');
  assert.ok(index >= 0);
  state.messages.splice(index, 1);
}

async function assertRepairAndRedelivery(fx) {
  const { state } = fx;
  const map = state.crossTurnCalls;
  const beforeCache = cached(fx);
  assert.ok(map.size > 0);
  assert.ok(beforeCache);
  const history = state.messages;
  await beginIteration(state);
  assert.equal(state.messages, history, 'repair keeps the live transcript array');
  assert.equal(state.crossTurnCalls, map, 'clear in place for shared dispatcher references');
  assert.equal(map.size, 0, 'no receipt survives the transcript rebuild');
  assert.equal(state.iterations, 1, 'this was repair, not compaction');
  assert.ok(!history.some((m) => m.role === 'tool' && m.content === 'snapshot-1.txt'));
  assert.deepEqual(cached(fx), beforeCache, 'keep the valid body, source id and original TTL');
  const delivered = await globRound(fx);
  assert.equal(delivered.content, 'snapshot-1.txt');
  assert.equal(delivered.toolKind, 'scoped-cache-hit');
  assert.equal(fx.executions, 1, 'redelivery needs no search replay');
  const referenced = await globRound(fx);
  assert.equal(referenced.toolKind, 'skipped');
  assert.match(referenced.content, /iteration 2/);
  assert.equal(fx.executions, 1);
}

for (const mode of ['serial', 'fallback', 'streaming']) {
  for (const [shape, damage] of [
    ['orphan removal', orphanDeliveredResult],
    ['missing-result replacement', removeDeliveredBody],
  ]) {
    test(`${shape} clears receipts before ${mode} reuse and re-delivers the cached body`, async (t) => {
      const fx = fixture(t, mode);
      assert.equal((await globRound(fx)).content, 'snapshot-1.txt');
      damage(fx.state);
      await assertRepairAndRedelivery(fx);
      assert.equal(fx.state.opts.cacheBreakIntent, 'transcript_rebuild');
    });
  }

  test(`an unchanged transcript retains references across the request boundary (${mode})`, async (t) => {
    const fx = fixture(t, mode);
    await globRound(fx);
    const map = fx.state.crossTurnCalls;
    const receipts = [...map];
    const history = fx.state.messages.slice();
    await beginIteration(fx.state);
    assert.equal(fx.state.crossTurnCalls, map);
    assert.deepEqual([...map], receipts);
    assert.deepEqual(fx.state.messages, history);
    assert.equal(fx.state.opts.cacheBreakIntent, undefined);
    assert.equal((await globRound(fx)).toolKind, 'skipped');
    assert.equal(fx.executions, 1);
  });
}

test('an existing cache-break intent cannot suppress reference invalidation', async (t) => {
  const fx = fixture(t);
  await globRound(fx);
  orphanDeliveredResult(fx.state);
  fx.state.opts.cacheBreakIntent = 'automatic_compaction';
  await assertRepairAndRedelivery(fx);
  assert.equal(fx.state.opts.cacheBreakIntent, 'automatic_compaction', 'keep the original observability tag');
});

test('repair only clears the affected loop, not another session or its cached result', async (t) => {
  const changed = fixture(t);
  const other = fixture(t);
  await globRound(changed);
  await globRound(other);
  const otherReceipts = [...other.state.crossTurnCalls];
  const otherCache = cached(other);
  orphanDeliveredResult(changed.state);
  await assertRepairAndRedelivery(changed);
  assert.deepEqual([...other.state.crossTurnCalls], otherReceipts);
  assert.deepEqual(cached(other), otherCache);
  assert.equal((await globRound(other)).toolKind, 'skipped');
  assert.equal(other.executions, 1);
});

test('request-boundary callers without a receipt map still repair normally', async (t) => {
  const fx = fixture(t);
  await globRound(fx);
  orphanDeliveredResult(fx.state);
  delete fx.state.crossTurnCalls;
  await beginIteration(fx.state);
  assert.ok(!fx.state.messages.some((m) => m.role === 'tool'));
  assert.equal(fx.state.opts.cacheBreakIntent, 'transcript_rebuild');
});
