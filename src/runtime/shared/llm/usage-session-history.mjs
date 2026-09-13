/**
 * Long-range usage recovered from the durable session stores.
 *
 * The gateway event list is capped by row count and the daily rollup only
 * carries days recorded after rolling up began, so both stores answer "what
 * happened recently" and neither can answer "what did I ever spend on Grok".
 * The session documents can: every session keeps its own lifetime token
 * counters, its route, and its transcript timestamps, and they outlive both
 * telemetry stores.
 *
 * So this module rebuilds per-day totals from those documents. The rebuild is
 * a derivation, not a second recording: a day that the rollup or the raw
 * events already cover is never taken from here, which is what keeps a turn
 * from being counted twice.
 *
 * Two things are approximations, and both are marked `restored` so a surface
 * can say so:
 *   - a session carries ONE set of token counters, so a session that changed
 *     model mid-way is attributed to the route it ended on;
 *   - those counters are not stamped per turn, so a session that spans days is
 *     split across them by how many messages each day holds.
 *
 * Scanning is incremental: a session file whose size and mtime are unchanged
 * is read from the cache instead of being parsed again, which keeps a refresh
 * to the handful of sessions that actually moved.
 */
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomicAsync } from '../atomic-file.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { billableInputTokensForProvider, computeCostUsd } from './cost.mjs';
import { isConversationUsageSource, usageRollupDayKey } from './usage-rollup.mjs';

export const USAGE_HISTORY_FILE = 'usage-history.local.json';
export const USAGE_HISTORY_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
// A session document is transcript-sized. The largest on a working machine sit
// around 10 MB; the cap only exists so a corrupted giant cannot take the
// daemon's heap with it.
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
// A full first pass reads every transcript on disk. Persisting along the way
// means an interrupted scan resumes instead of starting over.
const PERSIST_EVERY_FILES = 150;
// A rescan only has to notice sessions that moved since the last one.
const RESCAN_IDLE_MS = 60 * 1000;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let cached = null;
let scanPromise = null;
let lastScanAt = 0;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !UNSAFE_KEYS.has(text) ? text.slice(0, 200) : '';
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function resolveHistoryPath() {
  const explicit = process.env.MIXDOG_USAGE_HISTORY_PATH;
  if (explicit) return explicit;
  // Repo test workers must not read or rewrite the user's real cache.
  if (process.env.NODE_TEST_CONTEXT) return null;
  try {
    return join(resolvePluginData(), USAGE_HISTORY_FILE);
  } catch {
    return null;
  }
}

function resolveSessionsDir() {
  const explicit = process.env.MIXDOG_USAGE_SESSION_DIR;
  if (explicit) return explicit;
  try {
    return join(resolvePluginData(), 'sessions');
  } catch {
    return null;
  }
}

export function usageSessionHistoryPath() {
  return resolveHistoryPath();
}

/** Timestamp a transcript message was written at, when it carries one. */
function messageTimestamp(message) {
  const direct = num(message?.createdAt);
  if (direct > 0) return direct;
  return num(message?.meta?.transcript?.at);
}

/**
 * Spread `total` across `keys` in proportion to `weights`, keeping the sum
 * exact: the rounding remainder lands on the heaviest day rather than
 * disappearing from the totals.
 */
function distribute(total, keys, weights, weightSum) {
  const out = new Map();
  if (!(total > 0) || !keys.length) return out;
  if (keys.length === 1 || !(weightSum > 0)) {
    out.set(keys[0], total);
    return out;
  }
  let assigned = 0;
  let heaviest = keys[0];
  let heaviestWeight = -1;
  for (const key of keys) {
    const weight = weights.get(key) || 0;
    const share = Math.floor((total * weight) / weightSum);
    out.set(key, share);
    assigned += share;
    if (weight > heaviestWeight) {
      heaviest = key;
      heaviestWeight = weight;
    }
  }
  if (assigned < total) out.set(heaviest, (out.get(heaviest) || 0) + (total - assigned));
  return out;
}

