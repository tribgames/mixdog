// Exit + queued-prompt/history plumbing: the clean
// two-phase exit (final frame flush, store dispose race, hard-exit timer),
// queued-message restore into the draft, the engine-published prompt
// history with its local-scan fallback, and history-nav reset.
// The restore flow itself lives in use-prompt-queue-history/restore-to-prompt.mjs
// and the local history scan in use-prompt-queue-history/prompt-history.mjs;
// this file owns the hooks and their dependencies.
import { useCallback, useMemo, useRef } from 'react';
import { scanPromptHistory } from './use-prompt-queue-history/prompt-history.mjs';
import { runRestoreQueuedToPrompt } from './use-prompt-queue-history/restore-to-prompt.mjs';

export function usePromptQueueHistory({
  store,
  state,
  exit,
  exitRequestedRef,
  setExiting,
  promptValueRef,
  promptDraft,
  showPromptHint,
  clearPromptHint,
  installPastedImages,
  installPastedTexts,
  syncPromptLayoutRows,
  setPromptDraftOverride,
  promptHistoryNavRef,
}) {
  const queuedRestoreInFlightRef = useRef(false);

  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    setExiting(true);
    const hardExitTimer = setTimeout(() => {
      try {
        process.stdout.write('\x1b[?25h\x1b[0m');
      } catch {}
      process.exit(0);
    }, 2000);
    hardExitTimer.unref?.();
    setTimeout(() => {
      let timer = null;
      Promise.race([
        Promise.resolve(store.dispose?.('cli-react-exit', { detach: true })),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 350);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        exit();
      });
    }, 60);
  }, [store, exit]);

  const restoreQueuedToPrompt = useCallback(
    (options = {}) =>
      runRestoreQueuedToPrompt(options, {
        store,
        queued: state?.queued,
        promptDraft,
        promptValueRef,
        inFlightRef: queuedRestoreInFlightRef,
        showPromptHint,
        clearPromptHint,
        installPastedImages,
        installPastedTexts,
        syncPromptLayoutRows,
        setPromptDraftOverride,
      }),
    [
      store,
      state?.queued,
      promptDraft,
      showPromptHint,
      clearPromptHint,
      installPastedImages,
      installPastedTexts,
      setPromptDraftOverride,
      syncPromptLayoutRows,
    ]
  );

  const recentPromptHistory = useMemo(() => {
    // The engine maintains this list incrementally (rebuilt only when a user
    // item is appended or the transcript is bulk-swapped), so App no longer
    // rescans all items on every transcript change. Fall back to a local scan
    // only if the engine did not publish it (older snapshot).
    if (Array.isArray(state.promptHistoryList)) return state.promptHistoryList;
    return scanPromptHistory(Array.isArray(state.items) ? state.items : []);
  }, [state.promptHistoryList, state.items]);

  const resetPromptHistoryNav = useCallback(() => {
    promptHistoryNavRef.current = { active: false, index: -1, seed: '', lastValue: '' };
  }, []);

  return { requestExit, restoreQueuedToPrompt, recentPromptHistory, resetPromptHistoryNav };
}
