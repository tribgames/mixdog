// cache-warm-admission.mjs — the account gate of a cache warm
// (anthropic-cache-warm.mjs). A warm never waits, queues, rotates accounts or
// retries: right before its POST it reads the state a normal send consults
// for the account it goes to — the Developer option, the account's admission
// lane (rate-limit cooldown, a lane throttled after a 429), the account
// roster's blocks and quota windows, and the session's quota-resume pause —
// and is skipped when any of them holds or when no fresh quota reading says
// the account has room. A warm's own refusal is recorded like a send's: a 429
// in the lane cooldown, and the roster's verdict through the account pool.
import {
  ACCOUNT_PROVIDERS,
  providerAccountExhausted,
  quotaReadingFresh,
  readProviderAccountPool,
  staleQuotaWindows,
} from '../../../shared/provider-accounts.mjs';
import { quotaResumeEntry } from '../../../shared/quota-resume-store.mjs';
import { recordAccountRefusal } from './account-pool.mjs';
import { providerAdmissionKey, providerAdmissionScheduler } from './admission-scheduler.mjs';
import { readCachedOAuthUsageSnapshot } from './oauth-usage.mjs';
import { providerAvailable } from './provider-availability.mjs';

function readingBlock(providerName, windows, checkedAt, now, exhausted) {
  if (!Array.isArray(windows) || !quotaReadingFresh(checkedAt, now)) return 'no fresh quota reading';
  if (staleQuotaWindows(providerName, windows)) return 'no fresh quota reading';
  return exhausted ? 'account blocked or quota exhausted' : null;
}

function rosterBlock(providerName, accountId, model, now) {
  if (!ACCOUNT_PROVIDERS.includes(providerName)) return null;
  const pool = readProviderAccountPool(providerName);
  const useCredits = pool.useCredits === true;
  if (!pool.accounts.length) {
    if (useCredits) return null;
    const stored = readCachedOAuthUsageSnapshot({ provider: providerName, model: '' });
    const row = stored ? { usage: { windows: stored.quotaWindows, checkedAt: stored.cachedAt } } : null;
    return readingBlock(
      providerName,
      stored?.quotaWindows,
      stored?.cachedAt,
      now,
      row && providerAccountExhausted(row, now, model)
    );
  }
  if (!accountId) return 'account holding the cache unknown';
  const row = pool.accounts.find((entry) => entry.id === accountId);
  if (!row) return 'account not connected';
  const exhausted = providerAccountExhausted(row, now, model, { useCredits });
  if (useCredits) return exhausted ? 'account blocked' : null;
  return readingBlock(providerName, row.usage?.windows, row.usage?.checkedAt, now, exhausted);
}

/**
 * Why a warm on `instance` (account `accountId` of `providerName`; no id for
 * a provider without an account roster) may not be sent now, or null. The
 * instance's admission lane — the one its ordinary sends are admitted on —
 * cooling down or throttled blocks it. Never waits.
 */
export function cacheWarmAccountBlock(
  providerName,
  instance,
  {
    accountId = '',
    model = '',
    sessionId = '',
    scheduler = providerAdmissionScheduler,
    now = Date.now(),
  } = {}
) {
  if (!providerAvailable(providerName)) return 'provider disabled';
  const lane = scheduler.immediateBlock(providerAdmissionKey(providerName, instance));
  if (lane) return lane;
  if (sessionId && quotaResumeEntry(sessionId)) return 'session paused until its quota resets';
  return rosterBlock(providerName, accountId, model, now);
}

/** The error a skipped warm rejects with (nothing was sent or billed). */
export function cacheWarmBlockedError(reason) {
  return Object.assign(new Error(`cache warm skipped: ${reason}`), { code: 'ECACHEWARMBLOCKED', usage: null });
}

/** Feed a warm's refusal into the shared state a send's would reach (the
 *  lane keeps 429s only; the roster judges every refusal as the pool's send
 *  does). A warm the caller aborted is no refusal. */
export async function recordCacheWarmRefusal(
  providerName,
  instance,
  error,
  { accountId = '', model = '', aborted = false, scheduler = providerAdmissionScheduler } = {}
) {
  if (aborted || error?.code === 'ECACHEWARMBLOCKED') return;
  scheduler.recordRateLimit(providerAdmissionKey(providerName, instance), error);
  if (accountId && ACCOUNT_PROVIDERS.includes(providerName)) {
    await recordAccountRefusal(providerName, accountId, model, error, instance);
  }
}
