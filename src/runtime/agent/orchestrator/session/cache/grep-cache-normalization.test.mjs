import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-cache-normalization-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { prepareGrepArgs, validateBuiltinArgs } = await import('../../tools/builtin/arg-guard.mjs');
const { resolveGrepRequest } = await import('../../tools/builtin/lib/grep-request.mjs');
const { processToolBatch } = await import('../tool-batch.mjs');
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');
const { clearScopedToolsForSession, setScopedToolCached, tryScopedToolCached } = await import('./scoped-cache.mjs');
// Run after the runtime's exit-time fixture flushes.
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const variants = [
  { label: 'default', args: {}, group: 'context' },
  { label: 'public content', args: { mode: 'content' }, group: 'context' },
  { label: 'legacy context', args: { output_mode: 'content_with_context' }, group: 'context' },
  { label: 'legacy bare', args: { output_mode: 'content' }, group: 'bare' },
  { label: 'public files', args: { mode: 'files' }, group: 'files' },
  { label: 'legacy files', args: { output_mode: 'files_with_matches' }, group: 'files' },
  { label: 'public count', args: { mode: 'count' }, group: 'count' },
  { label: 'legacy count', args: { output_mode: 'count' }, group: 'count' },
];
const argsFor = (extra = {}) => ({ path: root, pattern: 'needle', ...extra });
const specFor = (sessionId, args) => ({ sessionId, toolName: 'grep', cwd: root, args });

function assertSharedKey(left, right) {
  const sessionId = randomUUID();
  try {
    for (const [first, second] of [[left, right], [right, left]]) {
      clearScopedToolsForSession(sessionId);
      setScopedToolCached({ ...specFor(sessionId, argsFor(first)), content: 'same-request', toolUseId: 'source' });
      assert.equal(tryScopedToolCached(specFor(sessionId, argsFor(second)))?.content, 'same-request');
    }
  } finally {
    clearScopedToolsForSession(sessionId);
  }
}

test('public and legacy grep modes share only execution-equivalent cache keys in both directions', () => {
  const sessionId = randomUUID();
  try {
    for (const first of variants) {
      clearScopedToolsForSession(sessionId);
      setScopedToolCached({ ...specFor(sessionId, argsFor(first.args)), content: first.label, toolUseId: 'source' });
      for (const second of variants) {
        const hit = tryScopedToolCached(specFor(sessionId, argsFor(second.args)));
        assert.equal(hit?.content ?? null, first.group === second.group ? first.label : null,
          `${first.label} -> ${second.label}`);
      }
    }
  } finally {
    clearScopedToolsForSession(sessionId);
  }
});

test('grep context alias precedence and numeric coercion match the execution guard', () => {
  assertSharedKey({ mode: 'content', context: 0, '-C': '3' }, { output_mode: 'content', context: 3 });
  assertSharedKey({ '-A': 0, after: '2' }, { '-A': 2 });
  assertSharedKey({ '-B': 0, before_context: '4' }, { '-B': 4 });
  assertSharedKey({ mode: 'content', context: 0 }, { output_mode: 'content' });
  assertSharedKey({ mode: 'files', context: 2 }, { output_mode: 'files_with_matches' });
  // The executor clamps context counts rather than rejecting negative values.
  assertSharedKey({ mode: 'files', context: -1 }, { output_mode: 'files_with_matches' });
});

test('grep aliases and explicit mode precedence retain caller-owned arguments', () => {
  const input = { directory: root, query: ['needle', 'other'], include: '*.mjs', mode: 'files', limit: '12' };
  const before = structuredClone(input);
  const sessionId = randomUUID();
  try {
    setScopedToolCached({ ...specFor(sessionId, input), content: 'paths', toolUseId: 'source' });
    const canonical = { path: root, pattern: ['needle', 'other'], glob: '*.mjs', output_mode: 'files_with_matches', head_limit: 12 };
    assert.equal(tryScopedToolCached(specFor(sessionId, canonical))?.content, 'paths');
    assert.deepEqual(input, before);
    assert.equal(tryScopedToolCached(specFor(sessionId, input))?.content, 'paths');
    assert.deepEqual(input, before);
  } finally {
    clearScopedToolsForSession(sessionId);
  }
  assertSharedKey({ output_mode: 'count', mode: 'content' }, { output_mode: 'count' });
});

