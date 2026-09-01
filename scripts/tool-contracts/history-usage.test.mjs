// Session history, usage accounting, and pending-message contracts.
import './_env.mjs';
import test from 'node:test';
import { assert } from './_helpers.mjs';
import {
  _mergePendingMessageEntries,
  applyAskTerminalUsageTotals,
  drainPendingMessages,
  enqueuePendingMessage,
} from '../../src/runtime/agent/orchestrator/session/manager.mjs';
import { compactToolCallsForHistory } from '../../src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs';
import { crossTurnDedupStub } from '../../src/runtime/agent/orchestrator/session/loop/completion-guards.mjs';
import { toolCompletionInstruction } from '../../src/runtime/shared/tool-execution-contract.mjs';

test('settled mutation bodies stay verbatim in stored history', () => {
  const longPatch = `*** Begin Patch\n*** Add File: compacted.txt\n+${'x'.repeat(11_000)}\n*** End Patch\n`;
  const messages = [
    { role: 'assistant', toolCalls: [{ id: 'call_compacted', name: 'apply_patch', arguments: { patch: longPatch } }] },
    { role: 'tool', toolCallId: 'call_compacted', toolKind: 'normal', content: 'Applied 1 File (Native)' },
  ];
  // A settled mutation body stays verbatim in history. Collapsing it later
  // rewrote a prefix the provider had already cached, and the re-billed request
  // cost more than the collapsed tokens ever recovered.
  const stored = compactToolCallsForHistory(messages[0].toolCalls, { deferBodies: true });
  assert(stored[0].arguments.patch === longPatch,
    'settled mutation body must stay verbatim so the cached prefix survives');
});

test('completion instructions and dedup reminders stay behavior-neutral', () => {
  const completion = toolCompletionInstruction({
    surface: 'shell',
    id: 'job-1',
    status: 'completed',
    detail: 'exit 0',
  });
  assert(/^Async shell task job-1 \(completed, exit 0\) finished\.$/.test(completion),
    `completion instruction must stay status-only: ${completion}`);
  assert(/No new evidence; use the existing result or report it unresolved\.$/.test(
    crossTurnDedupStub('read', 2, true),
  ), 'cross-turn dedup reminder must stay evidence-neutral');
});

test('inclusive usage totals subtract cache reads (OpenAI OAuth)', () => {
  const session = { provider: 'openai-oauth' };
  applyAskTerminalUsageTotals(session, {
    usage: { inputTokens: 100_000, outputTokens: 10, cachedTokens: 98_000, cacheWriteTokens: 0 },
  });
  assert(session.lastInputTokens === 100_000, `inclusive last input should retain provider total: ${JSON.stringify(session)}`);
  assert(session.lastUncachedInputTokens === 2_000, `inclusive last uncached input should subtract cache reads: ${JSON.stringify(session)}`);
  assert(session.totalUncachedInputTokens === 2_000, `inclusive total uncached input should be tracked: ${JSON.stringify(session)}`);
});

test('additive usage totals include cache writes (Anthropic OAuth)', () => {
  const session = { provider: 'anthropic-oauth' };
  applyAskTerminalUsageTotals(session, {
    usage: { inputTokens: 2_000, outputTokens: 10, cachedTokens: 90_000, cacheWriteTokens: 8_000 },
  });
  assert(session.lastInputTokens === 2_000, `additive last input should retain provider input field: ${JSON.stringify(session)}`);
  assert(session.lastUncachedInputTokens === 10_000, `additive uncached input should include cache writes: ${JSON.stringify(session)}`);
  assert(session.lastContextTokens === 100_000, `additive context should include input+cache read+cache write: ${JSON.stringify(session)}`);
  assert(session.totalUncachedInputTokens === 10_000, `additive total uncached input should include cache writes: ${JSON.stringify(session)}`);
});

test('rich pending messages dedupe, preserve content, and drain once', async () => {
  const sid = `tool-contracts-rich-pending-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const richContent = [
    { type: 'text', text: 'look at this' },
    { type: 'image', data: 'abc', mimeType: 'image/png' },
  ];
  const depth = enqueuePendingMessage(sid, { text: 'look at this\n[Image]', content: richContent });
  assert(depth >= 1, `rich pending enqueue should return queue depth, got ${depth}`);
  const drained = drainPendingMessages(sid);
  assert(drained.length === 1, `rich pending drain should dedupe memory+persisted entries, got ${drained.length}`);
  assert(Array.isArray(drained[0]?.content), `rich pending drain should preserve content array: ${JSON.stringify(drained)}`);
  assert(drained[0].content.some((part) => part?.type === 'image' && part?.data === 'abc'), `rich pending drain lost image part: ${JSON.stringify(drained)}`);
  const merged = _mergePendingMessageEntries([...drained, 'plain follow-up']);
  assert(Array.isArray(merged?.content), `rich pending merge should preserve structured content: ${JSON.stringify(merged)}`);
  assert(merged.content.some((part) => part?.type === 'image' && part?.data === 'abc'), `rich pending merge lost image part: ${JSON.stringify(merged)}`);
  assert(
    merged.content.some((part) => part?.type === 'text' && /plain follow-up/.test(part.text || '')),
    `rich pending merge should keep later text follow-up: ${JSON.stringify(merged)}`,
  );
  assert(drainPendingMessages(sid).length === 0, 'rich pending drain should remove persisted fallback after first drain');
  await new Promise((resolve) => setImmediate(resolve));
  assert(drainPendingMessages(sid).length === 0, 'rich pending async mirror must not resurrect an already-drained message');
});

test('async pending mirror persists fallback text', async () => {
  const sid = `tool-contracts-async-pending-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  enqueuePendingMessage(sid, 'persisted pending text');
  await new Promise((resolve) => setImmediate(resolve));
  const drained = drainPendingMessages(sid);
  assert(
    drained.length === 1
      && drained[0]?.text === 'persisted pending text'
      && drained[0]?.content === 'persisted pending text',
    `async pending mirror should persist fallback text: ${JSON.stringify(drained)}`,
  );
});
