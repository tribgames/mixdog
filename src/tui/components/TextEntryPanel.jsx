/**
 * components/TextEntryPanel.jsx — inline editor used inside picker workflows.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

function insertText(draft, input) {
  if (!input) return draft;
  return {
    value: draft.value.slice(0, draft.cursor) + input + draft.value.slice(draft.cursor),
    cursor: draft.cursor + input.length,
  };
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
  const [draft, setDraft] = useState(() => ({ value: String(initialValue || ''), cursor: String(initialValue || '').length }));
  const [, bumpCursorAnchorEpoch] = useState(0);
  const draftRef = useRef(draft);
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false);
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

  const commitDraft = (next) => {
    draftRef.current = next;
    setDraft(next);
    queueMicrotask(flushImmediate);
  };

  const updateDraft = (fn) => {
    commitDraft(fn(draftRef.current));
  };

  useEffect(() => {
    const value = String(initialValue || '');
    commitDraft({ value, cursor: value.length });
  }, [title, initialValue]);

  const submit = () => {
    const accepted = onSubmit?.(draftRef.current.value) !== false;
    if (accepted) {
      commitDraft({ value: '', cursor: 0 });
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
      updateDraft((d) => ({ ...d, cursor: previousOffset(d.value, d.cursor) }));
      return;
    }
    if (key.rightArrow) {
      updateDraft((d) => ({ ...d, cursor: nextOffset(d.value, d.cursor) }));
      return;
    }
    if (key.home || (key.ctrl && input === 'a')) {
      updateDraft((d) => ({ ...d, cursor: 0 }));
      return;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      updateDraft((d) => ({ ...d, cursor: d.value.length }));
      return;
    }
    if (key.ctrl && input === 'u') {
      commitDraft({ value: '', cursor: 0 });
      return;
    }
    if (key.backspace) {
      updateDraft((d) => {
        if (d.cursor <= 0) return d;
        const start = previousOffset(d.value, d.cursor);
        return { value: d.value.slice(0, start) + d.value.slice(d.cursor), cursor: start };
      });
      return;
    }
    if (key.delete) {
      updateDraft((d) => {
        if (d.cursor >= d.value.length) return d;
        const end = nextOffset(d.value, d.cursor);
        return { value: d.value.slice(0, d.cursor) + d.value.slice(end), cursor: d.cursor };
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
  const renderedValue = draft.cursor === draft.value.length ? `${visibleValue} ` : visibleValue;
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
