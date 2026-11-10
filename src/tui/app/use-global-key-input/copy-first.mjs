// use-global-key-input/copy-first.mjs
// What Ctrl+C does before anything else: copy the active selection, whichever
// region owns it.
import { copyToClipboard } from '../clipboard.mjs';
import { selectionRectIsDegenerate } from '../transcript-window.mjs';

export function copyActiveSelection({ promptSelectionRef, dragRef, copySelection, showSelectionCopyHint }) {
  // Ctrl+C is copy-first. Native terminal selections can still forward the
  // key event to us on Windows Terminal, so a missing app-owned selection
  // must NOT cancel the active turn; use Esc to interrupt instead.
  // Region-aware copy source: a prompt-box selection (its OWN engine) copies
  // from promptSelectionRef; a transcript/status ink-grid selection copies
  // from store.getRenderSelectionText via copySelection(). Only one region is
  // ever active at a time (a press in one region clears the others), but when
  // the last drag was in the prompt we prefer its selection explicitly.
  const promptSelectionText = promptSelectionRef.current?.text;
  const lastRegion = dragRef.current.region;
  const inkRect = dragRef.current.rect;
  const hasInkSelection = inkRect && !selectionRectIsDegenerate(inkRect);
  if (promptSelectionText && (lastRegion === 'prompt' || !hasInkSelection)) {
    copyToClipboard(promptSelectionText)
      .then(() =>
        showSelectionCopyHint(
          `copied ${promptSelectionText.length} char${promptSelectionText.length === 1 ? '' : 's'}`,
          'plain'
        )
      )
      .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
    return;
  }
  if (hasInkSelection) {
    copySelection();
    return;
  }
  // No app-owned selection. On Windows Terminal the same Ctrl+C is also the
  // native terminal's copy shortcut for a mouse selection we can't see — so
  // rendering a hint here fights that copy and flashes a spurious message.
  // Suppress the hint on win32 (interrupt routing is unchanged: Esc still
  // interrupts). Other platforms keep the guidance.
  if (process.platform !== 'win32') {
    showSelectionCopyHint('select text to copy · Esc interrupts', 'plain');
  }
}
