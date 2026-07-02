import {
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { num, round, cleanString } from './lib/usage-primitives.mjs';

const CACHE_FILE = 'gateway-oauth-usage-cache.json';
const LIVE_CACHE_TTL_MS = 60_000;
const DISK_CACHE_TTL_MS = 10 * 60_000;
const STALE_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 4500;
const WARN_TTL_MS = 5 * 60_000;

const memoryCache = new Map();
const inflight = new Map();
const lastWarnAt = new Map();
let pendingDiskSnapshots = new Map();
let pendingDiskFlushTimer = null;

function providerKey(routeInfo = {}) {
  return String(routeInfo?.provider || '').toLowerCase();
}

function routeKey(routeInfo = {}) {
  return `${providerKey(routeInfo)}\u0001${String(routeInfo?.model || '')}`;
}

function cacheModelId(value) {
  const model = cleanString(value);
  if (!model) return null;
  // Route cache keys are model identifiers, not free-form display/user text.
  // A malformed route once copied a user prompt into the provider-wide OAuth
  // cache; keeping cache keys/display model IDs single-token prevents that
  // poison from persisting or winning provider fallback lookups.
  if (model.length > 160 || /\s/.test(model)) return null;
  return model;
}

function cachePath() {
  return join(resolvePluginData(), CACHE_FILE);
}

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSnapshotCache(key, snapshot) {
  if (!key || !snapshot) return;
  pendingDiskSnapshots.set(key, snapshot);
  if (!pendingDiskFlushTimer) {
    pendingDiskFlushTimer = setTimeout(flushSnapshotCache, 250);
    pendingDiskFlushTimer.unref?.();
  }
}

function flushSnapshotCache() {
  if (pendingDiskFlushTimer) {
    clearTimeout(pendingDiskFlushTimer);
    pendingDiskFlushTimer = null;
  }
  if (!pendingDiskSnapshots.size) return;
  const updates = pendingDiskSnapshots;
  pendingDiskSnapshots = new Map();
  try {
    updateJsonAtomicSync(cachePath(), (curRaw) => {
      const cur = curRaw && typeof curRaw === 'object' ? curRaw : {};
      const routes = cur.routes && typeof cur.routes === 'object' ? cur.routes : {};
      return {
        version: 1,
        updatedAt: Date.now(),
        routes: {
          ...routes,
          ...Object.fromEntries(updates),
        },
      };
    }, { compact: true, fsync: false, fsyncDir: false });
  } catch {
    // Usage display must never affect the gateway request path.
  }
}

try {
  process.on('beforeExit', flushSnapshotCache);
  process.on('exit', flushSnapshotCache);
} catch {
  // Embedded runtimes may not expose process lifecycle hooks.
}

function isContentfulSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot === 'object'
    && (
      Array.isArray(snapshot.quotaWindows) && snapshot.quotaWindows.length > 0
      || snapshot.balance && typeof snapshot.balance === 'object'
    );
}

function hasFutureWindow(snapshot) {
  const windows = Array.isArray(snapshot?.quotaWindows) ? snapshot.quotaWindows : [];
  if (!windows.length) return true;
  const now = Date.now();
  return windows.some(w => !w?.resetAt || num(w.resetAt, 0) > now);
}

function freshSnapshot(snapshot, ttlMs) {
  if (!isContentfulSnapshot(snapshot)) return null;
  const at = num(snapshot.cachedAt, 0);
  if (!at || Date.now() - at > ttlMs) return null;
  if (!hasFutureWindow(snapshot)) return null;
  return snapshot;
}

function newestProviderSnapshot(entries, provider, ttlMs) {
  const providerOnly = String(provider || '').toLowerCase();
  if (!providerOnly) return null;
  const routePrefix = `${providerOnly}\u0001`;
  let best = null;
  let bestAt = 0;
  const iterable = entries instanceof Map ? entries.entries() : Object.entries(entries || {});
  for (const [key, snapshot] of iterable) {
    if (key !== providerOnly && !String(key).startsWith(routePrefix)) continue;
    const fresh = freshSnapshot(snapshot, ttlMs);
    const at = num(fresh?.cachedAt, 0);
    if (fresh && at >= bestAt) {
      best = fresh;
      bestAt = at;
    }
  }
  return best;
}

