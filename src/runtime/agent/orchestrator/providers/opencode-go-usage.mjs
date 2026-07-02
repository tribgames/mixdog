import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { getOpenCodeGoAuthCookie } from '../../../shared/config.mjs';

const CACHE_FILE = 'opencode-go-usage-cache.json';
const LIVE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 60 * 60_000;
const BASE_URL = 'https://opencode.ai';
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143 Safari/537.36';
const LIMITS_USD = Object.freeze({
  rolling: { label: '5H', limitUsd: 12 },
  weekly: { label: '7D', limitUsd: 30 },
  monthly: { label: 'M', limitUsd: 60 },
});
const DISK_JSON_MEMORY_TTL_MS = 1000;
let diskJsonCache = { at: 0, file: '', value: null };

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
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

// Synchronous atomic+lock write (updateJsonAtomicSync) instead of the prior
// fire-and-forget fsp.writeFile: this cache is single-entry (one snapshot
// per file, no cross-process merge), so the lock protects against a torn
// write racing readers, not a lost-update merge. Only one write happens
// per successful fetch (TTL-gated, at most once per LIVE_TTL_MS), so the
// switch off async has no meaningful latency impact on the request path.
function writeJson(file, value) {
  let next = null;
  try {
    next = updateJsonAtomicSync(file, () => value, { lock: true, fsyncDir: true, timeoutMs: 1000 }); // best-effort cache write: short lock timeout, don't block on contention
  } catch {}
  if (next) diskJsonCache = { at: Date.now(), file, value: next }; // only mirror on confirmed write, avoid phantom cache on lock timeout
}

function freshSnapshot(snapshot, ttlMs) {
  const cachedAt = num(snapshot?.cachedAt, 0);
  if (!cachedAt || Date.now() - cachedAt > ttlMs) return null;
  return Array.isArray(snapshot?.quotaWindows) && snapshot.quotaWindows.length ? snapshot : null;
}

function workspaceIdFromConfig(config = {}) {
  return clean(process.env.OPENCODE_WORKSPACE_ID)
    || clean(process.env.OPENCODE_GO_WORKSPACE_ID)
    || clean(process.env.MIXDOG_OPENCODE_WORKSPACE_ID)
    || clean(config?.providers?.['opencode-go']?.workspaceId)
    || clean(config?.providers?.['opencode-go']?.workspace_id);
}

function normalizeCookie(raw) {
  const value = clean(raw);
  if (!value) return null;
  const authMatch = /(?:^|;\s*)auth=([^;]+)/.exec(value);
  return authMatch ? authMatch[1] : value;
}

function parseObjectLiteral(text) {
  const json = String(text || '')
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*!0\b/g, ':true')
    .replace(/:\s*!1\b/g, ':false')
    .replace(/:\s*null\b/g, ':null');
  return JSON.parse(json);
}

function cookieHeader(authCookie) {
  return `auth=${authCookie}`;
}

function requestHeaders(authCookie, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', referer = BASE_URL } = {}) {
  return {
    Accept: accept,
    Cookie: cookieHeader(authCookie),
    Origin: BASE_URL,
    Referer: referer,
    'User-Agent': USER_AGENT,
  };
}

function normalizeWorkspaceId(raw) {
  const value = clean(raw);
  if (!value) return null;
  if (/^wrk_[a-zA-Z0-9]+$/.test(value)) return value;
  const match = value.match(/wrk_[a-zA-Z0-9]+/);
  return match ? match[0] : null;
}

function parseWorkspaceIdsFromJson(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (/^wrk_[a-zA-Z0-9]+$/.test(value) && !out.includes(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) parseWorkspaceIdsFromJson(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) parseWorkspaceIdsFromJson(item, out);
  }
  return out;
}

