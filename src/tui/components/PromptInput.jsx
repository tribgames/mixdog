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
import React, { useEffect, useState, useRef } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import { normalizeLineEndings } from '../safe-text.mjs';

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

function hintStyle(tone) {
  void tone;
  return { accentColor: theme.inactive, textColor: theme.inactive, prefix: '*' };
}

function insertText(draft, input) {
  if (!input) return draft;
  return {
    value: draft.value.slice(0, draft.cursor) + input + draft.value.slice(draft.cursor),
    cursor: draft.cursor + input.length,
  };
}

function normalizePastedText(text) {
  return normalizeLineEndings(text);
}

export function PromptInput({
  onSubmit,
  disabled = false,
  onDraftChange,
  commandPaletteActive = false,
  mask = false,
  hint = '',
  hintTone = 'info',
  initialValue = '',
  draftOverride,
  onEscape,
  onCommandPaletteNavigate,
  onCommandPaletteAccept,
  onCommandPaletteCancel,
  onCommandPaletteComplete,
  valueRef,
}) {
  const [draft, setDraft] = useState(() => {
    const value = String(initialValue || '');
    return { value, cursor: value.length };
  });
  const draftRef = useRef(draft);
  const lastReportedValueRef = useRef(draft.value);
  if (valueRef) valueRef.current = draftRef.current.value;
  const { isRawModeSupported } = useStdin();
  // The text box's ink DOM node. We mark it as the cursor anchor (forked ink
  // reads internal_cursorAnchor during render and parks the hardware cursor at
  // that node's REAL laid-out position + our caret col/row — no external
  // absolute-coordinate guessing, so it never drifts).
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false); // latest enabled state, read by the anchor fn at render time
  const { value, cursor } = draft;
  draftRef.current = draft;

  // Bypass ink's render throttle for keystroke echo. ink coalesces renders to
  // maxFps (leading+trailing throttle), so when typing faster than one frame the
  // last chars land on the trailing timer — felt as input lag ("a beat behind").
  // ink exposes an UNthrottled `onImmediateRender` on the ink-root node; walking
  // the parent chain from our box and firing it flushes the new draft in the same
  // tick. Guarded so a structure change in the ink fork degrades to throttled
  // (slower) rendering, never a crash.
  const flushImmediate = () => {
    let node = boxRef.current;
    for (let i = 0; node && i < 64; i++) {
      if (node.nodeName === 'ink-root') {
        if (typeof node.onImmediateRender === 'function') node.onImmediateRender();
        return;
      }
      node = node.parentNode;
    }
  };

  const commitDraft = (next) => {
    draftRef.current = next;
    setDraft(next);
    if (next.value !== lastReportedValueRef.current) {
      lastReportedValueRef.current = next.value;
      onDraftChange?.(next.value);
    }
    if (valueRef) valueRef.current = next.value;
    queueMicrotask(flushImmediate);
  };

  const updateDraft = (fn) => {
    commitDraft(fn(draftRef.current));
  };

  useEffect(() => {
    if (!draftOverride || typeof draftOverride.value !== 'string') return;
    commitDraft({ value: draftOverride.value, cursor: draftOverride.value.length });
  }, [draftOverride?.id]);

  const submitDraft = (next) => {
    const text = next.value;
    const accepted = onSubmit?.(text) !== false;
    if (!accepted) {
      commitDraft(next);
      return;
    }
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

    const pasteFallback = /[\r\n]/.test(rawInput) && (rawInput.length > 1 || !key.return);
    if (pasteFallback) {
      const pasted = normalizePastedText(rawInput);
      if (pasted) updateDraft((d) => insertText(d, pasted));
      return;
    }

    const returnIndex = rawInput.indexOf('\r');
    if (returnIndex !== -1 && !key.shift && !key.meta) {
      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value);
        if (accepted !== false) {
          const text = draftRef.current.value;
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
      }
      return;
    }

    if (key.downArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(1);
      }
      return;
    }

    if (commandPaletteActive && key.pageUp) {
      onCommandPaletteNavigate?.(-8);
      return;
    }

    if (commandPaletteActive && key.pageDown) {
      onCommandPaletteNavigate?.(8);
      return;
    }

    if (commandPaletteActive && key.home) {
      onCommandPaletteNavigate?.('home');
      return;
    }

    if (commandPaletteActive && key.end) {
      onCommandPaletteNavigate?.('end');
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
        commitDraft({ value: '', cursor: 0 });
        return;
      }
      const currentValue = draftRef.current.value;
      if (currentValue) {
        commitDraft({ value: '', cursor: 0 });
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
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.('right');
        return;
      }
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
  const hintMeta = hintStyle(hintTone);

  return (
    <Box ref={boxRef} flexDirection="row" flexGrow={1} flexShrink={1} backgroundColor={theme.background}>
      <Text color={theme.text} wrap="hard">{renderedValue}</Text>
      {!value && hint ? (
        <Box marginLeft={-1}>
          <Text>
            <Text color={hintMeta.accentColor}>{hintMeta.prefix}</Text>
            <Text color={hintMeta.textColor}> {hint}</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
