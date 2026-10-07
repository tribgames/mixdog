/**
 * Usage ledger rows for media generations.
 *
 * Adapters return (or attach to their error) a normalized `usage` object read
 * from what the upstream response actually reported:
 *   { inputTokens, outputTokens, cachedTokens, outputImageTokens, outputVideoTokens,
 *     costUsd, images, seconds, resolution }
 * `jobs.mjs` records exactly one row per generation through recordMediaUsage.
 * Nothing here estimates tokens: a field the provider did not report stays absent.
 */
import { getUsageLedger, makeUsageRecord } from '../shared/llm/usage-ledger.mjs';
import { ACCOUNT_PROVIDERS } from '../shared/provider-accounts.mjs';
import { currentProviderAccountId } from '../shared/provider-auth-binding.mjs';

const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : 0);
const pick = (source, ...keys) => {
  for (const key of keys) if (source?.[key] != null) return source[key];
  return undefined;
};

const TICKS_PER_USD = 1e10;

/** Token usage when the provider reported any; null otherwise. */
function tokenUsage(fields) {
  const usage = Object.fromEntries(Object.entries(fields).filter(([, value]) => value > 0));
  return Object.keys(usage).length ? usage : null;
}

/** Gemini `generateContent` / Antigravity `usageMetadata` (camelCase or snake_case). */
export function geminiUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const details = pick(meta, 'candidatesTokensDetails', 'candidates_tokens_details');
  const imageTokens = (Array.isArray(details) ? details : [])
    .filter((entry) => String(entry?.modality || '').toUpperCase() === 'IMAGE')
    .reduce((sum, entry) => sum + count(pick(entry, 'tokenCount', 'token_count')), 0);
  return tokenUsage({
    inputTokens: count(pick(meta, 'promptTokenCount', 'prompt_token_count')),
    cachedTokens: count(pick(meta, 'cachedContentTokenCount', 'cached_content_token_count')),
    outputTokens:
      count(pick(meta, 'candidatesTokenCount', 'candidates_token_count')) +
      count(pick(meta, 'thoughtsTokenCount', 'thoughts_token_count')),
    outputImageTokens: imageTokens,
  });
}

/** Gemini Interactions API `usage` (omni video). */
export function interactionsUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const videoTokens = (Array.isArray(usage.output_tokens_by_modality) ? usage.output_tokens_by_modality : [])
    .filter((entry) => String(entry?.modality || '').toLowerCase() === 'video')
    .reduce((sum, entry) => sum + count(entry?.tokens), 0);
  return tokenUsage({
    inputTokens: count(usage.total_input_tokens),
    cachedTokens: count(usage.total_cached_tokens),
    outputTokens: count(usage.total_output_tokens) + count(usage.total_thought_tokens),
    outputVideoTokens: videoTokens,
  });
}

/** OpenAI / Codex Responses `usage` from response.completed. */
export function responsesUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return tokenUsage({
    inputTokens: count(usage.input_tokens),
    cachedTokens: count(usage.input_tokens_details?.cached_tokens),
    outputTokens: count(usage.output_tokens),
  });
}

/** xAI image/video `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks); the billed cost. */
export function xaiUsage(usage) {
  const ticks = usage?.cost_in_usd_ticks;
  return typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0 ? { costUsd: ticks / TICKS_PER_USD } : null;
}

/** True when the provider reported something billable for the request. */
export function hasReportedUsage(usage) {
  if (!usage) return false;
  // Seconds are only attached once a video generation completed (billed per second).
  return (
    typeof usage.costUsd === 'number' ||
    ['inputTokens', 'outputTokens', 'cachedTokens', 'seconds'].some((k) => usage[k] > 0)
  );
}

/** Attach provider-reported usage to a failure so jobs.mjs can still record it. */
export function withReportedUsage(error, usage) {
  if (hasReportedUsage(usage)) error.usage = usage;
  return error;
}

/**
 * Append one ledger row for a generation. A ledger failure never fails the
 * generation; it is logged the way usage-accounting does.
 */
export async function recordMediaUsage(args, getLedger = getUsageLedger) {
  try {
    const usage = args.usage || {};
    const row = makeUsageRecord({
      ts: Date.now(),
      provider: args.lane,
      model: args.model,
      requestedModel: args.model,
      pricingModel: args.pricingModel,
      sessionId: args.sessionId,
      sourceType: args.sourceType,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedTokens,
      costUsd: usage.costUsd,
      media: {
        reportedCostUsd: usage.costUsd,
        outputImageTokens: usage.outputImageTokens,
        outputVideoTokens: usage.outputVideoTokens,
        images: usage.images,
        seconds: usage.seconds,
        resolution: usage.resolution,
      },
      account: ACCOUNT_PROVIDERS.includes(args.lane) ? currentProviderAccountId(args.lane) : '',
      // No durationMs: a generation's wall time is render time, not token
      // streaming, and a timed row would report it as the model's output speed.
    });
    await getLedger()?.recordQueued(row);
  } catch (error) {
    process.stderr.write(`[usage-ledger] RECORD NOT SAVED: ${String(error?.message || error)}\n`);
  }
}
