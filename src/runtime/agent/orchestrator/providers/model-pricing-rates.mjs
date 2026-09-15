// Source formats are normalized to USD per million tokens before merging.
export const PRICING_RATE_KEYS = Object.freeze([
    'inputCostPerM', 'outputCostPerM', 'cacheReadCostPerM', 'cacheWriteCostPerM',
]);
const LITELLM_KEYS = [
    'input_cost_per_token', 'output_cost_per_token',
    'cache_read_input_token_cost', 'cache_creation_input_token_cost',
];
const MODELSDEV_KEYS = ['input', 'output', 'cache_read', 'cache_write'];
const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function rates(source, keys, multiplier) {
    return Object.fromEntries(PRICING_RATE_KEYS.map((key, i) =>
        [key, validRate(source?.[keys[i]]) ? source[keys[i]] * multiplier : null]));
}

export function litellmPricing(entry) {
    const thresholds = new Set();
    for (const key of Object.keys(entry || {})) {
        for (const prefix of LITELLM_KEYS) {
            if (!key.startsWith(`${prefix}_above_`)) continue;
            const match = key.slice(prefix.length).match(/^_above_(\d+)k_tokens$/);
            if (match) thresholds.add(Number(match[1]) * 1000);
        }
    }
    return {
        ...rates(entry, LITELLM_KEYS, 1_000_000),
        pricingTiers: [...thresholds].sort((a, b) => a - b).map((aboveInputTokens) => ({
            aboveInputTokens,
            ...rates(entry, LITELLM_KEYS.map((key) => `${key}_above_${aboveInputTokens / 1000}k_tokens`), 1_000_000),
        })),
    };
}

export function modelsDevPricing(cost) {
    // Structured tiers supersede the older context_over_200k compatibility
    // field; it can coexist with a tier whose actual boundary is not 200k.
    const tiers = Array.isArray(cost?.tiers)
        ? cost.tiers.filter((row) => row?.tier?.type === 'context'
            && Number.isFinite(row.tier.size) && row.tier.size > 0)
            .map((row) => ({ aboveInputTokens: row.tier.size, ...rates(row, MODELSDEV_KEYS, 1) }))
        : cost?.context_over_200k
            ? [{ aboveInputTokens: 200000, ...rates(cost.context_over_200k, MODELSDEV_KEYS, 1) }] : [];
    return { ...rates(cost, MODELSDEV_KEYS, 1), pricingTiers: tiers.sort((a, b) => a.aboveInputTokens - b.aboveInputTokens) };
}

export function ratesForPrompt(meta, promptTokens) {
    const result = Object.fromEntries(PRICING_RATE_KEYS.map((key) => [key, meta?.[key] ?? null]));
    for (const tier of meta?.pricingTiers || []) {
        if (promptTokens <= tier.aboveInputTokens) continue;
        for (const key of PRICING_RATE_KEYS) if (tier[key] != null) result[key] = tier[key];
    }
    return result;
}
