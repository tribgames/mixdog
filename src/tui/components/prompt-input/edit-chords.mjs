/*
 * components/prompt-input/edit-chords.mjs — draft edits shared verbatim by
 * PromptInput and TextEntryPanel.
 */
import {
  deleteBackwardWord,
  deleteForwardWord,
  deleteToLineEnd,
  deleteToLineStart,
  moveCursor,
  nextOffset,
  nextWordOffset,
  previousOffset,
  previousWordOffset,
  verticalOffset,
} from '../../input-editing.mjs';
import { deleteBackwardChar, deleteForwardChar } from './edit-helpers.mjs';

// Character/word motion and deletion chords. Returns true when the key was one
// of them (the draft was updated), false to let the caller keep dispatching.
export function applyEditChord(key, inputKey, updateDraft) {
  // ctrl+b / ctrl+f — character left / right.
  if (key.ctrl && inputKey === 'b') {
    updateDraft((d) => moveCursor(d, previousOffset(d.value, d.cursor), { extend: key.shift }));
    return true;
  }
  if (key.ctrl && inputKey === 'f') {
    updateDraft((d) => moveCursor(d, nextOffset(d.value, d.cursor), { extend: key.shift }));
    return true;
  }
  // alt/option+b / alt/option+f — word left / right.
  if (key.meta && inputKey === 'b') {
    updateDraft((d) => moveCursor(d, previousWordOffset(d.value, d.cursor), { extend: key.shift }));
    return true;
  }
  if (key.meta && inputKey === 'f') {
    updateDraft((d) => moveCursor(d, nextWordOffset(d.value, d.cursor), { extend: key.shift }));
    return true;
  }
  // ctrl+u / ctrl+k — delete to line start / end.
  if (key.ctrl && inputKey === 'u') {
    updateDraft(deleteToLineStart);
    return true;
  }
  if (key.ctrl && inputKey === 'k') {
    updateDraft(deleteToLineEnd);
    return true;
  }
  // ctrl+w / alt+backspace — delete previous word.
  if ((key.ctrl && inputKey === 'w') || ((key.ctrl || key.meta) && key.backspace)) {
    updateDraft(deleteBackwardWord);
    return true;
  }
  // alt+d / ctrl+delete — delete next word.
  if ((key.meta && inputKey === 'd') || (key.ctrl && key.delete)) {
    updateDraft(deleteForwardWord);
    return true;
  }
  if (key.backspace) {
    updateDraft(deleteBackwardChar);
    return true;
  }
  if (key.delete) {
    updateDraft(deleteForwardChar);
    return true;
  }
  return false;
}

// Visual-line cursor motion that remembers the preferred column across a run
// of vertical moves. Returns false when the cursor could not move.
export function createVerticalMover({ draftRef, contentWidthRef, preferredColumnRef, commitDraft }) {
  return (direction, { extend = false } = {}) => {
    const current = draftRef.current;
    const moved = verticalOffset(
      current.value,
      current.cursor,
      contentWidthRef.current,
      direction,
      preferredColumnRef.current
    );
    preferredColumnRef.current = moved.preferredColumn;
    if (moved.cursor === current.cursor) return false;
    commitDraft(moveCursor(current, moved.cursor, { extend }), { keepPreferredColumn: true });
    return true;
  };
}
