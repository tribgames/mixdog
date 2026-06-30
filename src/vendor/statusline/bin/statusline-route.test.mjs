import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGatewayLimitSegments } from './statusline-route.mjs';

test('formatGatewayLimitSegments hides OpenAI OAuth credit balance on L1', () => {
  const segments = formatGatewayLimitSegments({
    provider: 'openai-oauth',
    providerKind: 'oauth',
    source: 'openai-codex-wham',
    quotaWindows: [
      { label: '5H', source: 'openai-codex-oauth', usedPct: 42 },
      { label: '7D', source: 'openai-codex-oauth', usedPct: 5 },
    ],
    balance: {
      source: 'openai-codex-credits',
      remainingUsd: 12.34,
    },
  }, { COLS: 120 });

  assert.deepEqual(segments, ['5H 42%', '7D 5%']);
  assert.equal(segments.some((segment) => /Credit|\$12\.34/.test(segment)), false);
});

test('formatGatewayLimitSegments falls back to percent for OpenAI OAuth credit windows', () => {
  const segments = formatGatewayLimitSegments({
    provider: 'openai-oauth',
    providerKind: 'oauth',
    quotaWindows: [
      {
        label: '5H',
        source: 'openai-codex-oauth',
        usedPct: 55,
        remainingUsd: 4,
        usedUsd: 6,
        limitUsd: 10,
        remainingCredits: 40,
        usedCredits: 60,
        limitCredits: 100,
      },
    ],
  }, { COLS: 120 });

  assert.deepEqual(segments, ['5H 55%']);
});

test('formatGatewayLimitSegments keeps non-OpenAI OAuth credit balance on L1', () => {
  const segments = formatGatewayLimitSegments({
    provider: 'anthropic-oauth',
    providerKind: 'oauth',
    source: 'anthropic-oauth',
    quotaWindows: [
      { label: '5H', source: 'anthropic-oauth', usedPct: 20 },
    ],
    balance: {
      source: 'anthropic-oauth-extra',
      remainingUsd: 7.5,
    },
  }, { COLS: 120 });

  assert.ok(segments.includes('Credit $7.50'));
});

test('formatGatewayLimitSegments suppresses OpenAI OAuth credit via providerId even without a source hint', () => {
  // Mirrors the merged quotaStatus shape (mergeQuotaStatus) where `source` may
  // be absent and `balance.source` is generic: the providerId === openai-oauth
  // branch alone must still suppress any Credit/$ leak on L1.
  const segments = formatGatewayLimitSegments({
    provider: 'openai-oauth',
    providerKind: 'oauth',
    quotaWindows: [
      { label: '5H', source: 'openai-codex-oauth', usedPct: 30 },
    ],
    balance: {
      remainingUsd: 99.99,
    },
  }, { COLS: 120 });

  assert.deepEqual(segments, ['5H 30%']);
  assert.equal(segments.some((segment) => /Credit|\$/.test(segment)), false);
});