/**
 * One session document → the per-day slices it contributes.
 * Returns null for a session that never spent a token, which is most of the
 * short-lived ids a daemon mints.
 */
export function summarizeSessionUsage(doc) {
  const provider = clean(doc?.provider);
  const model = clean(doc?.model);
  if (!provider || !model) return null;

  const cacheRead = num(doc?.totalCachedReadTokens);
  const cacheWrite = num(doc?.totalCacheWriteTokens);
  // `totalUncachedInputTokens` is already the billable part. Where a session
  // predates that counter the raw input is unpacked the same way the rollup
  // does it, so a provider that reports the cache inside `input` is not
  // counted twice.
  const input = num(doc?.totalUncachedInputTokens)
    || billableInputTokensForProvider(provider, num(doc?.totalInputTokens), cacheRead, cacheWrite);
  const output = num(doc?.totalOutputTokens);
  if (input + output + cacheRead + cacheWrite <= 0) return null;

  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  const weights = new Map();
  let weightSum = 0;
  let firstTs = 0;
  let lastTs = 0;
  let userTurns = 0;
  for (const message of messages) {
    if (message?.role === 'user') userTurns += 1;
    const ts = messageTimestamp(message);
    if (ts <= 0) continue;
    const key = usageRollupDayKey(ts);
    weights.set(key, (weights.get(key) || 0) + 1);
    weightSum += 1;
    firstTs = firstTs > 0 ? Math.min(firstTs, ts) : ts;
    lastTs = Math.max(lastTs, ts);
  }
  // A transcript compacted down to nothing still spent what it spent; the day
  // it was last used is the only timestamp left to attribute it to.
  if (!weights.size) {
    const fallback = num(doc?.updatedAt) || num(doc?.lastUsedAt) || num(doc?.createdAt);
    if (!fallback) return null;
    const key = usageRollupDayKey(fallback);
    weights.set(key, 1);
    weightSum = 1;
    firstTs = fallback;
    lastTs = fallback;
  }

  const keys = [...weights.keys()].sort();
  const turns = Math.max(1, userTurns);
  const byInput = distribute(input, keys, weights, weightSum);
  const byOutput = distribute(output, keys, weights, weightSum);
  const byCacheRead = distribute(cacheRead, keys, weights, weightSum);
  const byCacheWrite = distribute(cacheWrite, keys, weights, weightSum);
  const byTurns = distribute(turns, keys, weights, weightSum);

  const days = {};
  for (const key of keys) {
    const slice = {
      turns: byTurns.get(key) || 0,
      input: byInput.get(key) || 0,
      output: byOutput.get(key) || 0,
      cacheRead: byCacheRead.get(key) || 0,
      cacheWrite: byCacheWrite.get(key) || 0,
      costUsd: 0,
    };
    if (slice.turns + slice.input + slice.output + slice.cacheRead + slice.cacheWrite <= 0) continue;
    let costUsd = 0;
    try {
      costUsd = num(computeCostUsd({
        provider,
        model,
        uncachedInputTokens: slice.input,
        outputTokens: slice.output,
        cacheReadTokens: slice.cacheRead,
        cacheWriteTokens: slice.cacheWrite,
      }));
    } catch {
      // An unpriced model still reports its tokens.
    }
    slice.costUsd = round6(costUsd);
    days[key] = slice;
  }
  if (!Object.keys(days).length) return null;

  return {
    provider,
    model,
    sessionId: clean(doc?.id),
    conversation: isConversationUsageSource(doc?.sourceType),
    firstTs,
    lastTs,
    days,
  };
}

function emptyRouteTotals() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function emptyTurnTotals() {
  return {
    ...emptyRouteTotals(),
    costBilled: 0,
    // Nothing here was priced by a provider invoice: the catalog priced it.
    costEstimated: 0,
    costKnownTurns: 0,
    durationMs: 0,
    durationTurns: 0,
  };
}