export function readCachedOAuthUsageSnapshot(routeInfo, options = {}) {
  const key = routeKey(routeInfo);
  const providerOnlyKey = providerKey(routeInfo);
  const diskTtlMs = options?.allowStale === true
    ? STALE_DISK_CACHE_TTL_MS
    : DISK_CACHE_TTL_MS;
  const mem = freshSnapshot(memoryCache.get(key), LIVE_CACHE_TTL_MS)
    || freshSnapshot(memoryCache.get(providerOnlyKey), LIVE_CACHE_TTL_MS)
    || newestProviderSnapshot(memoryCache, providerOnlyKey, LIVE_CACHE_TTL_MS);
  if (mem) return mem;

  const raw = readJsonFile(cachePath());
  const routes = raw?.routes && typeof raw.routes === 'object' ? raw.routes : {};
  return freshSnapshot(routes[key], diskTtlMs)
    || freshSnapshot(routes[providerOnlyKey], diskTtlMs)
    || newestProviderSnapshot(routes, providerOnlyKey, diskTtlMs)
    || null;
}

function cacheNegative(key, source = 'none') {
  if (!key) return;
  memoryCache.set(key, { empty: true, source, cachedAt: Date.now() });
}

function negativeFresh(key) {
  const cur = memoryCache.get(key);
  return !!cur?.empty && Date.now() - num(cur.cachedAt, 0) < NEGATIVE_CACHE_TTL_MS;
}

function warnThrottled(log, key, message) {
  const now = Date.now();
  const last = num(lastWarnAt.get(key), 0);
  if (last && now - last < WARN_TTL_MS) return;
  lastWarnAt.set(key, now);
  try { log(message); } catch {}
}

function fetchOptions(headers, timeoutMs = FETCH_TIMEOUT_MS) {
  let dispatcher = null;
  try { dispatcher = getLlmDispatcher(); } catch {}
  return {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    ...(dispatcher ? { dispatcher } : {}),
  };
}

function resetAtMs(value, fallbackSeconds = null) {
  if (typeof value === 'string') {
    const iso = Date.parse(value);
    if (Number.isFinite(iso)) return iso;
  }
  const n = num(value, 0);
  if (n > 0) return n < 10_000_000_000 ? n * 1000 : n;
  const secs = num(fallbackSeconds, 0);
  return secs > 0 ? Date.now() + secs * 1000 : null;
}

function labelForDuration(seconds, fallback) {
  const s = num(seconds, 0);
  if (s > 0) {
    if (Math.abs(s - 5 * 60 * 60) <= 120) return '5H';
    if (Math.abs(s - 7 * 24 * 60 * 60) <= 3600) return '7D';
    if (Math.abs(s - 24 * 60 * 60) <= 600) return '24H';
    if (s >= 28 * 24 * 60 * 60 && s <= 31 * 24 * 60 * 60) return 'M';
  }
  return fallback;
}

function windowFromPercent(label, value, source) {
  const entry = value && typeof value === 'object' ? value : {};
  const windowSeconds = num(entry.limit_window_seconds ?? entry.window_seconds ?? entry.windowSeconds, 0);
  const windowMinutes = num(entry.window_minutes ?? entry.windowMinutes, 0);
  const usedPct = num(
    entry.usedPct
      ?? entry.used_percent
      ?? entry.used_percentage
      ?? entry.utilization
      ?? entry.percent,
    null,
  );
  const limitUsd = num(entry.limitUsd ?? entry.limit_usd ?? entry.limit_dollars ?? entry.monthly_limit, null);
  const usedUsd = num(entry.usedUsd ?? entry.used_usd ?? entry.used_dollars ?? entry.used_credits, null);
  const remainingUsd = num(entry.remainingUsd ?? entry.remaining_usd ?? entry.remaining_dollars, null);
  const resetAt = resetAtMs(
    entry.resetAt ?? entry.resetsAt ?? entry.reset_at ?? entry.resets_at,
    entry.reset_after_seconds,
  );
  const out = {
    label: labelForDuration(windowSeconds || windowMinutes * 60, label),
    source,
  };
  if (usedPct !== null) out.usedPct = round(usedPct, 2);
  if (limitUsd !== null) out.limitUsd = round(limitUsd, 4);
  if (usedUsd !== null) out.usedUsd = round(usedUsd, 4);
  if (remainingUsd !== null) out.remainingUsd = round(remainingUsd, 4);
  if (resetAt) out.resetAt = resetAt;
  return Object.keys(out).length > 2 ? out : null;
}

