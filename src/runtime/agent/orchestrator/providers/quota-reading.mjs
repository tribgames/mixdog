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
import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';
import { getModelProxyChannel } from './model-proxy-channel.mjs';

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

/** The model-independent, account-wide measurement: one forced usage reading
 *  per roster account (or the single credential). Null for a provider that
 *  reports no exhausted quota. */
export async function measureProviderQuota(providerName, { provider } = {}) {
  // Only an account-pooled provider reports exhausted quota at all.
  if (!ACCOUNT_PROVIDERS.includes(providerName)) return null;
  if (provider === undefined) provider = getProvider(providerName);
  const pool = readProviderAccountPool(providerName);
  const useCredits = pool.useCredits === true;
  if (pool.accounts.length > 0) {
    const readings = await Promise.all(
      pool.accounts.map((row) =>
        forcedReading(
          { provider: providerName, accountId: row.id },
          typeof provider?.forAccount === 'function' ? provider.forAccount(row.id) : provider
        )
      )
    );
    return {
      providerName,
      useCredits,
      accounts: pool.accounts.map((row, index) => ({ id: row.id, reading: readings[index] })),
    };
  }
  // No roster: the single credential's fresh meter decides.
  const reading = await forcedReading({ provider: providerName, model: '' }, provider);
  return { providerName, useCredits, accounts: null, reading };
}

/** Whether `model` can be served per `measurement` (from measureProviderQuota).
 *  Only the measurement counts as evidence: an account whose forced reading
 *  failed or measured nothing for this model stays exhausted however its
 *  older record reads; the pool's own choice (selection, blocks) decides
 *  among the rest. */
export function quotaMeasurementServesModel(measurement, model = '') {
  if (!measurement) return true;
  const { providerName, useCredits, accounts } = measurement;
  if (!accounts) return readingServesModel(measurement.reading, model, useCredits);
  const unproven = new Set(
    accounts.filter((row) => !readingServesModel(row.reading, model, useCredits)).map((row) => row.id)
  );
  if (unproven.size === accounts.length) return false;
  return chooseProviderAccount(readProviderAccountPool(providerName), unproven, Date.now(), model) !== null;
}

export async function providerQuotaUsable(providerName, model = '', { provider } = {}) {
  // The PC owns the accounts in proxy mode; do not resolve a server provider.
  if (modelProxyClientMode()) {
    return (await getModelProxyChannel().request({ provider: providerName, method: 'quotaUsable', model })) === true;
  }
  return quotaMeasurementServesModel(await measureProviderQuota(providerName, { provider }), model);
}
