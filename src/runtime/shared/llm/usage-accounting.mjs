import { randomUUID } from 'node:crypto';
import { getUsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { withUsageContext } from './usage-context.mjs';

/**
 * Runs at the common provider boundary, not inside optional diagnostic IO.
 * Provider-local retries remain owned by the provider. Accounting failure must
 * not replay a paid request or replace a provider's cancellation/error.
 */
export async function accountProviderSend(provider, instance, send, model, opts = {}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const sessionId = opts.sessionId || opts.session?.id;
  const sourceType = opts.session?.sourceType || opts.sourceType || opts.requestKind || '';
  const inputTokensInclusive = instance.constructor?.inputExcludesCache !== true;
  let ledger;
  let openingError;
  try {
    ledger = getUsageLedger();
    ledger?.beginCapture(startedAt);
  } catch (error) {
    openingError = error;
  }
  const record = (result) => {
    if (!result?.usage) return;
    if (openingError) throw openingError;
    if (!ledger) return;
    const usage = result.usage;
    const row = makeUsageRecord({
      id: result.responseId ? undefined : requestId,
      ts: Date.now(),
      provider,
      model: result.model || model,
      requestedModel: model,
      pricingModel: result.pricingModel,
      sessionId,
      sourceType,
      inputTokens: usage.inputTokens,
      inputTokensKnown: usage.inputTokensKnown,
      inputTokensInclusive,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      cacheWrite1hTokens: usage.cacheWrite1hTokens,
      costUsd: usage.costUsd,
      serviceTier: result.serviceTier || usage.raw?.service_tier,
      fast: opts.fast === true,
      responseId: result.responseId,
      durationMs: Date.now() - startedAt,
    });
    ledger.record([row]);
  };
  const save = (result) => {
    try {
      record(result);
    } catch (error) {
      result.usageAccountingError = String(error?.message || error);
      process.stderr.write(`[usage-ledger] RECORD NOT SAVED: ${result.usageAccountingError}\n`);
    }
  };
  let result;
  try {
    result = await withUsageContext(
      {
        provider,
        requestedModel: model,
        sessionId,
        sourceType,
        inputTokensInclusive,
      },
      send
    );
  } catch (error) {
    // Only provider-reported partial usage is recordable; never invent
    // tokens for a failed request or reinterpret an error as a success.
    if (error?.usage) save(error);
    throw error;
  }
  save(result);
  return result;
}