function creditWindowFromBilling(config) {
  if (!config || typeof config !== 'object') return null;
  const limit = num(config.monthlyLimit?.val ?? config.monthlyLimit ?? config.includedLimit?.val, null);
  const used = num(config.used?.val ?? config.includedUsed?.val ?? config.used, null);
  if (limit === null || used === null || !(limit > 0)) return null;
  const resetAt = resetAtMs(config.billingPeriodEnd ?? config.billing_period_end);
  return {
    label: 'M',
    source: 'grok-build-billing',
    usedPct: round(Math.min(100, used * 100 / limit), 2),
    usedCredits: round(used, 2),
    limitCredits: round(limit, 2),
    remainingCredits: round(Math.max(0, limit - used), 2),
    ...(resetAt ? { resetAt } : {}),
  };
}

function balanceFromGrokBilling(config) {
  if (!config || typeof config !== 'object') return null;
  const cap = num(config.onDemandCap?.val ?? config.onDemandCap, null);
  const used = num(config.onDemandUsed?.val ?? config.onDemandUsed, 0);
  if (cap === null || !(cap > 0)) return null;
  return {
    source: 'grok-build-on-demand',
    period: 'monthly',
    budgetCredits: round(cap, 2),
    spentCredits: round(used, 2),
    remainingCredits: round(Math.max(0, cap - used), 2),
  };
}

function balanceFromCredits(credits, source) {
  if (!credits || typeof credits !== 'object') return null;
  const balance = num(credits.balance ?? credits.remaining ?? credits.remaining_dollars, null);
  if (balance === null) return null;
  return {
    source,
    remainingUsd: round(balance, 4),
    currency: cleanString(credits.currency) || 'USD',
  };
}

function balanceFromExtraUsage(extra) {
  if (!extra || typeof extra !== 'object') return null;
  const limit = num(extra.monthly_limit, null);
  const used = num(extra.used_credits, 0);
  if (limit === null) return null;
  return {
    source: 'anthropic-oauth-extra',
    period: 'monthly',
    budgetUsd: round(limit, 4),
    spentUsd: round(used, 4),
    remainingUsd: round(Math.max(0, limit - used), 4),
    currency: cleanString(extra.currency) || 'USD',
  };
}

function balanceFromAnthropicSpend(spend) {
  if (!spend || typeof spend !== 'object') return null;
  const currency = cleanString(spend.used?.currency ?? spend.limit?.currency) || 'USD';
  // spend.balance may be a plain number or a {amount_minor, exponent} money
  // object like used/limit; support both shapes.
  const directBalance = spend.balance && typeof spend.balance === 'object'
    ? (() => {
      const minor = num(spend.balance.amount_minor, null);
      return minor === null ? null : minor / (10 ** num(spend.balance.exponent, 2));
    })()
    : num(spend.balance, null);
  if (directBalance !== null) {
    return {
      source: 'anthropic-oauth-spend',
      remainingUsd: round(directBalance, 4),
      spentUsd: round(num(spend.used?.amount_minor, 0) / (10 ** num(spend.used?.exponent, 2)), 4),
      currency,
    };
  }

  const usedMinor = num(spend.used?.amount_minor, null);
  const usedExponent = num(spend.used?.exponent, 2);
  const usedUsd = usedMinor === null ? null : usedMinor / (10 ** usedExponent);

  const capMinor = num(spend.cap?.credits?.amount_minor, null);
  if (capMinor !== null && usedUsd !== null) {
    const capExponent = num(spend.cap?.credits?.exponent, 2);
    const capUsd = capMinor / (10 ** capExponent);
    return {
      source: 'anthropic-oauth-spend',
      remainingUsd: round(Math.max(0, capUsd - usedUsd), 4),
      spentUsd: round(usedUsd, 4),
      currency,
    };
  }

  const limitMinor = num(spend.limit?.amount_minor, null);
  if (limitMinor !== null && limitMinor > 0 && usedUsd !== null) {
    const limitExponent = num(spend.limit?.exponent, 2);
    const limitUsd = limitMinor / (10 ** limitExponent);
    return {
      source: 'anthropic-oauth-spend',
      remainingUsd: round(Math.max(0, limitUsd - usedUsd), 4),
      spentUsd: round(usedUsd, 4),
      currency,
    };
  }

  return null;
}

