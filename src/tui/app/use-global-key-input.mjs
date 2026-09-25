// Global key input. Everything the app handles
// before PromptInput sees a key: tool-approval y/n, copy-first Ctrl+C with
// region-aware selection sources, Ctrl+O expand, shift-arrow grid-selection
// moves, panel Escapes, and PageUp/PageDown transcript paging.
// The ordered dispatch below stays whole; two leaf branches live next to it in
// use-global-key-input/ — the Ctrl+C copy source (copy-first) and the chord
// decoding of the grid-selection move (shift-arrow).
import { useInput } from 'ink';
import { overlayBlocksGlobalTranscriptScroll } from './slash-commands.mjs';
import { copyActiveSelection } from './use-global-key-input/copy-first.mjs';
import { decodeSelectionMoveChord } from './use-global-key-input/shift-arrow.mjs';
export function useGlobalKeyInput({
  store,
  state: _state,
  toolApproval,
  picker,
  usagePanel,
  contextPanel,
  surface,
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
  settleStuckDrag,
}) {
  useInput(
    (input, key) => {
      // A drag whose button release never reached the app (button let go OUTSIDE
      // the terminal window, or the release swallowed while mouse tracking was
      // off) leaves dragRef.current.active stuck true: Ctrl+C copy is gated on
      // !active, and every later scroll rebuilds the rect from anchor→last so the
      // highlight drifts on its own. A keystroke proves the gesture is over —
      // settle it through the same path a real release takes, before any branch
      // below reads the selection.
      settleStuckDrag?.();
      if (toolApproval) {
        const value = String(input || '')
          .trim()
          .toLowerCase();
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
        copyActiveSelection({ promptSelectionRef, dragRef, copySelection, showSelectionCopyHint });
        return;
      }
      if (key.ctrl && (input === 'o' || input === 'O')) {
        toggleExpand();
        return;
      }
      const selectionMove = decodeSelectionMoveChord(input, key);
      if (!picker && selectionMove.isChord) {
        // Consume the chord whenever a transcript/status ink-grid selection is
        // live — even if the focus clamps at an edge (moveSelectionFocus returns
        // false there). PromptInput independently skips the same chord via the
        // shared gridSelectionActiveRef predicate, so there is no double-handling.
        // When no grid selection is live, fall through to PromptInput.
        if (selectionMove.move && gridSelectionActiveRef.current()) {
          moveSelectionFocus(selectionMove.move);
          return;
        }
      }
      if (key.escape && usagePanel && !picker) {
        closeUsagePanel();
        return;
      }
      if (key.escape && contextPanel && !picker) {
        // Esc inside the key handler: this keypress owns what it closes.
        surface.claim().context(null);
        return;
      }
      if (key.pageUp || key.pageDown) {
        if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
        const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
        scrollTranscriptRows(key.pageUp ? pageRows : -pageRows);
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
    },
    { isActive: isRawModeSupported }
  );
}
