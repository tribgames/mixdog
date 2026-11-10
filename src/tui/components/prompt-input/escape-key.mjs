/*
 * components/prompt-input/escape-key.mjs — Escape handling for PromptInput.
 *
 * Every path ends the key event; the caller returns right after invoking it.
 */
import { clearSelection, selectionRange } from '../../input-editing.mjs';
import { classifyPromptEscape } from './escape-policy.mjs';

export function handleEscapeKey(ctx) {
  const {
    draftRef,
    commitDraft,
    commandPaletteOpen,
    onCommandPaletteCancel,
    onEscape,
    onInterrupt,
    interruptActive,
    hasQueuedMessages,
    hasMessages,
    escapeClearAtRef,
    restoreQueuedToDraft,
  } = ctx;
  if (commandPaletteOpen) {
    onCommandPaletteCancel?.(draftRef.current.value);
    return;
  }
  if (selectionRange(draftRef.current)) {
    commitDraft(clearSelection(draftRef.current));
    return;
  }
  const currentValue = draftRef.current.value;
  if (onEscape?.(currentValue, { phase: 'before' }) === true) {
    return;
  }
  let escapeDecision = classifyPromptEscape({
    interruptActive,
    hasQueuedMessages,
    hasMessages,
    value: currentValue,
    lastClearPressAt: escapeClearAtRef.current,
  });
  if (escapeDecision.action === 'restore-queue') {
    if (restoreQueuedToDraft()) {
      escapeClearAtRef.current = 0;
      return;
    }
    // A stale projected queue can empty between render and key handling.
    // Fall through to the normal draft/idle action in that case.
    escapeDecision = classifyPromptEscape({
      interruptActive,
      hasMessages,
      value: currentValue,
      lastClearPressAt: escapeClearAtRef.current,
    });
  }
  escapeClearAtRef.current = escapeDecision.nextClearPressAt;
  // Active work always wins, even if the user has already typed a steering
  // draft. The draft is preserved; the old submitted prompt is restored only
  // when this box is still empty after cancellation.
  if (escapeDecision.action === 'interrupt') {
    const restoredText = onInterrupt?.(currentValue);
    if (!currentValue && typeof restoredText === 'string') {
      commitDraft({ value: restoredText, cursor: restoredText.length, selectionAnchor: null });
    }
    return;
  }
  if (escapeDecision.action === 'arm-clear') {
    onEscape?.(currentValue, { phase: 'clear-arm' });
    return;
  }
  if (escapeDecision.action === 'clear') {
    onEscape?.(currentValue, { phase: 'clear' });
    commitDraft({ value: '', cursor: 0, selectionAnchor: null });
    return;
  }
  // Empty draft + conversation history: first press arms, the second
  // opens the message selector.
  if (escapeDecision.action === 'arm-select') {
    onEscape?.('', { phase: 'select-arm' });
    return;
  }
  if (escapeDecision.action === 'message-selector') {
    onEscape?.('', { phase: 'select' });
    return;
  }
  onEscape?.('', { phase: 'empty' });
}