function normalizeOpenAIWhamUsage(data) {
  const rate = data?.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : null;
  if (!rate) return null;
  const windows = [
    windowFromPercent('5H', rate.primary_window || rate.primary, 'openai-codex-oauth'),
    windowFromPercent('7D', rate.secondary_window || rate.secondary, 'openai-codex-oauth'),
  ].filter(Boolean);
  if (!windows.length) return null;
  return {
    provider: 'openai-oauth',
    source: 'openai-codex-wham',
    planType: cleanString(data.plan_type),
    quotaWindows: windows,
    balance: balanceFromCredits(data.credits, 'openai-codex-credits'),
    rawKeys: Object.keys(data || {}).sort(),
  };
}

function normalizeCodexRateLimits(rateLimits, source = 'openai-codex-local') {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const windows = [
    windowFromPercent('5H', rateLimits.primary || rateLimits.five_hour, source),
    windowFromPercent('7D', rateLimits.secondary || rateLimits.seven_day, source),
  ].filter(Boolean);
  if (!windows.length) return null;
  return {
    provider: 'openai-oauth',
    source,
    planType: cleanString(rateLimits.plan_type),
    quotaWindows: windows,
    balance: balanceFromCredits(rateLimits.credits, `${source}-credits`),
  };
}

function normalizeAnthropicUsage(data, source = 'anthropic-oauth') {
  if (!data || typeof data !== 'object') return null;
  let windows = [
    windowFromPercent('5H', data.five_hour, source),
    windowFromPercent('7D', data.seven_day, source),
  ].filter(Boolean);

  if (!windows.length && Array.isArray(data.limits)) {
    windows = data.limits
      .filter(x => x && x.is_active !== false)
      .map((x) => {
        const label = x.kind === 'session' || x.group === 'session'
          ? '5H'
          : x.kind === 'weekly_all' || x.group === 'weekly'
            ? '7D'
            : String(x.kind || x.group || 'USE').toUpperCase();
        return windowFromPercent(label, {
          percent: x.percent,
          resets_at: x.resets_at,
        }, source);
      })
      .filter(Boolean);
  }

  const extra = data.extra_usage && data.extra_usage.is_enabled === true
    ? windowFromPercent('EXTRA', {
      utilization: data.extra_usage.utilization,
      limit_dollars: data.extra_usage.monthly_limit,
      used_dollars: data.extra_usage.used_credits,
      remaining_dollars: Math.max(0, num(data.extra_usage.monthly_limit, 0) - num(data.extra_usage.used_credits, 0)),
    }, 'anthropic-oauth-extra')
    : null;
  if (extra) windows.push(extra);

  if (!windows.length && !data.extra_usage) return null;
  return {
    provider: 'anthropic-oauth',
    source,
    quotaWindows: windows,
    balance: balanceFromAnthropicSpend(data.spend) || balanceFromExtraUsage(data.extra_usage),
    rawKeys: Object.keys(data || {}).sort(),
  };
}

function latestClaudeStatuslineUsage() {
  // Standalone CLI must not borrow a host-agent rendered statusline cache.
  // Anthropic quota should come from the OAuth usage endpoint above.
  return null;
}

async function fetchOpenAICodexUsage(providerObj) {
  const auth = await providerObj?.ensureAuth?.({ reason: 'usage' });
  const token = auth?.access_token || auth?.accessToken;
  if (!token) return null;
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', fetchOptions({
    Authorization: `Bearer ${token}`,
    originator: 'codex_cli_rs',
    'chatgpt-account-id': auth.account_id || auth.accountId || '',
    'OpenAI-Beta': 'responses=experimental',
    Accept: 'application/json',
  }));
  if (!res.ok) throw new Error(`openai-oauth usage ${res.status}`);
  const data = await res.json();
  return normalizeOpenAIWhamUsage(data);
}

async function fetchAnthropicUsage(providerObj) {
  const auth = await providerObj?.ensureAuth?.({ reason: 'usage' });
  const token = auth?.accessToken || auth?.access_token;
  if (!token) return latestClaudeStatuslineUsage();
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', fetchOptions({
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.0.0',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }));
  if (!res.ok) throw new Error(`anthropic oauth usage ${res.status}`);
  const data = await res.json();
  return normalizeAnthropicUsage(data) || latestClaudeStatuslineUsage();
}

