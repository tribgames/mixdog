import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { makeAgentDispatch, resolveMaintenanceRoute } from '../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { loadConfig } from '../runtime/agent/orchestrator/config.mjs';
import { initProviders } from '../runtime/agent/orchestrator/providers/registry.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';

ensureProcessListenerHeadroom(64);

// Ported from the original mixdog tool-defs.mjs `explore` entry.
// `aiWrapped` is dropped: in the standalone build there is no aiWrapped
// dispatch hub — execution is wired directly in the runtime executor below
// via makeAgentDispatch. The standalone surface is synchronous: it returns a
// bounded locator result in this tool call.
export const EXPLORE_TOOL = {
  name: 'explore',
  title: 'Explore',
  annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Locator for broad/uncertain targets with no known path, repo or machine-wide (dot dirs included). Array = independent targets: query[] fans out facets (max 8), never rephrasings.',
  inputSchema: {
    type: 'object',
    properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Narrow locator query; array = independent facets of the task (not rephrasings), fanned out in parallel.' },
      cwd: { type: 'string', description: 'Project/root directory.' },
    },
    required: [],
    additionalProperties: false,
  },
};

// Total merged-output character cap. The original source uses a very large cap
// (50MB) plus a smart-read summariser downstream; the standalone path returns
// the merged text in-turn, so we keep a sane bound to protect the Lead context.
export const EXPLORE_OUTPUT_CHAR_CAP = 24_000;
const EXPLORE_TRUNCATION_MARKER = '\n\n[explore: output truncated; narrow cwd or split queries to see more]';
// Bound fan-out so a hostile/poisoned query array cannot spawn unbounded subs.
export const MAX_FANOUT_QUERIES = 8;
// Mechanical turn cap per explorer sub-session: 3 free turns (contract: tool
// turn 1 = whole batched search, turns 2-3 = miss recovery), then the agent
// loop forces one tool-less final-answer turn. Overridable for tuning.
export const EXPLORE_MAX_LOOP_ITERATIONS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_MAX_LOOP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
})();
const EXPLORE_RESULT_CACHE_MAX_ENTRIES = 64;
const EXPLORE_RESULT_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_RESULT_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5 * 60_000;
})();
// Hard ceiling for one explorer compute. The dispatch-level watchdog is the
// primary abort; this race + its AbortController is the last line of defence so
// a wedged compute can never hang the awaiting tool call (and its cache key)
// forever. Default 60s (was 10min): a locator sub-session that has not produced
// anchors within a minute is wedged, and holding the tool call open longer only
// delays the caller and risks the compute outliving the turn. The
// MIXDOG_EXPLORE_HARD_TIMEOUT_MS override (including 0 = disabled) is preserved.
export const EXPLORE_COMPUTE_HARD_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_HARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60_000;
})();
const EXPLORE_RESULT_CACHE = new Map(); // key -> { ts, value?, promise? }
// Fan-out launch stagger: when >1 query, dispatch the first sub-session
// immediately and delay the rest by this many ms so they can reuse the first
// sub's provider prompt-cache write instead of racing cold. Default 0 (off):
// live A/B (2026-07-07) showed 800ms produced zero cross-sub iter1 cache
// reads (the first sub's write lands only after its iter1 completes, ~2.5s+)
// while costing every later sub the full delay. Cross-BATCH reuse works
// without stagger now that iter1 writes the prefix breakpoint. Env knob kept
// for tuning experiments.
const EXPLORE_FANOUT_STAGGER_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_FANOUT_STAGGER_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
})();

// Build a promise that rejects the MOMENT `signal` aborts (immediately if it is
// already aborted), plus a `cancel` to detach the listener once the caller has
// settled by another path. This is what makes a canceled/timed-out explore
// reject RIGHT AWAY even when the underlying compute is non-cooperative (ignores
// its AbortSignal) instead of hanging until the wall-clock timeout fires.
function abortRejectionPromise(signal) {
  let cancel = () => {};
  const promise = new Promise((_resolve, reject) => {
    if (!(signal instanceof AbortSignal)) return; // never settles
    const onAbort = () => {
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'explore aborted')));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    cancel = () => { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
  });
  return { promise, cancel };
}

