import stringWidth from 'string-width';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeUnits(text) {
  return Array.from(graphemeSegmenter.segment(String(text || '')), ({ index, segment }) => ({
    start: index,
    end: index + segment.length,
    segment,
  }));
}

function wordLike(segment) {
  return /[\p{L}\p{N}\p{M}\p{Pc}]/u.test(segment);
}

function safeWidth(width) {
  return Math.max(1, Math.floor(Number(width) || 80));
}

function clampOffset(text, offset) {
  const value = String(text || '');
  const n = Number(offset);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(value.length, Math.floor(n)));
}

export function selectionRange(draft) {
  const value = String(draft?.value || '');
  if (!Number.isFinite(draft?.selectionAnchor)) return null;
  const anchor = clampOffset(value, draft.selectionAnchor);
  const cursor = clampOffset(value, draft.cursor);
  if (anchor === cursor) return null;
  return {
    start: Math.min(anchor, cursor),
    end: Math.max(anchor, cursor),
  };
}

export function clearSelection(draft) {
  return draft?.selectionAnchor == null ? draft : { ...draft, selectionAnchor: null };
}

export function moveCursor(draft, cursor, { extend = false } = {}) {
  const value = String(draft?.value || '');
  const nextCursor = clampOffset(value, cursor);
  if (extend) {
    const anchor = Number.isFinite(draft?.selectionAnchor)
      ? clampOffset(value, draft.selectionAnchor)
      : clampOffset(value, draft?.cursor);
    return { ...draft, value, cursor: nextCursor, selectionAnchor: anchor };
  }
  return { ...draft, value, cursor: nextCursor, selectionAnchor: null };
}

export function replaceSelection(draft, input = '') {
  const value = String(draft?.value || '');
  const insert = String(input ?? '');
  const range = selectionRange(draft);
  const start = range?.start ?? clampOffset(value, draft?.cursor);
  const end = range?.end ?? start;
  return {
    ...draft,
    value: value.slice(0, start) + insert + value.slice(end),
    cursor: start + insert.length,
    selectionAnchor: null,
  };
}

export function deleteSelectedText(draft) {
  return selectionRange(draft) ? replaceSelection(draft, '') : clearSelection(draft);
}

export function previousOffset(text, offset) {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const { index, segment } of graphemeSegmenter.segment(String(text || ''))) {
    const end = index + segment.length;
    if (end >= offset) return index;
    previous = end;
  }
  return previous;
}

export function nextOffset(text, offset) {
  const value = String(text || '');
  if (offset >= value.length) return value.length;
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    const end = index + segment.length;
    if (index >= offset) return end;
    if (end > offset) return end;
  }
  return value.length;
}

export function previousWordOffset(text, offset) {
  const units = graphemeUnits(text);
  let index = 0;
  while (index < units.length && units[index].end <= offset) index += 1;
  while (index > 0 && !wordLike(units[index - 1].segment)) index -= 1;
  while (index > 0 && wordLike(units[index - 1].segment)) index -= 1;
  return index <= 0 ? 0 : units[index].start;
}

export function nextWordOffset(text, offset) {
  const value = String(text || '');
  const units = graphemeUnits(value);
  let index = 0;
  while (index < units.length && units[index].end <= offset) index += 1;
  while (index < units.length && !wordLike(units[index].segment)) index += 1;
  while (index < units.length && wordLike(units[index].segment)) index += 1;
  return index <= 0 ? 0 : (units[index - 1]?.end ?? value.length);
}

export function lineStart(text, offset) {
  return String(text || '').lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

export function lineEnd(text, offset) {
  const value = String(text || '');
  const end = value.indexOf('\n', offset);
  return end === -1 ? value.length : end;
}

export function caretPosition(text, offset, width) {
  const value = String(text || '');
  const before = value.slice(0, offset);
  const w = safeWidth(width);
  let row = 0;
  let col = 0;

  for (const { segment } of graphemeSegmenter.segment(before)) {
    if (segment === '\n') {
      row += 1;
      col = 0;
      continue;
    }

    const segmentWidth = stringWidth(segment);
    if (segmentWidth === 0) continue;

    if (col > 0 && col + segmentWidth > w) {
      row += 1;
      col = 0;
    }

    col += segmentWidth;
    if (col >= w) {
      row += Math.floor(col / w);
      col %= w;
    }
  }

  return { row, col };
}

function boundaryPositions(text, width) {
  const value = String(text || '');
  const offsets = [0];
  for (const unit of graphemeUnits(value)) offsets.push(unit.end);

  const seen = new Set();
  return offsets
    .filter((offset) => {
      if (seen.has(offset)) return false;
      seen.add(offset);
      return true;
    })
    .map((offset) => ({ offset, ...caretPosition(value, offset, width) }));
}

export function verticalOffset(text, offset, width, direction, preferredColumn = null) {
  const w = safeWidth(width);
  const current = caretPosition(text, offset, w);
  const targetColumn = Number.isFinite(preferredColumn) ? preferredColumn : current.col;
  const targetRow = current.row + direction;
  if (targetRow < 0) return { cursor: offset, preferredColumn: targetColumn };

  const candidates = boundaryPositions(text, w).filter((position) => position.row === targetRow);
  if (candidates.length === 0) return { cursor: offset, preferredColumn: targetColumn };

  let best = candidates[0];
  for (const candidate of candidates) {
    const bestDistance = Math.abs(best.col - targetColumn);
    const candidateDistance = Math.abs(candidate.col - targetColumn);
    if (
      candidateDistance < bestDistance ||
      (candidateDistance === bestDistance && candidate.col <= targetColumn && candidate.col > best.col)
    ) {
      best = candidate;
    }
  }

  return { cursor: best.offset, preferredColumn: targetColumn };
}

export function deleteBackwardWord(draft) {
  if (selectionRange(draft)) return replaceSelection(draft, '');
  if (draft.cursor <= 0) return draft;
  const start = previousWordOffset(draft.value, draft.cursor);
  return {
    value: draft.value.slice(0, start) + draft.value.slice(draft.cursor),
    cursor: start,
    selectionAnchor: null,
  };
}

export function deleteForwardWord(draft) {
  if (selectionRange(draft)) return replaceSelection(draft, '');
  if (draft.cursor >= draft.value.length) return draft;
  const end = nextWordOffset(draft.value, draft.cursor);
  return {
    value: draft.value.slice(0, draft.cursor) + draft.value.slice(end),
    cursor: draft.cursor,
    selectionAnchor: null,
  };
}

export function deleteToLineStart(draft) {
  if (selectionRange(draft)) return replaceSelection(draft, '');
  const start = lineStart(draft.value, draft.cursor);
  if (start === draft.cursor) return draft;
  return {
    value: draft.value.slice(0, start) + draft.value.slice(draft.cursor),
    cursor: start,
    selectionAnchor: null,
  };
}

export function deleteToLineEnd(draft) {
  if (selectionRange(draft)) return replaceSelection(draft, '');
  const end = lineEnd(draft.value, draft.cursor);
  const deleteEnd = end > draft.cursor
    ? end
    : (draft.value[draft.cursor] === '\n' ? draft.cursor + 1 : draft.cursor);
  if (deleteEnd === draft.cursor) return draft;
  return {
    value: draft.value.slice(0, draft.cursor) + draft.value.slice(deleteEnd),
    cursor: draft.cursor,
    selectionAnchor: null,
  };
}
