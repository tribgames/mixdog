const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Official list prices ($/M). Unknown models must not inherit another row.
const OPENAI_LUNA = { input: 0.2, cached: 0.02, write: 0.25, output: 1.2, family: 'openai' };
const OPENAI_TERRA = { input: 2, cached: 0.2, write: 2.5, output: 12, family: 'openai' };
const OPENAI_SOL = { input: 5, cached: 0.5, write: 6.25, output: 30, family: 'openai' };
const ANTHROPIC_HAIKU = { input: 1, cached: 0.1, write: 1.25, output: 5, family: 'anthropic' };
const ANTHROPIC_OPUS = { input: 5, cached: 0.5, write: 10, output: 25, family: 'anthropic' };
const ANTHROPIC_SONNET = { input: 2, cached: 0.2, write: 2.5, output: 10, family: 'anthropic' };
const RATES = {
  'gpt-5.6-luna': OPENAI_LUNA,
  'gpt-5.6-terra': OPENAI_TERRA,
  'gpt-5.6-sol': OPENAI_SOL,
  'gpt-5.5': OPENAI_SOL,
  'claude-haiku-4-5': ANTHROPIC_HAIKU,
  'claude-opus-5': ANTHROPIC_OPUS,
  'claude-opus-4-8': ANTHROPIC_OPUS,
  'claude-fable-5': ANTHROPIC_OPUS,
  'claude-sonnet-5': ANTHROPIC_SONNET,
};

export function rateFor(model) {
  const name = String(model || '').trim().toLowerCase();
  if (!name || !Object.hasOwn(RATES, name)) return null;
  return RATES[name];
}

export function uncachedTokens(rate, input, cached = 0, cacheWrite = 0) {
  if (!rate) return null;
  return rate.family === 'openai'
    ? Math.max(finite(input) - finite(cached) - finite(cacheWrite), 0)
    : finite(input);
}

export function pricedSplitCost({ model, uncached, cached, cacheWrite, output }) {
  const rate = rateFor(model);
  if (!rate) return null;
  return (
    finite(uncached) * rate.input
    + finite(cached) * rate.cached
    + finite(cacheWrite) * rate.write
    + finite(output) * rate.output
  ) / 1e6;
}

export function pricedCost({ model, input, cached, cacheWrite, output }) {
  const rate = rateFor(model);
  if (!rate) return null;
  return pricedSplitCost({
    model,
    uncached: uncachedTokens(rate, input, cached, cacheWrite),
    cached,
    cacheWrite,
    output,
  });
}
