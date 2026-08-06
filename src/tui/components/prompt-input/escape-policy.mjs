export const PROMPT_ESCAPE_CLEAR_WINDOW_MS = 800;

/**
 * Claude Code-compatible chat Escape priority after overlays/selections have
 * already had a chance to consume the key:
 * active turn -> interrupt, idle queue -> restore for editing,
 * idle non-empty draft -> double-press clear, idle empty draft -> fallback.
 */
export function classifyPromptEscape({
  interruptActive = false,
  hasQueuedMessages = false,
  value = '',
  lastClearPressAt = 0,
  now = Date.now(),
} = {}) {
  if (interruptActive) return { action: 'interrupt', nextClearPressAt: 0 };
  if (hasQueuedMessages) return { action: 'restore-queue', nextClearPressAt: 0 };
  if (String(value ?? '') === '') return { action: 'idle', nextClearPressAt: 0 };

  const current = Number(now);
  const previous = Number(lastClearPressAt);
  const repeated = Number.isFinite(current)
    && Number.isFinite(previous)
    && previous > 0
    && current >= previous
    && current - previous <= PROMPT_ESCAPE_CLEAR_WINDOW_MS;
  return repeated
    ? { action: 'clear', nextClearPressAt: 0 }
    : { action: 'arm-clear', nextClearPressAt: Number.isFinite(current) && current > 0 ? current : 1 };
}
