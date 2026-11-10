// Source formats are normalized to USD per million tokens before merging.
export const PRICING_RATE_KEYS = Object.freeze([
  'inputCostPerM',
  'outputCostPerM',
  'cacheReadCostPerM',
  'cacheWriteCostPerM',
]);
const LITELLM_KEYS = [
  'input_cost_per_token',
  'output_cost_per_token',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
];
const MODELSDEV_KEYS = ['input', 'output', 'cache_read', 'cache_write'];
const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function rates(source, keys, multiplier) {
  return Object.fromEntries(
    PRICING_RATE_KEYS.map((key, i) => [key, validRate(source?.[keys[i]]) ? source[keys[i]] * multiplier : null])
  );
}

// `suffix` selects a service-tier column set (e.g. `_priority`), published as
// `<key>_priority` and `<key>_above_<N>k_tokens_priority`.
export function litellmPricing(entry, suffix = '') {
  const thresholds = new Set();
  const tierKey = new RegExp(`^_above_(\\d+)k_tokens${suffix}$`);
  for (const key of Object.keys(entry || {})) {
    for (const prefix of LITELLM_KEYS) {
      if (!key.startsWith(`${prefix}_above_`)) continue;
      const match = key.slice(prefix.length).match(tierKey);
      if (match) thresholds.add(Number(match[1]) * 1000);
    }
  }
  return {
    ...rates(
      entry,
      LITELLM_KEYS.map((key) => `${key}${suffix}`),
      1_000_000
    ),
    pricingTiers: [...thresholds]
      .sort((a, b) => a - b)
      .map((aboveInputTokens) => ({
        aboveInputTokens,
        ...rates(
          entry,
          LITELLM_KEYS.map((key) => `${key}_above_${aboveInputTokens / 1000}k_tokens${suffix}`),
          1_000_000
        ),
      })),
  };
}

/**
 * Non-token media rates published by LiteLLM: USD per generated image, USD per
 * generated video second (optionally per resolution, `output_cost_per_second_<res>`),
 * and USD/M for image / video output tokens, which bill above the text output rate.
 */
export function litellmMediaPricing(entry) {
  const perM = (value) => (validRate(value) ? value * 1_000_000 : null);
  const byResolution = {};
  for (const [key, value] of Object.entries(entry || {})) {
    const match = key.match(/^output_cost_per_second_(.+)$/);
    if (match && validRate(value)) byResolution[match[1].toLowerCase()] = value;
  }
  return {
    outputImageCostPerM: perM(entry?.output_cost_per_image_token),
    outputVideoCostPerM: perM(entry?.output_cost_per_video_token),
    outputCostPerImage: validRate(entry?.output_cost_per_image) ? entry.output_cost_per_image : null,
    outputCostPerSecond: validRate(entry?.output_cost_per_second) ? entry.output_cost_per_second : null,
    outputCostPerSecondByResolution: byResolution,
  };
}

export function modelsDevPricing(cost) {
  // Structured tiers supersede the older context_over_200k compatibility
  // field; it can coexist with a tier whose actual boundary is not 200k.
  let tiers = [];
  if (Array.isArray(cost?.tiers)) {
    tiers = cost.tiers
      .filter((row) => row?.tier?.type === 'context' && Number.isFinite(row.tier.size) && row.tier.size > 0)
      .map((row) => ({ aboveInputTokens: row.tier.size, ...rates(row, MODELSDEV_KEYS, 1) }));
  } else if (cost?.context_over_200k) {
    tiers = [{ aboveInputTokens: 200000, ...rates(cost.context_over_200k, MODELSDEV_KEYS, 1) }];
  }
  return {
    ...rates(cost, MODELSDEV_KEYS, 1),
    pricingTiers: tiers.sort((a, b) => a.aboveInputTokens - b.aboveInputTokens),
  };
}

export function ratesForPrompt(meta, promptTokens) {
  const result = Object.fromEntries(PRICING_RATE_KEYS.map((key) => [key, meta?.[key] ?? null]));
  for (const tier of meta?.pricingTiers || []) {
    if (promptTokens <= tier.aboveInputTokens) continue;
    for (const key of PRICING_RATE_KEYS) if (tier[key] != null) result[key] = tier[key];
  }
  return result;
}
