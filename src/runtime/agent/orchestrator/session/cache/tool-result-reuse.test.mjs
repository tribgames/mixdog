import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'mixdog-tool-result-reuse-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
// This cache harness injects tool execution; a native patch server is unused
// and would keep its executable locked during Windows fixture cleanup.
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { processToolBatch } = await import('../tool-batch.mjs');
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');
const { clearReadDedupSession, setReadCached } = await import('./read-cache.mjs');
const { SCOPED_CACHE_TTL_MS, clearScopedToolsForSessionPaths } = await import('./scoped-cache.mjs');
// Remove the isolated data directory after imported modules' exit flushes.
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const tools = ['read', 'grep', 'mcp__remote__status'].map((name) => ({
  name,
  annotations: { readOnlyHint: true },
}));

function fixture(mode) {
  const cwd = mkdtempSync(join(root, 'case-'));
  const file = join(cwd, 'file.txt');
  writeFileSync(file, 'ORIGINAL\n');
  return {
    mode, cwd, file,
    sessionId: `reuse-${randomUUID()}`,
    sessionRef: { schemaAllowedTools: null },
    crossTurnCalls: new Map(),
    messages: [],
    iterations: 0,
    executions: 0,
    dedupStubTotal: 0,
    editCount: 0,
  };
}

