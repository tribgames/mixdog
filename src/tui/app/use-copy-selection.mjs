// Ctrl+C selection copy, extracted from App.jsx. Merges the three harvest
// sources — the current render's visible selection, the last fully-painted
// remembered text, and the cross-scroll stitch buffer (only when contiguous)
// — retries briefly while ink refreshes, and reports feedback via the prompt
// hint band.
import { useCallback } from 'react';
import { copyToClipboard } from './clipboard.mjs';

export function useCopySelection({
  store,
  selectionTextRef,
  getStitchedSelectionText,
  showSelectionCopyHint,
}) {
  const copySelection = useCallback((attempt = 0) => {
    const renderText = store.getRenderSelectionText?.();
    const remembered = selectionTextRef.current || '';
    // A selection that has partially scrolled out of the viewport renders —
    // and therefore harvests — only its visible rows. The remembered text
    // (captured while the selection was last fully painted) is the fuller
    // copy; prefer whichever is longer so scrolling never shrinks a copy.
    let text = renderText == null
      ? remembered
      : (remembered.length > renderText.length ? remembered : renderText);
    // The stitch buffer accumulates rows harvested across every scroll position
    // during a transcript drag, so it can reconstruct rows that scrolled out of
    // view entirely (neither renderText nor the last-full-paint remembered text
    // ever saw them). getStitchedSelectionText reports a `complete` flag:
    // prefer the stitch ONLY when it contiguously covers the selection (no
    // interior gap) AND adds rows. A gapped stitch silently drops a scrolled-off
    // row, so preferring it purely on length yielded a mangled copy.
    const stitched = getStitchedSelectionText?.() || { text: '', complete: false };
    if (stitched.complete && stitched.text.length > text.length) text = stitched.text;
    if ((!text || !text.trim()) && attempt < 4) {
      setTimeout(() => copySelection(attempt + 1), attempt === 0 ? 0 : 24);
      return;
    }
    if (!text || !text.trim()) {
      // Retries exhausted with nothing to copy: never return silently — the
      // user pressed Ctrl+C expecting feedback. Surface a hint (and still
      // swallow the key, which the caller already did).
      showSelectionCopyHint('nothing to copy · select text first', 'error');
      return;
    }
    selectionTextRef.current = text;
    copyToClipboard(text)
      .then(() => {
        const lines = text.split('\n').length;
        const chars = text.length;
        showSelectionCopyHint(`copied ${chars} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`, 'plain');
      })
      .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
  }, [store, selectionTextRef, showSelectionCopyHint, getStitchedSelectionText]);

  return { copySelection };
}