// Arm the wall-clock hard timeout (default 60s; MIXDOG_EXPLORE_HARD_TIMEOUT_MS
// override incl. 0 = disabled): when it fires it ABORTS `controller` — which
// both tears down a cooperative compute (child dispatch + provider call) AND,
// via abortRejectionPromise(controller.signal), rejects the awaiting call.
// Returns a disposer that clears the timer.
function armExploreHardTimeout(controller, timeoutMs = EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
  if (!(timeoutMs > 0)) return () => {};
  const timer = setTimeout(() => {
    try { controller.abort(new Error(`explorer timed out after ${timeoutMs}ms`)); } catch { /* ignore */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearTimeout(timer);
}

// Cascade a parent AbortSignal into a compute controller (immediately if the
// parent is already aborted). Returns a detach fn for the listener, or null.
function linkParentAbort(parentSignal, controller) {
  if (!(parentSignal instanceof AbortSignal)) return null;
  const onParentAbort = () => {
    try { controller.abort(parentSignal.reason); } catch { try { controller.abort(); } catch { /* ignore */ } }
  };
  if (parentSignal.aborted) { onParentAbort(); return null; }
  parentSignal.addEventListener('abort', onParentAbort, { once: true });
  return () => { try { parentSignal.removeEventListener('abort', onParentAbort); } catch { /* ignore */ } };
}

// Interruptible stagger delay: resolves after `ms`, but REJECTS the instant
// `signal` aborts (or immediately if already aborted) so a canceled fan-out
// cancels the pending stagger BEFORE it dispatches the (now-pointless) child.
// Exported for focused stagger-cancellation regression tests.
export function exploreStaggerDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const rejectCanceled = () => {
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason ?? 'explore canceled')));
    };
    if (signal instanceof AbortSignal && signal.aborted) { rejectCanceled(); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => { cleanup(); rejectCanceled(); };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal instanceof AbortSignal) { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
    };
    if (signal instanceof AbortSignal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Run one explorer compute under an AbortController that fires on EITHER the
// caller's cancellation (parentSignal) OR the wall-clock hard timeout, and RACE
// the compute against that abort so a canceled/timed-out call rejects
// IMMEDIATELY (it never waits on a non-cooperative compute). The compute
// receives the controller signal and threads it into the child dispatch so the
// abort tears down every child + its provider call at once. This is the
// single-caller path (cache disabled / non-shared); the shared-cache path uses
// startSharedCompute + subscribeToSharedCompute so one caller's cancellation
// never poisons the other subscribers. Exported for focused regression tests.
export function runExploreComputeWithAbort(compute, parentSignal = null, timeoutMs = EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
  const controller = new AbortController();
  const detachParent = linkParentAbort(parentSignal, controller);
  const disarm = armExploreHardTimeout(controller, timeoutMs);
  const { promise: aborted } = abortRejectionPromise(controller.signal);
  const computePromise = Promise.resolve().then(() => compute(controller.signal));
  return Promise.race([computePromise, aborted]).finally(() => {
    disarm();
    if (detachParent) detachParent();
  });
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Each explorer receives only its own query. The full routing and behavioral
// contract lives at system level (rules/agent/30-explorer.md).
export function buildExplorerPrompt(query) {
  return `<query>${escapeXml(query)}</query>`;
}
export function normalizeExploreQueries(rawQuery) {
  let raw = rawQuery;
  // Some clients JSON-stringify arrays when the schema field is loosely typed.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed;
      } catch { /* not a JSON array — keep as plain string */ }
    }
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean);
}

function resolveExploreCwd(input, callerCwd) {
  const base = (typeof callerCwd === 'string' && callerCwd) ? callerCwd : process.cwd();
  if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim();
    const expanded = trimmed.startsWith('~') ? trimmed.replace(/^~/, homedir()) : trimmed;
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  }
  return base;
}

function settledExplorerResult(result, cwd = null) {
  if (result?.status !== 'fulfilled') {
    const message = result?.reason?.message || String(result?.reason);
    // The hard deadline has one caller-visible convention regardless of
    // whether it expires during provider warmup or child dispatch.
    if (/^explorer timed out after \d+ms$/.test(message)) {
      return { ok: true, text: 'EXPLORATION_FAILED' };
    }
    return { ok: false, text: `[explorer error] ${message}` };
  }
  const text = cleanExplorerText(typeof result.value === 'string' ? result.value : responseText(result.value), cwd);
  if (!text) return { ok: false, text: '[explorer error] empty response' };
  return { ok: true, text };
}

