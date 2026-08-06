// Exit + queued-prompt/history plumbing, extracted from App.jsx: the clean
// two-phase exit (final frame flush, store dispose race, hard-exit timer),
// queued-message restore into the draft, the engine-published prompt
// history with its local-scan fallback, and history-nav reset.
import { useCallback, useMemo } from 'react';
import { PROMPT_HISTORY_LIMIT } from './transcript-window.mjs';
import { promptHistoryKey } from './app-format.mjs';

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
  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    setExiting(true);
    const hardExitTimer = setTimeout(() => {
      try { process.stdout.write('\x1b[?25h\x1b[0m'); } catch {}
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

  const restoreQueuedToPrompt = useCallback((options = {}) => {
    const restoreDraft = options.restoreDraft !== false;
    const showHint = options.showHint !== false;
    const currentText = options.currentText ?? promptValueRef.current ?? promptDraft;
    const apply = (restored) => {
      if (!restored || restored.count === 0) {
        if (showHint) showPromptHint('No queued messages to restore.', 'info');
        return false;
      }
      if (restoreDraft) {
        if (restored.pastedImages) installPastedImages(restored.pastedImages, { merge: true });
        if (restored.pastedTexts) installPastedTexts(restored.pastedTexts, { merge: true });
        syncPromptLayoutRows(restored.text);
        setPromptDraftOverride({ id: Date.now(), value: restored.text });
      }
      if (showHint) {
        showPromptHint(`restored ${restored.count} queued message${restored.count === 1 ? '' : 's'}`, 'info');
      } else {
        clearPromptHint();
      }
      return true;
    };
    const restored = store.restoreQueued?.(currentText);
    // A daemon-backed store answers this as an ASYNC remote call, so the
    // payload (and with it the queued text) only exists a tick later. Reading
    // `.count`/`.text` off the promise dropped the popped entries on the floor —
    // the queued message vanished instead of returning to the draft. Decide the
    // synchronous verdict from the published queue and fill the draft on settle.
    if (restored && typeof restored.then === 'function') {
      const queuedCount = Array.isArray(state?.queued) ? state.queued.length : 0;
      void Promise.resolve(restored).then(apply).catch(() => {
        if (showHint) showPromptHint('Could not restore queued messages.', 'error');
      });
      return queuedCount > 0;
    }
    return apply(restored);
  }, [store, state?.queued, promptDraft, showPromptHint, clearPromptHint, installPastedImages, installPastedTexts, setPromptDraftOverride, syncPromptLayoutRows]);

  const recentPromptHistory = useMemo(() => {
    // The engine maintains this list incrementally (rebuilt only when a user
    // item is appended or the transcript is bulk-swapped), so App no longer
    // rescans all items on every transcript change. Fall back to a local scan
    // only if the engine did not publish it (older snapshot).
    if (Array.isArray(state.promptHistoryList)) return state.promptHistoryList;
    const items = Array.isArray(state.items) ? state.items : [];
    const seen = new Set();
    const history = [];
    for (let i = items.length - 1; i >= 0 && history.length < PROMPT_HISTORY_LIMIT; i -= 1) {
      const item = items[i];
      if (item?.kind !== 'user') continue;
      const text = String(item.text || '').trim();
      const key = promptHistoryKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      history.push(text);
    }
    return history;
  }, [state.promptHistoryList, state.items]);

  const resetPromptHistoryNav = useCallback(() => {
    promptHistoryNavRef.current = { active: false, index: -1, seed: '', lastValue: '' };
  }, []);

  return { requestExit, restoreQueuedToPrompt, recentPromptHistory, resetPromptHistoryNav };
}