test('clamp notices remain distinct from an unclamped result and caller notices cannot poison the key', () => {
  const sessionId = randomUUID();
  const clamped = argsFor({ mode: 'content', limit: 250 });
  const before = structuredClone(clamped);
  try {
    setScopedToolCached({ ...specFor(sessionId, clamped), content: 'with-clamp-notice' });
    assert.equal(tryScopedToolCached(specFor(sessionId, argsFor({ mode: 'content', limit: 40 }))), null);
    assert.equal(tryScopedToolCached(specFor(sessionId, clamped))?.content, 'with-clamp-notice');
    assert.deepEqual(clamped, before);
    clearScopedToolsForSession(sessionId);
    const withCallerNotice = argsFor({ mode: 'files', _clampNotices: ['caller supplied'] });
    setScopedToolCached({ ...specFor(sessionId, withCallerNotice), content: 'safe' });
    assert.equal(tryScopedToolCached(specFor(sessionId, argsFor({ mode: 'files' })))?.content, 'safe');
    assert.deepEqual(withCallerNotice._clampNotices, ['caller supplied']);
  } finally {
    clearScopedToolsForSession(sessionId);
  }
});

test('invalid modes and context arguments cannot hit or populate a successful grep cache', () => {
  const sessionId = randomUUID();
  try {
    for (const variant of variants) {
      setScopedToolCached({ ...specFor(sessionId, argsFor(variant.args)), content: 'cached-success' });
    }
    for (const extra of [
      { mode: 'invalid' }, { output_mode: 'invalid' }, { output_mode: 7 },
      { mode: 'files', context: 'bad' }, { mode: 'count', context: 'bad' },
    ]) {
      const args = argsFor(extra);
      const before = structuredClone(args);
      assert.match(validateBuiltinArgs('grep', structuredClone(args)), /^Error:/, JSON.stringify(extra));
      assert.equal(tryScopedToolCached(specFor(sessionId, args)), null);
      setScopedToolCached({ ...specFor(sessionId, args), content: 'must-not-be-stored' });
      assert.equal(tryScopedToolCached(specFor(sessionId, args)), null);
      assert.deepEqual(args, before);
    }
  } finally {
    clearScopedToolsForSession(sessionId);
  }
});

// The native scan is not needed to distinguish modes: use the real builtin
// guard, alias normalizer and grep request resolver, and expose the resolved
// search contract as the leaf result. Admission, batch dispatch and cache
// population/consumption remain the production implementations.
async function resolvedGrep(args) {
  const prepared = prepareGrepArgs(args);
  if (prepared.error) return prepared.error;
  const resolved = await resolveGrepRequest(prepared.args, root, {});
  if (resolved.result !== undefined) return resolved.result;
  assert.ok(resolved.request, 'the fixture must resolve to a search');
  const { outputMode, beforeN, afterN, contextN, autoContext, headLimit, offset } = resolved.request;
  return JSON.stringify({ outputMode, beforeN, afterN, contextN, autoContext, headLimit, offset });
}

