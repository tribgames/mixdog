'use strict';

const fs = require('fs');
const path = require('path');

/** Truthy env: 1, true, yes, on (case-insensitive). */
function isTruthyEnv(value) {
  if (value == null || value === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Ship-mode gate: verbose hook/daemon tracing. Default OFF.
 * MIXDOG_DEBUG_SESSION_START remains a legacy alias.
 */
function isMixdogDebugEnabled() {
  return (
    isTruthyEnv(process.env.MIXDOG_DEBUG) ||
    isTruthyEnv(process.env.MIXDOG_DEBUG_SESSION_START)
  );
}

/** Canonical / live logs — never subject to sibling GC. */
const CANONICAL_PLUGIN_LOG_NAMES = new Set([
  'boot.log',
  'crash.log',
  'drop-trace.log',
  'event.log',
  'channels-worker.log',
  'memory-worker.log',
  'mcp-debug.log',
  'pg.log',
  'schedule.log',
  'session-start.log',
  'session-start-critical.log',
  'webhook.log',
  'perf.log',
]);

/**
 * Per-process sibling logs (stale accumulators). Matches channels worker GC.
 * Only these may be count-pruned.
 */
const STALE_PLUGIN_LOG_SIBLING_RE = [
  /^(channels|memory)-worker\.\d+\.\d+\.log$/,
  /^mcp-debug\.\d+\.\d+\.log$/,
  /^supervisor\.\d+\.log$/,
];

const DEFAULT_STALE_LOG_SIBLING_MAX = 50;
const DEFAULT_STALE_LOG_MIN_AGE_MS = 5 * 60 * 1000;

function isStalePluginLogSibling(name) {
  if (!name || !name.endsWith('.log')) return false;
  if (CANONICAL_PLUGIN_LOG_NAMES.has(name)) return false;
  return STALE_PLUGIN_LOG_SIBLING_RE.some((re) => re.test(name));
}

/**
 * Drop oldest stale per-worker / per-PID log siblings only. Skips canonical logs
 * and files touched within minAgeMs (likely live writers). Best-effort; no throw.
 */
function pruneStalePluginDataLogSiblings(
  dataDir,
  maxSiblings = DEFAULT_STALE_LOG_SIBLING_MAX,
  minAgeMs = DEFAULT_STALE_LOG_MIN_AGE_MS,
) {
  if (!dataDir || maxSiblings < 1) return { removed: 0, kept: 0 };
  const now = Date.now();
  let entries;
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && isStalePluginLogSibling(e.name));
  } catch {
    return { removed: 0, kept: 0 };
  }
  const candidates = [];
  for (const e of entries) {
    const p = path.join(dataDir, e.name);
    try {
      const st = fs.statSync(p);
      if (now - st.mtimeMs < minAgeMs) continue;
      candidates.push({ path: p, mtimeMs: st.mtimeMs });
    } catch { /* skip */ }
  }
  if (candidates.length <= maxSiblings) {
    return { removed: 0, kept: candidates.length };
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toRemove = candidates.length - maxSiblings;
  let removed = 0;
  for (let i = 0; i < toRemove; i++) {
    try {
      fs.unlinkSync(candidates[i].path);
      removed++;
    } catch { /* skip */ }
  }
  return { removed, kept: candidates.length - removed };
}

/** @deprecated use pruneStalePluginDataLogSiblings */
function prunePluginDataLogFiles(dataDir, maxFiles) {
  return pruneStalePluginDataLogSiblings(dataDir, maxFiles);
}

const SESSION_START_CRITICAL_LOG = 'session-start-critical.log';
const SESSION_START_CRITICAL_MAX_BYTES = 64 * 1024;
const SESSION_START_CRITICAL_KEEP_BYTES = 64 * 1024;

function rotateBoundedLog(filePath, maxBytes, keepBytes) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > maxBytes) {
      const buf = fs.readFileSync(filePath);
      fs.writeFileSync(filePath, buf.subarray(Math.max(0, buf.length - keepBytes)));
    }
  } catch { /* missing file ok */ }
}

/**
 * Ship-mode durable fail-open record (size-capped). No-op when line empty.
 */
function appendSessionStartCriticalLog(dataDir, line) {
  if (!dataDir || !line) return;
  try {
    const p = path.join(dataDir, SESSION_START_CRITICAL_LOG);
    fs.mkdirSync(dataDir, { recursive: true });
    rotateBoundedLog(p, SESSION_START_CRITICAL_MAX_BYTES, SESSION_START_CRITICAL_KEEP_BYTES);
    fs.appendFileSync(p, line.endsWith('\n') ? line : `${line}\n`);
  } catch { /* best-effort */ }
}

/**
 * Fallback when call sites omit `{ critical: true }`.
 */
function sessionStartCriticalFallback(line) {
  const s = String(line || '');
  if (/reason=ok\b/.test(s)) return false;
  if (/\[session-start\] skip\b/.test(s) && /reason=/.test(s)) return true;
  if (/result=null/.test(s)) return true;
  if (/owner route unavailable/.test(s)) return true;
  if (/memory_port unavailable/.test(s)) return true;
  if (/\baborted\b/i.test(s)) return true;
  if (/\bcycle1\b/.test(s) && /reason=/.test(s) && !/reason=ok\b/.test(s)) return true;
  if (/\b(exception|failed|abort|err=|non-200|missing-dirs|catch endpoint)\b/i.test(s)) {
    return true;
  }
  return false;
}

module.exports = {
  isTruthyEnv,
  isMixdogDebugEnabled,
  isStalePluginLogSibling,
  pruneStalePluginDataLogSiblings,
  prunePluginDataLogFiles,
  appendSessionStartCriticalLog,
  sessionStartCriticalFallback,
  DEFAULT_STALE_LOG_SIBLING_MAX,
  DEFAULT_PLUGIN_LOG_MAX_FILES: DEFAULT_STALE_LOG_SIBLING_MAX,
  SESSION_START_CRITICAL_LOG,
};
