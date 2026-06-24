/**
 * components/TextEntryPanel.jsx — inline editor used inside picker workflows.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
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

function normalizeInput(text) {
  return String(text ?? '')
    .replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function truncateMiddle(text, width) {
  const value = String(text || '');
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(-width);
  return `…${value.slice(-(width - 1))}`;
}

export function TextEntryPanel({
  title,
  hint = '',
  initialValue = '',
  mask = false,
  columns = 80,
  actionLabel = 'save',
  onSubmit,
  onCancel,
}) {
  const [draft, setDraft] = useState(() => ({ value: String(initialValue || ''), cursor: String(initialValue || '').length }));
  const draftRef = useRef(draft);
  const { isRawModeSupported } = useStdin();
  draftRef.current = draft;

  useEffect(() => {
    const value = String(initialValue || '');
    setDraft({ value, cursor: value.length });
  }, [title, initialValue]);

  const updateDraft = (fn) => {
    setDraft((current) => {
      const next = fn(current);
      draftRef.current = next;
      return next;
    });
  };

  const submit = () => {
    const accepted = onSubmit?.(draftRef.current.value) !== false;
    if (accepted) {
      setDraft({ value: '', cursor: 0 });
    }
  };

  usePaste((text) => {
    const pasted = normalizeInput(text);
    if (!pasted) return;
    updateDraft((d) => ({
      value: d.value.slice(0, d.cursor) + pasted + d.value.slice(d.cursor),
      cursor: d.cursor + pasted.length,
    }));
  }, { isActive: isRawModeSupported });

  useInput((input, key) => {
    const rawInput = normalizeInput(input);
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(String(input ?? ''))) return;

    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.return || rawInput.includes('\n')) {
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
      updateDraft(() => ({ value: '', cursor: 0 }));
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
      updateDraft((d) => ({
        value: d.value.slice(0, d.cursor) + rawInput + d.value.slice(d.cursor),
        cursor: d.cursor + rawInput.length,
      }));
    }
  }, { isActive: isRawModeSupported });

  const visibleValue = mask ? draft.value.replace(/[^\n]/g, '*') : draft.value;
  const before = visibleValue.slice(0, draft.cursor);
  const cursorChar = visibleValue[draft.cursor] || ' ';
  const after = visibleValue.slice(draft.cursor + 1);
  const width = Math.max(8, columns - 8);
  const shownBefore = truncateMiddle(before.replace(/\n/g, ' '), Math.max(0, width - after.length - 1));
  const shownAfter = after.replace(/\n/g, ' ');

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>Enter {actionLabel} · Esc back</Text>
        </Box>
        {hint ? <Text color={theme.inactive}>{hint}</Text> : <Text color={theme.inactive}> </Text>}
        <Text>
          <Text color={theme.inactive}>{'> '}</Text>
          <Text color={theme.text}>{shownBefore}</Text>
          <Text color={theme.inverseText} backgroundColor={theme.promptBorder}>{cursorChar === '\n' ? ' ' : cursorChar}</Text>
          <Text color={theme.text}>{shownAfter}</Text>
        </Text>
      </Box>
    </Box>
  );
}