/** Rollup-shaped so the stats model folds a restored day with the same code. */
function emptyHistoryDay() {
  return {
    ...emptyTurnTotals(),
    firstTs: 0,
    lastTs: 0,
    conversation: emptyTurnTotals(),
    conversationPartial: false,
    sessionsPurged: true,
    // Tells a reader these numbers were derived from transcripts rather than
    // recorded turn by turn.
    restored: true,
    models: {},
    sessions: {},
    sessionTokens: [],
    sessionsDropped: 0,
  };
}

function addRouteTotals(target, slice) {
  target.turns += slice.turns;
  target.input += slice.input;
  target.output += slice.output;
  target.cacheRead += slice.cacheRead;
  target.cacheWrite += slice.cacheWrite;
  target.costUsd = round6(target.costUsd + slice.costUsd);
}

function addTurnTotals(target, slice) {
  addRouteTotals(target, slice);
  if (slice.costUsd > 0) {
    target.costEstimated = round6(target.costEstimated + slice.costUsd);
    target.costKnownTurns += slice.turns;
  }
}

/** Fold every cached session summary into one day-keyed document. */
export function buildUsageHistoryDays(entries) {
  const days = {};
  for (const entry of entries) {
    if (!entry?.provider || !entry?.model || !entry?.days) continue;
    const routeKey = `${entry.provider}/${entry.model}`;
    for (const [key, slice] of Object.entries(entry.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const day = days[key] || emptyHistoryDay();
      const normalized = {
        turns: num(slice?.turns),
        input: num(slice?.input),
        output: num(slice?.output),
        cacheRead: num(slice?.cacheRead),
        cacheWrite: num(slice?.cacheWrite),
        costUsd: num(slice?.costUsd),
      };
      addTurnTotals(day, normalized);
      if (entry.conversation) addTurnTotals(day.conversation, normalized);

      const bucket = day.models[routeKey] || {
        provider: entry.provider,
        model: entry.model,
        kind: '',
        ...emptyRouteTotals(),
        conversation: emptyRouteTotals(),
      };
      addRouteTotals(bucket, normalized);
      if (entry.conversation) addRouteTotals(bucket.conversation, normalized);
      day.models[routeKey] = bucket;

      // Only conversation ids count as sessions, matching the rollup: a
      // background runner mints a fresh id per cycle.
      if (entry.conversation && entry.sessionId) {
        const tokens = normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite;
        day.sessions[entry.sessionId] = (day.sessions[entry.sessionId] || 0) + tokens;
      }
      const dayStart = Date.parse(`${key}T00:00:00`);
      if (Number.isFinite(dayStart)) {
        const first = num(entry.firstTs);
        const last = num(entry.lastTs);
        const from = first > dayStart && first < dayStart + DAY_MS ? first : dayStart;
        const to = last > dayStart && last < dayStart + DAY_MS ? last : dayStart + DAY_MS - 1;
        day.firstTs = day.firstTs > 0 ? Math.min(day.firstTs, from) : from;
        day.lastTs = Math.max(day.lastTs, to);
      }
      days[key] = day;
    }
  }
  return days;
}

function normalizeCache(raw) {
  const files = {};
  const source = raw?.files && typeof raw.files === 'object' ? raw.files : {};
  for (const [name, value] of Object.entries(source)) {
    if (!name || UNSAFE_KEYS.has(name)) continue;
    if (!value || typeof value !== 'object') continue;
    files[name] = {
      mtimeMs: num(value.mtimeMs),
      size: num(value.size),
      entry: value.entry && typeof value.entry === 'object' ? value.entry : null,
    };
  }
  return {
    version: USAGE_HISTORY_VERSION,
    updatedAt: num(raw?.updatedAt),
    scannedAt: num(raw?.scannedAt),
    complete: raw?.complete === true,
    files,
  };
}

function readCache() {
  if (cached) return cached;
  const path = resolveHistoryPath();
  if (!path) {
    cached = normalizeCache(null);
    return cached;
  }
  try {
    cached = normalizeCache(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    cached = normalizeCache(null);
  }
  return cached;
}

async function persistCache(state) {
  const path = resolveHistoryPath();
  if (!path) return;
  try {
    await writeJsonAtomicAsync(path, state, { compact: true, fsync: false, fsyncDir: false });
  } catch {
    // Local derivation only: a cache that cannot be written is recomputed.
  }
}

/**
 * Rebuild the cache from the session directory. Only files whose size or
 * mtime changed are parsed, and the pass awaits each read, so a first full
 * scan runs alongside the daemon instead of blocking it.
 */
async function scanSessions({ now = Date.now() } = {}) {
  const dir = resolveSessionsDir();
  const state = readCache();
  if (!dir) {
    state.complete = true;
    return state;
  }
  let names = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    // No session directory yet: a fresh install has no history to recover.
    state.complete = true;
    state.scannedAt = now;
    return state;
  }

  const seen = new Set();
  let parsed = 0;
  for (const name of names) {
    seen.add(name);
    const known = state.files[name];
    let info = null;
    try {
      info = await stat(join(dir, name));
    } catch {
      continue;
    }
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) continue;
    if (info.size > MAX_SESSION_BYTES) {
      state.files[name] = { mtimeMs: info.mtimeMs, size: info.size, entry: null };
      continue;
    }
    let entry = null;
    try {
      entry = summarizeSessionUsage(JSON.parse(await readFile(join(dir, name), 'utf8')));
    } catch {
      // A session being written right now is re-read on the next pass.
      continue;
    }
    state.files[name] = { mtimeMs: info.mtimeMs, size: info.size, entry };
    parsed += 1;
    if (parsed % PERSIST_EVERY_FILES === 0) {
      state.updatedAt = Date.now();
      await persistCache(state);
    }
  }

  // A deleted session takes its contribution with it.
  for (const name of Object.keys(state.files)) {
    if (!seen.has(name)) delete state.files[name];
  }
  state.complete = true;
  state.scannedAt = Date.now();
  state.updatedAt = Date.now();
  await persistCache(state);
  return state;
}

