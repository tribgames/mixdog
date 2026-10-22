// Escalated max_tokens: the model's declared limit above the normal safety cap,
// used once by the loop after a turn spent its whole normal budget.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAnthropicEscalatedMaxTokens, resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';

const ENV_VAR = 'MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS';

function withEnv(value, fn) {
  const previous = process.env[ENV_VAR];
  if (value == null) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previous;
  }
}

test('escalation offers the declared limit above the safety cap', () =>
  withEnv(null, () => {
    const catalogLookup = () => 128_000;
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup }), 65_536);
    assert.equal(resolveAnthropicEscalatedMaxTokens('claude-x', { catalogLookup }), 128_000);
  }));

test('escalation is null when the declared limit is not above the normal request', () =>
  withEnv(null, () => {
    assert.equal(resolveAnthropicEscalatedMaxTokens('claude-x', { catalogLookup: () => 65_536 }), null);
    assert.equal(resolveAnthropicEscalatedMaxTokens('claude-x', { catalogLookup: () => 16_384 }), null);
    // A gateway ceiling wins over the catalog and bounds the escalation too.
    assert.equal(
      resolveAnthropicEscalatedMaxTokens('claude-x', { catalogLookup: () => 128_000, modelMaxOutputTokens: 32_000 }),
      null
    );
  }));

test('escalation is null when nothing declares a limit', () =>
  withEnv(null, () => {
    assert.equal(resolveAnthropicEscalatedMaxTokens('claude-unlisted-x', { catalogLookup: () => null }), null);
  }));

test('an explicit env override is the ceiling and is never escalated past', () =>
  withEnv('20000', () => {
    assert.equal(resolveAnthropicEscalatedMaxTokens('claude-x', { catalogLookup: () => 128_000 }), null);
  }));

test('a one-shot override wins outright in max_tokens resolution', () =>
  withEnv(null, () => {
    const catalogLookup = () => 128_000;
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup, override: 128_000 }), 128_000);
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup, override: null }), 65_536);
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup, override: 0 }), 65_536);
  }));
