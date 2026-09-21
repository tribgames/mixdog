import assert from 'node:assert/strict';
import test from 'node:test';
import { reasoningUsage, combineReasoningUsage } from '../../../shared/llm/reasoning-usage.mjs';
import { normalizeUsage, addUsage, usageDeltaEvent } from './loop/usage.mjs';
import { applyAskTerminalUsageTotals } from './manager/usage-metrics.mjs';
import { _combineUsageWithWarmup } from '../providers/openai-ws-events.mjs';
import { _sessionForDisk } from './store/serialize.mjs';
import { createContextStatus } from '../../../../session-runtime/context-status.mjs';
import { sessionTokenCounters } from '../../../../session-runtime/context-status-shape.mjs';

test('provider-reported reasoning formats normalize without inspecting text or signatures', () => {
  const formats = [
    { output_tokens_details: { reasoning_tokens: 17 } },
    { output_tokens_details: { thinking_tokens: 17 } },
    { completion_tokens_details: { reasoning_tokens: 17 } },
    { completion_tokens_details: { thinking_tokens: 17 } },
    { thoughtsTokenCount: 17 },
    { thoughts_token_count: 17 },
    { thinking_tokens: 17 },
    { thinkingTokens: 17 },
  ];
  for (const raw of formats) {
    assert.deepEqual(reasoningUsage(raw), { reasoningTokens: 17, reasoningTokensComplete: true });
    assert.equal(normalizeUsage({ inputTokens: 100, outputTokens: 25, raw }).reasoningTokens, 17);
    assert.equal(usageDeltaEvent({ usage: { raw } }).reasoningTokens, 17);
  }
  assert.deepEqual(reasoningUsage({ output_tokens_details: { thinking_tokens: 0 } }), {
    reasoningTokens: 0, reasoningTokensComplete: true,
  });
  for (const value of [undefined, null, -1, NaN, Infinity, '17', 0.5]) {
    assert.equal(reasoningUsage({ output_tokens_details: { reasoning_tokens: value } }).reasoningTokens, null);
  }
  assert.equal(reasoningUsage({
    output_tokens: 500, signature: 'S'.repeat(5000), reasoning_content: 'reasoning text',
  }).reasoningTokens, null);
});

test('reported subtotals survive mixed-provider iterations without double-counting output', () => {
  const known = { inputTokens: 100, outputTokens: 40, raw: { thoughtsTokenCount: 17 } };
  const missing = { inputTokens: 100, outputTokens: 30 };
  let usage = addUsage(null, known);
  usage = addUsage(usage, missing);
  usage = addUsage(usage, known);
  assert.equal(usage.outputTokens, 110);
  assert.equal(usage.reasoningTokens, 34);
  assert.equal(usage.reasoningTokensComplete, false);
  assert.deepEqual(combineReasoningUsage(null, null), { reasoningTokens: null, reasoningTokensComplete: false });
  assert.equal(reasoningUsage({ reasoningTokens: null, raw: known.raw }).reasoningTokens, null);
});

test('warmup usage contributes exactly once to reasoning and marks missing readings', () => {
  const actual = { outputTokens: 40, raw: { output_tokens_details: { reasoning_tokens: 17 } } };
  const warmup = { outputTokens: 12, raw: { output_tokens_details: { reasoning_tokens: 3 } } };
  const result = _combineUsageWithWarmup(actual, warmup, { separateMainContext: true });
  assert.equal(normalizeUsage(result).reasoningTokens, 20);
  assert.equal(reasoningUsage(result.raw).reasoningTokens, 20);
  assert.equal(result.outputTokens, 52);
  assert.equal(result.mainOutputTokens, 40);
  assert.equal(normalizeUsage(_combineUsageWithWarmup(null, warmup)).reasoningTokens, 3);
  const partial = _combineUsageWithWarmup(actual, { outputTokens: 1 });
  assert.equal(partial.reasoningTokens, 17);
  assert.equal(partial.reasoningTokensComplete, false);
});

test('session accounting survives storage and exposes real usage outside context estimates', () => {
  const session = {
    id: 'reasoning-test', provider: 'openai', model: 'test',
    messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Answer' }],
    totalInputTokens: 0, totalOutputTokens: 0,
  };
  const usage = normalizeUsage({ inputTokens: 100, outputTokens: 40, raw: {
    output_tokens_details: { reasoning_tokens: 17 },
  } });
  applyAskTerminalUsageTotals(session, { usage, lastTurnUsage: usage });
  assert.deepEqual(session.reasoningUsage, { reasoningTokens: 17, reasoningTokensComplete: true });
  applyAskTerminalUsageTotals(session, { usage, lastTurnUsage: usage }, { skipTotalsIfIncremental: true });
  assert.equal(session.reasoningUsage.reasoningTokens, 17);
  assert.equal(session.totalOutputTokens, 40);
  const before = sessionTokenCounters(session);
  const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  assert.deepEqual(restored.reasoningUsage, session.reasoningUsage);
  const api = createContextStatus({
    getSession: () => restored,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getCurrentCwd: () => process.cwd(),
    getMode: () => 'code',
  });
  assert.deepEqual(api.contextStatus().usage.reasoningUsage, session.reasoningUsage);
  applyAskTerminalUsageTotals(session, { usage: { inputTokens: 100, outputTokens: 5 } });
  assert.deepEqual(session.reasoningUsage, { reasoningTokens: 17, reasoningTokensComplete: false });
  assert.notEqual(sessionTokenCounters(session).reasoningUsage, before.reasoningUsage);
});

test('legacy sessions and calls without usage never become a complete measured total', () => {
  const legacy = { provider: 'openai', totalInputTokens: 100, totalOutputTokens: 50 };
  applyAskTerminalUsageTotals(legacy, { usage: { reasoningTokens: 0, inputTokens: 20, outputTokens: 10 } });
  assert.deepEqual(legacy.reasoningUsage, { reasoningTokens: 0, reasoningTokensComplete: false });
  const fresh = { provider: 'cursor-oauth' };
  applyAskTerminalUsageTotals(fresh, {});
  assert.deepEqual(fresh.reasoningUsage, { reasoningTokens: null, reasoningTokensComplete: false });
  applyAskTerminalUsageTotals(fresh, { usage: { reasoningTokens: 10, outputTokens: 20 } });
  assert.deepEqual(fresh.reasoningUsage, { reasoningTokens: 10, reasoningTokensComplete: false });
});
