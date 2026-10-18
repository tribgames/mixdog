import { round, cleanString as clean } from './lib/usage-primitives.mjs';
import { STATUS_URL, consoleHeaders, withConsoleTokenRetry } from './opencode-go-oauth-tokens.mjs';

const FETCH_TIMEOUT_MS = 6500;
// `GET /api/go/status` answers an OpenCode Console OAuth token; the token
// names its organization through `x-org-id`.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143 Safari/537.36';
// Meters report micro-cents as strings: "1200000000" is the $12 five-hour cap.
// Limits come from the response, so a plan change needs no code change.
const MICRO_CENTS_PER_USD = 1e8;
const METER_LABELS = Object.freeze({ fiveHour: '5H', week: '7D', month: 'M' });

// Local unguarded `num`: this module intentionally coerces '' to 0 via
// Number(''), unlike the guarded shared num() in lib/usage-primitives.mjs.
// Behavior differs on empty-string input, so it stays local.
function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// `status` lets the usage path refresh the token on a 401.
function statusError(status) {
  if (status === 401) {
    return Object.assign(new Error('OpenCode console credential was rejected'), {
      code: 'OPENCODE_GO_USAGE_AUTH_FAILED',
      status,
    });
  }
  return Object.assign(new Error(`OpenCode Go usage fetch failed (${status})`), {
    code: 'OPENCODE_GO_USAGE_FETCH_FAILED',
    status,
  });
}

function usdFromMicroCents(value) {
  const micro = num(value, null);
  return micro === null ? null : round(micro / MICRO_CENTS_PER_USD, 4);
}

function windowFromMeter(kind, raw) {
  const label = METER_LABELS[kind];
  if (!label || !raw || typeof raw !== 'object') return null;
  const limitUsd = usdFromMicroCents(raw.limitMicroCents);
  const usedUsd = usdFromMicroCents(raw.usedMicroCents);
  if (limitUsd === null || usedUsd === null) return null;
  // `resetsAt` is an absolute ISO timestamp, and is null on a window that has
  // not started (an idle five-hour meter), so an unparsable value drops the
  // field rather than inventing a reset time.
  const resetAt = Date.parse(clean(raw.resetsAt) || '');
  return {
    label,
    source: 'opencode-go-console',
    usedPct: limitUsd > 0 ? round((usedUsd / limitUsd) * 100, 2) : 0,
    limitUsd,
    usedUsd,
    remainingUsd: round(Math.max(0, limitUsd - usedUsd), 4),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
  };
}

function snapshotFromStatus(status) {
  const meters = status?.access?.meters;
  if (!meters || typeof meters !== 'object') return null;
  const quotaWindows = Object.keys(METER_LABELS)
    .map((kind) => windowFromMeter(kind, meters[kind]))
    .filter(Boolean);
  if (!quotaWindows.length) return null;
  return { provider: 'opencode-go', source: 'opencode-go-console', quotaWindows };
}

// One `/api/go/status` read. `headers` carry the OAuth token plus `x-org-id`.
async function requestGoStatus(headers, fetchFn = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(STATUS_URL, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    });
    if (!res.ok) throw statusError(res.status);
    const parsed = snapshotFromStatus(await res.json().catch(() => null));
    if (!parsed) {
      const err = new Error('OpenCode Go subscription meters were not found');
      err.code = 'OPENCODE_GO_USAGE_PARSE_FAILED';
      throw err;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** Go meters for one OpenCode Go OAuth account (its token and organization). */
export async function fetchOpenCodeGoOAuthUsageSnapshot(tokens, { fetchFn } = {}) {
  const parsed = await withConsoleTokenRetry(tokens, (current) => requestGoStatus(consoleHeaders(current), fetchFn), {
    fetchFn,
  });
  return {
    ...parsed,
    provider: 'opencode-go-oauth',
    model: null,
    fetchedAt: Date.now(),
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.account_id ? { accountId: tokens.account_id } : {}),
  };
}
