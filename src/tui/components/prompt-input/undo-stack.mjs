/**
 * components/prompt-input/undo-stack.mjs — the prompt editor's undo/redo
 * history (no React).
 *
 * One responsibility: decide what becomes an undo step, and replay steps back
 * through the editor's own commit path. Each entry is a { value, cursor,
 * selectionAnchor } draft snapshot. The caller owns the state ref (so the
 * history survives re-renders) and resets it on submit / draftOverride.
 */
// Continuous-typing coalesce window: successive value-changing edits within
// this window collapse into a single undo step.
const UNDO_COALESCE_MS = 500;
const UNDO_MAX = 100;

const snapshotOf = (d) => ({ value: d.value, cursor: d.cursor, selectionAnchor: d.selectionAnchor ?? null });

export function createUndoStack({ stateRef, draftRef, commit }) {
  const reset = () => {
    stateRef.current = { past: [], future: [], lastPushAt: 0, lastValue: null };
  };

  // Record a snapshot of the PREVIOUS state before applying `next`. Cursor-only
  // moves (value unchanged) are never snapshotted. Consecutive value edits
  // within UNDO_COALESCE_MS coalesce (we keep only the first snapshot of the
  // run, so a single undo reverts the whole burst).
  const record = (prev, next, options = {}) => {
    const stack = stateRef.current;
    if (prev.value === next.value) {
      // Cursor/selection-only move: don't snapshot, but BREAK the coalesce run
      // so a following edit starts a fresh undo step (typing→move→typing must
      // not collapse into one undo).
      stack.lastPushAt = 0;
      stack.lastValue = next.value;
      return;
    }
    const now = Date.now();
    const coalesce =
      !options.undoBreak &&
      stack.past.length > 0 &&
      now - stack.lastPushAt < UNDO_COALESCE_MS &&
      stack.lastValue === prev.value;
    if (!coalesce) {
      stack.past.push(snapshotOf(prev));
      if (stack.past.length > UNDO_MAX) stack.past.shift();
    }
    stack.lastPushAt = now;
    stack.lastValue = next.value;
    stack.future = [];
  };

  const undo = () => {
    const stack = stateRef.current;
    if (stack.past.length === 0) return false;
    const prev = stack.past.pop();
    stack.future.push(snapshotOf(draftRef.current));
    stack.lastPushAt = 0;
    stack.lastValue = prev.value;
    commit(prev, { skipHistory: true });
    return true;
  };

  const redo = () => {
    const stack = stateRef.current;
    if (stack.future.length === 0) return false;
    const next = stack.future.pop();
    stack.past.push(snapshotOf(draftRef.current));
    if (stack.past.length > UNDO_MAX) stack.past.shift();
    stack.lastPushAt = 0;
    stack.lastValue = next.value;
    commit(next, { skipHistory: true });
    return true;
  };

  return { reset, record, undo, redo };
}
