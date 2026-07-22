/**
 * Persistent TUI prompt input history, scoped by project working directory.
 * Stored under MIXDOG data dir (not the repo working tree).
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

export const PROMPT_HISTORY_LIMIT = 50;

export function promptHistoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/** Stable map key for cwd-scoped prompt history buckets. */
function promptHistoryCwdKey(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '';
  const abs = resolve(text);
  return process.platform === 'win32'
    ? abs.replace(/[\\/]+$/, '').toLowerCase()
    : abs.replace(/\/+$/, '');
}

function historyFilePath(cwd) {
  const key = promptHistoryCwdKey(cwd);
  if (!key) return '';
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  return join(resolvePluginData(), 'tui-prompt-history', `${digest}.json`);
}

function readEntries(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries
      .map((entry) => String(entry || '').trim())
      .filter((entry) => promptHistoryKey(entry));
  } catch {
    return [];
  }
}

function buildPayload(entries) {
  return `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
}

function writeEntriesSync(filePath, entries) {
  if (!filePath) return false;
  try {
    // Prompt text may be sensitive; restrict directory/file to the owning user.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, buildPayload(entries), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best-effort; Windows may ignore mode bits */
    }
    return true;
  } catch {
    return false;
  }
}

// Async twin of writeEntriesSync — identical on-disk format (atomic tmp+rename,
// 0o600). Used by the write-behind flush so a submit never blocks on disk.
async function writeEntriesAsync(filePath, entries) {
  if (!filePath) return false;
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, buildPayload(entries), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, filePath);
    try {
      await chmod(filePath, 0o600);
    } catch {
      /* best-effort; Windows may ignore mode bits */
    }
    return true;
  } catch {
    return false;
  }
}

// ── Write-behind cache ──────────────────────────────────────────────────
// Per-file authoritative in-memory entry list (oldest → newest) for fast
// reads/returns, plus a per-file queue of appends not yet durably flushed.
// Disk writes are async + coalesced. CRITICAL: the flush does NOT blindly
// write memCache — a second mixdog process may have flushed newer prompts to
// disk after we seeded. So at flush we RE-READ the file and replay only OUR
// pending appends onto it (same filter-dup + push + cap rule as a per-submit
// read-merge-write), which preserves cross-process merge semantics.
const WRITE_BEHIND_MS = 250;
const FLUSH_CAP = 5; // flush immediately once this many appends are queued
const memCache = new Map(); // filePath -> entries[] (optimistic in-memory view)
const pendingAppends = new Map(); // filePath -> string[] appends since last flush
const pendingTimers = new Map(); // filePath -> timeout handle

function cachedEntries(filePath) {
  if (memCache.has(filePath)) return memCache.get(filePath);
  const entries = readEntries(filePath);
  memCache.set(filePath, entries);
  return entries;
}

// Apply one append to a base list: drop prior dup key, push, cap at limit.
function applyAppend(base, value) {
  const key = promptHistoryKey(value);
  const next = base.filter((entry) => promptHistoryKey(entry) !== key);
  next.push(String(value).trim());
  return next.length > PROMPT_HISTORY_LIMIT ? next.slice(-PROMPT_HISTORY_LIMIT) : next;
}

// Merge our queued appends onto the CURRENT on-disk entries (re-read now, so
// another process's post-seed flush is not clobbered), replaying prior rules.
function reconcileWithDisk(filePath, pend) {
  let out = readEntries(filePath);
  for (const value of pend) out = applyAppend(out, value);
  return out;
}

function scheduleWriteBehind(filePath) {
  if (!filePath) return;
  if (pendingTimers.has(filePath)) clearTimeout(pendingTimers.get(filePath));
  const timer = setTimeout(() => { void writeBehindFlush(filePath); }, WRITE_BEHIND_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.set(filePath, timer);
}

async function writeBehindFlush(filePath) {
  const timer = pendingTimers.get(filePath);
  if (timer) { clearTimeout(timer); pendingTimers.delete(filePath); }
  const pend = pendingAppends.get(filePath);
  if (!pend || !pend.length) return;
  // Claim this window; appends arriving during the async write accumulate fresh
  // and reconcile against the file we are about to write.
  pendingAppends.set(filePath, []);
  const merged = reconcileWithDisk(filePath, pend);
  memCache.set(filePath, merged);
  const ok = await writeEntriesAsync(filePath, merged);
  if (!ok) {
    // Retry: re-queue our appends ahead of any newer ones (oldest → newest).
    const cur = pendingAppends.get(filePath) || [];
    pendingAppends.set(filePath, pend.concat(cur));
    scheduleWriteBehind(filePath);
  }
}

// Synchronously flush any coalesced pending writes. Registered on process exit
// so an in-flight write-behind is never lost when the TUI quits.
function flushPromptHistory() {
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  for (const [filePath, pend] of pendingAppends) {
    if (!pend.length) continue;
    const merged = reconcileWithDisk(filePath, pend);
    memCache.set(filePath, merged);
    writeEntriesSync(filePath, merged);
  }
  pendingAppends.clear();
}

process.once('exit', flushPromptHistory);

/**
 * In-memory session list (newest first). Dedupes by promptHistoryKey.
 */
function pushSessionPromptHistory(sessionTexts, value, limit = PROMPT_HISTORY_LIMIT) {
  const text = String(value || '').trim();
  const key = promptHistoryKey(text);
  if (!key) return Array.isArray(sessionTexts) ? sessionTexts : [];
  const base = Array.isArray(sessionTexts) ? sessionTexts : [];
  const next = base.filter((entry) => promptHistoryKey(entry) !== key);
  next.unshift(text);
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * Merge session-derived prompts (newest first) with persisted prompts from
 * older sessions. Dedupes by promptHistoryKey; session wins ordering.
 */
export function buildMergedPromptHistory(sessionTexts, persistedTexts, limit = PROMPT_HISTORY_LIMIT) {
  const seen = new Set();
  const history = [];

  const push = (raw) => {
    if (history.length >= limit) return;
    const text = String(raw || '').trim();
    const key = promptHistoryKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    history.push(text);
  };

  for (const text of sessionTexts) push(text);

  const persisted = Array.isArray(persistedTexts) ? persistedTexts : [];
  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    push(persisted[i]);
  }

  return history;
}

export function loadPromptHistory(cwd) {
  const filePath = historyFilePath(cwd);
  const entries = cachedEntries(filePath);
  // Return a copy: the cache array is authoritative and must not be mutated by
  // callers (appendPromptHistory rebuilds it via filter/push).
  return entries.length <= PROMPT_HISTORY_LIMIT
    ? entries.slice()
    : entries.slice(-PROMPT_HISTORY_LIMIT);
}

/**
 * Append a submitted prompt for cwd. Skips empty keys; removes prior duplicate
 * keys (promptHistoryKey); caps at PROMPT_HISTORY_LIMIT.
 * Returns the saved entry list (oldest → newest) on success, or null on failure.
 */
export function appendPromptHistory(cwd, value) {
  const key = promptHistoryKey(value);
  if (!key) return null;
  const filePath = historyFilePath(cwd);
  if (!filePath) return null;
  // Optimistic in-memory update for immediate return/reads.
  const trimmed = applyAppend(cachedEntries(filePath), value);
  memCache.set(filePath, trimmed);
  // Queue the append for a durable, disk-reconciled flush (async, coalesced).
  const pend = pendingAppends.get(filePath) || [];
  pend.push(String(value).trim());
  pendingAppends.set(filePath, pend);
  // Bound crash-loss to FLUSH_CAP appends; otherwise coalesce over the window.
  if (pend.length >= FLUSH_CAP) void writeBehindFlush(filePath);
  else scheduleWriteBehind(filePath);
  return trimmed;
}

