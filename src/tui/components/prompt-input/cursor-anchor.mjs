/**
 * components/prompt-input/cursor-anchor.mjs — the prompt box's cursor-anchor
 * function (no React).
 *
 * One responsibility: what patched Ink calls during renderNodeToOutput, from
 * the final yoga layout. It does two things with that layout: publish the
 * editable content box's REAL absolute rect (so App's mouse handler can map a
 * cell to an edit offset) and return the caret's (col,row) WITHIN the box so
 * the hardware cursor parks there. Reads the latest draft/width from refs, so
 * the answer can never be a frame stale.
 */
import { displayWidth } from '../../display-width.mjs';
import { caretPosition } from '../../input-editing.mjs';

// Windows Terminal IME composition can clip a glyph that starts exactly at the
// left edge of the editable text node. The rounded prompt box already adds a
// paddingX of 1, so the typing start can sit directly against that padding
// without an extra guard column.
export const IME_LEFT_GUARD_COLUMNS = 0;

export function createCursorAnchor({ boxRef, boxRectRef, contentWidthRef, cursorEnabledRef, draftRef }) {
  return (yogaNode) => {
    // [mixdog] Report the editable content box's REAL absolute rect up to App
    // every frame so the mouse handler can map a click/drag cell to an edit
    // offset. Walk the parent chain summing yoga computed offsets (same math
    // render-node-to-output uses) — boxRef is the flex-row that holds the text
    // node, so its absolute x/y is the first content cell (col 0,row 0).
    if (boxRectRef) {
      let absLeft = 0;
      let absTop = 0;
      let node = boxRef.current;
      for (let i = 0; node && i < 64; i++) {
        const yn = node.yogaNode;
        if (yn?.getComputedLeft) {
          absLeft += yn.getComputedLeft() || 0;
          absTop += yn.getComputedTop() || 0;
        }
        if (node.nodeName === 'ink-root') break;
        node = node.parentNode;
      }
      const hNow = yogaNode?.getComputedHeight?.() ?? 1;
      boxRectRef.current = {
        top: absTop,
        left: absLeft,
        height: Math.max(1, hNow || 1),
        contentWidth: contentWidthRef.current,
      };
    }
    if (!cursorEnabledRef.current) return null;
    const d = draftRef.current;
    const w = yogaNode?.getComputedWidth?.() ?? 0;
    const guardColumns = w > IME_LEFT_GUARD_COLUMNS ? IME_LEFT_GUARD_COLUMNS : 0;
    const contentWidth = Math.max(1, (w ? w - guardColumns : contentWidthRef.current) || 80);
    contentWidthRef.current = contentWidth;
    // PromptInput renders a trailing space cell when the cursor is at
    // end-of-input, so a caret flush on the last column there still has a
    // following cell — pass hasTrailingContent=true so it rolls to row N+1
    // exactly as ink wraps the trailing space.
    const hasTrailingContent = d.cursor >= d.value.length ? true : undefined;
    const caret =
      w > 0
        ? caretPosition(d.value, d.cursor, contentWidth, hasTrailingContent)
        : { row: 0, col: displayWidth(d.value.slice(0, d.cursor)) };
    return w > 0 ? { ...caret, col: caret.col + guardColumns } : caret;
  };
}