// Keep ONE loop's crossTurnCalls across model iterations. Tests that reset
// this map for every batch cannot expose the signature-only bypass.
// Only the tool implementation is injected: admission, batching, cache
// insertion/validation, invalidation and transcript bookkeeping are real.
async function round(fx, name, args, { beforeBatch, afterRead } = {}) {
  const call = { id: randomUUID(), name, arguments: args };
  const results = [];
  fx.iterations += 1;
  const executeToolFn = async (toolName, input, cwd) => {
    fx.executions += 1;
    if (toolName !== 'read') return `snapshot-${fx.executions}`;
    const paths = input.file_path ?? input.path;
    const content = (Array.isArray(paths) ? paths : [paths]).map((value) => {
      const path = typeof value === 'string' ? value : value.file_path ?? value.path;
      return readFileSync(resolve(cwd, path), 'utf8');
    }).join('\n');
    afterRead?.();
    return content;
  };
  const dispatcher = createEagerDispatcher({
    tools, cwd: fx.cwd, sessionId: fx.sessionId, sessionRef: fx.sessionRef,
    signal: null, opts: {}, crossTurnCalls: fx.crossTurnCalls,
    getIterations: () => fx.iterations, getNextIteration: () => fx.iterations,
    repeatFailLimit: 3, executeToolFn,
  });
  if (fx.mode === 'streaming') {
    dispatcher.onToolCall(call);
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
  }
  beforeBatch?.(dispatcher);
  const stats = await processToolBatch({
    calls: [call], messages: fx.messages, tools, cwd: fx.cwd,
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
  return results[0];
}

for (const mode of ['serial', 'fallback', 'streaming']) {
  test(`unchanged reads reuse, external edits refresh, and references move to the new result (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    assert.match((await round(fx, 'read', args)).content, /ORIGINAL/);
    const unchanged = await round(fx, 'read', args);
    assert.equal(unchanged.toolKind, 'skipped');
    assert.match(unchanged.content, /iteration 1/);
    assert.equal(fx.executions, 1);

    writeFileSync(fx.file, 'EXTERNALLY_UPDATED\n');
    const changed = await round(fx, 'read', args);
    assert.equal(changed.toolKind, 'normal');
    assert.equal(changed.content, 'EXTERNALLY_UPDATED\n');
    const reused = await round(fx, 'read', args);
    assert.equal(reused.toolKind, 'skipped');
    assert.match(reused.content, /iteration 3/);
    assert.equal(fx.executions, 2);
  });

  test(`changing any member of a batch read invalidates its cross-turn reference (${mode})`, async () => {
    const fx = fixture(mode);
    const other = join(fx.cwd, 'other.txt');
    writeFileSync(other, 'OTHER\n');
    const args = { file_path: [{ file_path: fx.file }, { file_path: other }] };
    await round(fx, 'read', args);
    writeFileSync(other, 'OTHER_CHANGED\n');
    const changed = await round(fx, 'read', args);
    assert.match(changed.content, /OTHER_CHANGED/);
    assert.equal(changed.toolKind, 'normal');
    assert.equal(fx.executions, 2);
  });

  test(`deleted reads fail and recreated files are read rather than skipped (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    await round(fx, 'read', args);
    rmSync(fx.file);
    const missing = await round(fx, 'read', args);
    assert.equal(missing.toolKind, 'error');
    assert.match(missing.content, /ENOENT/);
    writeFileSync(fx.file, 'RECREATED\n');
    assert.equal((await round(fx, 'read', args)).content, 'RECREATED\n');
    assert.equal(fx.executions, 3);
  });

  test(`evicted cache entries cannot leave an authoritative cross-turn reference (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    await round(fx, 'read', args);
    clearReadDedupSession(fx.sessionId);
    const result = await round(fx, 'read', args);
    assert.equal(result.toolKind, 'normal');
    assert.equal(result.content, 'ORIGINAL\n');
    assert.equal(fx.executions, 2);
  });

  test(`a different cached source is delivered before it can be referenced (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    await round(fx, 'read', args);
    // Model a later cache population under a different call identity. Stat
    // freshness alone must not make the old iteration describe this body.
    setReadCached({ ...fx, args, content: 'REPLACEMENT_BODY', toolUseId: 'replacement-call' });
    const delivered = await round(fx, 'read', args);
    assert.equal(delivered.toolKind, 'cache-hit');
    assert.equal(delivered.content, 'REPLACEMENT_BODY');
    assert.equal(fx.executions, 1);
    assert.match((await round(fx, 'read', args)).content, /iteration 2/);
  });

  test(`a result rejected at cache insertion cannot authorize a later skip (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    await round(fx, 'read', args, {
      afterRead: () => writeFileSync(fx.file, 'CHANGED_DURING_READ\n'),
    });
    assert.equal((await round(fx, 'read', args)).content, 'CHANGED_DURING_READ\n');
    assert.equal(fx.executions, 2);
  });

  test(`relative reads in another cwd do not reuse the previous directory (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: 'file.txt' };
    await round(fx, 'read', args);
    fx.cwd = join(fx.cwd, 'other');
    mkdirSync(fx.cwd);
    writeFileSync(join(fx.cwd, 'file.txt'), 'OTHER_DIRECTORY\n');
    assert.equal((await round(fx, 'read', args)).content, 'OTHER_DIRECTORY\n');
    assert.equal(fx.executions, 2);
  });

  test(`read-only remote tools without a freshness policy execute again (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { resource: 'changing-status' };
    assert.equal((await round(fx, 'mcp__remote__status', args)).content, 'snapshot-1');
    assert.equal((await round(fx, 'mcp__remote__status', args)).content, 'snapshot-2');
    assert.equal(fx.executions, 2);
  });

  test(`scoped references respect both TTL expiry and dependency invalidation (${mode})`, async (t) => {
    const fx = fixture(mode);
    const args = { path: fx.cwd, pattern: 'needle', context: 0 };
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    assert.equal((await round(fx, 'grep', args)).content, 'snapshot-1');
    assert.equal((await round(fx, 'grep', args)).toolKind, 'skipped');
    now += SCOPED_CACHE_TTL_MS;
    assert.equal((await round(fx, 'grep', args)).content, 'snapshot-2');
    clearScopedToolsForSessionPaths(fx.sessionId, [fx.file], fx.cwd);
    assert.equal((await round(fx, 'grep', args)).content, 'snapshot-3');
    assert.equal(fx.executions, 3);
  });

  test(`authorization still precedes cache reuse and cross-turn references (${mode})`, async () => {
    const fx = fixture(mode);
    const args = { file_path: fx.file };
    await round(fx, 'read', args);
    fx.sessionRef.schemaAllowedTools = [];
    const result = await round(fx, 'read', args);
    assert.equal(result.toolKind, 'error');
    assert.match(result.content, /schema allowlist/);
    assert.doesNotMatch(result.content, /ORIGINAL/);
    assert.equal(fx.executions, 1);
  });
}

test('a cache hit at streaming admission is revalidated before the serial result is chosen', async () => {
  const fx = fixture('streaming');
  const args = { file_path: fx.file };
  await round(fx, 'read', args);
  const result = await round(fx, 'read', args, {
    beforeBatch: (dispatcher) => {
      assert.equal(dispatcher.pending.size, 0, 'the cache hit must suppress eager IO');
      writeFileSync(fx.file, 'CHANGED_AFTER_ADMISSION\n');
    },
  });
  assert.equal(result.content, 'CHANGED_AFTER_ADMISSION\n');
  assert.equal(fx.executions, 2);
});
