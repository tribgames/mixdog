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
import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import {
  caretPosition,
  deleteBackwardWord,
  deleteForwardWord,
  deleteToLineEnd,
  deleteToLineStart,
  lineEnd,
  lineStart,
  nextOffset,
  nextWordOffset,
  previousOffset,
  previousWordOffset,
  verticalOffset,
} from '../input-editing.mjs';

function hintStyle(tone) {
  if (tone === 'error') return { textColor: theme.error };
  if (tone === 'warn' || tone === 'cancel') return { textColor: theme.warning };
  if (tone === 'plain') return { textColor: theme.subtle };
  return { textColor: theme.inactive };
}

function insertText(draft, input) {
  if (!input) return draft;
  return {
    value: draft.value.slice(0, draft.cursor) + input + draft.value.slice(draft.cursor),
    cursor: draft.cursor + input.length,
  };
}

function normalizePastedText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function PromptInput({
  onSubmit,
  disabled = false,
  onDraftChange,
  interruptActive = false,
  onInterrupt,
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
  onRestoreQueued,
  onPasteText,
  valueRef,
}) {
  const [draft, setDraft] = useState(() => {
    const value = String(initialValue || '');
    return { value, cursor: value.length };
  });
  const [, bumpCursorAnchorEpoch] = useState(0);
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
  const contentWidthRef = useRef(80);
  const preferredColumnRef = useRef(null);
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

  const commitDraft = (next, options = {}) => {
    if (!options.keepPreferredColumn) preferredColumnRef.current = null;
    draftRef.current = next;
    setDraft(next);
    if (next.value !== lastReportedValueRef.current) {
      lastReportedValueRef.current = next.value;
      onDraftChange?.(next.value);
    }
    if (valueRef) valueRef.current = next.value;
  };

  const installCursorAnchor = () => {
    if (!boxRef.current || boxRef.current.internal_cursorAnchor) return false;
    boxRef.current.internal_cursorAnchor = (yogaNode) => {
      if (!cursorEnabledRef.current) return null;
      const d = draftRef.current;
      const w = yogaNode?.getComputedWidth?.() ?? 0;
      contentWidthRef.current = Math.max(1, w || contentWidthRef.current || 80);
      return w > 0
        ? caretPosition(d.value, d.cursor, w)
        : { row: 0, col: stringWidth(d.value.slice(0, d.cursor)) };
    };
    return true;
  };

  const updateDraft = (fn, options = {}) => {
    commitDraft(fn(draftRef.current), options);
  };

  const moveDraftVertically = (direction) => {
    const current = draftRef.current;
    const moved = verticalOffset(
      current.value,
      current.cursor,
      contentWidthRef.current,
      direction,
      preferredColumnRef.current,
    );
    preferredColumnRef.current = moved.preferredColumn;
    if (moved.cursor === current.cursor) return false;
    commitDraft({ ...current, cursor: moved.cursor }, { keepPreferredColumn: true });
    return true;
  };

  const restoreQueuedToDraft = () => {
    return onRestoreQueued?.(draftRef.current.value) === true;
  };

  const insertAtDraft = (text) => {
    const value = String(text ?? '');
    if (!value) return;
    commitDraft(insertText(draftRef.current, value));
  };

  const handleExternalPaste = (text, meta = {}) => {
    const pasted = normalizePastedText(text);
    const fallback = () => { if (pasted) insertAtDraft(pasted); };
    let handled;
    try {
      handled = onPasteText?.(pasted, meta);
    } catch {
      fallback();
      return;
    }
    const apply = (replacement) => {
      if (typeof replacement === 'string') {
        insertAtDraft(replacement);
        return;
      }
      if (replacement === false) return;
      fallback();
    };
    if (handled && typeof handled.then === 'function') {
      handled.then(apply).catch(fallback);
    } else {
      apply(handled);
    }
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
    handleExternalPaste(text, { source: 'paste' });
  }, { isActive: isRawModeSupported && !disabled });

  useInput((input, key) => {
    if (disabled) return;

    const rawInput = String(input ?? '');
    const inputKey = rawInput.toLowerCase();

    // Drop SGR mouse-tracking sequences (wheel/click). The App enables mouse
    // tracking for transcript scrolling and parses these off raw stdin itself;
    // ink still forwards the bytes here as "input", which would otherwise type
    // garbage like `[<64;55;22M` into the prompt. Match with or without the
    // leading ESC (terminals/ink may strip it): CSI '<' … final 'M'/'m'.
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawInput) || /^\[?<\d+;\d+;\d+[Mm]?$/.test(rawInput)) {
      return;
    }

    const rawUpArrow = rawInput === '\x1b[A' || rawInput === '\x1bOA' || rawInput === '[A' || rawInput === 'OA';
    const rawDownArrow = rawInput === '\x1b[B' || rawInput === '\x1bOB' || rawInput === '[B' || rawInput === 'OB';
    const lineBreakIndex = rawInput.search(/[\r\n]/);
    const rawEnter = rawInput === '\r' || rawInput === '\n' || rawInput === '\r\n';

    const pasteFallback = lineBreakIndex !== -1 && !rawEnter && (rawInput.length > 1 || !key.return);
    if (pasteFallback) {
      handleExternalPaste(rawInput, { source: 'paste-fallback' });
      return;
    }

    if (lineBreakIndex !== -1 && !key.shift && !key.meta && (key.return || rawEnter)) {
      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value);
        if (accepted !== false) {
          const text = draftRef.current.value;
          commitDraft({ value: '', cursor: 0 });
        }
        return;
      }
      submitDraft(insertText(draftRef.current, rawInput.slice(0, lineBreakIndex)));
      return;
    }

    if (!commandPaletteActive && ((key.ctrl && inputKey === 'v') || (key.meta && inputKey === 'v'))) {
      handleExternalPaste('', { source: 'clipboard-image-shortcut' });
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

    if (key.upArrow || rawUpArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(-1);
      } else {
        if (!restoreQueuedToDraft()) moveDraftVertically(-1);
      }
      return;
    }

    if (key.downArrow || rawDownArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(1);
      } else {
        moveDraftVertically(1);
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
      if (onEscape?.(currentValue, { phase: 'before' }) === true) {
        return;
      }
      if (currentValue) {
        onEscape?.(currentValue, { phase: 'clear' });
        commitDraft({ value: '', cursor: 0 });
        return;
      }
      if (interruptActive) {
        const restoredText = onInterrupt?.('');
        if (typeof restoredText === 'string') {
          commitDraft({ value: restoredText, cursor: restoredText.length });
        }
        return;
      }
      if (restoreQueuedToDraft()) {
        return;
      }
      onEscape?.('', { phase: 'empty' });
      return;
    }

    if (key.leftArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.('left');
        return;
      }
      updateDraft((d) => ({
        ...d,
        cursor: key.ctrl || key.meta
          ? previousWordOffset(d.value, d.cursor)
          : previousOffset(d.value, d.cursor),
      }));
      return;
    }
    if (key.rightArrow) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.('right');
        return;
      }
      updateDraft((d) => ({
        ...d,
        cursor: key.ctrl || key.meta
          ? nextWordOffset(d.value, d.cursor)
          : nextOffset(d.value, d.cursor),
      }));
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

    const editingKey = String(input || '').toLowerCase();

    // ctrl+a / ctrl+e — line home / line end (common readline bindings).
    if (key.ctrl && editingKey === 'a') {
      updateDraft((d) => ({ ...d, cursor: lineStart(d.value, d.cursor) }));
      return;
    }
    if (key.ctrl && editingKey === 'e') {
      updateDraft((d) => ({ ...d, cursor: lineEnd(d.value, d.cursor) }));
      return;
    }
    // ctrl+b / ctrl+f — character left / right.
    if (key.ctrl && editingKey === 'b') {
      updateDraft((d) => ({ ...d, cursor: previousOffset(d.value, d.cursor) }));
      return;
    }
    if (key.ctrl && editingKey === 'f') {
      updateDraft((d) => ({ ...d, cursor: nextOffset(d.value, d.cursor) }));
      return;
    }
    // alt/option+b / alt/option+f — word left / right.
    if (key.meta && editingKey === 'b') {
      updateDraft((d) => ({ ...d, cursor: previousWordOffset(d.value, d.cursor) }));
      return;
    }
    if (key.meta && editingKey === 'f') {
      updateDraft((d) => ({ ...d, cursor: nextWordOffset(d.value, d.cursor) }));
      return;
    }
    // ctrl+u / ctrl+k — delete to line start / end.
    if (key.ctrl && editingKey === 'u') {
      updateDraft(deleteToLineStart);
      return;
    }
    if (key.ctrl && editingKey === 'k') {
      updateDraft(deleteToLineEnd);
      return;
    }
    // ctrl+w / alt+backspace — delete previous word.
    if ((key.ctrl && editingKey === 'w') || ((key.ctrl || key.meta) && key.backspace)) {
      updateDraft(deleteBackwardWord);
      return;
    }
    // alt+d / ctrl+delete — delete next word.
    if ((key.meta && editingKey === 'd') || (key.ctrl && key.delete)) {
      updateDraft(deleteForwardWord);
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

    // Printable input (ignore other control keys). Strip any embedded SGR mouse
    // sequences as a belt-and-suspenders guard (the early return above catches
    // whole-sequence inputs; this removes partials that rode in with real text).
    const printable = rawInput
      .replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '')
      .replace(/[\r\n]/g, '');
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
  installCursorAnchor();

  useLayoutEffect(() => {
    if (!installCursorAnchor()) return;
    bumpCursorAnchorEpoch((epoch) => epoch + 1);
    queueMicrotask(flushImmediate);
  }, []);

  useLayoutEffect(() => {
    if (disabled || !isRawModeSupported) return;
    queueMicrotask(flushImmediate);
  }, [disabled, isRawModeSupported]);

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
          <Text color={hintMeta.textColor}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
