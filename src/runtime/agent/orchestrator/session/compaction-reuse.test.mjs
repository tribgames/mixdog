// Production-boundary coverage: the live loop state's crossTurnCalls map must
// reach adoptCompactedTranscript through beginIteration ->
// prepareProviderRequest -> runPreSendCompactPass, so a receipt never points
// at a tool result that compaction removed from context.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-compact-reuse-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_PATCH_NATIVE_PREWARM = '0';
const { processToolBatch } = await import('./tool-batch.mjs');
const { beginIteration } = await import('./loop/send-phase.mjs');
const { createLoopState } = await import('./loop/loop-state.mjs');
const { clearReadDedupSession } = await import('./cache/read-cache.mjs');
const { createScopedCacheOutcome } = await import('./cache/scoped-cache-outcome.mjs');
const { executeGlobTool } = await import('../tools/builtin/search-glob-tool.mjs');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal', '- continue', '', '## Constraints & Preferences', '- (none)', '',
  '## Progress', '### Done', '- summarized', '', '### In Progress', '- (none)', '',
  '### Blocked', '- (none)', '', '## Key Decisions', '- (none)', '',
  '## Next Steps', '- continue', '', '## Critical Context', '- none', '',
  '## Relevant Files', '- (none)',
].join('\n');

const tools = [{ name: 'glob', annotations: { readOnlyHint: true } }];

function fixture() {
  const cwd = mkdtempSync(join(root, 'case-'));
  const sessionId = `compact-reuse-${randomUUID()}`;
  const session = {
    id: sessionId, owner: 'agent', provider: 'compact-reuse', model: 'fake-model', cwd,
    contextWindow: 20_000, compactBoundaryTokens: 20_000,
    tools: [], compaction: { auto: true }, schemaAllowedTools: null,
  };
  const messages = [{ role: 'user', content: 'small request' }, { role: 'assistant', content: 'small answer' }];
  const provider = { name: 'compact-reuse', async send() { return { content: SUMMARY }; } };
  const state = createLoopState({
    provider, messages, model: 'fake-model', tools: [], cwd,
    sendOpts: { session, sessionId },
  });
  return { cwd, sessionId, session, messages, state, scans: 0, executions: 0 };
}

// Mirrors the loop: one tool batch per model iteration using the loop state's
// own crossTurnCalls, iteration counter and dedup counters.
async function globRound(fx, args) {
  const { state } = fx;
  const call = { id: randomUUID(), name: 'glob', arguments: args };
  const results = [];
  state.iterations += 1;
  const executeToolFn = async (_name, input, cwd, _sid, sessionRef, options) => {
    fx.executions += 1;
    const outcome = createScopedCacheOutcome();
    sessionRef._scopedCacheOutcomeByCallId ??= new Map();
    sessionRef._scopedCacheOutcomeByCallId.set(options.toolCallId, outcome);
    return executeGlobTool(structuredClone(input), cwd, {
      scopedCacheOutcome: outcome,
      __runRgWindowedLines: async () => {
        fx.scans += 1;
        return { lines: [`snapshot-${fx.scans}.txt`], complete: true, partial: false, cacheSafe: true };
      },
    });
  };
  const assistantTurnMsg = { role: 'assistant', content: '', toolCalls: [call] };
  fx.messages.push(assistantTurnMsg);
  const stats = await processToolBatch({
    calls: [call], messages: fx.messages, tools, cwd: fx.cwd,
    sessionId: fx.sessionId, sessionRef: fx.session, signal: null, opts: {},
    iterations: state.iterations,
    assistantTurnMsg,
    pending: new Map(), epoch: { mutation: 0 }, startEagerRun: () => {},
    crossTurnCalls: state.crossTurnCalls, crossTurnCap: 100, sessionAgent: null,
    pushToolResultMessage: (m) => { results.push(m); fx.messages.push(m); },
    throwIfAborted: () => {}, repeatFailLimit: 3,
    dedupStubTotal: state.dedupStubTotal, editCount: state.editCount, executeToolFn,
  });
  state.dedupStubTotal = stats.dedupStubTotal ?? state.dedupStubTotal;
  state.editCount = stats.editCount ?? state.editCount;
  return results[0];
}

async function compactThroughBeginIteration(fx, { reactive }) {
  const { state, messages } = fx;
  messages.unshift(
    { role: 'user', content: `large old request ${'context '.repeat(12_000)}` },
    { role: 'assistant', content: `large old answer ${'detail '.repeat(12_000)}` }
  );
  // Compact keeps a bounded tail of valid execution groups. Put the tested
  // result behind enough later evidence that its body really leaves context;
  // a lone, recent small result is intentionally retained.
  for (let i = 0; i < 12; i += 1) {
    const call = { id: `later-${i}`, name: 'glob', arguments: { path: fx.cwd, pattern: `later-${i}-*.txt` } };
    messages.push(
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', name: 'glob', toolCallId: call.id, content: `later-${i} ${'unchanged observation '.repeat(40)}` }
    );
  }
  state.reactiveOverflowRetryPending = reactive;
  const map = state.crossTurnCalls;
  assert.ok(map.size > 0, 'a receipt exists before compaction');
  let receiptsBeforeCompact = 0;
  state.opts.preCompactHook = () => { receiptsBeforeCompact = map.size; };
  const round = await beginIteration(state);
  assert.ok(receiptsBeforeCompact > 0, 'healthy pairing repair must not mask the compaction reset');
  assert.equal(state.crossTurnCalls, map, 'the live map identity is preserved');
  assert.equal(state.iterations, 0, 'compaction reset the iteration counter');
  assert.equal(round.nextIteration, 1);
  assert.equal(map.size, 0, 'beginIteration forwarded the live map and compaction cleared it');
  assert.ok(
    !messages.some((m) => m.role === 'tool' && /snapshot-1\.txt/.test(String(m.content))),
    'the original tool result was removed from context'
  );
}

test('without compaction a repeated glob is referenced by a cross-turn stub', async (t) => {
  const fx = fixture();
  t.after(() => clearReadDedupSession(fx.sessionId));
  const args = { path: fx.cwd, pattern: '*.txt', sort: 'natural', limit: 25 };
  assert.match((await globRound(fx, args)).content, /snapshot-1/);
  assert.equal((await globRound(fx, args)).toolKind, 'skipped');
});

for (const reactive of [false, true]) {
  test(`${reactive ? 'reactive' : 'automatic'} compaction via beginIteration clears receipts; cached body is re-delivered, then stubs resume`, async (t) => {
    const fx = fixture();
    t.after(() => clearReadDedupSession(fx.sessionId));
    const args = { path: fx.cwd, pattern: '*.txt', sort: 'natural', limit: 25 };
    assert.match((await globRound(fx, args)).content, /snapshot-1/);
    await compactThroughBeginIteration(fx, { reactive });
    const scansBefore = fx.scans;
    // A different call occupies post-compaction iteration 1.
    await globRound(fx, { path: fx.cwd, pattern: '*.md', sort: 'natural', limit: 25 });
    const scansAfterOther = fx.scans;
    const repeated = await globRound(fx, args);
    assert.notEqual(repeated.toolKind, 'skipped', 'no stub for a body that left context');
    assert.match(repeated.content, /snapshot-1\.txt/, 'the valid cached body is re-delivered');
    assert.equal(fx.scans, scansAfterOther, 'no rescan for the cached body');
    assert.ok(scansAfterOther > scansBefore);
    assert.equal((await globRound(fx, args)).toolKind, 'skipped', 'stubs resume once the body is in context');
  });
}
