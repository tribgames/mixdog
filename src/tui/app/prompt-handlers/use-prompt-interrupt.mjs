// prompt-handlers/use-prompt-interrupt.mjs
// handlePromptInterrupt: Esc interrupts the active turn but never resurrects
// the submitted prompt on its own — the engine decides (result.restoreText)
// and the prompt only restores into an EMPTY draft. An async abort that
// settles while the turn is still busy parks its restore until idle; a newer
// interrupt (generation) invalidates anything parked before it.
import { useCallback, useEffect, useRef } from 'react';
import { promptInterruptRestoreText } from '../../components/prompt-input/interrupt-policy.mjs';

export function usePromptInterrupt({
  store,
  busy,
  promptValueRef,
  installPastedImages,
  installPastedTexts,
  clearPastedImagesSnapshot,
  clearPastedTextsSnapshot,
  clearPromptHint,
  syncPromptLayoutRows,
  setPromptDraftOverride,
}) {
  const generationRef = useRef(0);
  const pendingRestoreRef = useRef(null);

  const restoreAttachments = useCallback(
    (result) => {
      if (result?.pastedImages) installPastedImages(result.pastedImages, { merge: true });
      if (result?.pastedTexts) installPastedTexts(result.pastedTexts, { merge: true });
    },
    [installPastedImages, installPastedTexts]
  );

  /** True once the parked restore is settled (applied or obsolete); false
   *  while the turn is still busy and it must stay parked. */
  const commitAsyncRestore = useCallback(
    (pending) => {
      if (!pending || pending.generation !== generationRef.current) return true;
      if (store.getState?.().busy) return false;
      const restoreText = promptInterruptRestoreText(pending.result, promptValueRef.current);
      if (!restoreText) return true;
      restoreAttachments(pending.result);
      clearPromptHint();
      syncPromptLayoutRows(restoreText);
      setPromptDraftOverride({ id: Date.now(), value: restoreText });
      return true;
    },
    [store, promptValueRef, restoreAttachments, clearPromptHint, syncPromptLayoutRows, setPromptDraftOverride]
  );

  useEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending) return;
    if (commitAsyncRestore(pending)) pendingRestoreRef.current = null;
  }, [busy, commitAsyncRestore]);

  return useCallback(
    (currentText = '') => {
      const generation = ++generationRef.current;
      pendingRestoreRef.current = null;
      const applyResult = (result, draftText, asyncResult = false) => {
        if (generation !== generationRef.current || result?.aborted === false) return undefined;
        if (result?.discardPastedImages) clearPastedImagesSnapshot(result.discardPastedImages);
        if (result?.discardPastedTexts) clearPastedTextsSnapshot(result.discardPastedTexts);
        if (asyncResult) {
          const pending = { generation, result };
          if (!commitAsyncRestore(pending)) pendingRestoreRef.current = pending;
          return undefined;
        }
        const restoreText = promptInterruptRestoreText(result, draftText);
        if (!restoreText) return undefined;
        restoreAttachments(result);
        clearPromptHint();
        return restoreText;
      };

      let result;
      try {
        const options = { restorePrompt: false };
        result = typeof store.abortAsync === 'function' ? store.abortAsync(options) : store.abort?.(options);
      } catch (error) {
        store.pushNotice?.(`interrupt failed: ${error?.message || error}`, 'error');
        return undefined;
      }
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result)
          .then((resolved) => applyResult(resolved, promptValueRef.current, true))
          .catch((error) => store.pushNotice?.(`interrupt failed: ${error?.message || error}`, 'error'));
        return undefined;
      }
      return applyResult(result, currentText, false);
    },
    [
      store,
      promptValueRef,
      commitAsyncRestore,
      restoreAttachments,
      clearPromptHint,
      clearPastedImagesSnapshot,
      clearPastedTextsSnapshot,
    ]
  );
}
