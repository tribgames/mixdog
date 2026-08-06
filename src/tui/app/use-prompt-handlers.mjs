/**
 * use-prompt-handlers.mjs — the PROMPT HANDLER cluster extracted from App.jsx
 * (pass-7 split).
 *
 * Exports usePromptHandlers(), which owns the four useCallback handlers wired to
 * PromptInput: handlePromptPaste / handlePromptHistoryNavigate / handlePromptEscape
 * / handlePromptInterrupt. Every ref, setter, store value and derived value the
 * handlers close over is threaded in explicitly so the deps arrays stay
 * byte-identical to the original inline hooks. Import-level helpers (paste
 * attachments) are imported directly here.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  readClipboardImageAttachment,
  readClipboardText,
  readImageAttachmentFromPath,
  splitPastedImagePathCandidates,
} from '../paste-attachments.mjs';
import {
  shouldFoldPastedText,
} from '../paste-attachments.mjs';
import { promptHistoryKey } from '../prompt-history-store.mjs';
import { promptInterruptRestoreText } from '../components/prompt-input/interrupt-policy.mjs';
import { PROMPT_ESCAPE_CLEAR_WINDOW_MS } from '../components/prompt-input/escape-policy.mjs';

export function usePromptHandlers({
  store,
  state,
  // refs
  promptValueRef,
  pastedImagesRef,
  nextPastedImageIdRef,
  pastedTextsRef,
  nextPastedTextIdRef,
  promptHistoryNavRef,
  promptHistoryDraftChangeRef,
  // setters
  setPastedImages,
  setPastedTexts,
  setPromptDraftOverride,
  setContextPanel,
  // derived / helper values + callbacks
  syncPromptLayoutRows,
  showPromptHint,
  clearPromptHint,
  recentPromptHistory,
  resetPromptHistoryNav,
  restoreQueuedToPrompt,
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
  const interruptGenerationRef = useRef(0);
  const pendingInterruptRestoreRef = useRef(null);
  const handlePromptPaste = useCallback((text, meta = {}) => {
    const source = String(meta?.source || 'paste');
    const value = String(text ?? '');
    // Fold-or-insert text pipeline shared by bracketed paste and the Ctrl+V text
    // path. returnRaw=true makes the "insert raw" case return the string itself
    // (needed by the clipboard-text path, whose outer `text` is empty so the
    // handleExternalPaste fallback would insert nothing).
    const processText = (raw, returnRaw = false) => {
      const chunks = splitPastedImagePathCandidates(raw);
      const hasImagePath = chunks.some((chunk) => chunk.imagePath);
      // No image paths: fold the whole text into a token when large, otherwise
      // insert it raw (return undefined → PromptInput inserts, or the string).
      if (!hasImagePath) {
        if (shouldFoldPastedText(raw)) return registerPastedText(raw);
        return returnRaw ? raw : undefined;
      }
      // Mixed paste: resolve each image chunk to an image ref, then fold each
      // CONTIGUOUS run of non-image text into its own token (only if over
      // threshold) so content order around image refs is preserved. '\n'
      // separator chunks are plain text and stay inside their surrounding run.
      return Promise.all(chunks.map(async (chunk) => {
      if (!chunk.imagePath) return chunk.text;
      try {
        const image = await readImageAttachmentFromPath(chunk.text, state.cwd || process.cwd());
        if (!image) return chunk.text;
        const ref = registerPastedImage(image);
        showPromptHint(`attached ${image.filename || 'image'}`, 'plain');
        return ref;
      } catch (e) {
        showPromptHint(`image attach failed: ${e?.message || e}`, 'warn');
        return chunk.text;
      }
    })).then((parts) => {
      let out = '';
      let run = '';
      const flushRun = () => {
        if (!run) return;
        out += shouldFoldPastedText(run) ? registerPastedText(run) : run;
        run = '';
      };
      for (let i = 0; i < chunks.length; i += 1) {
        if (chunks[i].imagePath) {
          flushRun();
          out += parts[i];
        } else {
          run += parts[i];
        }
      }
      flushRun();
      return out;
    });
    };

    // Ctrl+V / Meta+V: clipboard.read() model. Prefer OS-clipboard TEXT
    // (routed through the SAME fold pipeline as bracketed paste); when the
    // clipboard holds no text, fall back to the image-attachment path. The async
    // read result is applied by handleExternalPaste under its pasteGeneration
    // staleness guard, so a stale resolve is dropped.
    if (source === 'clipboard-shortcut' && !value) {
      return readClipboardText()
        .then((clip) => {
          const normalized = String(clip ?? '').replace(/\r\n?/g, '\n');
          if (normalized) return processText(normalized, true);
          return readClipboardImageAttachment()
            .then((image) => {
              if (!image) {
                showPromptHint('no text or image found on clipboard', 'plain');
                return false;
              }
              const ref = registerPastedImage(image);
              showPromptHint(`attached ${image.filename || 'clipboard image'}`, 'plain');
              return ref;
            });
        })
        .catch((e) => {
          showPromptHint(`paste failed: ${e?.message || e}`, 'warn');
          return false;
        });
    }

    return processText(value);
  }, [registerPastedImage, registerPastedText, showPromptHint, state.cwd]);

  const handlePromptHistoryNavigate = useCallback((direction, currentText = '', meta = {}) => {
    const currentValue = String(currentText || '');
    const currentKey = promptHistoryKey(currentValue);
    const nav = promptHistoryNavRef.current || { active: false, index: -1, seed: '', lastValue: '' };

    if (meta.emptyDraft && direction === 'down') {
      resetPromptHistoryNav();
      clearPromptHint();
      return undefined;
    }

    if (recentPromptHistory.length === 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      return undefined;
    }

    if (direction === 'down' && !nav.active) {
      clearPromptHint();
      return undefined;
    }

    const active = nav.active && (currentValue === nav.lastValue || currentValue === nav.seed);
    const seed = active ? nav.seed : currentValue;
    const step = direction === 'down' ? -1 : 1;
    let nextIndex = (active ? nav.index : -1) + step;

    if (nextIndex < 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      promptHistoryDraftChangeRef.current = true;
      return seed;
    }

    while (nextIndex >= 0 && nextIndex < recentPromptHistory.length && promptHistoryKey(recentPromptHistory[nextIndex]) === currentKey) {
      nextIndex += step;
    }

    if (nextIndex < 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      promptHistoryDraftChangeRef.current = true;
      return seed;
    }

    if (nextIndex >= recentPromptHistory.length) {
      clearPromptHint();
      return undefined;
    }

    const nextValue = recentPromptHistory[nextIndex];
    promptHistoryNavRef.current = { active: true, index: nextIndex, seed, lastValue: nextValue };
    clearPromptHint();
    promptHistoryDraftChangeRef.current = true;
    return nextValue;
  }, [recentPromptHistory, resetPromptHistoryNav, clearPromptHint]);

  // ESC / Up handling (prompt input):
  // - prompt-local overlays such as the slash palette close first.
  // - active work is cancelled before queue/draft handling.
  // - idle non-empty text uses Claude Code's "Esc again to clear" guard.
  // - idle empty input restores queued editable messages.
  const handlePromptEscape = useCallback((text = '', meta = {}) => {
    if (usagePanel) { closeUsagePanel(); return true; }
    if (contextPanel) { setContextPanel(null); return true; }

    if (meta.phase === 'clear-arm') {
      showPromptHint('Esc again to clear', 'plain', PROMPT_ESCAPE_CLEAR_WINDOW_MS);
      return true;
    }
    if (meta.phase === 'clear') {
      try {
        const remembered = store.rememberPromptHistory?.(text);
        if (remembered?.catch) void remembered.catch(() => {});
      } catch { /* best-effort history parity */ }
      clearPastedImagesSnapshot();
      clearPastedTextsSnapshot();
      clearPromptHint();
      return false;
    }
    if (meta.phase === 'empty') {
      return restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText: text });
    }
    // Idle + empty + nothing to restore: nothing (double-press from empty
    // opens message selector, but we don't have that feature yet).
    return false;
  }, [contextPanel, usagePanel, closeUsagePanel, restoreQueuedToPrompt, showPromptHint, clearPromptHint, clearPastedImagesSnapshot, clearPastedTextsSnapshot, store]);

  const commitAsyncInterruptRestore = useCallback((pending) => {
    if (!pending || pending.generation !== interruptGenerationRef.current) return true;
    if (store.getState?.().busy) return false;
    const restoreText = promptInterruptRestoreText(pending.result, promptValueRef.current);
    if (!restoreText) return true;
    if (pending.result?.pastedImages) installPastedImages(pending.result.pastedImages, { merge: true });
    if (pending.result?.pastedTexts) installPastedTexts(pending.result.pastedTexts, { merge: true });
    clearPromptHint();
    syncPromptLayoutRows(restoreText);
    setPromptDraftOverride({ id: Date.now(), value: restoreText });
    return true;
  }, [store, promptValueRef, installPastedImages, installPastedTexts, clearPromptHint, syncPromptLayoutRows, setPromptDraftOverride]);

  useEffect(() => {
    const pending = pendingInterruptRestoreRef.current;
    if (!pending) return;
    if (commitAsyncInterruptRestore(pending)) pendingInterruptRestoreRef.current = null;
  }, [state.busy, commitAsyncInterruptRestore]);

  const handlePromptInterrupt = useCallback((currentText = '') => {
    const generation = ++interruptGenerationRef.current;
    pendingInterruptRestoreRef.current = null;
    const applyResult = (result, draftText, asyncResult = false) => {
      if (generation !== interruptGenerationRef.current || result?.aborted === false) return undefined;
      if (result?.discardPastedImages) clearPastedImagesSnapshot(result.discardPastedImages);
      if (result?.discardPastedTexts) clearPastedTextsSnapshot(result.discardPastedTexts);
      if (asyncResult) {
        const pending = { generation, result };
        if (!commitAsyncInterruptRestore(pending)) pendingInterruptRestoreRef.current = pending;
        return undefined;
      }
      const restoreText = promptInterruptRestoreText(result, draftText);
      if (!restoreText) return undefined;
      if (result?.pastedImages) installPastedImages(result.pastedImages, { merge: true });
      if (result?.pastedTexts) installPastedTexts(result.pastedTexts, { merge: true });
      clearPromptHint();
      return restoreText;
    };

    let result;
    try {
      const options = { restorePrompt: String(currentText ?? '') === '' };
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
  }, [store, commitAsyncInterruptRestore, clearPromptHint, installPastedImages, installPastedTexts, clearPastedImagesSnapshot, clearPastedTextsSnapshot]);

  return {
    handlePromptPaste,
    handlePromptHistoryNavigate,
    handlePromptEscape,
    handlePromptInterrupt,
  };
}