function isFatalExploreError(error) {
  if (!error) return false;
  const status = Number(error.httpStatus || error.status || error.response?.status || 0) || 0;
  if (status === 401 || status === 403 || status === 429) return true;
  if (error.providerQuota === true || error.quotaExceeded === true) return true;
  const code = String(error.code || '').toUpperCase();
  if (code === 'PROVIDER_QUOTA' || code === 'EACCES' || code === 'EAUTH') return true;
  const name = String(error.name || '');
  if (/ProviderQuotaError|Auth|Authentication|Permission/i.test(name)) return true;
  const text = String(error.message || error.reason || error || '');
  return /\b(?:quota|quota_exceeded|insufficient_quota|rate[_ -]?limit|too many requests|resource exhausted|unauthorized|authentication|forbidden|permission denied|invalid api key|token expired)\b/i.test(text);
}

function fatalExploreError(settled) {
  return (settled || []).find((r) => r?.status === 'rejected' && isFatalExploreError(r.reason))?.reason || null;
}

function mergeSettled(settled, queries, cwd = null) {
  const single = queries.length === 1;
  if (single) {
    const { text: body } = settledExplorerResult(settled[0], cwd);
    return body.length > EXPLORE_OUTPUT_CHAR_CAP
      ? body.slice(0, EXPLORE_OUTPUT_CHAR_CAP) + EXPLORE_TRUNCATION_MARKER
      : body;
  }
  const parts = [];
  let total = 0;
  const sep = '\n\n';
  let truncated = false;
  for (let i = 0; i < settled.length; i++) {
    const header = `Q${i + 1}: ${String(queries[i] ?? '').replace(/\s+/g, ' ').slice(0, 60)}`;
    const { text: body } = settledExplorerResult(settled[i], cwd);
    const piece = `${header}\n${body}`;
    const addLen = (parts.length === 0 ? 0 : sep.length) + piece.length;
    if (total + addLen > EXPLORE_OUTPUT_CHAR_CAP) {
      const remaining = EXPLORE_OUTPUT_CHAR_CAP - total - (parts.length === 0 ? 0 : sep.length);
      if (remaining > 0) parts.push(piece.slice(0, remaining));
      truncated = true;
      break;
    }
    parts.push(piece);
    total += addLen;
  }
  const merged = parts.join(sep);
  return truncated ? merged + EXPLORE_TRUNCATION_MARKER : merged;
}

