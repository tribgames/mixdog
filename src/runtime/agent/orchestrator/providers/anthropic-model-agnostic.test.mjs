// Model-dependent Anthropic behavior must follow catalog data first and carry
// forward to a release no code has heard of. Ids below that exist in no
// catalog (claude-nova-9) stand in for a future model; ids a fixture catalog
// describes (claude-quasar-7, claude-vega-3) prove catalog precedence.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-anthropic-agnostic-'));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
writeFileSync(
  join(dataDir, 'litellm-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      'claude-vega-3': {
        litellm_provider: 'anthropic',
        mode: 'chat',
        max_input_tokens: 640000,
        max_output_tokens: 20000,
        supports_fast_mode: true,
      },
      // Declared NOT fast-capable: beats the offline id floor that would allow it.
      'claude-opus-4-8': { litellm_provider: 'anthropic', mode: 'chat', supports_fast_mode: false },
    },
  })
);
writeFileSync(
  join(dataDir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      anthropic: {
        models: {
          // Opus 4.5 advertises an effort ladder yet keeps the manual-thinking contract.
          'claude-opus-4-5': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            tool_call: true,
          },
          'claude-opus-4-5-20251101': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            tool_call: true,
          },
          'claude-quasar-7': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            limit: { context: 750000, output: 48000 },
            tool_call: true,
          },
        },
      },
    },
  })
);
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
delete process.env.MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT;

const {
  anthropicEffortLevelsFor,
  applyAnthropicEffortToBody,
  assertAnthropicManualBudgetSupported,
  effortValuesForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  normalizeAnthropicEffortInput,
  setModelEffortCapabilities,
  shouldIncludeEffortBeta,
  thinkingTypesFromCapabilities,
} = await import('../../../shared/llm/anthropic-effort.mjs');
const { claudeGeneration, emitsAnthropicProgressUpdates } = await import(
  '../../../shared/llm/anthropic-thinking-contract.mjs'
);
const { supportsAnthropicFastMode } = await import('../../../shared/llm/anthropic-betas.mjs');
const { resolveAnthropicMaxTokens } = await import('./anthropic-max-tokens.mjs');
const { _defaultContextForModel, _normalizeAnthropicModel } = await import('./anthropic-model-resolve.mjs');
const { supportsAnthropicServerFallback } = await import('./anthropic-server-fallback.mjs');
const { _buildRequestBodyForCacheSmoke } = await import('./anthropic-oauth.mjs');
const { clampAnthropicThinkingBudget } = await import('./lib/anthropic-request-utils.mjs');

const FUTURE = 'claude-nova-9';

function effortBody(model, opts) {
  const body = { temperature: 0.5 };
  applyAnthropicEffortToBody(body, {
    model,
    opts,
    maxTokens: 64000,
    clampThinkingBudgetTokens: clampAnthropicThinkingBudget,
  });
  return body;
}

test.afterEach(() => setModelEffortCapabilities([]));

test('release generation comes from the version token, not the family name', () => {
  const table = {
    'claude-opus-4-8': 408,
    'claude-opus-4.8': 408,
    'claude-opus-4-8-20260101': 408,
    'claude-opus-4-20250514': 400,
    'claude-sonnet-4-5-20250929': 405,
    'claude-3-5-sonnet-20241022': 305,
    'claude-3-opus-20240229': 300,
    'claude-nova-9': 900,
    'claude-nova-9-1-20270101': 901,
    'claude-nova-9@20270101': 900,
    'us.anthropic.claude-opus-4-6-v1:0': 406,
    'claude-nova': Number.POSITIVE_INFINITY,
    'gpt-5': null,
    '': null,
  };
  for (const [id, generation] of Object.entries(table)) assert.equal(claudeGeneration(id), generation, id);
});

test('a future id with no catalog row gets adaptive effort, xhigh and max with no code change', () => {
  for (const id of [FUTURE, 'claude-nova-9-1', 'claude-nova-9-1-20270101', 'claude-nova-9@20270101', 'claude-nova']) {
    assert.equal(modelSupportsEffort(id), true, id);
    assert.equal(modelSupportsXhighEffort(id), true, id);
    assert.equal(modelSupportsMaxEffort(id), true, id);
    assert.deepEqual(anthropicEffortLevelsFor(id), ['low', 'medium', 'high', 'xhigh'], id);
    assert.equal(normalizeAnthropicEffortInput('xhigh', id), 'xhigh', id);
    assert.deepEqual(effortValuesForModel({ effort: true }, id), ['low', 'medium', 'high', 'xhigh', 'max'], id);
    assert.throws(() => assertAnthropicManualBudgetSupported(id), /does not support thinkingBudgetTokens/, id);
  }
  const body = effortBody(FUTURE, { effort: 'xhigh' });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'xhigh' });
  assert.equal('temperature' in body, false);
});

