/**
 * components/TextEntryPanel.jsx — inline editor used inside picker workflows.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import {
  clearSelection,
  deleteBackwardWord,
  deleteForwardWord,
  deleteSelectedText,
  deleteToLineEnd,
  deleteToLineStart,
  lineEnd,
  lineStart,
  moveCursor,
  nextOffset,
  nextWordOffset,
  previousOffset,
  previousWordOffset,
  replaceSelection,
  selectionRange,
  verticalOffset,
} from '../input-editing.mjs';

function insertText(draft, input) {
  if (!input) return draft;
  return replaceSelection(draft, input);
}

function renderSelectedText(displayValue, range, trailingSpace = false) {
  if (!range) return trailingSpace ? `${displayValue} ` : displayValue;
  const start = Math.max(0, Math.min(displayValue.length, range.start));
  const end = Math.max(start, Math.min(displayValue.length, range.end));
  return (
    <>
      {start > 0 ? displayValue.slice(0, start) : null}
      {end > start ? (
        <Text color={theme.selectionText} backgroundColor={theme.selectionBackground}>{displayValue.slice(start, end)}</Text>
      ) : null}
      {displayValue.slice(end)}
      {trailingSpace ? ' ' : ''}
    </>
  );
}

function normalizeInput(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

// Collapse newlines to a single visible glyph so multiline pasted input stays a
// single visual row (the draft itself is unchanged for editing/submit).
const NEWLINE_GLYPH = '⏎';
function flattenForSingleLine(text) {
  return String(text ?? '').replace(/\n/g, NEWLINE_GLYPH);
}

// Horizontal viewport over a single (flattened) line. Keeps the caret visible
// inside `width` cells and returns the visible slice plus the caret column so
// the content box can be hard-bounded to ONE row: long/multiline pasted input
// scrolls horizontally instead of wrapping and growing the panel. Offsets are
// code-unit offsets, which map 1:1 to the flattened string (newline → 1 glyph,
// mask → 1 char), so selection/cursor offsets carry over unchanged.
function windowSingleLine(flat, cursor, width) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const chars = Array.from(flat);
  const cells = chars.map((ch) => stringWidth(ch));
  // Map the code-unit cursor to a char index.
  let cuIndex = 0;
  let cursorCharIdx = chars.length;
  for (let i = 0; i < chars.length; i += 1) {
    if (cuIndex >= cursor) { cursorCharIdx = i; break; }
    cuIndex += chars[i].length;
  }
  let cursorCell = 0;
  for (let i = 0; i < cursorCharIdx; i += 1) cursorCell += cells[i];
  const totalCell = cells.reduce((a, b) => a + b, 0);
  let startCell = cursorCell > w - 1 ? cursorCell - (w - 1) : 0;
  startCell = Math.min(startCell, Math.max(0, totalCell - w));
  startCell = Math.max(0, startCell);
  let acc = 0;
  let a = 0;
  while (a < chars.length && acc + cells[a] <= startCell) { acc += cells[a]; a += 1; }
  const alignedStart = acc;
  let b = a;
  let bAcc = 0;
  while (b < chars.length && bAcc + cells[b] <= w) { bAcc += cells[b]; b += 1; }
  let cuStart = 0;
  for (let i = 0; i < a; i += 1) cuStart += chars[i].length;
  let cuEnd = cuStart;
  for (let i = a; i < b; i += 1) cuEnd += chars[i].length;
  return {
    text: chars.slice(a, b).join(''),
    cuStart,
    cuEnd,
    startCell: alignedStart,
    caretCol: Math.max(0, cursorCell - alignedStart),
  };
}

// Collapse any whitespace/newlines so a hint is always a single visual line.
function singleLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// Width-aware single-line truncation with an ellipsis so a long hint (e.g. an
// OAuth manual URL) can never wrap into extra rows and overflow the panel.
function truncateText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return '…'.repeat(Math.max(0, width));
  let out = '';
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}

function singleTrailingLineBreakPrefix(text) {
  const normalized = normalizeInput(text);
  if (!normalized.endsWith('\n')) return null;
  const prefix = normalized.slice(0, -1);
  return prefix.includes('\n') ? null : prefix;
}

// Recognize a MODIFIED Enter (Ctrl+Enter or Shift+Enter) delivered via the kitty
// keyboard protocol (\x1b[13;<mod>u) or modifyOtherKeys (\x1b[27;<mod>;13~). The
// xterm modifier param is (1 + bitmask): shift=1, alt=2, ctrl=4. We match when
// the shift OR ctrl bit is set so both chords insert a newline. Ctrl+J is the
// protocol-independent fallback, handled separately.
const MODIFIED_ENTER_SHIFT_OR_CTRL = 1 | 4;
function isModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return ((Number(kitty[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && (((Number(modifyOtherKeys[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0));
}

export function TextEntryPanel({
  title,
  hint = '',
  initialValue = '',
  mask = false,
  columns = 80,
  actionLabel = 'save',
  promptLabel = '> ',
  onSubmit,
  onCancel,
}) {
  const [draft, setDraft] = useState(() => ({ value: String(initialValue || ''), cursor: String(initialValue || '').length, selectionAnchor: null }));
  const [, bumpCursorAnchorEpoch] = useState(0);
  const draftRef = useRef(draft);
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false);
  const contentWidthRef = useRef(80);
  const preferredColumnRef = useRef(null);
  const { isRawModeSupported } = useStdin();
  draftRef.current = draft;

  const flushImmediate = () => {
    let node = boxRef.current;
    for (let i = 0; node && i < 64; i += 1) {
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
    queueMicrotask(flushImmediate);
  };

  const updateDraft = (fn, options = {}) => {
    commitDraft(fn(draftRef.current), options);
  };

  const moveDraftVertically = (direction, { extend = false } = {}) => {
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
    commitDraft(moveCursor(current, moved.cursor, { extend }), { keepPreferredColumn: true });
    return true;
  };

  useEffect(() => {
    const value = String(initialValue || '');
    commitDraft({ value, cursor: value.length, selectionAnchor: null });
  }, [title, initialValue]);

  const submit = () => {
    const accepted = onSubmit?.(draftRef.current.value) !== false;
    if (accepted) {
      commitDraft({ value: '', cursor: 0, selectionAnchor: null });
    }
  };

  const submitEnterChunk = (prefix = '') => {
    const current = draftRef.current;
    const next = prefix ? insertText(current, prefix) : current;
    const accepted = onSubmit?.(next.value) !== false;
    if (accepted) {
      commitDraft({ value: '', cursor: 0, selectionAnchor: null });
    } else if (next !== current) {
      commitDraft(next);
    }
  };

  usePaste((text) => {
    const pasted = normalizeInput(text);
    if (!pasted) return;
    updateDraft((d) => insertText(d, pasted));
  }, { isActive: isRawModeSupported });

  useInput((input, key) => {
    const rawSource = String(input ?? '');
    const rawInput = normalizeInput(input);
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawSource)) return;
    // Drop keyboard-protocol negotiation replies (kitty-flags \x1b[?<n>u / DA1
    // \x1b[?...c) so they're never typed into the field. See PromptInput for the
    // full rationale — ink fans the query reply out to every 'input' listener.
    if (/^(?:\x1b)?\[\?[\d;]*[uc]$/.test(rawSource)) return;

    if (key.escape) {
      if (selectionRange(draftRef.current)) {
        commitDraft(clearSelection(draftRef.current));
        return;
      }
      onCancel?.();
      return;
    }
    const trailingEnterPrefix = singleTrailingLineBreakPrefix(rawInput);
    const rawCtrlEnter = isModifiedEnterSequence(rawSource) || isModifiedEnterSequence(rawInput);
    const modifiedLineBreak = key.shift || key.meta || key.ctrl || rawCtrlEnter;

    // Ctrl+J (0x0A) — the protocol-independent newline. It arrives as a lone
    // '\n' on every terminal; a real Enter is CR (ink marks key.return), and a
    // multi-char paste is length > 1. A lone '\n' without key.return is Ctrl+J →
    // insert a newline. Must precede the trailing-newline/submit paths, since
    // singleTrailingLineBreakPrefix('\n') returns '' (not null) and would
    // otherwise route Ctrl+J to submit.
    if (rawSource === '\n' && !key.return) {
      updateDraft((d) => replaceSelection(d, '\n'));
      return;
    }

    const pasteFallback = rawInput.includes('\n') && trailingEnterPrefix === null && (rawInput.length > 1 || !key.return);
    if (pasteFallback) {
      updateDraft((d) => insertText(d, rawInput));
      return;
    }
    if (trailingEnterPrefix !== null) {
      if (modifiedLineBreak) {
        updateDraft((d) => insertText(d, `${trailingEnterPrefix}\n`));
        return;
      }
      submitEnterChunk(trailingEnterPrefix);
      return;
    }
    if (rawCtrlEnter) {
      updateDraft((d) => replaceSelection(d, '\n'));
      return;
    }
    if (key.return) {
      if (modifiedLineBreak) {
        updateDraft((d) => replaceSelection(d, '\n'));
        return;
      }
      submit();
      return;
    }
    if (key.leftArrow) {
      updateDraft((d) => {
        const range = !key.shift && !key.ctrl && !key.meta ? selectionRange(d) : null;
        const cursor = range
          ? range.start
          : key.ctrl || key.meta
            ? previousWordOffset(d.value, d.cursor)
            : previousOffset(d.value, d.cursor);
        return moveCursor(d, cursor, { extend: key.shift });
      });
      return;
    }
    if (key.rightArrow) {
      updateDraft((d) => {
        const range = !key.shift && !key.ctrl && !key.meta ? selectionRange(d) : null;
        const cursor = range
          ? range.end
          : key.ctrl || key.meta
            ? nextWordOffset(d.value, d.cursor)
            : nextOffset(d.value, d.cursor);
        return moveCursor(d, cursor, { extend: key.shift });
      });
      return;
    }
    if (key.upArrow) {
      moveDraftVertically(-1, { extend: key.shift });
      return;
    }
    if (key.downArrow) {
      moveDraftVertically(1, { extend: key.shift });
      return;
    }
    const inputKey = String(input || '').toLowerCase();
    if (key.home || (key.ctrl && inputKey === 'a')) {
      updateDraft((d) => (key.ctrl && inputKey === 'a' && d.value
        ? { ...d, cursor: d.value.length, selectionAnchor: 0 }
        : moveCursor(d, lineStart(d.value, d.cursor), { extend: key.shift })));
      return;
    }
    if (key.end || (key.ctrl && inputKey === 'e')) {
      updateDraft((d) => moveCursor(d, lineEnd(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.ctrl && inputKey === 'b') {
      updateDraft((d) => moveCursor(d, previousOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.ctrl && inputKey === 'f') {
      updateDraft((d) => moveCursor(d, nextOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.meta && inputKey === 'b') {
      updateDraft((d) => moveCursor(d, previousWordOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.meta && inputKey === 'f') {
      updateDraft((d) => moveCursor(d, nextWordOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.ctrl && inputKey === 'u') {
      updateDraft(deleteToLineStart);
      return;
    }
    if (key.ctrl && inputKey === 'k') {
      updateDraft(deleteToLineEnd);
      return;
    }
    if ((key.ctrl && inputKey === 'w') || ((key.ctrl || key.meta) && key.backspace)) {
      updateDraft(deleteBackwardWord);
      return;
    }
    if ((key.meta && inputKey === 'd') || (key.ctrl && key.delete)) {
      updateDraft(deleteForwardWord);
      return;
    }
    if (key.backspace) {
      updateDraft((d) => {
        if (selectionRange(d)) return deleteSelectedText(d);
        if (d.cursor <= 0) return d;
        const start = previousOffset(d.value, d.cursor);
        return { value: d.value.slice(0, start) + d.value.slice(d.cursor), cursor: start, selectionAnchor: null };
      });
      return;
    }
    if (key.delete) {
      updateDraft((d) => {
        if (selectionRange(d)) return deleteSelectedText(d);
        if (d.cursor >= d.value.length) return d;
        const end = nextOffset(d.value, d.cursor);
        return { value: d.value.slice(0, d.cursor) + d.value.slice(end), cursor: d.cursor, selectionAnchor: null };
      });
      return;
    }
    if (rawInput && !key.ctrl && !key.meta) {
      updateDraft((d) => insertText(d, rawInput));
    }
  }, { isActive: isRawModeSupported });

  const installCursorAnchor = () => {
    if (!boxRef.current || boxRef.current.internal_cursorAnchor) return false;
    boxRef.current.internal_cursorAnchor = (yogaNode) => {
      if (!cursorEnabledRef.current) return null;
      const d = draftRef.current;
      const labelWidth = stringWidth(String(promptLabel || ''));
      const w = Math.max(1, (yogaNode?.getComputedWidth?.() ?? columns) - labelWidth);
      contentWidthRef.current = w;
      // The content area is hard-bounded to ONE row (see render): newlines are
      // flattened to a glyph and the line scrolls horizontally. So the caret is
      // always on row 0, at the windowed caret column past the prompt label.
      const visible = mask ? d.value.replace(/[^\n]/g, '*') : d.value;
      const flat = flattenForSingleLine(visible);
      const win = windowSingleLine(flat, d.cursor, w);
      return { row: 0, col: labelWidth + win.caretCol };
    };
    return true;
  };

  cursorEnabledRef.current = isRawModeSupported;
  installCursorAnchor();

  useLayoutEffect(() => {
    if (!installCursorAnchor()) return;
    bumpCursorAnchorEpoch((epoch) => epoch + 1);
    queueMicrotask(flushImmediate);
  }, []);

  useLayoutEffect(() => {
    if (!isRawModeSupported) return;
    queueMicrotask(flushImmediate);
  }, [isRawModeSupported, title]);

  const visibleValue = mask ? draft.value.replace(/[^\n]/g, '*') : draft.value;
  // Hard-bound the content to the ONE reserved row: flatten newlines to a glyph
  // and take a horizontal window around the caret so long/multiline pasted
  // input scrolls sideways instead of wrapping and growing the panel (which
  // would top-clip the title). Offsets map 1:1 to the flattened string, so the
  // selection highlight stays aligned. The full draft value is preserved for
  // editing and submit; only the rendered slice is clipped.
  const labelCells = stringWidth(String(promptLabel || ''));
  const contentCells = Math.max(1, columns - 2 - labelCells);
  const flatValue = flattenForSingleLine(visibleValue);
  const win = windowSingleLine(flatValue, draft.cursor, contentCells);
  const windowSelection = (() => {
    const range = selectionRange(draft);
    if (!range) return null;
    const start = Math.max(win.cuStart, Math.min(win.cuEnd, range.start)) - win.cuStart;
    const end = Math.max(win.cuStart, Math.min(win.cuEnd, range.end)) - win.cuStart;
    return end > start ? { start, end } : null;
  })();
  const trailingCaret = draft.cursor === draft.value.length && win.cuEnd >= flatValue.length;
  const renderedValue = renderSelectedText(win.text, windowSelection, trailingCaret);
  const action = String(actionLabel || 'save').trim() || 'save';
  const helpText = `Enter to ${action} · Esc to cancel`;
  // Standard panel rhythm: title row, blank, single-line hint, blank, content.
  // The hint is collapsed to one line and width-truncated so a long manual
  // OAuth URL can never wrap and push the bordered title off the top.
  const hintText = truncateText(singleLine(hint), Math.max(0, columns - 4));

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>
        <Text> </Text>
        <Text color={theme.subtle}>{hintText || ' '}</Text>
        <Text> </Text>
        <Box ref={boxRef} flexDirection="row" width="100%" backgroundColor={theme.background}>
          <Text color={theme.inactive}>{promptLabel}</Text>
          <Text color={theme.text} wrap="truncate">{renderedValue}</Text>
        </Box>
      </Box>
    </Box>
  );
}
