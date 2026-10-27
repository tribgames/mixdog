// idle-auto-clear-gate.mjs — the idle auto-clear predicate, shared by the
// submit gate (tui/session/session-flow/auto-clear.mjs); the cache warmer
// (agent/orchestrator/session/cache-warm.mjs) registers its successful warms,
// which count as cache use (sessionActivityTimestamp). A thread is cleared before
// a submit when auto-clear is on, it has been idle for at least the window
// since its activity timestamp, and its context is not below the minimum
// share of the compaction trigger.
import { attachmentTextForPart, isAttachmentReference } from '../attachments/store.mjs';

export function promptContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return isAttachmentReference(part) ? attachmentTextForPart(part) : part.text || '';
        if (part?.type === 'image') return '[Image]';
        if (part?.type === 'file') return '[File]';
        return part?.text || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

function timestampMs(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasModelVisibleConversation(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
    const text = promptContentText(message.content).trim();
    if (role === 'user' && text.startsWith('<system-reminder>')) return false;
    if (role === 'assistant' && text === '.' && !Array.isArray(message.toolCalls)) return false;
    return !!text || role === 'assistant' || role === 'tool';
  });
}

// A session's last successful cache-warm use (a read with no write),
// registered by the warmer (cache-warm.mjs, from its durable touch store):
// `{ at, provider, model, accountId }` — when, and the route and account whose
// cached prefix it read — or a bare epoch-ms time; null/0 when none.
let lastCacheWarmUse = () => null;

/** Register the source of a session's last successful cache-warm use
 *  (`(sessionId) => { at, provider, model, accountId } | epoch ms | null`);
 *  null restores none. */
export function setCacheWarmUseSource(source) {
  lastCacheWarmUse = typeof source === 'function' ? source : () => null;
}

/** When a successful cache warm last used the session's prompt cache (epoch
 *  ms), or 0: the warm read and refreshed the cached prefix without moving
 *  any of the session's own timestamps. */
export function lastCacheWarmUseAt(sessionId) {
  const use = sessionId ? lastCacheWarmUse(sessionId) : null;
  return timestampMs(use && typeof use === 'object' ? use.at : use);
}

/** When a successful cache warm last used the prefix a request on `provider`
 *  / `model` / `accountId` reads (epoch ms), or 0: a warm on another route or
 *  account refreshed an entry this request cannot read, and a use without a
 *  recorded identity matches nothing. */
export function cacheWarmUseFor(sessionId, { provider, model, accountId = '' } = {}) {
  const use = sessionId ? lastCacheWarmUse(sessionId) : null;
  if (!use || typeof use !== 'object' || !use.provider) return 0;
  const matches =
    use.provider === provider && use.model === model && String(use.accountId || '') === String(accountId || '');
  return matches ? timestampMs(use.at) : 0;
}

/**
 * When the session was last active (0: no model-visible conversation): the
 * latest of its own activity and the last successful cache warm. Idleness is
 * measured from the last time the cached prompt was actually used, and a warm
 * that read the cache without writing used it; the session's own timestamps
 * are never moved.
 */
export function sessionActivityTimestamp(session, fallback = 0) {
  if (!hasModelVisibleConversation(session)) return 0;
  const own = timestampMs(session?.lastUsedAt) || timestampMs(session?.updatedAt) || timestampMs(fallback);
  return Math.max(own, lastCacheWarmUseAt(session?.id));
}

// A zero is often an unavailable/stale meter field, not an authoritative
// measurement. Do not let it mask the sibling live estimate.
function contextUsageBelowThreshold(runtime, minContextPercent) {
  if (!(minContextPercent > 0)) return false;
  const status = runtime.contextStatus?.() || null;
  const usedTokens = Math.max(
    0,
    Number(status?.usedTokens) || 0,
    Number(status?.currentEstimatedTokens) || 0,
    Number(status?.compaction?.currentEstimatedTokens) || 0
  );
  const triggerTokens = Number(
    status?.compaction?.triggerTokens ||
      status?.compaction?.autoCompactTokenLimit ||
      runtime.session?.autoCompactTokenLimit ||
      0
  );
  if (!Number.isFinite(usedTokens) || !Number.isFinite(triggerTokens) || !(usedTokens > 0 && triggerTokens > 0)) {
    return true;
  }
  return (usedTokens / triggerTokens) * 100 < minContextPercent;
}

/**
 * Whether the idle gate clears the thread before a submit at `at`: `cfg` is
 * the auto-clear state (`enabled`, `idleMs`, `minContextPercent`), the
 * activity is `activityAt` (sessionActivityTimestamp) and `runtime` answers
 * `contextStatus()` for the thread. The submit gate adds its own transient
 * conditions (busy, queued input, a clear already running).
 */
export function idleAutoClearDue({ cfg, activityAt, at, runtime }) {
  if (!cfg?.enabled || !activityAt || at - activityAt < cfg.idleMs) return false;
  return !contextUsageBelowThreshold(runtime, Number(cfg.minContextPercent ?? 10));
}