function ok(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[explore error] ${msg}` }], isError: true };
}

function clean(value) {
  return String(value ?? '').trim();
}

function exploreResultCacheEnabled() {
  return EXPLORE_RESULT_CACHE_TTL_MS > 0
    && !/^(?:0|false|off|no)$/i.test(String(process.env.MIXDOG_EXPLORE_RESULT_CACHE || '1'));
}

export function exploreResultCacheKey({ cwd, route, query }) {
  return JSON.stringify({
    cwd: String(cwd || ''),
    provider: clean(route?.provider),
    model: clean(route?.model),
    effort: clean(route?.effort),
    fast: route?.fast === true,
    query: String(query || ''),
  });
}

function findConfigPreset(config, presetName) {
  const wanted = clean(presetName);
  if (!wanted) return null;
  return (Array.isArray(config?.presets) ? config.presets : [])
    .find((preset) => clean(preset?.id) === wanted || clean(preset?.name) === wanted)
    || null;
}

export function resolveExploreRoute(config) {
  const routeOrName = resolveMaintenanceRoute({ agent: 'explorer', config });
  if (routeOrName && typeof routeOrName === 'object') return routeOrName;
  return findConfigPreset(config, routeOrName);
}

export async function ensureExploreProviderReady(config, route, signal = null, init = initProviders) {
  const provider = clean(route?.provider);
  if (!provider) return;
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
    await init(providers, { signal });
}

// Race provider warmup against the caller's cancellation so an ESC landing
// DURING provider init returns IMMEDIATELY (and no child dispatch follows)
// instead of finishing warmup and then spinning up subs it must tear down.
// Returns true when the caller canceled (already-aborted up front, or aborted
// before/at warmup completion), false when the provider is ready to dispatch. A
// genuine provider-init failure (not a cancel) still propagates. Exported for
// focused provider-init cancellation regression tests.
export async function awaitExploreProviderReadyOrCancel(readyPromise, parentSignal) {
  if (!(parentSignal instanceof AbortSignal)) { await readyPromise; return false; }
  if (parentSignal.aborted) return true;
  const { promise: aborted, cancel } = abortRejectionPromise(parentSignal);
  try {
    await Promise.race([readyPromise, aborted]);
  } catch (err) {
    if (parentSignal.aborted) return true; // canceled during warmup
    throw err; // a real init failure still surfaces to the caller
  } finally {
    cancel();
  }
  return parentSignal.aborted;
}

function scheduleExploreCodeGraphPrewarm(cwd) {
  if (/^(?:1|true|on|yes)$/i.test(String(process.env.MIXDOG_DISABLE_EXPLORE_CODE_GRAPH_PREWARM || ''))) return;
  void import('../runtime/agent/orchestrator/tools/code-graph.mjs')
    .then((mod) => mod?.prewarmCodeGraphIfProject?.(cwd))
    .catch(() => { /* best-effort */ });
}

// Best-effort: warm the find/enumeration cache the explorer's turn-1 `find`
// will hit, in parallel with provider warmup. The export may not exist yet —
// tolerate its absence.
function scheduleExploreFindPrewarm(cwd) {
  void import('../runtime/agent/orchestrator/tools/builtin/list-tool.mjs')
    .then((mod) => mod?.prewarmFindEnumeration?.(cwd))
    .catch(() => { /* best-effort; export may not exist yet */ });
}

function getCachedExploreResult(key) {
  if (!exploreResultCacheEnabled()) return null;
  const entry = EXPLORE_RESULT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > EXPLORE_RESULT_CACHE_TTL_MS) {
    EXPLORE_RESULT_CACHE.delete(key);
    return null;
  }
  if (typeof entry.value === 'string') {
    EXPLORE_RESULT_CACHE.delete(key);
    EXPLORE_RESULT_CACHE.set(key, entry);
    return entry.value;
  }
  return null;
}

function trimExploreResultCache() {
  while (EXPLORE_RESULT_CACHE.size > EXPLORE_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = EXPLORE_RESULT_CACHE.keys().next().value;
    if (!oldest) break;
    EXPLORE_RESULT_CACHE.delete(oldest);
  }
}

// Start ONE shared, caller-agnostic compute for `key`. Its AbortController is
// driven ONLY by the wall-clock hard timeout (a shared deadline) and by the
// subscriber ref-count reaching zero (see subscribeToSharedCompute) — NEVER by a
// single subscriber's cancellation. So one caller canceling can neither abort
// the shared compute nor poison the OTHER subscribers. On success the pending
// entry is replaced by a value entry; on timeout/failure the entry is purged
// (identity-guarded) so a future call recomputes instead of awaiting a dead
// promise (which is exactly what surfaces later as an empty tool result).
function startSharedCompute(key, compute, timeoutMs = EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
  const controller = new AbortController();
  const entry = { ts: Date.now(), controller, subscribers: new Set(), promise: null };
  const disarm = armExploreHardTimeout(controller, timeoutMs);
  const { promise: aborted } = abortRejectionPromise(controller.signal);
  const computePromise = Promise.resolve().then(() => compute(controller.signal));
  entry.promise = Promise.race([computePromise, aborted])
    .then((value) => {
      // Identity-guard EVERY eventual write: only cache/purge when THIS entry is
      // still the live one. A hard-timeout TTL eviction (runExploreCached) may
      // have retired us and started a fresh compute; a late resolve from the
      // retired compute must NEVER overwrite that newer entry (stale overwrite).
      if (EXPLORE_RESULT_CACHE.get(key) !== entry) return value;
      const text = typeof value === 'string' ? value : responseText(value);
      const cleaned = cleanExplorerText(text);
      if (cleaned && cleaned !== 'EXPLORATION_FAILED') {
        EXPLORE_RESULT_CACHE.set(key, { ts: Date.now(), value: text });
        trimExploreResultCache();
      } else {
        EXPLORE_RESULT_CACHE.delete(key);
      }
      return value;
    })
    .catch((err) => {
      // Canceled / timed-out / failed shared compute: purge the pending entry
      // (only when it is still ours) so a later call recomputes fresh instead of
      // awaiting a dead promise that would surface as "no tool output".
      if (EXPLORE_RESULT_CACHE.get(key) === entry) EXPLORE_RESULT_CACHE.delete(key);
      throw err;
    })
    .finally(() => { disarm(); });
  EXPLORE_RESULT_CACHE.set(key, entry);
  return entry;
}

// Subscribe ONE caller (with its OWN signal) to a shared compute. The
// subscriber's await is raced against its own cancellation so a canceled caller
// is RELEASED IMMEDIATELY (never left waiting on the shared promise). When the
// LAST subscriber cancels, the shared compute is aborted and its entry purged;
// while any subscriber remains the shared compute keeps running for them, so one
// caller's cancellation never disturbs the unaffected subscribers.
function subscribeToSharedCompute(key, entry, subscriberSignal) {
  const token = {};
  entry.subscribers.add(token);
  return new Promise((resolve, reject) => {
    let done = false;
    const detach = () => {
      if (subscriberSignal instanceof AbortSignal) {
        try { subscriberSignal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      }
    };
    const settle = (fn, val) => {
      if (done) return;
      done = true;
      entry.subscribers.delete(token);
      detach();
      fn(val);
    };
    function onAbort() {
      const reason = subscriberSignal?.reason;
      const err = reason instanceof Error ? reason : new Error(String(reason ?? 'explore canceled'));
      settle(reject, err);
      if (entry.subscribers.size === 0) {
        // Last subscriber gone: tear the shared compute down and purge the entry
        // so a future call recomputes instead of reusing an abandoned promise.
        try { entry.controller.abort(err); } catch { /* ignore */ }
        if (EXPLORE_RESULT_CACHE.get(key) === entry) EXPLORE_RESULT_CACHE.delete(key);
      }
    }
    if (subscriberSignal instanceof AbortSignal) {
      if (subscriberSignal.aborted) { onAbort(); return; }
      subscriberSignal.addEventListener('abort', onAbort, { once: true });
    }
    entry.promise.then((v) => settle(resolve, v), (e) => settle(reject, e));
  });
}

export async function runExploreCached(key, compute, parentSignal = null, timeoutMs = EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
  const cached = getCachedExploreResult(key);
  if (cached !== null) return cached;
  if (!exploreResultCacheEnabled()) return await runExploreComputeWithAbort(compute, parentSignal);
  let entry = EXPLORE_RESULT_CACHE.get(key);
  if (entry?.promise
    && EXPLORE_COMPUTE_HARD_TIMEOUT_MS > 0
    && Date.now() - entry.ts > EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
    // A pending entry that outlived the hard timeout is wedged — ABORT its
    // compute (tearing down any in-flight child dispatch + provider call) and
    // drop it, then recompute rather than subscribe to a promise that may never
    // settle (which later surfaces as an empty "no tool output" result). The
    // abort + identity-guarded writes in startSharedCompute guarantee the
    // retired compute can never overwrite the fresh entry with a stale value.
    if (EXPLORE_RESULT_CACHE.get(key) === entry) EXPLORE_RESULT_CACHE.delete(key);
    try { entry.controller?.abort(new Error('explore pending entry evicted after hard timeout')); } catch { /* ignore */ }
    entry = null;
  }
  if (!entry?.promise) entry = startSharedCompute(key, compute, timeoutMs);
  return await subscribeToSharedCompute(key, entry, parentSignal);
}

function responseText(response) {
  if (typeof response === 'string') return response;
  const parts = Array.isArray(response?.content) ? response.content : [];
  const text = parts
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text || JSON.stringify(response, null, 2);
}

const ANCHOR_LINE_RE = /(?:^|\s)(?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+):\d+\b/;
const ANCHOR_PATH_CAPTURE_RE = /(?:^|\s)((?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+)):\d+\b/;
// Coordinate (path:line) capture used as the dedup key: the same anchor
// restated with different reason wording must collapse to one line.
const ANCHOR_COORD_CAPTURE_RE = /(?:^|\s)((?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+):\d+(?:-\d+)?)\b/;
// Path-only anchor: line starts with a path token (contains a separator) and
// is followed by a dash separator or end of line — the `path — reason` shape
// without a :line suffix. Keeps such answers while dropping prose narration.
const ANCHOR_PATHONLY_CAPTURE_RE = /^(\S+[\\/][^\s:]+)(?=\s+[—–-]|\s*$)/;
// Explorer self-count markers ("turn 1/3") belong on tool messages only;
// strip them defensively if they leak into the final answer.
const TURN_COUNTER_LINE_RE = /^turn\s+\d+\s*\/\s*\d+\b/i;
// Contract cap: anchor answers are max 3 lines per query; extra anchors are
// cost, not quality (rules/agent/30-explorer.md).
const EXPLORE_MAX_ANCHOR_LINES = 3;
const FAILED_RE = /\b(?:EXPLORATION_FAILED|exploration failed|no credible (?:anchor|location)|no relevant (?:anchor|location)|not found|could(?: not|n't) find)\b/i;

function normalizeExplorerLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

// Anchor existence filter: a locator answer citing a file that does not exist
// is a hallucination — drop the line. Only enforced when cwd is known.
function anchorLineExists(line, cwd, captureRe = ANCHOR_PATH_CAPTURE_RE) {
  const m = line.match(captureRe);
  if (!m) return true;
  const p = m[1].trim();
  try { return existsSync(isAbsolute(p) ? p : resolve(cwd, p)); } catch { return true; }
}

export function cleanExplorerText(text, cwd = null) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const anchors = [];
  const pathOnly = [];
  const passthrough = [];
  const seen = new Set();
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = normalizeExplorerLine(sourceLine);
    if (!line || /^-{3,}$/.test(line) || /^#+\s+/.test(line) || TURN_COUNTER_LINE_RE.test(line)) continue;
    if (/^EXPLORATION_FAILED\b/i.test(line)) return 'EXPLORATION_FAILED';
    const coord = line.match(ANCHOR_COORD_CAPTURE_RE)?.[1]
      ?? line.match(ANCHOR_PATHONLY_CAPTURE_RE)?.[1];
    const key = (coord ?? line).toLowerCase().replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    if (ANCHOR_LINE_RE.test(line)) anchors.push(line);
    else if (ANCHOR_PATHONLY_CAPTURE_RE.test(line)) pathOnly.push(line);
    else passthrough.push(sourceLine);
  }
  if (anchors.length) {
    const real = (cwd ? anchors.filter((l) => anchorLineExists(l, cwd)) : anchors)
      .slice(0, EXPLORE_MAX_ANCHOR_LINES);
    // All anchors pointed at nonexistent paths: fail harmlessly instead of
    // forwarding hallucinated locations.
    return real.length ? real.join('\n') : 'EXPLORATION_FAILED';
  }
  if (pathOnly.length) {
    const real = (cwd ? pathOnly.filter((l) => anchorLineExists(l, cwd, ANCHOR_PATHONLY_CAPTURE_RE)) : pathOnly)
      .slice(0, EXPLORE_MAX_ANCHOR_LINES);
    if (real.length) return real.join('\n');
    return 'EXPLORATION_FAILED';
  }
  if (FAILED_RE.test(raw)) return 'EXPLORATION_FAILED';
  return passthrough.join('\n').trim() || raw;
}

/**
 * Standalone explore executor.
 *
 * Dispatches the hidden `explorer` read-only filesystem role (one ephemeral
 * sub-session per query) via makeAgentDispatch — the same path recall/search-style
 * hidden roles use. Runs query items concurrently (Promise.allSettled), then
 * aggregates the findings into one bounded text result.
 *
 * Runs synchronously and returns the bounded locator result in this tool call.
 *
 * @param {object} args         — tool args ({ query, cwd }).
 * @param {object} ctx          — { callerCwd, callerSessionId }.
 */
export async function runExplore(args = {}, ctx = {}) {
  return runExploreSync(args, ctx);
}

async function runExploreSync(args = {}, ctx = {}) {
  const queries = normalizeExploreQueries(args.query);
  if (queries.length === 0) return fail('query is required (one or more non-empty strings)');

  // Already-canceled call: short-circuit BEFORE any provider warmup / dispatch
  // so a canceled explore never spins up child sub-sessions it must immediately
  // tear down (and never continues into a dead "no tool output" state).
  if (ctx.signal instanceof AbortSignal && ctx.signal.aborted) {
    return fail('explore canceled before dispatch');
  }

  let working = queries;
  let capNotice = '';
  if (working.length > MAX_FANOUT_QUERIES) {
    capNotice = `[capped ${working.length}->${MAX_FANOUT_QUERIES} queries]\n`;
    working = working.slice(0, MAX_FANOUT_QUERIES);
  }

  const resolvedCwd = resolveExploreCwd(args.cwd, ctx.callerCwd);
  scheduleExploreCodeGraphPrewarm(resolvedCwd);
  scheduleExploreFindPrewarm(resolvedCwd);
  const config = loadConfig();
  const route = resolveExploreRoute(config);
  const parentSignal = ctx.signal instanceof AbortSignal ? ctx.signal : null;
  if (parentSignal?.aborted) return fail('explore canceled before dispatch');
  // Turn budget is enforced BOTH ways: the prompt contract (rules/agent/
  // 30-explorer.md, "hard max 3 tool turns, expected 1") steers the model,
  // and maxLoopIterations mechanically backstops it — live traces showed
  // explorers overshooting to 4+ tool turns on compound queries despite the
  // prompt. At the cap the loop grants ONE tool-less final turn ("answer
  // with your best result from context"), so a capped explorer still emits
  // its anchors instead of an empty/failed result. The wall-clock hard
  // timeout (EXPLORE_COMPUTE_HARD_TIMEOUT_MS) remains the runaway guard.
  const llm = makeAgentDispatch({
    agent: 'explorer',
    cwd: resolvedCwd,
    brief: true,
    parentSessionId: ctx.callerSessionId || null,
    clientHostPid: ctx.clientHostPid || null,
    config,
    maxLoopIterations: EXPLORE_MAX_LOOP_ITERATIONS,
  });

  // Stagger cold sub-session launches so later subs reuse the first sub's
  // provider prompt-cache write. Index 0 fires immediately; a cached-result
  // query resolves without delay regardless of index.
  const stagger = working.length > 1 ? EXPLORE_FANOUT_STAGGER_MS : 0;
  // Caller cancellation (ESC / owner-session abort) cascades into every child
  // dispatch: the per-compute AbortController links this signal (and the hard
  // timeout) so aborting the explore tool call tears down all fan-out subs and
  // their provider calls at once.
  const settled = await Promise.allSettled(working.map((q, i) => {
    const key = exploreResultCacheKey({ cwd: resolvedCwd, route, query: q });
    return runExploreCached(key, async (computeSignal) => {
      // Provider initialization is part of the timed compute: a wedged init
      // must consume the same 60s wall-clock budget as dispatch, never block
      // runExplore before its hard-timeout AbortController has been armed.
      await ensureExploreProviderReady(config, route, computeSignal);
      // Interruptible stagger: if the compute signal aborts during the delay,
      // exploreStaggerDelay rejects and the (now-pointless) child dispatch is
      // never launched.
      const delay = (stagger > 0 && i > 0) ? exploreStaggerDelay(stagger, computeSignal) : null;
      return await (delay
        ? delay.then(() => llm({ prompt: buildExplorerPrompt(q), parentSignal: computeSignal }))
        : llm({ prompt: buildExplorerPrompt(q), parentSignal: computeSignal }));
    }, parentSignal);
  }));

  const fatal = fatalExploreError(settled);
  if (fatal) return fail(presentErrorText(fatal, { surface: 'explore' }));

  const merged = mergeSettled(settled, working, resolvedCwd);
  const allFailed = settled.every((r) => !settledExplorerResult(r, resolvedCwd).ok);
  const out = capNotice + merged;
  return allFailed ? fail(out) : ok(out);
}

// Test-only hook: inspect the explore result cache so cancellation/timeout
// regression tests can assert poisoned entries are purged. Not part of the
// runtime surface.
export function __exploreResultCacheForTest() {
  return EXPLORE_RESULT_CACHE;
}