const tools = [{ name: 'grep', annotations: { readOnlyHint: true } }];
async function round(fx, args) {
  const call = { id: randomUUID(), name: 'grep', arguments: args };
  const before = structuredClone(args);
  const results = [];
  fx.iterations += 1;
  const executeToolFn = async (_name, input) => {
    fx.executions += 1;
    return resolvedGrep(input);
  };
  const dispatcher = createEagerDispatcher({
    tools, cwd: root, sessionId: fx.sessionId, sessionRef: fx.sessionRef,
    signal: null, opts: {}, crossTurnCalls: fx.crossTurnCalls,
    getIterations: () => fx.iterations, getNextIteration: () => fx.iterations,
    repeatFailLimit: 3, executeToolFn,
  });
  if (fx.mode === 'streaming') {
    dispatcher.onToolCall(call);
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
  }
  const stats = await processToolBatch({
    calls: [call], messages: fx.messages, tools, cwd: root,
    sessionId: fx.sessionId, sessionRef: fx.sessionRef, signal: null, opts: {},
    iterations: fx.iterations,
    assistantTurnMsg: { role: 'assistant', content: '', toolCalls: [call] },
    pending: dispatcher.pending, epoch: dispatcher.epoch,
    startEagerRun: fx.mode === 'serial' ? () => {} : dispatcher.startEagerRun,
    crossTurnCalls: fx.crossTurnCalls, crossTurnCap: 100, sessionAgent: null,
    pushToolResultMessage: (message) => { results.push(message); fx.messages.push(message); },
    throwIfAborted: () => {}, repeatFailLimit: 3,
    dedupStubTotal: fx.dedupStubTotal, editCount: fx.editCount, executeToolFn,
  });
  Object.assign(fx, stats);
  assert.equal(results.length, 1);
  assert.deepEqual(args, before);
  return results[0];
}

test('automatic context and explicit -B 8 -A 12 never share a cache entry', async () => {
  const automatic = argsFor({});
  const explicit = argsFor({ output_mode: 'content', '-B': 8, '-A': 12 });
  const expectedAuto = await resolvedGrep(automatic);
  const expectedExplicit = await resolvedGrep(explicit);
  assert.notEqual(expectedAuto, expectedExplicit);
  for (const [first, second, expectedFirst, expectedSecond] of [
    [automatic, explicit, expectedAuto, expectedExplicit],
    [explicit, automatic, expectedExplicit, expectedAuto],
  ]) {
    const fx = {
      mode: 'serial', sessionId: randomUUID(), sessionRef: { schemaAllowedTools: null },
      crossTurnCalls: new Map(), messages: [], iterations: 0, executions: 0,
      dedupStubTotal: 0, editCount: 0,
    };
    try {
      const initial = await round(fx, first);
      assert.equal(initial.content, expectedFirst);
      const other = await round(fx, second);
      assert.equal(other.content, expectedSecond);
      assert.equal(other.toolKind, 'normal');
      assert.equal(fx.executions, 2);
    } finally {
      clearScopedToolsForSession(fx.sessionId);
    }
  }
});

for (const mode of ['serial', 'fallback', 'streaming']) {
  test(`cold and warm grep requests retain the same meaning through ${mode} dispatch`, async () => {
    const expected = await Promise.all(variants.map((variant) => resolvedGrep(argsFor(variant.args))));
    assert.notEqual(expected[0], expected[3], 'the fixture distinguishes automatic context from bare content');
    assert.notEqual(expected[0], expected[4], 'the fixture distinguishes content from paths');
    assert.notEqual(expected[4], expected[6], 'the fixture distinguishes paths from counts');
    for (const [firstIndex, secondIndex] of [[0, 4], [4, 0], [1, 3], [3, 1], [1, 2], [4, 5], [6, 7]]) {
      const first = variants[firstIndex];
      const second = variants[secondIndex];
      const fx = {
        mode, sessionId: randomUUID(), sessionRef: { schemaAllowedTools: null },
        crossTurnCalls: new Map(), messages: [], iterations: 0, executions: 0,
        dedupStubTotal: 0, editCount: 0,
      };
      try {
        const initial = await round(fx, argsFor(first.args));
        assert.equal(initial.content, expected[firstIndex]);
        assert.equal(initial.toolKind, 'normal');
        const warm = await round(fx, argsFor(second.args));
        assert.equal(warm.content, expected[secondIndex], `${first.label} -> ${second.label}`);
        const equivalent = first.group === second.group;
        assert.equal(warm.toolKind, equivalent ? 'scoped-cache-hit' : 'normal');
        assert.equal(fx.executions, equivalent ? 1 : 2);
        const repeat = await round(fx, argsFor(second.args));
        assert.equal(repeat.toolKind, 'skipped');
        assert.match(repeat.content, /cross-turn-dedup/);
        assert.equal(fx.executions, equivalent ? 1 : 2);
      } finally {
        clearScopedToolsForSession(fx.sessionId);
      }
    }
  });
}
