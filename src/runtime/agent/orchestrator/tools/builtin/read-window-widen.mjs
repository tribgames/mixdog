/**
 * read-window-widen.mjs — reactive anti-fragmentation merge: per-session
 * (readStateScope) memory of the last requested window per file. When the
 * next windowed read of the same file starts shortly AFTER the previous
 * window (gap <= 200 lines) and the widened result stays modest (<= 400
 * lines), widen the request to include the gap so the model never needs a
 * third paging call.
 */
const historyByScope = new WeakMap();
function windowHistory(scope) {
  let history = historyByScope.get(scope);
  if (!history) {
    history = new Map();
    historyByScope.set(scope, history);
  }
  return history;
}
const WIDEN_GAP_MAX_LINES = 200;
const WIDEN_RESULT_MAX_LINES = 400;
const HISTORY_MAX_FILES = 64;

/**
 * Ranged text reads only (caller guarantees offset + limit were both given).
 * @returns {{ offset: number, limit: number, widenNote: string }}
 */
export function widenReadWindow(readStateScope, fullPath, { offset, limit }) {
  const history = windowHistory(readStateScope);
  const prev = history.get(fullPath);
  let widenNote = '';
  if (prev && offset > prev.end && limit <= WIDEN_RESULT_MAX_LINES) {
    const gap = offset - prev.end; // unread lines between windows
    const mergedLines = offset + limit - prev.end;
    if (gap <= WIDEN_GAP_MAX_LINES && mergedLines <= WIDEN_RESULT_MAX_LINES) {
      widenNote = `[widened: included the ${gap}-line gap after your last window (lines ${prev.start}-${prev.end}) — one span instead of another page]`;
      offset = prev.end;
      limit = mergedLines;
    }
  }
  history.set(fullPath, { start: offset + 1, end: offset + limit });
  if (history.size > HISTORY_MAX_FILES) history.delete(history.keys().next().value);
  return { offset, limit, widenNote };
}