test('a future id builds a complete OAuth request: prefix block, adaptive effort, conservative output cap', () => {
  const body = _buildRequestBodyForCacheSmoke(
    [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ],
    FUTURE,
    [],
    { effort: 'high' }
  );
  assert.equal(body.model, FUTURE);
  assert.equal(body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.max_tokens, 8192);
});

test('generations before the adaptive floor keep the manual-thinking contract', () => {
  for (const id of [
    'claude-3-7-sonnet-latest',
    'claude-3-5-haiku-20241022',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-opus-4-1-20250805',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
  ]) {
    assert.equal(modelSupportsEffort(id), false, id);
    assert.deepEqual(anthropicEffortLevelsFor(id), [], id);
    assert.doesNotThrow(() => assertAnthropicManualBudgetSupported(id), id);
    const body = effortBody(id, { effort: 'high' });
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 16384 }, id);
    assert.equal('output_config' in body, false, id);
  }
  // 4.6: adaptive effort + max, no xhigh, manual budgets still accepted.
  assert.equal(modelSupportsEffort('claude-opus-4-6'), true);
  assert.equal(modelSupportsXhighEffort('claude-opus-4-6'), false);
  assert.equal(modelSupportsMaxEffort('claude-sonnet-4-6'), true);
  assert.doesNotThrow(() => assertAnthropicManualBudgetSupported('claude-opus-4-6'));
  // 4.7+: manual budgets rejected before any request is built.
  assert.throws(() => assertAnthropicManualBudgetSupported('claude-opus-4-7'), /thinkingBudgetTokens/);
  assert.equal(modelSupportsXhighEffort('claude-opus-4-7'), true);
  // Non-Claude ids get no Claude capability.
  assert.equal(modelSupportsEffort('gpt-5'), false);
});

test('the live roster decides effort levels and thinking types over the generation floor', () => {
  setModelEffortCapabilities([
    {
      id: FUTURE,
      reasoningOptions: [{ type: 'effort', values: ['low', 'medium'] }],
      thinkingTypes: { adaptive: true, enabled: true },
    },
    { id: 'claude-opus-5', reasoningOptions: [] },
    { id: 'claude-opus-4-1', reasoningOptions: [], thinkingTypes: { adaptive: false, enabled: false } },
  ]);
  // The floor would grant xhigh/max and reject manual budgets for claude-nova-9.
  assert.equal(modelSupportsEffort(FUTURE), true);
  assert.equal(modelSupportsXhighEffort(FUTURE), false);
  assert.equal(modelSupportsMaxEffort(FUTURE), false);
  assert.deepEqual(anthropicEffortLevelsFor(FUTURE), ['low', 'medium', 'high']);
  assert.equal(normalizeAnthropicEffortInput('xhigh', FUTURE), 'high');
  assert.doesNotThrow(() => assertAnthropicManualBudgetSupported(FUTURE));
  assert.deepEqual(effortBody(FUTURE, { thinkingBudgetTokens: 4096 }).thinking, {
    type: 'enabled',
    budget_tokens: 4096,
  });
  // A record that advertises no effort turns effort off even where the floor grants it.
  assert.equal(modelSupportsEffort('claude-opus-5'), false);
  // …and the contradictory floor (no manual thinking) still refuses a manual request.
  assert.throws(() => effortBody('claude-opus-5', { effort: 'high' }), /thinkingBudgetTokens/);
  // A declared "no manual thinking" wins over an old-looking id.
  assert.throws(() => assertAnthropicManualBudgetSupported('claude-opus-4-1'), /thinkingBudgetTokens/);
  // A dated id and its alias share one record.
  assert.equal(modelSupportsXhighEffort(`${FUTURE}-20270101`), false);
});

test('roster rows record the thinking types /v1/models declares', () => {
  const capabilities = {
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
    effort: { supported: true, low: { supported: true }, high: { supported: true } },
  };
  assert.deepEqual(thinkingTypesFromCapabilities(capabilities), { adaptive: true, enabled: false });
  assert.equal(thinkingTypesFromCapabilities({ thinking: { supported: true } }), undefined);
  const row = _normalizeAnthropicModel({ id: FUTURE, capabilities });
  assert.deepEqual(row.thinkingTypes, { adaptive: true, enabled: false });
  assert.deepEqual(row.reasoningOptions, [{ type: 'effort', values: ['low', 'high'] }]);
  setModelEffortCapabilities([row]);
  assert.throws(() => assertAnthropicManualBudgetSupported(FUTURE), /thinkingBudgetTokens/);
  assert.equal(modelSupportsXhighEffort(FUTURE), false);
});

test('the shared model catalog supplies the effort ladder when the live roster has no row', () => {
  assert.equal(modelSupportsEffort('claude-quasar-7'), true);
  assert.equal(modelSupportsXhighEffort('claude-quasar-7'), false);
  assert.deepEqual(anthropicEffortLevelsFor('claude-quasar-7'), ['low', 'medium', 'high']);
  // A live-roster row still outranks the shared catalog.
  setModelEffortCapabilities([
    { id: 'claude-quasar-7', reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'xhigh'] }] },
  ]);
  assert.equal(modelSupportsXhighEffort('claude-quasar-7'), true);
});

