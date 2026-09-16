/**
 * Per-call cost estimator for agent-trace usage rows.
 *
 * Pricing is pulled from the LiteLLM catalog (already warmed by providers/
 * agent bootstrap). All four token slots — input / output / cacheRead /
 * cacheWrite — are multiplied by their matching $/M rate from the catalog
 * and summed. A missing rate for a used token slot leaves the cost unknown.
 *
 * The catalog is looked up synchronously: if it has not been warmed yet
 * (fresh process, first call), this returns an unknown price. The next
 * call will pick up the cache.
 */

import {
  getModelMetadataSync,
  resolveModelPricingIdentity,
} from '../../agent/orchestrator/providers/model-catalog.mjs';
import { PRICING_RATE_KEYS, ratesForPrompt } from '../../agent/orchestrator/providers/model-pricing-rates.mjs';

// OpenAI OAuth / OpenAI API / Gemini report `input_tokens` as the total prompt token
// count *including* the cached portion (inclusive). Anthropic reports the
// uncached remainder only and bills cached_read / cached_write as separate
// additive slots (additive). Cost and prompt-total math has to branch on this.
// OpenAI-compatible direct providers (deepseek / mixdog-local)
// go through the OpenAI SDK and likewise report an inclusive prompt_tokens
// with a separate cached-tokens detail — so they are inclusive too. Omitting
// them bills the cached portion at the full input rate AND re-adds it as a
// cacheRead slot, double-billing the cache (e.g. a ~10k-token cached system
// prompt charged ~25x its real cost on every DeepSeek call).
export function isInclusiveProvider(provider) {
  if (!provider) return false;
  const p = String(provider).toLowerCase();
  // Matches the registry's cold-start convention. Live accounting passes
  // the provider constructor's explicit convention, including custom routes.
  return p !== 'anthropic' && p !== 'anthropic-oauth';
}

export function billableInputTokensForProvider(provider, inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const input = Number(inputTokens) || 0;
  if (!isInclusiveProvider(provider)) return input;
  return Math.max(input - (Number(cacheReadTokens) || 0) - (Number(cacheWriteTokens) || 0), 0);
}

/**
 * Price normalized token slots once. Null means unknown, not a free request.
 * Rates are returned so a durable record keeps the price applied at ingestion.
 * Historical imports use current catalog rates as estimates, not old invoices.
 */
export function priceUsage(args) {
  const n = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
  const cached = n(args.cacheReadTokens);
  const written = n(args.cacheWriteTokens);
  const inclusive = args.inputTokensInclusive ?? isInclusiveProvider(args.provider);
  const input =
    args.inputTokensKnown === false
      ? 0
      : args.uncachedInputTokens != null
        ? n(args.uncachedInputTokens)
        : inclusive
          ? Math.max(0, n(args.inputTokens) - cached - written)
          : n(args.inputTokens);
  const identity = resolveModelPricingIdentity(args.model, args.provider, args);
  const meta = getModelMetadataSync(identity.pricingModel, args.provider);
  const provenance = {
    ...identity,
    pricingProvider: meta?.pricingProvider || identity.pricingProvider,
    pricingSource: meta?.pricingSource || null,
    ...(args.inputTokensKnown === false ? { inputTokensKnown: false } : {}),
    ...(args.fast ? { fast: true } : {}),
    ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
  };
  if (args.inputTokensKnown === false || !meta)
    return {
      input,
      costUsd: null,
      rates: {
        ...provenance,
        unpricedReason: args.inputTokensKnown === false ? 'unmeasured-input' : 'model-not-found',
      },
    };
  const promptTokens = input + cached + written;
  if (
    args.historicalAggregate &&
    (meta.pricingTiers?.some((tier) => promptTokens > tier.aboveInputTokens) ||
      (meta.longContextThreshold && promptTokens >= meta.longContextThreshold))
  ) {
    // A daily sum cannot establish which individual requests crossed a
    // context boundary. Do not price the whole day as one huge prompt.
    return { input, costUsd: null, rates: { ...provenance, unpricedReason: 'request-boundaries-unavailable' } };
  }
  let multiplier = 1;
  if (meta.longContextThreshold && input + cached + written >= meta.longContextThreshold) {
    multiplier *= meta.longContextMultiplier || 1;
  }
  // DeepSeek's published peak/off-peak schedule is UTC, not the UI timezone.
  // Without an exact timestamp (legacy sessions), retain the list/peak rate.
  if (meta.offPeakMultiplier && Number.isFinite(args.ts) && !args.historical) {
    const date = new Date(args.ts);
    const h = date.getUTCHours();
    const peak = date.getUTCDay() >= 1 && date.getUTCDay() <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
    if (!peak) multiplier *= meta.offPeakMultiplier;
  }
  if (identity.pricingModel === 'claude-opus-4-8' && (args.fast || args.serviceTier === 'fast')) multiplier *= 2;
  const keys = PRICING_RATE_KEYS;
  const tokens = [input, n(args.outputTokens), cached, written];
  const tierRates = ratesForPrompt(meta, promptTokens);
  const rates = {
    ...provenance,
    ...Object.fromEntries(keys.map((key) => [key, tierRates[key] == null ? null : tierRates[key] * multiplier])),
  };
  const missingRates = keys.filter((key, i) => tokens[i] > 0 && rates[key] === null);
  if (missingRates.length) {
    rates.unpricedReason = 'missing-rate';
    rates.missingRates = missingRates;
    return { input, costUsd: null, rates };
  }
  const costUsd = tokens.reduce((sum, amount, i) => sum + amount * (rates[keys[i]] ?? 0), 0) / 1_000_000;
  return { input, costUsd: Number(costUsd.toFixed(6)), rates };
}

/**
 * @param {object} args
 * @param {string} args.model
 * @param {string} [args.provider]
 * @param {number} [args.inputTokens]
 * @param {number} [args.outputTokens]
 * @param {number} [args.cacheReadTokens]
 * @param {number} [args.cacheWriteTokens]
 * @returns {number} USD, rounded to 6 decimal places.
 */
export function computeCostUsd(args) {
  return priceUsage(args || {}).costUsd ?? 0;
}
