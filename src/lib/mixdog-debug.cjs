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

// ---------------------------------------------------------------------------
// Ship / dev mode
// ---------------------------------------------------------------------------
// Shipping (a published install) disables best-effort diagnostic trace/log IO
// by default; a dev/debug run opts back in. This keeps a shipped process from
// silently spooling agent-trace.jsonl / tool-failures.jsonl to disk while
// leaving critical bounded logs and in-memory session metrics untouched.
let _cachedFromSource = null;

/** True when running from a git checkout (dev), not a published npm install. */
function _detectFromSourceCheckout() {
  if (_cachedFromSource !== null) return _cachedFromSource;
  try {
    // src/lib/mixdog-debug.cjs → repo root two levels up. Use module.filename
    // instead of __dirname so esbuild's ESM TUI bundle does not emit a free
    // __dirname identifier (ReferenceError in node ESM).
    const moduleDir = module && module.filename
      ? path.dirname(module.filename)
      : process.cwd();
    const roots = [
      path.resolve(moduleDir, '..', '..'),
      process.cwd(),
    ];
    _cachedFromSource = roots.some((root) => fs.existsSync(path.join(root, '.git')));
  } catch {
    _cachedFromSource = false;
  }
  return _cachedFromSource;
}

/**
 * Resolve explicit ship/dev mode. Precedence:
 *   1. MIXDOG_MODE=dev|development|debug            → 'dev'
 *   2. MIXDOG_MODE=ship|shipping|prod|production    → 'ship'
 *   3. MIXDOG_SHIP truthy                           → 'ship'
 *   4. any debug flag (isMixdogDebugEnabled)        → 'dev'
 *   5. default: from-source checkout → 'dev', else  → 'ship'
 */
function resolveMixdogMode() {
  const raw = String(process.env.MIXDOG_MODE || '').trim().toLowerCase();
  if (raw === 'dev' || raw === 'development' || raw === 'debug') return 'dev';
  if (raw === 'ship' || raw === 'shipping' || raw === 'prod' || raw === 'production') return 'ship';
  if (isTruthyEnv(process.env.MIXDOG_SHIP)) return 'ship';
  if (isMixdogDebugEnabled()) return 'dev';
  return _detectFromSourceCheckout() ? 'dev' : 'ship';
}

function isShippingMode() {
  return resolveMixdogMode() === 'ship';
}

function isDevMode() {
  return resolveMixdogMode() === 'dev';
}

/**
 * Whether best-effort diagnostic (non-critical) trace/log file IO should run.
 * Shipping default OFF; dev/debug ON. MIXDOG_DIAGNOSTICS truthy force-enables
 * even under shipping. Per-writer *_DISABLE envs still force OFF at the writer.
 */
function isDiagnosticIOEnabled() {
  if (isTruthyEnv(process.env.MIXDOG_DIAGNOSTICS)) return true;
  return !isShippingMode();
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
  'tool-events.log',
  'memory-runtime-proxy.log',
  'channels-worker-standalone.log',
  'mixdog-tui.stderr.log',
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

// Shared bound for unbounded per-writer plugin logs (tool-events,
// memory-runtime-proxy, channels-worker-standalone). Keep a tail so recent
// context survives rotation while the file stays under the 10 MB cap.
const PLUGIN_LOG_MAX_BYTES = 10 * 1024 * 1024;
const PLUGIN_LOG_KEEP_BYTES = 2 * 1024 * 1024;

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

module.exports = {
  isMixdogDebugEnabled,
  resolveMixdogMode,
  isShippingMode,
  isDevMode,
  isDiagnosticIOEnabled,
  pruneStalePluginDataLogSiblings,
  appendSessionStartCriticalLog,
  DEFAULT_STALE_LOG_SIBLING_MAX,
  rotateBoundedLog,
  PLUGIN_LOG_MAX_BYTES,
  PLUGIN_LOG_KEEP_BYTES,
};
