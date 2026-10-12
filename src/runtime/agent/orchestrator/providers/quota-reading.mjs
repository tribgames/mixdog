/**
 * quota-reading.mjs — the authoritative "can this provider serve this model
 * now?" answer a quota resume asks before it fires. Every account is
 * re-measured with a forced usage reading (the account pool's own probe), and
 * the answer is the pool's own choice over the fresh readings, so a resume
 * fires exactly when a send would find a usable account.
 */
import {
  ACCOUNT_PROVIDERS,
  chooseProviderAccount,
  quotaWindowAppliesToModel,
  readProviderAccountPool,
} from '../../../shared/provider-accounts.mjs';
import { fetchOAuthUsageSnapshot } from './oauth-usage.mjs';
import { getProvider } from './registry.mjs';

const forcedReading = (routeInfo, providerObj) =>
  fetchOAuthUsageSnapshot(routeInfo, providerObj, () => {}, { force: true }).catch(() => null);

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Measured evidence in this one reading that `model` can be served: an
 *  applicable window with a numeric meter and none of them spent, or, when
 *  the account pays with credits, a positive measured balance. A failed,
 *  unknown or balance-only reading is no evidence. */
function readingServesModel(reading, model, useCredits) {
  if (!reading) return false;
  const balance = reading.balance;
  if (
    useCredits &&
    balance &&
    (balance.unlimited === true || positive(balance.remainingCredits) || positive(balance.remainingUsd))
  ) {
    return true;
  }
  const measured = (reading.quotaWindows || []).filter(
    (window) =>
      quotaWindowAppliesToModel(window, model) && typeof window?.usedPct === 'number' && Number.isFinite(window.usedPct)
  );
  return measured.length > 0 && measured.every((window) => window.usedPct < 100);
}

export async function providerQuotaUsable(providerName, model = '', { provider = getProvider(providerName) } = {}) {
  // Only an account-pooled provider reports exhausted quota at all.
  if (!ACCOUNT_PROVIDERS.includes(providerName)) return true;
  const pool = readProviderAccountPool(providerName);
  const useCredits = pool.useCredits === true;
  // Only this reading counts as evidence: an account whose forced reading
  // failed or measured nothing for this model stays exhausted however its
  // older record reads; the pool's own choice (selection, blocks) decides
  // among the rest.
  if (pool.accounts.length > 0) {
    const readings = await Promise.all(
      pool.accounts.map((row) =>
        forcedReading(
          { provider: providerName, accountId: row.id },
          typeof provider?.forAccount === 'function' ? provider.forAccount(row.id) : provider
        )
      )
    );
    const unproven = new Set(
      pool.accounts.filter((_, index) => !readingServesModel(readings[index], model, useCredits)).map((row) => row.id)
    );
    if (unproven.size === pool.accounts.length) return false;
    return chooseProviderAccount(readProviderAccountPool(providerName), unproven, Date.now(), model) !== null;
  }
  // No roster: the single credential's fresh meter decides.
  const reading = await forcedReading({ provider: providerName, model: '' }, provider);
  return readingServesModel(reading, model, useCredits);
}
