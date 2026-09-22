/**
 * components/prompt-input/mouse-selection.mjs — the prompt box's mouse
 * drag-selection driver (no React).
 *
 * [mixdog] App's single mouse handler maps a click/drag cell over the prompt
 * box to an edit offset and calls this controller, so the SAME
 * selectionAnchor/cursor engine that keyboard Shift-selection uses paints the
 * highlight. Anchor on press, extend on drag/release, clear on a plain click.
 * Its one extra responsibility is cadence: drag-extend commits are coalesced
 * (SGR motion can fire faster than ink needs to immediate-render) while the
 * press/release edges commit straight through.
 */
import { clearSelection, lineEnd, lineStart, offsetAtCell, selectionRange, wordRangeAt } from '../../input-editing.mjs';
import { draftStateEqual } from './edit-helpers.mjs';

// Coalesce prompt mouse-drag extend commits. Matches transcript selection
// paint cadence.
const MOUSE_EXTEND_COALESCE_MS = 24;

export function createPromptMouseSelection({ coalesceRef, draftRef, contentWidthRef, commitDraft }) {
  const cancelMouseExtendCoalesce = () => {
    const state = coalesceRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pendingNext = null;
  };

  const queueMouseExtendCommit = (next, immediate = false) => {
    if (immediate) {
      cancelMouseExtendCoalesce();
      commitDraft(next, { immediateSettle: true });
      coalesceRef.current.t = Date.now();
      return;
    }
    if (draftStateEqual(draftRef.current, next)) {
      cancelMouseExtendCoalesce();
      commitDraft(next, { throttledRender: true });
      return;
    }
    const state = coalesceRef.current;
    state.pendingNext = next;
    const now = Date.now();
    const elapsed = now - state.t;
    if (elapsed >= MOUSE_EXTEND_COALESCE_MS) {
      cancelMouseExtendCoalesce();
      state.t = now;
      commitDraft(next, { throttledRender: true });
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(
      () => {
        const current = coalesceRef.current;
        const pending = current.pendingNext;
        current.timer = null;
        current.pendingNext = null;
        current.t = Date.now();
        if (pending) commitDraft(pending, { throttledRender: true });
      },
      Math.max(1, MOUSE_EXTEND_COALESCE_MS - elapsed)
    );
    state.timer.unref?.();
  };

  // Reuses contentWidthRef (the real measured content width).
  return {
    offsetAtCell: (row, col) => offsetAtCell(draftRef.current.value, row, col, contentWidthRef.current),
    anchorAt: (offset) => {
      cancelMouseExtendCoalesce();
      const value = draftRef.current.value;
      const off = Math.max(0, Math.min(value.length, Math.floor(Number(offset) || 0)));
      commitDraft({ ...draftRef.current, cursor: off, selectionAnchor: off });
      coalesceRef.current.t = Date.now();
    },
    extendTo: (offset, immediate = false) => {
      if (offset == null) {
        if (immediate) cancelMouseExtendCoalesce();
        return;
      }
      const d = draftRef.current;
      const off = Math.max(0, Math.min(d.value.length, Math.floor(Number(offset) || 0)));
      const anchor = Number.isFinite(d.selectionAnchor) ? d.selectionAnchor : d.cursor;
      queueMouseExtendCommit({ ...d, cursor: off, selectionAnchor: anchor }, immediate);
    },
    hasSelection: () => selectionRange(draftRef.current) != null,
    // Double-click word select: pick the word/punctuation run under the
    // clicked offset and set selectionAnchor/cursor to its bounds so it
    // paints via the normal selection highlight. Triple-click line select
    // uses lineStart/lineEnd instead (see selectLineAt).
    selectWordAt: (offset) => {
      cancelMouseExtendCoalesce();
      const value = draftRef.current.value;
      const off = Math.max(0, Math.min(value.length, Math.floor(Number(offset) || 0)));
      const { start, end } = wordRangeAt(value, off);
      commitDraft({ ...draftRef.current, cursor: end, selectionAnchor: start });
      coalesceRef.current.t = Date.now();
    },
    selectLineAt: (offset) => {
      cancelMouseExtendCoalesce();
      const value = draftRef.current.value;
      const off = Math.max(0, Math.min(value.length, Math.floor(Number(offset) || 0)));
      const start = lineStart(value, off);
      const end = lineEnd(value, off);
      commitDraft({ ...draftRef.current, cursor: end, selectionAnchor: start });
      coalesceRef.current.t = Date.now();
    },
    clear: () => {
      cancelMouseExtendCoalesce();
      if (selectionRange(draftRef.current)) commitDraft(clearSelection(draftRef.current));
    },
  };
}
