/**
 * ChatGPT subscription usage lookup.
 *
 * A usage-limit failure does not always say when the window reopens. The
 * account's usage summary does: each metered limit lists its windows with
 * `used_percent` and an epoch `reset_at`.
 */
import { timeoutSignal } from './bounded-signal.mjs';
import { codexUserAgent } from '../agent/orchestrator/providers/codex-client-meta.mjs';

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const LOOKUP_TIMEOUT_MS = 10_000;

function exhaustedResetAt(rateLimit) {
  if (!rateLimit || typeof rateLimit !== 'object') return null;
  const windows = [rateLimit.primary_window, rateLimit.secondary_window].filter((w) => Number(w?.reset_at) > 0);
  const full = windows.filter((w) => Number(w.used_percent) >= 100);
  const candidates = full.length ? full : rateLimit.limit_reached ? windows : [];
  return candidates.length ? Math.max(...candidates.map((w) => Math.trunc(Number(w.reset_at)))) : null;
}

/**
 * Reset time (epoch seconds) of the exhausted limit in a usage summary. The
 * limit named `limitId` wins; an image limit is next; the account's main
 * window is last.
 */
export function limitResetFromUsage(payload, limitId = '') {
  const extra = Array.isArray(payload?.additional_rate_limits) ? payload.additional_rate_limits : [];
  const id = String(limitId).toLowerCase();
  const names = (entry) => [entry?.metered_feature, entry?.limit_name].map((name) => String(name || '').toLowerCase());
  const named =
    (id && extra.find((entry) => names(entry).includes(id))) ||
    extra.find((entry) => names(entry).some((name) => name.includes('image')));
  return exhaustedResetAt(named ? named.rate_limit : payload?.rate_limit);
}

/**
 * Look the reset time up for the signed-in account. A failed lookup yields
 * null: the caller still reports the limit, just without a time.
 */
export async function chatgptLimitResetAt({ auth, limitId = '', fetchFn = fetch, signal } = {}) {
  try {
    const headers = { Authorization: `Bearer ${auth.access_token}`, 'User-Agent': codexUserAgent() };
    if (auth.account_id) headers['ChatGPT-Account-Id'] = auth.account_id;
    const res = await fetchFn(CHATGPT_USAGE_URL, {
      headers,
      redirect: 'error',
      signal: timeoutSignal(signal, LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return limitResetFromUsage(await res.json(), limitId);
  } catch {
    return null;
  }
}