function historyEntries(state) {
  const entries = [];
  for (const file of Object.values(state.files)) {
    if (file?.entry) entries.push(file.entry);
  }
  return entries;
}

/** Whatever the cache holds right now — no disk scan, no waiting. */
export function loadUsageSessionHistory() {
  const state = readCache();
  return {
    days: buildUsageHistoryDays(historyEntries(state)),
    complete: state.complete === true,
    pending: state.complete !== true,
    scannedAt: state.scannedAt,
  };
}

/**
 * Refresh the cache, waiting at most `waitMs` for it. The scan keeps running
 * after the wait expires, so an early call returns partial history and the
 * next one sees the rest.
 */
export async function refreshUsageSessionHistory({ waitMs = 0, force = false, now = Date.now() } = {}) {
  const state = readCache();
  const stale = force
    || state.complete !== true
    || now - Math.max(lastScanAt, state.scannedAt) > RESCAN_IDLE_MS;
  if (stale && !scanPromise) {
    lastScanAt = now;
    scanPromise = scanSessions({ now })
      .catch(() => readCache())
      .finally(() => { scanPromise = null; });
  }
  if (scanPromise && waitMs > 0) {
    await Promise.race([
      scanPromise,
      new Promise((resolve) => { setTimeout(resolve, waitMs).unref?.(); }),
    ]);
  }
  return loadUsageSessionHistory();
}

/** Test seam: drops the in-process cache so the next read hits disk. */
export function resetUsageSessionHistoryCache() {
  cached = null;
  scanPromise = null;
  lastScanAt = 0;
}
