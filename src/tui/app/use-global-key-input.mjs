// Global key input, extracted from App.jsx. Everything the app handles
// before PromptInput sees a key: tool-approval y/n, copy-first Ctrl+C with
// region-aware selection sources, Ctrl+O expand, shift-arrow grid-selection
// moves, panel Escapes, and PageUp/PageDown transcript paging.
import { useInput } from 'ink';
import { copyToClipboard } from './clipboard.mjs';
import { overlayBlocksGlobalTranscriptScroll } from './slash-commands.mjs';
export function useGlobalKeyInput({
  store,
  state,
  toolApproval,
  picker,
  usagePanel,
  contextPanel,
  setContextPanel,
  closeUsagePanel,
  isRawModeSupported,
  resizeState,
  promptSelectionRef,
  promptMouseSelectionRef,
  dragRef,
  scrollFocusRef,
  gridSelectionActiveRef,
  moveSelectionFocus,
  copySelection,
  showSelectionCopyHint,
  toggleExpand,
  scrollTranscriptRows,
  resetTranscriptScroll,
  applySelectionRect,
}) {
  // (body moved verbatim)
  useInput((input, key) => {
    if (toolApproval) {
      const value = String(input || '').trim().toLowerCase();
      if (key.escape || value === 'd' || value === 'n') {
        store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
        return;
      }
      if (value === 'a' || value === 'y') {
        store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'approved by user' });
        return;
      }
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
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
      const hasInkSelection = inkRect && !(inkRect.x1 === inkRect.x2 && inkRect.y1 === inkRect.y2);
      if (promptSelectionText && (lastRegion === 'prompt' || !hasInkSelection)) {
        copyToClipboard(promptSelectionText)
          .then(() => showSelectionCopyHint(`copied ${promptSelectionText.length} char${promptSelectionText.length === 1 ? '' : 's'}`, 'plain'))
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
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    const rawShiftUp = input === '\x1b[1;2A' || input === '\x1b[a' || input === '[1;2A';
    const rawShiftDown = input === '\x1b[1;2B' || input === '\x1b[b' || input === '[1;2B';
    const rawShiftRight = input === '\x1b[1;2C' || input === '\x1b[c' || input === '[1;2C';
    const rawShiftLeft = input === '\x1b[1;2D' || input === '\x1b[d' || input === '[1;2D';
    const rawCtrlShiftUp = input === '\x1b[1;6A' || input === '[1;6A';
    const rawCtrlShiftDown = input === '\x1b[1;6B' || input === '[1;6B';
    const rawCtrlShiftRight = input === '\x1b[1;6C' || input === '[1;6C';
    const rawCtrlShiftLeft = input === '\x1b[1;6D' || input === '[1;6D';
    const rawModifiedShiftArrow = rawShiftUp || rawShiftDown || rawShiftLeft || rawShiftRight
      || rawCtrlShiftUp || rawCtrlShiftDown || rawCtrlShiftLeft || rawCtrlShiftRight;
    if (
      !picker
      && (
        (key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end))
        || rawModifiedShiftArrow
      )
    ) {
      // Consume the chord whenever a transcript/status ink-grid selection is
      // live — even if the focus clamps at an edge (moveSelectionFocus returns
      // false there). PromptInput independently skips the same chord via the
      // shared gridSelectionActiveRef predicate, so there is no double-handling.
      // When no grid selection is live, fall through to PromptInput.
      let move = null;
      if (key.leftArrow || rawShiftLeft || rawCtrlShiftLeft) move = 'left';
      else if (key.rightArrow || rawShiftRight || rawCtrlShiftRight) move = 'right';
      else if (key.upArrow || rawShiftUp || rawCtrlShiftUp) move = 'up';
      else if (key.downArrow || rawShiftDown || rawCtrlShiftDown) move = 'down';
      else if (key.home) move = 'lineStart';
      else if (key.end) move = 'lineEnd';
      if (move && gridSelectionActiveRef.current()) {
        moveSelectionFocus(move);
        return;
      }
    }
    if (key.escape && usagePanel && !picker) {
      closeUsagePanel();
      return;
    }
    if (key.escape && contextPanel && !picker) {
      setContextPanel(null);
      return;
    }
    if (key.pageUp) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(pageRows);
      return;
    }
    if (key.pageDown) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(-pageRows);
      return;
    }
    if (key.ctrl && key.end) {
      resetTranscriptScroll();
      return;
    }
    if (key.escape && !picker) {
      dragRef.current.active = false;
      dragRef.current.region = null;
      dragRef.current.anchorSpan = null;
      // Clear whichever region's selection is active. PromptInput's own ESC also
      // clears its selection when focused/enabled; this covers the disabled case
      // and a status/transcript ink-grid selection in one press.
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    }
  }, { isActive: isRawModeSupported });
}
