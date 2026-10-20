import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, routeUsageSegments } from '../loop/usage.mjs';
import { computeCostUsd } from '../../../../shared/llm/cost.mjs';

const rows = [];
mock.module('../../usage-log.mjs', { namedExports: { logLlmCall: (row) => rows.push(row) } });
mock.module('./status-telemetry.mjs', { namedExports: { recordStandaloneStatusTelemetry: () => {} } });
const { recordAskUsage } = await import('./ask-turn-commit.mjs');

const send = (input, output, cached = 0) => ({ inputTokens: input, outputTokens: output, cachedTokens: cached });

test('a turn that switched models books each model its own tokens at its own rates', async () => {
  // Model 1 ran two requests (a tool round), then hit its usage limit; the
  // rest of the turn ran on model 2.
  let total = addUsage(undefined, send(1000, 200));
  total = addUsage(total, send(1500, 100, 800));
  const hops = [{ provider: 'openai-oauth', model: 'gpt-5.5', usage: { ...total } }];
  total = addUsage(total, send(3000, 400));
  const usageSegments = routeUsageSegments(hops, total, { provider: 'anthropic', model: 'claude-opus-4-1' });
  assert.deepEqual(
    usageSegments.map(({ model, usage }) => [model, usage.inputTokens, usage.outputTokens, usage.cachedTokens]),
    [
      ['gpt-5.5', 2500, 300, 800],
      ['claude-opus-4-1', 3000, 400, 0],
    ]
  );
  rows.length = 0;
  const session = { id: 's', provider: 'anthropic', model: 'claude-opus-4-1', agent: 'worker' };
  await recordAskUsage({ session, result: { usage: total, usageSegments }, askStartedAt: Date.now() });
  assert.deepEqual(
    rows.map((row) => [row.provider, row.model, row.inputTokens, row.outputTokens]),
    [
      ['openai-oauth', 'gpt-5.5', 2500, 300],
      ['anthropic', 'claude-opus-4-1', 3000, 400],
    ]
  );
  const price = (provider, model, usage) =>
    computeCostUsd({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedTokens,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
    });
  assert.equal(rows[0].costUsd, price('openai-oauth', 'gpt-5.5', usageSegments[0].usage));
  assert.equal(rows[1].costUsd, price('anthropic', 'claude-opus-4-1', usageSegments[1].usage));
  // The session itself keeps its current route.
  assert.equal(session.model, 'claude-opus-4-1');
});

test('a turn on one model still books one row for the whole turn', async () => {
  rows.length = 0;
  const session = { id: 's', provider: 'anthropic', model: 'claude-opus-4-1' };
  await recordAskUsage({ session, result: { usage: addUsage(undefined, send(10, 5)) }, askStartedAt: Date.now() });
  assert.deepEqual(
    rows.map((row) => [row.model, row.inputTokens]),
    [['claude-opus-4-1', 10]]
  );
  assert.equal(routeUsageSegments(undefined, addUsage(undefined, send(1, 1)), {}), null);
});
