import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCompatErrorContract } from './openai-compat-error-contract.mjs';
import { listCompatModels } from './openai-compat-models.mjs';
import { extractCompatCachedTokens } from './openai-compat-trace.mjs';
import { providerErrorKind } from './provider-error-kind.mjs';
import { compatReportedCostUsd, responsesReportedCostUsd } from './openai-compat-response-normalization.mjs';

test('OpenRouter 402 in-flight budget is transient; other 402s stay billing', () => {
  const budget = Object.assign(new Error('in flight budget'), {
    status: 402,
    headers: { 'retry-after': '3' },
    error: { code: 'openrouter_in_flight_budget', message: 'budget' },
  });
  const r = providerErrorKind(budget);
  assert.equal(r.kind, 'transient');
  assert.equal(r.retryAfterMs, 3000);
  const plain = Object.assign(new Error('Insufficient credits'), { status: 402, error: { code: 402 } });
  assert.equal(providerErrorKind(plain).kind, 'billing');
  const typed = Object.assign(new Error('pay'), { status: 402, error: { metadata: { error_type: 'payment_required' } } });
  assert.equal(providerErrorKind(typed).kind, 'billing');
});

test('OpenRouter in-flight 402 is read from metadata.limit_source and needs short Retry-After advice', () => {
  const make = (headers) =>
    Object.assign(new Error('budget'), {
      status: 402,
      headers,
      error: { code: 402, metadata: { limit_source: 'openrouter_in_flight_budget' } },
    });
  assert.equal(providerErrorKind(make({ 'retry-after': '2' })).kind, 'transient');
  assert.equal(providerErrorKind(make({})).kind, 'billing');
  assert.equal(providerErrorKind(make({ 'retry-after': '600' })).kind, 'billing');
});

test('in-flight 402 accepts Retry-After 0 through 60s inclusive, nothing beyond', () => {
  const make = (value) =>
    Object.assign(new Error('budget'), {
      status: 402,
      headers: { 'retry-after': value },
      error: { code: 'openrouter_in_flight_budget' },
    });
  for (const value of ['0', '1', '60']) assert.equal(providerErrorKind(make(value)).kind, 'transient', value);
  for (const value of ['61', '-1', 'soon']) assert.equal(providerErrorKind(make(value)).kind, 'billing', value);
});

test('non-budget 402 is billing even with generic retryable codes', () => {
  for (const code of ['server_error', 'rate_limit_exceeded', 'overloaded_error']) {
    const err = Object.assign(new Error('x'), { status: 402, headers: { 'retry-after': '2' }, error: { code } });
    assert.equal(providerErrorKind(err).kind, 'billing', code);
  }
  const typedWithMetadata = Object.assign(new Error('x'), {
    status: 402,
    error: { code: 'server_error', metadata: { limit_source: 'openrouter_credits' } },
  });
  assert.equal(providerErrorKind(typedWithMetadata).kind, 'billing');
});

test('responses reported cost: ticks outrank cost; null/empty/negative is not reported', () => {
  assert.equal(responsesReportedCostUsd({ cost_in_usd_ticks: 5e9, cost: 9 }), 0.5);
  assert.equal(responsesReportedCostUsd({ cost: 0.25 }), 0.25);
  assert.equal(responsesReportedCostUsd({ cost: 0 }), 0);
  for (const cost of [null, '', '  ', -1]) assert.equal(responsesReportedCostUsd({ cost }), undefined);
  assert.equal(responsesReportedCostUsd({ cost_in_usd_ticks: -1 }), undefined);
  assert.equal(compatReportedCostUsd('openrouter', { cost: '' }), undefined);
  assert.equal(compatReportedCostUsd('xai', { cost_in_usd_ticks: null }), undefined);
});

test('resetAt reads nested error.metadata.resets_at', () => {
  const err = applyCompatErrorContract(
    Object.assign(new Error('limit'), { status: 429, error: { message: 'x', metadata: { resets_at: 1_900_000_000 } } })
  );
  assert.equal(err.resetAt, 1_900_000_000_000);
});

test('top-level usage.cached_tokens is read without stacking on nested counts', () => {
  assert.equal(extractCompatCachedTokens({ prompt_tokens: 100, cached_tokens: 40 }), 40);
  assert.equal(
    extractCompatCachedTokens({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, cached_tokens: 30 }),
    30
  );
});

test('listCompatModels keeps native metadata and drops native non-chat entries', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try {
    const items = [
      { id: 'zz-mistral-x', max_context_length: 32768, capabilities: { completion_chat: true }, type: 'base' },
      { id: 'zz-mistral-embed', max_context_length: 8192, capabilities: { completion_chat: false } },
      {
        id: 'zz-or-x',
        context_length: 1000,
        top_provider: { context_length: 1000, max_completion_tokens: 512 },
      },
      { id: 'zz-or-image', context_length: 1000, architecture: { output_modalities: ['image'] } },
      { id: 'zz-together-chat', type: 'chat', context_length: 4096 },
      { id: 'zz-together-emb', type: 'embedding', context_length: 512 },
    ];
    const provider = { name: 'zz-custom', _fetchModelItems: async () => items };
    const rows = await listCompatModels(provider, { throwOnError: true });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId['zz-mistral-x'].contextWindow, 32768);
    assert.equal(byId['zz-mistral-x'].mode, 'chat');
    assert.equal(byId['zz-or-x'].outputTokens, 512);
    assert.equal(byId['zz-or-x'].contextWindow, 1000);
    assert.equal(byId['zz-together-chat'].mode, 'chat');
    assert.equal(byId['zz-mistral-embed'], undefined);
    assert.equal(byId['zz-together-emb'], undefined);
    assert.equal(byId['zz-or-image'], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
