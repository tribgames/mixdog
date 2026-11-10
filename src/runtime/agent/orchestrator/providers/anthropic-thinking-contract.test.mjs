import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAnthropicEffortToBody, setModelEffortCapabilities } from './anthropic-effort.mjs';
import { emitsAnthropicProgressUpdates, supportsAnthropicTurnScopedSystemMessages } from './anthropic-thinking-contract.mjs';
import { clampAnthropicThinkingBudget } from './lib/anthropic-request-utils.mjs';
import { _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';

test('adaptive-only Claude models reject manual thinking budgets before producing an invalid request', () => {
  for (const model of [
    'claude-fable-5-1',
    'claude-fable-5.1-20260901',
    'claude-mythos-5-1',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
  ]) {
    const body = { model };
    assert.throws(
      () =>
        applyAnthropicEffortToBody(body, {
          model,
          opts: { thinkingBudgetTokens: 4096, effort: 'high' },
          maxTokens: 128000,
          clampThinkingBudgetTokens: clampAnthropicThinkingBudget,
        }),
      /does not support thinkingBudgetTokens; use effort/
    );
    assert.deepEqual(body, { model });
  }
});

// The id lists these predicates were before the family floors: every listed id
// keeps its "yes", in its dated and dotted spellings too.
const OLD_PROGRESS_UPDATES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5'];
const OLD_TURN_SCOPED = [
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
];
// Catalog ids no list named: they keep their "no".
const NEVER_LISTED = [
  'claude-opus-4-1',
  'claude-opus-4-20250514',
  'claude-sonnet-4',
  'claude-3-7-sonnet-20250219',
  'claude-opus-4-8-fast',
  'claude-opus-5-5@default',
  'anthropic.claude-fable-5-1',
  'us.anthropic.claude-opus-5-5',
  'claude-fable-latest',
  'claude-mythos-preview',
  'claude-nova-9',
];
const spellings = (id) => [id, `${id}-20261101`, id.replace(/-(\d+)-(\d+)$/, '-$1.$2')];

function assertTable(predicate, { listed, off, newer }) {
  for (const id of listed) for (const spelling of spellings(id)) assert.equal(predicate(spelling), true, spelling);
  for (const id of [...NEVER_LISTED, ...off]) for (const spelling of spellings(id)) assert.equal(predicate(spelling), false, spelling);
  for (const [id, expected] of Object.entries(newer)) assert.equal(predicate(id), expected, id);
}

test('progress updates: each family from its first listed version on, later versions inherit', () => {
  assertTable(emitsAnthropicProgressUpdates, {
    listed: OLD_PROGRESS_UPDATES,
    off: ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-mythos-5'],
    newer: {
      'claude-fable-5-2': true,
      'claude-mythos-5-2': true,
      'claude-mythos-5.2-20261201': true,
      'claude-opus-6': true,
      'claude-sonnet-5-6': true,
      'claude-fable-7-1': true,
      // A family with no floor stays off at any version.
      'claude-haiku-6': false,
      'claude-nova-9-9': false,
    },
  });
});

test('turn-scoped system messages: each family from its first listed version on, later versions inherit', () => {
  assertTable(supportsAnthropicTurnScopedSystemMessages, {
    listed: OLD_TURN_SCOPED,
    off: ['claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    newer: {
      'claude-fable-5-2': true,
      'claude-mythos-5-2': true,
      'claude-opus-6': true,
      'claude-sonnet-6': true,
      'claude-haiku-5-6': true,
      'claude-nova-9-9': false,
    },
  });
});

test('Mythos 5.1 uses adaptive thinking and effort with no model catalog', () => {
  setModelEffortCapabilities([]);
  for (const model of ['claude-mythos-5-1', 'claude-mythos-5.1-20260901']) {
    for (const effort of ['low', 'high', 'xhigh', 'max']) {
      const body = _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'Hello.' }], model, [], { effort });
      // Mythos 5.1 writes tool preambles as progress updates, so OAuth asks for them.
      assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' });
      assert.deepEqual(body.output_config, { effort });
    }
  }
});
