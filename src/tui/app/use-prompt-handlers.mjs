/**
 * use-prompt-handlers.mjs — the PROMPT HANDLER cluster of the TUI App.
 *
 * Exports usePromptHandlers(), which owns the four handlers wired to
 * PromptInput: handlePromptPaste / handlePromptHistoryNavigate /
 * handlePromptEscape / handlePromptInterrupt. Every ref, setter, store value
 * and derived value the handlers close over is threaded in explicitly so the
 * deps arrays stay exact. Escape lives here; the other three are sub-hooks
 * under ./prompt-handlers/ (paste pipeline, history navigation, interrupt
 * restore), each with its pure decision module beside it.
 */
import { useCallback } from 'react';
import { PROMPT_ESCAPE_HINT_TIMEOUT_MS } from '../components/prompt-input/escape-policy.mjs';
import { usePromptHistoryNavigation } from './prompt-handlers/use-prompt-history-nav.mjs';
import { usePromptInterrupt } from './prompt-handlers/use-prompt-interrupt.mjs';
import { usePromptPaste } from './prompt-handlers/use-prompt-paste.mjs';

export function usePromptHandlers({
  store,
  state,
  // refs
  promptValueRef,
  promptHistoryNavRef,
  promptHistoryDraftChangeRef,
  // setters
  setPromptDraftOverride,
  surface,
  // derived / helper values + callbacks
  syncPromptLayoutRows,
  showPromptHint,
  clearPromptHint,
  recentPromptHistory,
  resetPromptHistoryNav,
  restoreQueuedToPrompt,
  openMessageSelector,
  usagePanel,
  closeUsagePanel,
  contextPanel,
  // paste-attachment helpers (owned by App, threaded in explicitly)
  installPastedImages,
  clearPastedImagesSnapshot,
  registerPastedImage,
  installPastedTexts,
  clearPastedTextsSnapshot,
  registerPastedText,
}) {
  const handlePromptPaste = usePromptPaste({ state, showPromptHint, registerPastedImage, registerPastedText });

  const handlePromptHistoryNavigate = usePromptHistoryNavigation({
    promptHistoryNavRef,
    promptHistoryDraftChangeRef,
    recentPromptHistory,
    resetPromptHistoryNav,
    clearPromptHint,
  });

  // ESC / Up handling (prompt input):
  // - prompt-local overlays such as the slash palette close first.
  // - active work is cancelled before queue/draft handling.
  // - idle non-empty text uses an "Esc again to clear" guard.
  // - idle empty input restores queued editable messages, and a double press
  //   opens the message selector (jump back to a previous prompt).
  const handlePromptEscape = useCallback(
    (text = '', meta = {}) => {
      if (usagePanel) {
        closeUsagePanel();
        return true;
      }
      // Esc from the prompt: this keypress owns the overlay it closes.
      if (contextPanel) {
        surface.claim().context(null);
        return true;
      }

      if (meta.phase === 'clear-arm') {
        showPromptHint('Esc again to clear', 'plain', PROMPT_ESCAPE_HINT_TIMEOUT_MS);
        return true;
      }
      if (meta.phase === 'select-arm') {
        showPromptHint('Esc again to pick a message', 'plain', PROMPT_ESCAPE_HINT_TIMEOUT_MS);
        return true;
      }
      if (meta.phase === 'select') {
        clearPromptHint();
        // Queue first: a stale queue projection must not let
        // the selector shadow an editable follow-up that is still waiting.
        if (restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText: text })) return true;
        return openMessageSelector?.() === true;
      }
      if (meta.phase === 'clear') {
        try {
          const remembered = store.rememberPromptHistory?.(text);
          if (remembered?.catch) void remembered.catch(() => {});
        } catch {
          /* best-effort history parity */
        }
        clearPastedImagesSnapshot();
        clearPastedTextsSnapshot();
        clearPromptHint();
        return false;
      }
      if (meta.phase === 'empty') {
        return restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText: text });
      }
      // Idle + empty + no transcript to jump back into: nothing to do.
      return false;
    },
    [
      contextPanel,
      surface,
      usagePanel,
      closeUsagePanel,
      restoreQueuedToPrompt,
      openMessageSelector,
      showPromptHint,
      clearPromptHint,
      clearPastedImagesSnapshot,
      clearPastedTextsSnapshot,
      store,
    ]
  );

  const handlePromptInterrupt = usePromptInterrupt({
    store,
    busy: state.busy,
    promptValueRef,
    installPastedImages,
    installPastedTexts,
    clearPastedImagesSnapshot,
    clearPastedTextsSnapshot,
    clearPromptHint,
    syncPromptLayoutRows,
    setPromptDraftOverride,
  });

  return {
    handlePromptPaste,
    handlePromptHistoryNavigate,
    handlePromptEscape,
    handlePromptInterrupt,
  };
}
