export const PROMPT_ESCAPE_CLEAR_WINDOW_MS = 800;
export const PROMPT_ESCAPE_HINT_TIMEOUT_MS = 1000;

/**
 * Claude Code-compatible chat Escape priority after overlays have already had
 * a chance to consume the key:
 * active turn -> interrupt immediately, selected draft -> collapse selection,
 * then (while idle) queued editable messages -> restore for editing, idle
 * non-empty draft -> double-press clear, idle empty draft with history ->
 * double-press message selector, otherwise fallback.
 */
export function classifyPromptEscape({
  interruptActive = false,
  hasSelection = false,
  hasQueuedMessages = false,
  hasMessages = false,
  value = '',
  lastClearPressAt = 0,
  now = Date.now(),
} = {}) {
  if (interruptActive) return { action: 'interrupt', nextClearPressAt: 0 };
  if (hasSelection) return { action: 'collapse-selection', nextClearPressAt: 0 };
  if (hasQueuedMessages) return { action: 'restore-queue', nextClearPressAt: 0 };

  const current = Number(now);
  const previous = Number(lastClearPressAt);
  const repeated = Number.isFinite(current)
    && Number.isFinite(previous)
    && previous > 0
    && current >= previous
    && current - previous <= PROMPT_ESCAPE_CLEAR_WINDOW_MS;
  const armed = Number.isFinite(current) && current > 0 ? current : 1;

  // Empty draft: Claude Code's double-press opens the message selector so a
  // previous prompt can be pulled back into the box (nothing to clear here).
  if (String(value ?? '') === '') {
    if (!hasMessages) return { action: 'idle', nextClearPressAt: 0 };
    return repeated
      ? { action: 'message-selector', nextClearPressAt: 0 }
      : { action: 'arm-select', nextClearPressAt: armed };
  }

  return repeated
    ? { action: 'clear', nextClearPressAt: 0 }
    : { action: 'arm-clear', nextClearPressAt: armed };
}