function parseWorkspaceIds(text) {
  const body = String(text || '');
  const ids = [];
  for (const match of body.matchAll(/id\s*:\s*"?(wrk_[a-zA-Z0-9]+)"?/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  if (ids.length) return ids;
  try {
    return parseWorkspaceIdsFromJson(JSON.parse(body));
  } catch {
    return [];
  }
}

function windowFromUsage(kind, raw) {
  const limit = LIMITS_USD[kind];
  if (!limit || !raw || typeof raw !== 'object') return null;
  let usagePercent = num(
    raw.usagePercent
      ?? raw.usage_percent
      ?? raw.usedPercent
      ?? raw.used_percent
      ?? raw.percentUsed
      ?? raw.percent
      ?? raw.utilizationPercent
      ?? raw.utilization_percent,
    null,
  );
  if (usagePercent === null) {
    const used = num(raw.used ?? raw.usage ?? raw.consumed, null);
    const quota = num(raw.limit ?? raw.total ?? raw.quota ?? raw.max ?? raw.cap, null);
    if (used !== null && quota > 0) usagePercent = (used / quota) * 100;
  }
  if (usagePercent === null) return null;
  if (usagePercent >= 0 && usagePercent <= 1) usagePercent *= 100;
  const resetInSec = num(
    raw.resetInSec
      ?? raw.resetInSeconds
      ?? raw.resetSeconds
      ?? raw.reset_sec
      ?? raw.reset_in_sec
      ?? raw.resetsInSec
      ?? raw.resetsInSeconds
      ?? raw.resets_in_seconds,
    null,
  );
  const usedUsd = round(limit.limitUsd * Math.max(0, usagePercent) / 100, 4);
  const remainingUsd = round(Math.max(0, limit.limitUsd - usedUsd), 4);
  return {
    label: limit.label,
    source: 'opencode-go-console',
    usedPct: round(usagePercent, 2),
    limitUsd: limit.limitUsd,
    usedUsd,
    remainingUsd,
    ...(resetInSec !== null ? { resetAt: Date.now() + Math.max(0, resetInSec) * 1000 } : {}),
  };
}

function parseWindowObject(html, key) {
  const source = String(html || '');
  const match = source.match(new RegExp(`${key}\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?(\\{[^}]+\\})`));
  if (!match) return null;
  try {
    return parseObjectLiteral(match[1]);
  } catch {
    return null;
  }
}

function parseUsageHtml(html) {
  const usage = {
    rolling: parseWindowObject(html, 'rollingUsage'),
    weekly: parseWindowObject(html, 'weeklyUsage'),
    monthly: parseWindowObject(html, 'monthlyUsage'),
  };
  if (!usage.rolling || !usage.weekly) {
    try {
      const json = JSON.parse(String(html || ''));
      const root = json?.usage || json?.data || json?.result || json?.payload || json;
      usage.rolling ||= root?.rollingUsage || root?.rolling || root?.rolling_usage || null;
      usage.weekly ||= root?.weeklyUsage || root?.weekly || root?.weekly_usage || null;
      usage.monthly ||= root?.monthlyUsage || root?.monthly || root?.monthly_usage || null;
    } catch {}
  }
  const quotaWindows = Object.entries(usage)
    .filter(([, raw]) => raw)
    .map(([kind, raw]) => windowFromUsage(kind, raw))
    .filter(Boolean);
  if (!quotaWindows.length) return null;
  return {
    provider: 'opencode-go',
    source: 'opencode-go-console',
    quotaWindows,
    rawKeys: Object.keys(usage).sort(),
  };
}

export function readCachedOpenCodeGoUsageSnapshot({ allowStale = true } = {}) {
  const raw = readJson(cachePath());
  const snapshot = raw?.snapshot || raw;
  return freshSnapshot(snapshot, allowStale ? STALE_TTL_MS : LIVE_TTL_MS);
}

export function openCodeGoUsageConfigStatus(config = {}) {
  const workspaceId = normalizeWorkspaceId(workspaceIdFromConfig(config));
  const authCookie = normalizeCookie(getOpenCodeGoAuthCookie());
  return {
    workspaceIdSet: Boolean(workspaceId),
    authCookieSet: Boolean(authCookie),
    ready: Boolean(authCookie),
  };
}

// Primary discovery: GET /auth with the auth cookie, follow-manual. The
// console redirects authenticated sessions straight to /workspace/{id};
// unauthenticated/invalid cookies redirect to /auth/authorize instead.
// This avoids depending on the hashed server-fn id used by the /_server
// probe (WORKSPACES_SERVER_ID), which can change across console deploys.
async function fetchWorkspaceIdFromAuthRedirect(authCookie, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth`, {
      signal,
      redirect: 'manual',
      headers: requestHeaders(authCookie),
    });
  } catch {
    return null; // network/redirect-mode quirk: let the _server fallback decide
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('OpenCode Go console auth failed');
    err.code = 'OPENCODE_GO_USAGE_AUTH_FAILED';
    throw err;
  }
  const location = res.headers.get('location') || '';
  if (!location) return null;
  if (/(?:^|\/|\.\/)auth\/authorize\b/.test(location)) {
    const err = new Error('OpenCode Go console auth failed');
    err.code = 'OPENCODE_GO_USAGE_AUTH_FAILED';
    throw err;
  }
  const workspaceMatch = location.match(/\/workspace\/(wrk_[a-zA-Z0-9]+)/);
  return normalizeWorkspaceId(workspaceMatch ? workspaceMatch[1] : location);
}

async function fetchWorkspaceId(authCookie, { signal } = {}) {
  const fromRedirect = await fetchWorkspaceIdFromAuthRedirect(authCookie, { signal });
  if (fromRedirect) return fromRedirect;
  const url = new URL(`${BASE_URL}/_server`);
  url.searchParams.set('id', WORKSPACES_SERVER_ID);
  const res = await fetch(url, {
    signal,
    headers: {
      ...requestHeaders(authCookie, {
        accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
        referer: BASE_URL,
      }),
      'X-Server-Id': WORKSPACES_SERVER_ID,
      'X-Server-Instance': `server-fn:${Date.now().toString(36)}`,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403
      ? 'OpenCode Go console auth failed'
      : `OpenCode Go workspace lookup failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'OPENCODE_GO_USAGE_AUTH_FAILED' : 'OPENCODE_GO_USAGE_FETCH_FAILED';
    throw err;
  }
  const [workspaceId] = parseWorkspaceIds(text);
  if (!workspaceId) {
    const err = new Error('OpenCode Go workspace id was not found');
    err.code = 'OPENCODE_GO_USAGE_WORKSPACE_NOT_FOUND';
    throw err;
  }
  return workspaceId;
}

export async function fetchOpenCodeGoUsageSnapshot(config = {}, { force = false } = {}) {
  if (!force) {
    const fresh = readCachedOpenCodeGoUsageSnapshot({ allowStale: false });
    if (fresh) return fresh;
  }
  let workspaceId = normalizeWorkspaceId(workspaceIdFromConfig(config));
  const authCookie = normalizeCookie(getOpenCodeGoAuthCookie());
  if (!authCookie) {
    const err = new Error('OpenCode Go console usage requires auth cookie');
    err.code = 'OPENCODE_GO_USAGE_AUTH_REQUIRED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    workspaceId ||= await fetchWorkspaceId(authCookie, { signal: controller.signal });
    const res = await fetch(`${BASE_URL}/workspace/${encodeURIComponent(workspaceId)}/go`, {
      signal: controller.signal,
      headers: requestHeaders(authCookie, { referer: `${BASE_URL}/workspace/${workspaceId}` }),
    });
    if (!res.ok) {
      const err = new Error(res.status === 401 || res.status === 403
        ? 'OpenCode Go console auth failed'
        : `OpenCode Go console usage fetch failed (${res.status})`);
      err.code = res.status === 401 || res.status === 403 ? 'OPENCODE_GO_USAGE_AUTH_FAILED' : 'OPENCODE_GO_USAGE_FETCH_FAILED';
      throw err;
    }
    const html = await res.text();
    const parsed = parseUsageHtml(html);
    if (!parsed) {
      const err = new Error('OpenCode Go console usage data was not found');
      err.code = 'OPENCODE_GO_USAGE_PARSE_FAILED';
      throw err;
    }
    const snapshot = { ...parsed, workspaceId, cachedAt: Date.now() };
    writeJson(cachePath(), { version: 1, updatedAt: Date.now(), snapshot });
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}
