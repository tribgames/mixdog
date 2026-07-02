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

// Return the [start,end) run of same-class characters (word-like vs
// non-word-like) surrounding `offset`, used by double-click word selection.
// Mirrors typical desktop double-click behavior: clicking inside a run of
// letters/digits selects that whole run; clicking on a run of punctuation or
// whitespace selects that run instead (still deterministic, never empty).
export function wordRangeAt(text, offset) {
  const value = String(text || '');
  const units = graphemeUnits(value);
  if (units.length === 0) return { start: 0, end: 0 };
  const off = clampOffset(value, offset);
  let idx = units.findIndex((u) => off >= u.start && off < u.end);
  if (idx === -1) {
    idx = units.length - 1;
    for (let i = 0; i < units.length; i += 1) {
      if (units[i].start >= off) { idx = i > 0 ? i - 1 : 0; break; }
    }
  }
  const targetIsWord = wordLike(units[idx].segment);
  let start = idx;
  while (start > 0 && wordLike(units[start - 1].segment) === targetIsWord) start -= 1;
  let end = idx;
  while (end < units.length - 1 && wordLike(units[end + 1].segment) === targetIsWord) end += 1;
  return { start: units[start].start, end: units[end].end };
}

// `hasTrailingContent` (default derived from the full text) decides whether a
// caret that lands FLUSH on the last column (col === w) rolls to the next row.
// It must reflect whether ANY rendered cell follows this offset in the FULL
// text — not just the sliced prefix — otherwise a caret at a mid-text soft-wrap
// boundary reports {row N, col w} while ink already rendered the next glyph on
// row N+1, dropping the caret outside the box. PromptInput also appends a
// trailing space cell when the cursor sits at end-of-input, so "end of text"
// still has a following cell there; callers pass hasTrailingContent=true for
// that case.
export function caretPosition(text, offset, width, hasTrailingContent = undefined) {
  const value = String(text || '');
  const before = value.slice(0, offset);
  const w = safeWidth(width);
  const followsInFullText = hasTrailingContent === undefined
    ? offset < value.length
    : hasTrailingContent === true;
  let row = 0;
  let col = 0;
  const segments = [...graphemeSegmenter.segment(before)];
  for (let i = 0; i < segments.length; i += 1) {
    const { segment } = segments[i];
    if (segment === '\n') {
      row += 1;
      col = 0;
      continue;
    }

    const segmentWidth = stringWidth(segment);
    if (segmentWidth === 0) continue;

    // Mirror ink's wrap-ansi wrapWord (wrap="hard", wordWrap:false): a glyph
    // that would overflow the row is pushed WHOLE to the next row (col never
    // exceeds w for wide chars — no half-column left behind), and a glyph that
    // lands flush on the last column starts a new row ONLY when more rendered
    // content follows. Whether content follows is decided from the FULL text
    // (followsInFullText), not the sliced prefix, so a caret at a mid-text wrap
    // boundary rolls to row N+1 exactly as ink renders it. The old
    // `col >= w → row += floor(col/w)` over-counted a row for width-2 glyphs at
    // odd widths (col could reach w+1), landing the cursor one row too low.
    if (col > 0 && col + segmentWidth > w) {
      row += 1;
      col = 0;
    }
    col += segmentWidth;
    const moreFollows = i < segments.length - 1 || followsInFullText;
    if (col === w && moreFollows) {
      row += 1;
      col = 0;
    }
  }

  return { row, col };
}

// Inverse of caretPosition: given a visual (row, col) cell inside the wrapped
// content of `width` columns, return the character offset whose caret sits
// closest to that cell. Used to map a mouse click/drag cell in the prompt box
// to an edit offset so mouse selection can drive selectionAnchor + cursor.
export function offsetAtCell(text, row, col, width) {
  const w = safeWidth(width);
  const value = String(text || '');
  const positions = boundaryPositions(value, w);
  if (positions.length === 0) return 0;
  let best = positions[0];
  let bestScore = Infinity;
  for (const position of positions) {
    const rowDist = Math.abs(position.row - row);
    const colDist = Math.abs(position.col - col);
    // Row distance dominates so a click never jumps to a different visual line;
    // within the matched row the nearest column wins.
    const score = rowDist * 100000 + colDist;
    if (score < bestScore) {
      best = position;
      bestScore = score;
    }
  }
  return best.offset;
}

function boundaryPositions(text, width) {
  const value = String(text || '');
  const offsets = [0];
  for (const unit of graphemeUnits(value)) offsets.push(unit.end);

  const seen = new Set();
  const positions = offsets
    .filter((offset) => {
      if (seen.has(offset)) return false;
      seen.add(offset);
      return true;
    })
    // Decide the flush-boundary advance from the FULL text so a soft-wrap
    // offset reports {row N+1, col 0} (matching ink) instead of {row N, col w}.
    .map((offset) => ({ offset, ...caretPosition(value, offset, width) }));
  return positions;
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
