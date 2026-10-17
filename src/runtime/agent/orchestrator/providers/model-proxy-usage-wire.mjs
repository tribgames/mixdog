// Shared by the desktop exporter and daemon reader. This is a projection, not
// a pass-through: credentials, identities and provider response bodies never
// become part of the usage protocol.
export function isModelProxyUsageAccount(value) {
  return typeof value === 'string' && /^proxy-[a-f0-9]{64}$/.test(value);
}

const WINDOW_FIELDS = [
  'usedPct',
  'resetAt',
  'usedUsd',
  'limitUsd',
  'remainingUsd',
  'usedCredits',
  'limitCredits',
  'remainingCredits',
];
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value) => nonnegative(value) && value <= 8_640_000_000_000_000;
const unavailable = () => ({ status: 'unavailable', accounts: [] });

export function sanitizeModelProxyUsageReply(provider, value) {
  try {
    if (
      typeof provider !== 'string' ||
      !provider ||
      !value ||
      !Array.isArray(value.accounts) ||
      value.accounts.length > 20
    )
      return unavailable();
    const accounts = [...new Set(value.accounts)];
    if (!accounts.every(isModelProxyUsageAccount)) return unavailable();
    const identity = { accounts };
    if (value.account !== undefined) {
      if (!isModelProxyUsageAccount(value.account) || !accounts.includes(value.account))
        return { status: 'unavailable', ...identity };
      identity.account = value.account;
    }
    if (value.status !== 'ready') {
      return {
        status: value.status === 'unsupported' ? 'unsupported' : 'unavailable',
        ...identity,
      };
    }
    const snapshot = value.snapshot;
    const invalid = () => ({ status: 'unavailable', ...identity });
    if (
      !identity.account ||
      snapshot?.provider !== provider ||
      snapshot.accountId !== identity.account ||
      snapshot.source !== 'desktop-oauth' ||
      !timestamp(snapshot.cachedAt) ||
      !Array.isArray(snapshot.quotaWindows) ||
      !snapshot.quotaWindows.length
    )
      return invalid();
    const quotaWindows = [];
    for (const window of snapshot.quotaWindows.slice(0, 12)) {
      if (
        typeof window?.label !== 'string' ||
        !/^[\w .-]{1,40}$/.test(window.label) ||
        !nonnegative(window.usedPct)
      )
        return invalid();
      const out = { label: window.label };
      for (const key of WINDOW_FIELDS) {
        if (window[key] == null) continue;
        if (!nonnegative(window[key]) || (key === 'resetAt' && !timestamp(window[key]))) return invalid();
        out[key] = window[key];
      }
      quotaWindows.push(out);
    }
    return {
      status: 'ready',
      ...identity,
      snapshot: {
        provider,
        accountId: identity.account,
        source: 'desktop-oauth',
        cachedAt: snapshot.cachedAt,
        quotaWindows,
      },
    };
  } catch {
    return unavailable();
  }
}