test('an effort ladder does not turn a manual-thinking model adaptive (Opus 4.5 keeps its legacy body)', () => {
  const legacyBody = { type: 'enabled', budget_tokens: 16384 };
  const check = (id) => {
    const body = effortBody(id, { effort: 'high' });
    assert.deepEqual(body.thinking, legacyBody, id);
    assert.equal('output_config' in body, false, id);
    assert.equal(body.temperature, 0.5, id);
    assert.equal(shouldIncludeEffortBeta(id, { effort: 'high' }), false, id);
    assert.doesNotThrow(() => assertAnthropicManualBudgetSupported(id), id);
  };
  // Shared catalog (models.dev fixture) advertises the ladder; no live roster row.
  for (const id of ['claude-opus-4-5', 'claude-opus-4-5-20251101']) {
    assert.equal(modelSupportsEffort(id), true, id);
    check(id);
  }
  // Live roster declares the ladder without thinking types: same result.
  setModelEffortCapabilities([
    { id: 'claude-opus-4-5', reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
    { id: 'claude-opus-4-5-20251101', reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
  ]);
  for (const id of ['claude-opus-4-5', 'claude-opus-4-5-20251101']) check(id);
  // A roster that DECLARES adaptive wins over the floor.
  setModelEffortCapabilities([
    {
      id: 'claude-opus-4-5',
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
      thinkingTypes: { adaptive: true },
    },
  ]);
  assert.deepEqual(effortBody('claude-opus-4-5', { effort: 'high' }).thinking, { type: 'adaptive' });
  // A future id with a ladder in either tier is adaptive.
  for (const id of [FUTURE, 'claude-quasar-7']) {
    const body = effortBody(id, { effort: 'low' });
    assert.deepEqual(body.thinking, { type: 'adaptive' }, id);
    assert.deepEqual(body.output_config, { effort: 'low' }, id);
    assert.equal(shouldIncludeEffortBeta(id, { effort: 'low' }), true, id);
  }
});

test('max_tokens: env, live roster, shared catalog, then the pre-catalog family limits', () => {
  assert.equal(resolveAnthropicMaxTokens(FUTURE), 8192);
  assert.equal(resolveAnthropicMaxTokens('claude-opus-9-9'), 65536);
  assert.equal(resolveAnthropicMaxTokens('claude-sonnet-5-5'), 65536);
  assert.equal(resolveAnthropicMaxTokens('claude-quasar-7'), 48000);
  assert.equal(resolveAnthropicMaxTokens('claude-vega-3'), 20000);
  assert.equal(resolveAnthropicMaxTokens('claude-quasar-7', { catalogLookup: () => 30000 }), 30000);
  assert.equal(resolveAnthropicMaxTokens('claude-quasar-7', { catalogLookup: () => 900000 }), 65536);
  assert.equal(
    resolveAnthropicMaxTokens('claude-quasar-7', {
      catalogLookup: () => {
        throw new Error('no roster');
      },
    }),
    48000
  );
  process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = '12345';
  try {
    assert.equal(resolveAnthropicMaxTokens('claude-quasar-7', { catalogLookup: () => 30000 }), 12345);
  } finally {
    delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
  }
});

test('context window: reported value, shared catalog, then the pre-catalog family windows', () => {
  assert.equal(_defaultContextForModel(FUTURE), 1000000);
  assert.equal(_defaultContextForModel('claude-haiku-4-5'), 200000);
  assert.equal(_defaultContextForModel('claude-quasar-7'), 750000);
  assert.equal(_normalizeAnthropicModel({ id: FUTURE }).contextWindow, 1000000);
  assert.equal(_normalizeAnthropicModel({ id: FUTURE, max_input_tokens: 2000000 }).contextWindow, 2000000);
  assert.equal(_normalizeAnthropicModel({ id: 'claude-quasar-7' }).contextWindow, 750000);
});

test('fast mode: the catalog declaration decides, the id floor only fills silence', () => {
  assert.equal(supportsAnthropicFastMode('claude-vega-3'), true);
  assert.equal(supportsAnthropicFastMode('claude-opus-4-8'), false);
  assert.equal(supportsAnthropicFastMode('claude-opus-5'), true);
  assert.equal(supportsAnthropicFastMode(FUTURE), false);
});

test('beta-gated extras stay off for an id nothing declares', () => {
  assert.equal(emitsAnthropicProgressUpdates(FUTURE), false);
  assert.equal(supportsAnthropicServerFallback(FUTURE), false);
  const body = _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'hi' }], FUTURE, [], { effort: 'high' });
  assert.equal('fallbacks' in body, false);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
});
