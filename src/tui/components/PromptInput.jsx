/*
 * components/PromptInput.jsx — the prompt input line.
 *
 * A self-contained editor built on ink's useInput. The text renders as plain
 * text and a thin NATIVE hardware cursor sits at the insertion point (also where
 * the terminal echoes typed/IME characters).
 *
 * CURSOR — via a small ink fork (vendor/ink, mirrored into node_modules): we
 * tag the text-box node with `internal_cursorAnchor = { col, row }` (the caret's
 * position WITHIN the box). Forked ink, during renderNodeToOutput, parks the
 * hardware cursor at that node's REAL laid-out absolute cell + (col,row) — every
 * frame, from the actual yoga layout. This replaces ink's stock useCursor, whose
 * externally-supplied absolute coordinate drifted/vanished whenever the layout
 * above the input changed (spinner/thinking growth, Enter, fullscreen relayout)
 * because it was computed a beat before the final layout. The fork computes it
 * at the exact moment of drawing, so it can never be stale.
 */
import React, { useState, useRef } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function previousOffset(text, offset) {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    const end = index + segment.length;
    if (end >= offset) return index;
    previous = end;
  }
  return previous;
}

function nextOffset(text, offset) {
  if (offset >= text.length) return text.length;
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    const end = index + segment.length;
    if (index >= offset) return end;
    if (end > offset) return end;
  }
  return text.length;
}

function lineStart(text, offset) {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function lineEnd(text, offset) {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

function caretPosition(text, offset, width) {
  const before = text.slice(0, offset);
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

    if (col > 0 && col + segmentWidth > width) {
      row += 1;
      col = 0;
    }

    col += segmentWidth;
    if (col >= width) {
      row += Math.floor(col / width);
      col %= width;
    }
  }

  return { row, col };
}

function offsetAtPosition(text, targetRow, targetCol, width) {
  let row = 0;
  let col = 0;

  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    if (segment === '\n') {
      if (row === targetRow) return index;
      row += 1;
      col = 0;
      continue;
    }

    const segmentWidth = stringWidth(segment);
    if (segmentWidth === 0) continue;

    if (col > 0 && col + segmentWidth > width) {
      if (row === targetRow) return index;
      row += 1;
      col = 0;
    }

    if (row === targetRow) {
      if (targetCol <= col) return index;
      if (targetCol < col + segmentWidth) return index;
      if (targetCol === col + segmentWidth) return index + segment.length;
    }

    col += segmentWidth;
    if (col >= width) {
      if (row === targetRow) return index + segment.length;
      row += Math.floor(col / width);
      col %= width;
    }
  }

  return text.length;
}

function insertText(draft, input) {
  if (!input) return draft;
  return {
    value: draft.value.slice(0, draft.cursor) + input + draft.value.slice(draft.cursor),
    cursor: draft.cursor + input.length,
  };
}

