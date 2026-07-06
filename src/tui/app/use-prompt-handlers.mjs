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
import { useCallback } from 'react';
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

    // Ctrl+V / Meta+V: opencode clipboard.read() model. Prefer OS-clipboard TEXT
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
  // - queued editable messages pop back into the prompt before clear/interrupt.
  // - non-empty prompt text is cleared by PromptInput and must never interrupt
  //   the active turn on the same Esc press.
  // - empty prompt + active turn interrupts the active turn.
  const handlePromptEscape = useCallback((text = '', meta = {}) => {
    if (usagePanel) { closeUsagePanel(); return true; }
    if (contextPanel) { setContextPanel(null); return true; }

    if (meta.phase === 'clear') {
      clearPastedImagesSnapshot();
      clearPromptHint();
      return false;
    }
    if (meta.phase === 'empty') {
      return restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText: text });
    }
    // Idle + empty + nothing to restore: nothing (double-press from empty
    // opens message selector, but we don't have that feature yet).
    return false;
  }, [contextPanel, usagePanel, closeUsagePanel, restoreQueuedToPrompt, clearPromptHint, clearPastedImagesSnapshot, store]);

  const handlePromptInterrupt = useCallback((currentText = '') => {
    const result = store.abort?.();
    if (result?.aborted === false) return undefined;
    if (result?.pastedImages) installPastedImages(result.pastedImages, { merge: true });
    if (result?.discardPastedImages) clearPastedImagesSnapshot(result.discardPastedImages);
    if (result?.pastedTexts) installPastedTexts(result.pastedTexts, { merge: true });
    if (result?.discardPastedTexts) clearPastedTextsSnapshot(result.discardPastedTexts);
    const restoreText = String(result?.restoreText || '').trim();
    if (!restoreText) return undefined;
    const existingText = String(currentText || '').trim();
    const nextText = [restoreText, existingText].filter(Boolean).join('\n');
    clearPromptHint();
    return nextText;
  }, [store, clearPromptHint, installPastedImages, clearPastedImagesSnapshot]);

  return {
    handlePromptPaste,
    handlePromptHistoryNavigate,
    handlePromptEscape,
    handlePromptInterrupt,
  };
}