async function fetchGrokUsage(providerObj, routeInfo) {
  const auth = await providerObj?.ensureAuth?.({ reason: 'usage' });
  const token = auth?.access_token || auth?.accessToken || auth?.key;
  if (!token) return null;
  const userId = auth?.user_id || auth?.userId || auth?.principal_id || auth?.principalId || '';
  const cliHeaders = {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-userid': userId,
    Accept: 'application/json',
    'User-Agent': 'xai-grok-build/0.2.16',
  };

  try {
    const res = await fetch('https://cli-chat-proxy.grok.com/v1/billing', fetchOptions(cliHeaders));
    if (res.ok) {
      const data = await res.json();
      const config = data?.config && typeof data.config === 'object' ? data.config : data;
      const monthly = creditWindowFromBilling(config);
      if (monthly) {
        return {
          provider: routeInfo?.provider || 'grok-oauth',
          model: routeInfo?.model || null,
          source: 'grok-build-billing',
          quotaWindows: [monthly],
          balance: balanceFromGrokBilling(config),
          rawKeys: Object.keys(data || {}).sort(),
        };
      }
    }
  } catch {
    // Fall through to generic probes below.
  }

  // xAI documents per-request cost tracking and console rate-limit pages, but
  // the stable Grok Build quota is currently on the CLI proxy /billing route.
  // Probe conservative generic candidates too so a future API addition starts
  // working without changing the statusline contract.
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-userid': userId,
    Accept: 'application/json',
    'User-Agent': 'xai-grok-build/mixdog',
  };
  const urls = [
    'https://cli-chat-proxy.grok.com/v1/billing',
    'https://api.x.ai/v1/usage',
    'https://api.x.ai/v1/rate_limits',
    'https://api.x.ai/v1/rate-limits',
    'https://cli-chat-proxy.grok.com/v1/usage',
    'https://cli-chat-proxy.grok.com/v1/rate_limits',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, fetchOptions(headers, 2500));
      if (!res.ok) continue;
      const data = await res.json();
      const parsed = normalizeCodexRateLimits(data?.rate_limits || data?.rateLimits, 'grok-oauth')
        || normalizeAnthropicUsage(data, 'grok-oauth')
        || null;
      if (parsed) return { ...parsed, provider: routeInfo?.provider || 'grok-oauth' };
    } catch {}
  }
  return null;
}

export async function fetchOAuthUsageSnapshot(routeInfo, providerObj, log = () => {}) {
  const provider = providerKey(routeInfo);
  if (!provider.includes('oauth')) return null;
  const key = routeKey(routeInfo);
  const providerOnly = providerKey(routeInfo);
  const cached = freshSnapshot(memoryCache.get(key), LIVE_CACHE_TTL_MS)
    || freshSnapshot(memoryCache.get(providerOnly), LIVE_CACHE_TTL_MS);
  if (cached) return cached;
  if (negativeFresh(key) || negativeFresh(providerOnly)) return null;
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    let snapshot = null;
    try {
      if (provider === 'openai-oauth') {
        snapshot = await fetchOpenAICodexUsage(providerObj);
      } else if (provider === 'anthropic-oauth') {
        snapshot = await fetchAnthropicUsage(providerObj);
      } else if (provider === 'grok-oauth') {
        snapshot = await fetchGrokUsage(providerObj, routeInfo);
      }
    } catch (err) {
      if (provider === 'anthropic-oauth') snapshot = latestClaudeStatuslineUsage();
      if (!snapshot) {
        warnThrottled(log, `oauth-usage:${provider}`, `gateway ${provider} usage fetch unavailable: ${err?.message || err}`);
      }
    }

    if (!isContentfulSnapshot(snapshot)) {
      cacheNegative(key, 'empty');
      cacheNegative(providerOnly, 'empty');
      return null;
    }

    const model = cacheModelId(routeInfo?.model) || cacheModelId(snapshot.model);
    const providerSnapshot = {
      ...snapshot,
      provider: routeInfo?.provider || snapshot.provider || provider,
      cachedAt: Date.now(),
    };
    delete providerSnapshot.model;

    const routeSnapshot = model
      ? { ...providerSnapshot, model }
      : providerSnapshot;

    if (model) {
      const normalizedKey = `${provider}\u0001${model}`;
      memoryCache.set(normalizedKey, routeSnapshot);
      writeSnapshotCache(normalizedKey, routeSnapshot);
    }
    memoryCache.set(providerOnly, providerSnapshot);
    writeSnapshotCache(providerOnly, providerSnapshot);
    return routeSnapshot;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}
