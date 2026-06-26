import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { getAgentApiKey, getOpenAIUsageSessionKey } from '../../../shared/config.mjs';

const CACHE_FILE = 'api-usage-cache.json';
const LIVE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 60 * 60_000;
const DISK_JSON_MEMORY_TTL_MS = 1000;
let diskJsonCache = { at: 0, file: '', value: null };

function num(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function cachePath() {
  return join(resolvePluginData(), CACHE_FILE);
}

function readJson(file) {
  if (diskJsonCache.file === file && Date.now() - diskJsonCache.at < DISK_JSON_MEMORY_TTL_MS) {
    return diskJsonCache.value;
  }
  try {
    if (!existsSync(file)) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    diskJsonCache = { at: Date.now(), file, value };
    return value;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  diskJsonCache = { at: Date.now(), file, value };
  try {
    mkdirSync(resolvePluginData(), { recursive: true });
    void fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8').catch(() => {});
  } catch {}
}

function cacheKey(provider) {
  return String(provider || '').trim().toLowerCase();
}

function freshSnapshot(snapshot, ttlMs) {
  const cachedAt = num(snapshot?.cachedAt, 0);
  if (!cachedAt || Date.now() - cachedAt > ttlMs) return null;
  if (snapshot?.balance || Array.isArray(snapshot?.quotaWindows)) return snapshot;
  return null;
}

export function readCachedApiUsageSnapshot(provider, { allowStale = true } = {}) {
  const raw = readJson(cachePath());
  const snapshot = raw?.snapshots?.[cacheKey(provider)] || null;
  return freshSnapshot(snapshot, allowStale ? STALE_TTL_MS : LIVE_TTL_MS);
}

function writeCachedApiUsageSnapshot(provider, snapshot) {
  const file = cachePath();
  const raw = readJson(file) || {};
  const snapshots = raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {};
  writeJson(file, {
    version: 1,
    updatedAt: Date.now(),
    snapshots: {
      ...snapshots,
      [cacheKey(provider)]: snapshot,
    },
  });
}

function authHeaders(key, extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${key}`,
  };
}

async function fetchJson(url, { headers = {}, timeoutMs = 6500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`usage fetch failed (${res.status})`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function parseDeepSeekBalance(data) {
  const balances = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const usd = balances.find((entry) => String(entry?.currency || '').toUpperCase() === 'USD') || null;
  const remainingUsd = num(usd?.total_balance, null);
  if (remainingUsd === null) return null;
  return {
    provider: 'deepseek',
    source: 'deepseek-balance',
    balance: {
      remainingUsd: round(remainingUsd, 4),
      currency: 'USD',
      source: 'deepseek-balance',
    },
    available: data?.is_available === true,
    cachedAt: Date.now(),
  };
}

async function fetchDeepSeekUsageSnapshot() {
  const key = getAgentApiKey('deepseek');
  if (!key) return null;
  const data = await fetchJson('https://api.deepseek.com/user/balance', {
    headers: authHeaders(key, { Accept: 'application/json' }),
  });
  return parseDeepSeekBalance(data);
}

function firstCostAmount(bucket) {
  const results = Array.isArray(bucket?.results) ? bucket.results : [];
  let total = 0;
  let seen = false;
  for (const item of results) {
    const amount = num(item?.amount?.value ?? item?.amount?.usd ?? item?.amount, null);
    if (amount !== null) {
      total += amount;
      seen = true;
    }
  }
  return seen ? total : null;
}

function parseOpenAICosts(data) {
  const buckets = Array.isArray(data?.data) ? data.data : [];
  let usedUsd = 0;
  let seen = false;
  for (const bucket of buckets) {
    const amount = firstCostAmount(bucket);
    if (amount !== null) {
      usedUsd += amount;
      seen = true;
    }
  }
  if (!seen) return null;
  return {
    provider: 'openai',
    source: 'openai-organization-costs',
    balance: {
      usedUsd: round(usedUsd, 4),
      source: 'openai-organization-costs',
    },
    cachedAt: Date.now(),
  };
}

function parseOpenAICreditGrants(data) {
  const remainingUsd = num(data?.total_available ?? data?.totalAvailable ?? data?.available, null);
  if (remainingUsd === null) return null;
  const usedUsd = num(data?.total_used ?? data?.totalUsed, null);
  const limitUsd = num(data?.total_granted ?? data?.totalGranted, null);
  const grants = Array.isArray(data?.grants?.data) ? data.grants.data : [];
  const activeExpiries = grants
    .map((grant) => num(grant?.expires_at ?? grant?.expiresAt, null))
    .filter((value) => value !== null && value > 0)
    .map((value) => value < 10_000_000_000 ? value * 1000 : value);
  const nextExpiry = activeExpiries.length ? Math.min(...activeExpiries) : null;
  return {
    provider: 'openai',
    source: 'openai-credit-grants',
    balance: {
      remainingUsd: round(remainingUsd, 4),
      currency: 'USD',
      source: 'openai-credit-grants',
    },
    cachedAt: Date.now(),
    ...(usedUsd !== null || limitUsd !== null ? {
      creditGrants: {
        usedUsd: usedUsd === null ? null : round(usedUsd, 4),
        limitUsd: limitUsd === null ? null : round(limitUsd, 4),
        nextExpiry,
      },
    } : {}),
  };
}

function uniqueValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

async function fetchOpenAICreditGrantSnapshot(apiKey) {
  // OpenAI does not expose an official remaining-credit endpoint. The dashboard
  // credit_grants route is undocumented and may require a browser/session token
  // on some accounts, so treat it as an optional best-effort source and never
  // let it block the official costs fallback.
  const keys = uniqueValues([getOpenAIUsageSessionKey(), apiKey]);
  for (const key of keys) {
    try {
      const data = await fetchJson('https://api.openai.com/dashboard/billing/credit_grants', {
        headers: authHeaders(key, { Accept: 'application/json' }),
      });
      const snapshot = parseOpenAICreditGrants(data);
      if (snapshot) return snapshot;
    } catch {
      // Ignore: undocumented endpoint, auth shape varies by account/session.
    }
  }
  return null;
}

async function fetchOpenAICostSnapshot(apiKey) {
  if (!apiKey) return null;
  const start = Math.floor((Date.now() - 31 * 24 * 60 * 60_000) / 1000);
  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(start));
  url.searchParams.set('limit', '31');
  const data = await fetchJson(url, {
    headers: authHeaders(apiKey, { Accept: 'application/json' }),
  });
  return parseOpenAICosts(data);
}

async function fetchOpenAIUsageSnapshot() {
  const key = getAgentApiKey('openai');
  const credit = await fetchOpenAICreditGrantSnapshot(key);
  if (credit) return credit;
  return await fetchOpenAICostSnapshot(key);
}

function managementKey(provider) {
  const id = cacheKey(provider).replace(/[^a-z0-9]/g, '_').toUpperCase();
  return process.env[`${id}_MANAGEMENT_API_KEY`] || process.env.XAI_MANAGEMENT_API_KEY || '';
}

function teamId(provider) {
  const id = cacheKey(provider).replace(/[^a-z0-9]/g, '_').toUpperCase();
  return process.env[`${id}_TEAM_ID`] || process.env.XAI_TEAM_ID || '';
}

function moneyNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const stripped = value.replace(/[$,\s]/g, '');
    return num(stripped, null);
  }
  if (typeof value === 'object') {
    const direct = value.usd ?? value.dollars ?? value.amountUsd ?? value.amount_usd
      ?? value.availableUsd ?? value.available_usd ?? value.balanceUsd ?? value.balance_usd
      ?? value.amount ?? value.value ?? value.balance ?? value.available ?? value.total;
    const parsed = moneyNumber(direct);
    if (parsed !== null) return parsed;
    const cents = num(value.cents ?? value.amountCents ?? value.amount_cents ?? value.usd_cents, null);
    if (cents !== null) return cents / 100;
  }
  return null;
}

function parseXaiPrepaidBalance(data) {
  const remainingUsd = moneyNumber(
    data?.total
      ?? data?.availableCredits
      ?? data?.available_credits
      ?? data?.creditBalance
      ?? data?.credit_balance
      ?? data?.balance
      ?? data?.credits,
  );
  if (remainingUsd === null) return null;
  return {
    provider: 'xai',
    source: 'xai-management-prepaid-balance',
    balance: {
      remainingUsd: round(remainingUsd, 4),
      currency: 'USD',
      source: 'xai-management-prepaid-balance',
    },
    cachedAt: Date.now(),
  };
}

async function fetchXaiUsageSnapshot() {
  const key = managementKey('xai');
  const team = teamId('xai');
  if (!key || !team) return null;
  const data = await fetchJson(`https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}/prepaid/balance`, {
    headers: authHeaders(key, { Accept: 'application/json' }),
  });
  return parseXaiPrepaidBalance(data);
}

export async function fetchApiUsageSnapshot(provider, { force = false } = {}) {
  const id = cacheKey(provider);
  if (!force) {
    const fresh = readCachedApiUsageSnapshot(id, { allowStale: false });
    if (fresh) return fresh;
  }

  let snapshot = null;
  try {
    if (id === 'deepseek') snapshot = await fetchDeepSeekUsageSnapshot();
    else if (id === 'openai') snapshot = await fetchOpenAIUsageSnapshot();
    else if (id === 'xai') snapshot = await fetchXaiUsageSnapshot();
  } catch (err) {
    const status = num(err?.status, null);
    if (status === 401 || status === 403 || status === 404) return null;
    throw err;
  }

  if (snapshot) writeCachedApiUsageSnapshot(id, snapshot);
  return snapshot;
}
