/**
 * components/TextEntryPanel.jsx — inline editor used inside picker workflows.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import {
  caretPosition,
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
        <Text color={theme.inverseText} backgroundColor="rgb(245,245,245)">{displayValue.slice(start, end)}</Text>
      ) : null}
      {displayValue.slice(end)}
      {trailingSpace ? ' ' : ''}
    </>
  );
}

function normalizeInput(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
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

  usePaste((text) => {
    const pasted = normalizeInput(text);
    if (!pasted) return;
    updateDraft((d) => insertText(d, pasted));
  }, { isActive: isRawModeSupported });

  useInput((input, key) => {
    const rawInput = normalizeInput(input);
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(String(input ?? ''))) return;

    if (key.escape) {
      if (selectionRange(draftRef.current)) {
        commitDraft(clearSelection(draftRef.current));
        return;
      }
      onCancel?.();
      return;
    }
    const pasteFallback = rawInput.includes('\n') && (rawInput.length > 1 || !key.return);
    if (pasteFallback) {
      updateDraft((d) => insertText(d, rawInput));
      return;
    }
    if (key.return || rawInput === '\n') {
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
      const pos = caretPosition(d.value, d.cursor, w);
      return pos.row === 0 ? { row: 0, col: labelWidth + pos.col } : pos;
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
  const renderedValue = renderSelectedText(visibleValue, selectionRange(draft), draft.cursor === draft.value.length);
  const action = String(actionLabel || 'save').trim() || 'save';
  const helpText = `Enter to ${action} · Esc to cancel`;

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>
        {hint ? <Text color={theme.subtle}>{hint}</Text> : <Text color={theme.subtle}> </Text>}
        <Box ref={boxRef} flexDirection="row" width="100%" backgroundColor={theme.background}>
          <Text color={theme.inactive}>{promptLabel}</Text>
          <Text color={theme.text} wrap="hard">{renderedValue}</Text>
        </Box>
      </Box>
    </Box>
  );
}
