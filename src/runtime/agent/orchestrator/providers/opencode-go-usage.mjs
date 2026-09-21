import { join } from 'node:path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { getAgentApiKey, getOpenCodeGoConsoleKey } from '../../../shared/config.mjs';
import { round, cleanString as clean } from './lib/usage-primitives.mjs';
import { JsonMemoryCache } from './lib/json-memory-cache.mjs';

const CACHE_FILE = 'opencode-go-usage-cache.json';
const LIVE_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 60 * 60_000;
// The console replaced its server-rendered page (usage inlined in the HTML) with
// a SPA over this REST API, so scraping `/workspace/{id}/go` now yields an empty
// shell. `GET /api/go/status` answers a service-account key that carries the
// `all` permission and rejects `inference-only` keys with 403. The key itself
// resolves the workspace, so no workspace id or `x-org-id` header is needed.
const BASE_URL = 'https://opencode.ai/console';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143 Safari/537.36';
// Meters report micro-cents as strings: "1200000000" is the $12 five-hour cap.
// Limits come from the response, so a plan change needs no code change.
const MICRO_CENTS_PER_USD = 1e8;
const METER_LABELS = Object.freeze({ fiveHour: '5H', week: '7D', month: 'M' });
const diskJsonCache = new JsonMemoryCache();

// Local unguarded `num`: this module intentionally coerces '' to 0 via
// Number(''), unlike the guarded shared num() in lib/usage-primitives.mjs.
// Behavior differs on empty-string input, so it stays local.
function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cachePath() {
  return join(resolvePluginData(), CACHE_FILE);
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
  if (next) diskJsonCache.remember(file, next);
}

function freshSnapshot(snapshot, ttlMs) {
  const cachedAt = num(snapshot?.cachedAt, 0);
  if (!cachedAt || Date.now() - cachedAt > ttlMs) return null;
  return Array.isArray(snapshot?.quotaWindows) && snapshot.quotaWindows.length ? snapshot : null;
}

function isConsoleKey(value) {
  return /^(?:oc_sk_|sk-)/.test(String(value || ''));
}

// Usage auth is a console API key holding the `all` permission; the inference
// key is the fallback when one key serves both roles. A stored value that is
// not key-shaped predates the API migration, so it counts as "not configured"
// and the UI asks for a key instead of surfacing an opaque 401.
function consoleApiKey() {
  const stored = clean(getOpenCodeGoConsoleKey());
  if (isConsoleKey(stored)) return stored;
  const inferenceKey = clean(getAgentApiKey('opencode-go'));
  return isConsoleKey(inferenceKey) ? inferenceKey : null;
}

function statusError(status) {
  if (status === 401) {
    const err = new Error('OpenCode console API key was rejected');
    err.code = 'OPENCODE_GO_USAGE_AUTH_FAILED';
    return err;
  }
  if (status === 403) {
    const err = new Error(
      'OpenCode console API key lacks permission: subscription usage needs an "all" key, not an inference-only key'
    );
    err.code = 'OPENCODE_GO_USAGE_FORBIDDEN';
    return err;
  }
  const err = new Error(`OpenCode Go usage fetch failed (${status})`);
  err.code = 'OPENCODE_GO_USAGE_FETCH_FAILED';
  return err;
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

export function readCachedOpenCodeGoUsageSnapshot({ allowStale = true } = {}) {
  const raw = diskJsonCache.read(cachePath());
  const snapshot = raw?.snapshot || raw;
  return freshSnapshot(snapshot, allowStale ? STALE_TTL_MS : LIVE_TTL_MS);
}

export function openCodeGoUsageConfigStatus() {
  return { ready: Boolean(consoleApiKey()) };
}

export async function fetchOpenCodeGoUsageSnapshot(_config = {}, { force = false } = {}) {
  if (!force) {
    const fresh = readCachedOpenCodeGoUsageSnapshot({ allowStale: false });
    if (fresh) return fresh;
  }
  const apiKey = consoleApiKey();
  if (!apiKey) {
    const err = new Error('OpenCode Go usage requires an OpenCode console API key');
    err.code = 'OPENCODE_GO_USAGE_AUTH_REQUIRED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(`${BASE_URL}/api/go/status`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) throw statusError(res.status);
    const parsed = snapshotFromStatus(await res.json().catch(() => null));
    if (!parsed) {
      const err = new Error('OpenCode Go subscription meters were not found');
      err.code = 'OPENCODE_GO_USAGE_PARSE_FAILED';
      throw err;
    }
    const snapshot = { ...parsed, cachedAt: Date.now() };
    writeJson(cachePath(), { version: 1, updatedAt: Date.now(), snapshot });
    return snapshot;
  } finally {
    clearTimeout(timer);
  }
}