function normalizePastedText(text) {
  return String(text ?? '')
    .replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function moveVertical(draft, direction, width) {
  if (!width || width <= 0) return null;
  const current = caretPosition(draft.value, draft.cursor, width);
  const last = caretPosition(draft.value, draft.value.length, width);
  const targetRow = current.row + direction;

  if (targetRow < 0 || targetRow > last.row) return null;

  const cursor = offsetAtPosition(draft.value, targetRow, current.col, width);
  if (cursor === draft.cursor) return null;
  return { ...draft, cursor };
}

export function PromptInput({
  onSubmit,
  disabled = false,
  onDraftChange,
  commandPaletteActive = false,
  mask = false,
  onEscape,
  onCommandPaletteNavigate,
  onCommandPaletteAccept,
  onCommandPaletteCancel,
  onCommandPaletteComplete,
}) {
  const [draft, setDraft] = useState(() => ({ value: '', cursor: 0 }));
  const draftRef = useRef(draft);
  const history = useRef([]);
  const histIdx = useRef(-1); // -1 = current (unsubmitted) line
  const { isRawModeSupported } = useStdin();
  // The text box's ink DOM node. We mark it as the cursor anchor (forked ink
  // reads internal_cursorAnchor during render and parks the hardware cursor at
  // that node's REAL laid-out position + our caret col/row — no external
  // absolute-coordinate guessing, so it never drifts).
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false); // latest enabled state, read by the anchor fn at render time
  const { value, cursor } = draft;
  draftRef.current = draft;

  // wrapWidth for the caret column math + up/down line moves. Read from the
  // node's measured yoga width (available after layout); falls back to undefined
  // (treated as a single unwrapped line) until measured.
  const measuredWidth = boxRef.current?.yogaNode?.getComputedWidth?.() ?? 0;
  const wrapWidth = measuredWidth > 0 ? measuredWidth : undefined;

  const commitDraft = (next) => {
    draftRef.current = next;
    setDraft(next);
    onDraftChange?.(next.value);
  };

  const updateDraft = (fn) => {
    commitDraft(fn(draftRef.current));
  };

  const submitDraft = (next) => {
    const text = next.value;
    const accepted = onSubmit?.(text) !== false;
    if (!accepted) {
      commitDraft(next);
      return;
    }
    if (text.trim()) {
      history.current.push(text);
    }
    histIdx.current = -1;
    commitDraft({ value: '', cursor: 0 });
  };

  // Input capture is only active on a real TTY (raw mode). In pipes/CI the input
  // is inert — useInput with isActive:false won't throw.
  usePaste((text) => {
    if (disabled) return;
    const pasted = normalizePastedText(text);
    if (!pasted) return;
    updateDraft((d) => insertText(d, pasted));
  }, { isActive: isRawModeSupported && !disabled });

  useInput((input, key) => {
    if (disabled) return;

    const rawInput = String(input ?? '');

    // Drop SGR mouse-tracking sequences (wheel/click). The App enables mouse
    // tracking for transcript scrolling and parses these off raw stdin itself;
    // ink still forwards the bytes here as "input", which would otherwise type
    // garbage like `[<64;55;22M` into the prompt. Match with or without the
    // leading ESC (terminals/ink may strip it): CSI '<' … final 'M'/'m'.
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawInput) || /^\[?<\d+;\d+;\d+[Mm]?$/.test(rawInput)) {
      return;
    }

    const returnIndex = rawInput.indexOf('\r');
    if (returnIndex !== -1 && !key.shift && !key.meta) {
      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value);
        if (accepted !== false) {
          const text = draftRef.current.value;
          if (text.trim()) {
            history.current.push(text);
          }
          histIdx.current = -1;
          commitDraft({ value: '', cursor: 0 });
        }
        return;
      }
      submitDraft(insertText(draftRef.current, rawInput.slice(0, returnIndex)));
      return;
    }

    if (key.return) {
      if (key.shift || key.meta) {
        updateDraft((d) => ({
          value: `${d.value.slice(0, d.cursor)}\n${d.value.slice(d.cursor)}`,
          cursor: d.cursor + 1,
        }));
        return;
      }

      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value);
        if (accepted !== false) {
          const current = draftRef.current.value;
          if (current.trim()) {
            history.current.push(current);
          }
          histIdx.current = -1;
          commitDraft({ value: '', cursor: 0 });
        }
        return;
      }

      const current = draftRef.current;
      if (current.value[current.cursor - 1] === '\\') {
        updateDraft((d) => ({
          value: `${d.value.slice(0, d.cursor - 1)}\n${d.value.slice(d.cursor)}`,
          cursor: d.cursor,
        }));
        return;
      }

      submitDraft(current);
      return;
    }

    if (key.upArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(-1);
        return;
      }

      const moved = moveVertical(draftRef.current, -1, wrapWidth);
      if (moved) {
        commitDraft(moved);
        return;
      }

      const h = history.current;
      if (h.length === 0) return;
      const next = histIdx.current === -1 ? h.length - 1 : Math.max(0, histIdx.current - 1);
      histIdx.current = next;
      const v = h[next] ?? '';
      commitDraft({ value: v, cursor: v.length });
      return;
    }

    if (key.downArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(1);
        return;
      }

      const moved = moveVertical(draftRef.current, 1, wrapWidth);
      if (moved) {
        commitDraft(moved);
        return;
      }

      const h = history.current;
      if (histIdx.current === -1) return;
      const next = histIdx.current + 1;
      if (next >= h.length) {
        histIdx.current = -1;
        commitDraft({ value: '', cursor: 0 });
      } else {
        histIdx.current = next;
        const v = h[next] ?? '';
        commitDraft({ value: v, cursor: v.length });
      }
      return;
    }

    if (key.tab && commandPaletteActive) {
      const completed = onCommandPaletteComplete?.(draftRef.current.value);
      if (typeof completed === 'string') {
        commitDraft({ value: completed, cursor: completed.length });
      }
      return;
    }

    if (key.escape) {
      if (commandPaletteActive) {
        onCommandPaletteCancel?.(draftRef.current.value);
        return;
      }
      if (onEscape) {
        onEscape(draftRef.current.value);
        commitDraft({ value: '', cursor: 0 });
      }
      return;
    }

    if (key.leftArrow) {
      updateDraft((d) => ({ ...d, cursor: previousOffset(d.value, d.cursor) }));
      return;
    }
    if (key.rightArrow) {
      updateDraft((d) => ({ ...d, cursor: nextOffset(d.value, d.cursor) }));
      return;
    }
    if (key.home) {
      updateDraft((d) => ({ ...d, cursor: lineStart(d.value, d.cursor) }));
      return;
    }
    if (key.end) {
      updateDraft((d) => ({ ...d, cursor: lineEnd(d.value, d.cursor) }));
      return;
    }

    if (key.backspace) {
      updateDraft((d) => {
        if (d.cursor <= 0) return d;
        const start = previousOffset(d.value, d.cursor);
        return {
          value: d.value.slice(0, start) + d.value.slice(d.cursor),
          cursor: start,
        };
      });
      return;
    }

    if (key.delete) {
      updateDraft((d) => {
        if (d.cursor >= d.value.length) return d;
        const end = nextOffset(d.value, d.cursor);
        return {
          value: d.value.slice(0, d.cursor) + d.value.slice(end),
          cursor: d.cursor,
        };
      });
      return;
    }

    // ctrl+a / ctrl+e — line home / line end (common readline bindings).
    if (key.ctrl && input === 'a') {
      updateDraft((d) => ({ ...d, cursor: lineStart(d.value, d.cursor) }));
      return;
    }
    if (key.ctrl && input === 'e') {
      updateDraft((d) => ({ ...d, cursor: lineEnd(d.value, d.cursor) }));
      return;
    }
    // ctrl+u — clear line.
    if (key.ctrl && input === 'u') {
      commitDraft({ value: '', cursor: 0 });
      return;
    }

    // Printable input (ignore other control keys). Strip any embedded SGR mouse
    // sequences as a belt-and-suspenders guard (the early return above catches
    // whole-sequence inputs; this removes partials that rode in with real text).
    const printable = rawInput
      .replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '')
      .replace(/\r/g, '');
    if (printable && !key.ctrl && !key.meta) {
      updateDraft((d) => insertText(d, printable));
    }
  }, { isActive: isRawModeSupported && !disabled });

  // Mark the text-box node with a cursor-anchor FUNCTION. Forked ink calls it
  // during renderNodeToOutput — AFTER yoga layout is final and (crucially)
  // during the same onRender that paints the new text. The function reads the
  // latest caret from refs (synced every render below), so the cursor can never
  // be stale: an earlier object-anchor set in a layout effect was always one
  // keystroke behind, because ink's reconciler runs onRender inside
  // resetAfterCommit BEFORE React layout effects — that lag made the 2nd+ char
  // appear to land behind the caret (the observed scramble). Computing inside
  // the fork, from the real layout + current refs, fixes that by construction.
  cursorEnabledRef.current = !disabled && isRawModeSupported;
  if (boxRef.current && !boxRef.current.internal_cursorAnchor) {
    boxRef.current.internal_cursorAnchor = (yogaNode) => {
      if (!cursorEnabledRef.current) return null;
      const d = draftRef.current;
      const w = yogaNode?.getComputedWidth?.() ?? 0;
      return w > 0
        ? caretPosition(d.value, d.cursor, w)
        : { row: 0, col: stringWidth(d.value.slice(0, d.cursor)) };
    };
  }

  // Trailing space cell so the caret at end-of-input has a rendered cell to sit
  // on (kept visually blank — no synthetic underline).
  const displayValue = mask ? value.replace(/[^\n]/g, '*') : value;
  const renderedValue = cursor === value.length ? `${displayValue} ` : displayValue;

  return (
    <Box ref={boxRef} flexDirection="row" flexGrow={1} flexShrink={1}>
      <Text color={theme.text} wrap="hard">{renderedValue}</Text>
    </Box>
  );
}
