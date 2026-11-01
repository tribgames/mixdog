import { randomUUID } from 'node:crypto';
import { getUsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { currentUsageContext, isNotedUsage, withUsageContext } from './usage-context.mjs';
import { servedModelSubstituted, usageRequestStatus } from './usage-request-status.mjs';
import { isVisibleStreamProgress } from '../stream-progress.mjs';
import { ACCOUNT_PROVIDERS } from '../provider-accounts.mjs';
import { currentProviderAccountId } from '../provider-auth-binding.mjs';

// Results and errors already written. A provider-local re-send (model
// fallback, catalog retry) runs its own accounting and its result or error
// then returns through the enclosing send, which must not write it again.
const recorded = new WeakSet();
const UNMEASURED_USAGE = Object.freeze({ inputTokens: null, inputTokensKnown: false });
const FAILED_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
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
    // A provider's own re-send on another model (an overload or retired-model
    // fallback) runs nested in this context: it still answers the model the
    // outer send was asked for.
    requestedModel: currentUsageContext()?.requestedModel || model,
    sessionId,
    sourceType,
    inputTokensInclusive,
  };
  // The loop's progress callback marks the first visible output; an abandoned
  // attempt clears it (usage-context.mjs), so the answering attempt's counts.
  const progress = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
  const sendOpts = progress
    ? {
        ...opts,
        onStreamDelta: (kind, ...rest) => {
          if (!identity.firstOutputAt && isVisibleStreamProgress(kind)) identity.firstOutputAt = Date.now();
          return progress(kind, ...rest);
        },
      }
    : opts;
  // `timed`: only a send's completed result owns the request's wall time. An
  // abandoned attempt or a failure shares that clock with the final attempt,
  // so timing it too would count the same seconds twice and understate speed.
  const record = async (result, id, owner, timed, outcome = null) => {
    // A completed call that reported no usage is still a call: it is recorded
    // as unmeasured (unknown input, unpriced) instead of vanishing from totals.
    if (!result?.usage && !(timed && result && typeof result === 'object')) return;
    // A nested send (e.g. a fallback model re-send) already stamped its own
    // final attempt's tier; the outer context only saw the abandoned attempt.
    result.requestServiceTier ??= identity.requestServiceTier || '';
    if (recorded.has(owner)) return;
    if (openingError) throw openingError;
    if (!ledger) return;
    recorded.add(owner);
    const usage = result.usage || UNMEASURED_USAGE;
    const durationMs = timed ? Date.now() - startedAt : 0;
    const servedModel = result.model || model;
    const attempts = outcome ? outcome.attempts : 1;
    let status = 'completed';
    if (outcome?.cancelled) status = 'cancelled';
    else if (outcome)
      status = usageRequestStatus({
          failed: outcome.failed,
          attempts,
          substituted: servedModelSubstituted({
            provider,
            requestedModel: identity.requestedModel,
            servedModel,
            fallback: Boolean(result.providerMetadata?.anthropicFallbacks?.length),
          }),
        });
    // The one measured request time: the loop's speed figures read it, so
    // the composer and the ledger show the same span.
    if (timed && result && typeof result === 'object') {
      Object.defineProperty(result, 'usageDurationMs', { value: durationMs, configurable: true, writable: true });
    }
    const row = makeUsageRecord({
      id: result.responseId ? undefined : id,
      ts: Date.now(),
      provider,
      model: servedModel,
      requestedModel: outcome ? identity.requestedModel : model,
      status,
      attempts,
      ttftMs: timed && identity.firstOutputAt ? identity.firstOutputAt - startedAt : null,
      // The request log shows how long a failure took; statistics never time it.
      elapsedMs: outcome?.failed ? Date.now() - startedAt : 0,
      pricingModel: result.pricingModel,
      sessionId,
      // The session this one runs for (an agent's Lead), kept with its spend.
      ownerSessionId: opts.session?.ownerSessionId || opts.session?.parentSessionId,
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
      durationMs,
    });
    // Committed by the ledger worker (batched with concurrent sends); the
    // send still settles only once its row is durable, as before, but the
    // SQLite write no longer runs on the event loop.
    await ledger.recordQueued(row);
  };
  const save = async (result, id = requestId, owner = result, timed = false, outcome = null) => {
    try {
      await record(result, id, owner, timed, outcome);
    } catch (error) {
      result.usageAccountingError = String(error?.message || error);
      process.stderr.write(`[usage-ledger] RECORD NOT SAVED: ${result.usageAccountingError}\n`);
    }
  };
  const saveAbandoned = async (skip = -1) => {
    for (const [index, attempt] of (identity.abandonedUsage || []).entries()) {
      if (index !== skip && recordable(attempt.usage)) await save(attempt, `${requestId}:abandoned:${index}`);
    }
  };
  let result;
  try {
    result = await withUsageContext(identity, () => send(sendOpts));
  } catch (error) {
    const abandoned = identity.abandonedUsage || [];
    const cancelled = opts.signal?.aborted === true || error?.name === 'AbortError';
    // Only provider-reported usage is recordable; never invent tokens for a
    // failed request or reinterpret an error as a success.
    const reported = error?.usage || (recordable(error?.partialUsage) ? error.partialUsage : null);
    if (cancelled) {
      // A user's cancel is not a request outcome: it records exactly what it
      // always did, under the same ids (noted attempts as abandoned rows, the
      // cancel's own unnoted usage as the request's row, response-keyed when
      // it names a response), and that row is marked `cancelled` so the
      // request log leaves it out.
      await saveAbandoned();
      const outcome = { cancelled: true, attempts: abandoned.length + 1 };
      if (error?.usage) {
        if (!isNotedUsage(error.usage)) await save(error, requestId, error, false, outcome);
      } else if (reported && !isNotedUsage(reported)) {
        await save({ usage: reported, model: error.partialModel }, requestId, error, false, outcome);
      }
      throw error;
    }
    // The failing attempt's usage may already be noted as abandoned (the
    // error carries that same usage): that attempt is the request's own row,
    // not an abandoned one. Any other failure without usage is an attempt of
    // its own.
    const last = reported
      ? abandoned.findLastIndex((attempt) => attempt.source === reported || attempt.usage === reported)
      : -1;
    await saveAbandoned(last);
    const failure = { failed: true, attempts: last >= 0 ? abandoned.length : abandoned.length + 1 };
    const owner = error && typeof error === 'object' ? error : {};
    if (last >= 0) {
      const attempt = abandoned[last];
      // Owned by the attempt, as when it was stored as abandoned: one error
      // may end several concurrent sends (a shared cancel reason).
      await save({ usage: attempt.usage, model: attempt.model || error?.model }, requestId, attempt, false, failure);
    } else if (reported) {
      // Usage noted by a nested send was recorded there.
      const failed = error.usage ? error : { usage: reported, model: error.partialModel };
      if (!isNotedUsage(reported)) await save(failed, requestId, owner, false, failure);
    } else {
      // A failure that reported nothing is still a request: zero tokens.
      await save({ usage: FAILED_USAGE, model: error?.model }, requestId, owner, false, failure);
    }
    throw error;
  }
  await saveAbandoned();
  await save(result, requestId, result, true, { failed: false, attempts: (identity.abandonedUsage?.length || 0) + 1 });
  return result;
}
