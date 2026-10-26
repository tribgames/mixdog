// cache-warm-prices.test.mjs — the per-token prices a warm's break-even is
// computed from (cache-warm.mjs defaultPrices) follow the session's actual
// prompt length: a model priced by prompt length charges cache reads, writes
// and output at the tier the prompt falls in.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-cache-warm-prices-'));
process.env.MIXDOG_DATA_DIR = dir;
// Published-style long-context pricing: above 200k prompt tokens every rate
// changes (litellm `*_above_200k_tokens` columns).
writeFileSync(
  join(dir, 'litellm-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      'anthropic/claude-tier-test': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
        cache_read_input_token_cost: 0.4e-6,
        cache_creation_input_token_cost: 5e-6,
        input_cost_per_token_above_200k_tokens: 8e-6,
        output_cost_per_token_above_200k_tokens: 30e-6,
        cache_read_input_token_cost_above_200k_tokens: 0.8e-6,
        cache_creation_input_token_cost_above_200k_tokens: 10e-6,
      },
    },
  })
);
const { defaultPrices } = await import('./cache-warm.mjs');

after(() => rmSync(dir, { recursive: true, force: true }));

const M = 1_000_000;
const MINUTE = 60_000;
const request = { model: 'claude-tier-test', provider: { name: 'anthropic' }, opts: {} };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

test('a prompt under the long-context boundary is priced at the base rates, not the 1M-token tier', async () => {
  const short = await defaultPrices(request, 5 * MINUTE, 100_000);
  close(short.read, 0.4 / M);
  close(short.write, 5 / M);
  close(short.output, 20 / M);
  const hour = await defaultPrices(request, 60 * MINUTE, 100_000);
  close(hour.write, 8 / M);
});

test('a prompt over the boundary is priced at the long-context rates for reads, writes and output', async () => {
  const long = await defaultPrices(request, 5 * MINUTE, 300_000);
  close(long.read, 0.8 / M);
  close(long.write, 10 / M);
  close(long.output, 30 / M);
  const hour = await defaultPrices(request, 60 * MINUTE, 300_000);
  close(hour.write, 16 / M);
});

test('an unpriced model has no prices', async () => {
  const none = await defaultPrices({ ...request, model: 'claude-unpriced-test' }, 5 * MINUTE, 100_000);
  assert.deepEqual(none, { read: null, write: null, output: null });
});
