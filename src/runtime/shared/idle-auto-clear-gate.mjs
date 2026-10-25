// idle-auto-clear-gate.mjs — the idle auto-clear predicate, shared by the
// submit gate (tui/session/session-flow/auto-clear.mjs) and the cache warmer
// (agent/orchestrator/session/cache-warm.mjs), which must not keep a prefix
// warm that the gate will compact at the due turn. A thread is cleared before
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

/** When the session was last active (0: no model-visible conversation). */
export function sessionActivityTimestamp(session, fallback = 0) {
  if (!hasModelVisibleConversation(session)) return 0;
  return timestampMs(session?.lastUsedAt) || timestampMs(session?.updatedAt) || timestampMs(fallback);
}

// A zero is often an unavailable/stale meter field, not an authoritative
// measurement. Do not let it mask the sibling live estimate.
export function contextUsageBelowThreshold(runtime, minContextPercent) {
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

/**
 * From when the idle gate clears the thread before a submit (epoch ms), with
 * the same arguments as idleAutoClearDue less `at`; null when it never does
 * while the thread stays idle (auto-clear off, no activity yet, or a context
 * below the minimum share — idling moves neither). An unlimited window
 * resolves to a deadline no clock reaches.
 */
export function idleAutoClearDeadline({ cfg, activityAt, runtime }) {
  if (!cfg?.enabled || !activityAt) return null;
  const at = activityAt + Number(cfg.idleMs);
  return idleAutoClearDue({ cfg, activityAt, at, runtime }) ? at : null;
}
