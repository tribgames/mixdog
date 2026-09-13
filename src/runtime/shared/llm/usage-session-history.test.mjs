import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUsageHistoryDays, summarizeSessionUsage } from './usage-session-history.mjs';
import { usageRollupDayKey } from './usage-rollup.mjs';

const DAY_ONE = new Date(2026, 7, 10, 9, 0, 0).getTime();
const DAY_TWO = new Date(2026, 7, 11, 9, 0, 0).getTime();
const KEY_ONE = usageRollupDayKey(DAY_ONE);
const KEY_TWO = usageRollupDayKey(DAY_TWO);

function session(overrides = {}) {
  return {
    id: 'session-a',
    provider: 'grok-oauth',
    model: 'grok-4.6',
    sourceType: 'lead',
    createdAt: DAY_ONE,
    updatedAt: DAY_TWO,
    totalUncachedInputTokens: 900,
    totalOutputTokens: 300,
    totalCachedReadTokens: 600,
    totalCacheWriteTokens: 0,
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'a', createdAt: DAY_ONE },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'b', createdAt: DAY_TWO },
    ],
    ...overrides,
  };
}

test('a session spanning two days is split across them without losing tokens', () => {
  const summary = summarizeSessionUsage(session());

  assert.deepEqual(Object.keys(summary.days).sort(), [KEY_ONE, KEY_TWO]);
  const slices = Object.values(summary.days);
  const sum = (field) => slices.reduce((total, slice) => total + slice[field], 0);
  assert.equal(sum('input'), 900);
  assert.equal(sum('output'), 300);
  assert.equal(sum('cacheRead'), 600);
  // Both user messages are turns, and neither is invented or dropped.
  assert.equal(sum('turns'), 2);
  assert.equal(summary.conversation, true);
});

test('a transcript without timestamps lands on the day it was last used', () => {
  const summary = summarizeSessionUsage(session({
    messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' }],
  }));

  assert.deepEqual(Object.keys(summary.days), [KEY_TWO]);
  assert.equal(summary.days[KEY_TWO].input, 900);
});

test('a provider that reports the cache inside input has it unpacked once', () => {
  const summary = summarizeSessionUsage(session({
    provider: 'openai-oauth',
    model: 'gpt-5.6',
    totalUncachedInputTokens: 0,
    totalInputTokens: 10_000,
    totalCachedReadTokens: 8000,
    messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a', createdAt: DAY_ONE }],
  }));

  assert.equal(summary.days[KEY_ONE].input, 2000);
  assert.equal(summary.days[KEY_ONE].cacheRead, 8000);
});

test('a session that never spent a token contributes nothing', () => {
  assert.equal(summarizeSessionUsage(session({
    totalUncachedInputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedReadTokens: 0,
    totalCacheWriteTokens: 0,
  })), null);
  assert.equal(summarizeSessionUsage({ id: 'no-route', totalOutputTokens: 10 }), null);
});

test('days fold per route, and background sessions keep out of the conversation split', () => {
  const days = buildUsageHistoryDays([
    summarizeSessionUsage(session()),
    summarizeSessionUsage(session({
      id: 'session-cycle',
      sourceType: 'memory-cycle',
      provider: 'openai-oauth',
      model: 'gpt-5.6',
      totalUncachedInputTokens: 400,
      totalOutputTokens: 100,
      totalCachedReadTokens: 0,
      messages: [{ role: 'user', content: 'cycle' }, { role: 'assistant', content: 'x', createdAt: DAY_ONE }],
    })),
  ]);

  const day = days[KEY_ONE];
  assert.equal(day.restored, true);
  assert.deepEqual(Object.keys(day.models).sort(), ['grok-oauth/grok-4.6', 'openai-oauth/gpt-5.6']);
  assert.equal(day.input, day.models['grok-oauth/grok-4.6'].input + 400);
  // The background cycle is in the day total and out of the conversation one.
  assert.equal(day.conversation.input, day.models['grok-oauth/grok-4.6'].input);
  assert.equal(day.models['openai-oauth/gpt-5.6'].conversation.input, 0);
  // Only conversation ids count as sessions.
  assert.deepEqual(Object.keys(day.sessions), ['session-a']);
  assert.equal(day.firstTs > 0 && day.lastTs >= day.firstTs, true);
});
