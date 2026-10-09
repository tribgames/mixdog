import { randomUUID } from 'node:crypto';
import { getUsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { isNotedUsage, withUsageContext } from './usage-context.mjs';
import { ACCOUNT_PROVIDERS } from '../provider-accounts.mjs';
import { currentProviderAccountId } from '../provider-auth-binding.mjs';

// Results and errors already written. A provider-local re-send (model
// fallback, catalog retry) runs its own accounting and its result or error
// then returns through the enclosing send, which must not write it again.
const recorded = new WeakSet();
const hasTokens = (usage) =>
  ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'].some((key) => Number(usage?.[key]) > 0);
// One rule for every reported usage object: tokens, or a provider-reported
// cost (a cost-only report is still a billed request).
const recordable = (usage) =>
  hasTokens(usage) ||
  (usage?.costUsd != null &&
    usage.costUsd !== '' &&
    Number.isFinite(Number(usage.costUsd)) &&
    Number(usage.costUsd) >= 0);

/**
 * Runs at the common provider boundary, not inside optional diagnostic IO.
 * Provider-local retries remain owned by the provider. Accounting failure must
 * not replay a paid request or replace a provider's cancellation/error.
 */
export async function accountProviderSend(provider, instance, send, model, opts = {}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  // usageSessionId: a request isolated under its own provider session id
  // (compaction's `:compact`) whose spend belongs to the source session.
  const sessionId = opts.usageSessionId || opts.sessionId || opts.session?.id;
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
  const identity = {
    provider,
    requestedModel: model,
    sessionId,
    sourceType,
    inputTokensInclusive,
  };
  // `timed`: only a send's completed result owns the request's wall time. An
  // abandoned attempt or a failure shares that clock with the final attempt,
  // so timing it too would count the same seconds twice and understate speed.
  const record = async (result, id, owner, timed) => {
    if (!result?.usage) return;
    // A nested send (e.g. a fallback model re-send) already stamped its own
    // final attempt's tier; the outer context only saw the abandoned attempt.
    result.requestServiceTier ??= identity.requestServiceTier || '';
    if (recorded.has(owner)) return;
    if (openingError) throw openingError;
    if (!ledger) return;
    recorded.add(owner);
    const usage = result.usage;
    const row = makeUsageRecord({
      id: result.responseId ? undefined : id,
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
      requestServiceTier: result.requestServiceTier,
      responseId: result.responseId,
      // The account this send is bound to, so quota history can tell one
      // connected subscription's records from another's.
      account: ACCOUNT_PROVIDERS.includes(provider) ? currentProviderAccountId(provider) : '',
      durationMs: timed ? Date.now() - startedAt : 0,
    });
    // Committed by the ledger worker (batched with concurrent sends); the
    // send still settles only once its row is durable, as before, but the
    // SQLite write no longer runs on the event loop.
    await ledger.recordQueued(row);
  };
  const save = async (result, id = requestId, owner = result, timed = false) => {
    try {
      await record(result, id, owner, timed);
    } catch (error) {
      result.usageAccountingError = String(error?.message || error);
      process.stderr.write(`[usage-ledger] RECORD NOT SAVED: ${result.usageAccountingError}\n`);
    }
  };
  const saveAbandoned = async () => {
    for (const [index, attempt] of (identity.abandonedUsage || []).entries()) {
      if (recordable(attempt.usage)) await save(attempt, `${requestId}:abandoned:${index}`);
    }
  };
  let result;
  try {
    result = await withUsageContext(identity, send);
  } catch (error) {
    await saveAbandoned();
    // Only provider-reported partial usage is recordable; never invent
    // tokens for a failed request or reinterpret an error as a success.
    // Usage already noted as an abandoned attempt was just recorded above.
    if (error?.usage) {
      if (!isNotedUsage(error.usage)) await save(error);
    } else if (recordable(error?.partialUsage) && !isNotedUsage(error.partialUsage))
      await save({ usage: error.partialUsage, model: error.partialModel }, requestId, error);
    throw error;
  }
  await saveAbandoned();
  await save(result, requestId, result, true);
  return result;
}
