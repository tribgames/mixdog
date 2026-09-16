import assert from 'node:assert/strict';
import test from 'node:test';

import { foldUsageRollup, normalizeUsageRollup, usageRollupDayKey } from './usage-rollup.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 12, 12, 0, 0).getTime();

function turn(overrides = {}) {
  return {
    ts: NOW,
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    providerKind: 'oauth',
    sessionId: 'session-a',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    costUsd: 0.25,
    costSource: 'provider',
    durationMs: 4000,
    ...overrides,
  };
}

test('turns accumulate into one day bucket per provider and model', () => {
  const first = foldUsageRollup(null, turn(), NOW);
  const rollup = foldUsageRollup(first, turn({ outputTokens: 800, costUsd: 0.5 }), NOW);
  const day = rollup.days[usageRollupDayKey(NOW)];

  assert.equal(day.turns, 2);
  assert.equal(day.input, 2000);
  assert.equal(day.output, 1000);
  assert.equal(day.cacheRead, 10000);
  assert.equal(day.costUsd, 0.75);
  assert.equal(day.costKnownTurns, 2);
  assert.equal(day.durationTurns, 2);

  const model = day.models['anthropic-oauth/claude-sonnet-4-5'];
  assert.equal(model.provider, 'anthropic-oauth');
  assert.equal(model.kind, 'oauth');
  assert.equal(model.turns, 2);
  assert.equal(model.costUsd, 0.75);
  // One session spanning both turns keeps a single running token total.
  assert.equal(day.sessions['session-a'], 13600);
});

test('a turn without a route is not counted as unknown usage', () => {
  const rollup = foldUsageRollup(null, turn({ provider: '', model: '' }), NOW);
  assert.deepEqual(rollup.days, {});
});

test('separate providers stay separate and keep their own model buckets', () => {
  const first = foldUsageRollup(null, turn(), NOW);
  const rollup = foldUsageRollup(
    first,
    turn({
      provider: 'openai',
      model: 'gpt-5.5',
      providerKind: 'api',
      sessionId: 'session-b',
    }),
    NOW
  );
  const day = rollup.days[usageRollupDayKey(NOW)];

  assert.deepEqual(Object.keys(day.models).sort(), ['anthropic-oauth/claude-sonnet-4-5', 'openai/gpt-5.5']);
  assert.equal(day.models['openai/gpt-5.5'].kind, 'api');
  assert.equal(Object.keys(day.sessions).length, 2);
});

test('session ids age out of old days while their token totals survive', () => {
  const oldTs = NOW - 60 * DAY_MS;
  const rollup = foldUsageRollup(null, turn({ ts: oldTs }), NOW);
  const day = rollup.days[usageRollupDayKey(oldTs)];

  assert.deepEqual(day.sessions, {});
  assert.deepEqual(day.sessionTokens, [6500]);
  assert.equal(day.turns, 1);
});

test('days beyond the retention horizon are dropped', () => {
  const rollup = foldUsageRollup(null, turn({ ts: NOW - 500 * DAY_MS }), NOW);
  assert.deepEqual(Object.keys(rollup.days), []);
});

test('a malformed document is read as empty rather than throwing', () => {
  assert.deepEqual(normalizeUsageRollup('nonsense').days, {});
  assert.deepEqual(normalizeUsageRollup({ days: { bad: { turns: 3 } } }).days, {});
  const recovered = normalizeUsageRollup({ days: { '2026-08-12': { turns: 'x', models: null } } });
  assert.equal(recovered.days['2026-08-12'].turns, 0);
});

test('a background turn is folded whole but stays out of the conversation split', () => {
  const first = foldUsageRollup(null, turn(), NOW);
  const rollup = foldUsageRollup(
    first,
    turn({
      sourceType: 'memory-cycle',
      sessionId: 'cycle-1',
    }),
    NOW
  );
  const day = rollup.days[usageRollupDayKey(NOW)];

  assert.equal(day.turns, 2);
  assert.equal(day.conversation.turns, 1);
  assert.equal(day.conversation.input, 1000);
  // The cycle's id is not a session the user ever had.
  assert.deepEqual(Object.keys(day.sessions), ['session-a']);

  const model = day.models['anthropic-oauth/claude-sonnet-4-5'];
  assert.equal(model.turns, 2);
  assert.equal(model.conversation.turns, 1);
});

test('a day records the span of the turns it already holds', () => {
  const first = foldUsageRollup(null, turn({ ts: NOW - 60_000 }), NOW);
  const rollup = foldUsageRollup(first, turn({ ts: NOW }), NOW);
  const day = rollup.days[usageRollupDayKey(NOW)];

  // A reader holding the raw events adds only what lies outside this span.
  assert.equal(day.firstTs, NOW - 60_000);
  assert.equal(day.lastTs, NOW);
});

test('cost is split into what the provider billed and what the catalog priced', () => {
  const first = foldUsageRollup(null, turn({ costUsd: 0.25, costSource: 'provider' }), NOW);
  const rollup = foldUsageRollup(first, turn({ costUsd: 0.5, costSource: 'catalog' }), NOW);
  const day = rollup.days[usageRollupDayKey(NOW)];

  assert.equal(day.costUsd, 0.75);
  assert.equal(day.costBilled, 0.25);
  assert.equal(day.costEstimated, 0.5);
  assert.equal(day.costKnownTurns, 2);
});
