// Every measured quota window also lands in the usage ledger's quota history,
// the record behind the subscription usage view. The ledger loads on first
// use — lightweight importers such as the statusline never open SQLite — and
// writes on its worker; neither may cost the measurement itself.
import { cleanString, round } from './usage-primitives.mjs';

export async function recordQuotaReadings(
  provider,
  account,
  snapshot,
  log = () => {},
  ts = Date.now(),
  current = () => true
) {
  const samples = (Array.isArray(snapshot?.quotaWindows) ? snapshot.quotaWindows : []).flatMap((window) => {
    const label = (cleanString(window?.label) || '').slice(0, 40);
    const usedPct = typeof window?.usedPct === 'number' && Number.isFinite(window.usedPct) ? window.usedPct : null;
    if (!label || usedPct === null || usedPct < 0) return [];
    const resetAt =
      typeof window.resetAt === 'number' && Number.isFinite(window.resetAt) ? Math.round(window.resetAt) : null;
    return [{ provider, account: account || 'default', label, ts, usedPct: round(usedPct, 2), resetAt }];
  });
  if (!samples.length) return false;
  try {
    const { getUsageLedger } = await import('../../../../shared/llm/usage-ledger.mjs');
    // The import may yield across a disconnect. A write already submitted is
    // allowed to finish as history; an old generation must not submit one.
    if (!current()) return false;
    const ledger = getUsageLedger();
    if (!ledger) return false;
    await ledger.recordQuotaQueued(samples);
    return true;
  } catch (error) {
    log(`Quota history could not be saved: ${error?.message || error}`);
    return false;
  }
}
