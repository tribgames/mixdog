/**
 * components/Picker.jsx — selectable list picker for slash commands.
 *
 * Renders a bordered, scrollable list of items with up/down navigation,
 * Enter confirm and Escape cancel. Used by /model and /resume to let the
 * user pick from available presets or saved sessions.
 *
 * Keyboard:
 *   ↑ / ↓      — move selection (wraps at ends)
 *   ←          — back to previous picker when available
 *   →          — proceed with the selected item
 *   Enter       — confirm selection, calls onSelect(value)
 *   Escape      — cancel, calls onCancel()
 *   Ctrl+C      — ignored by the TUI so terminal copy behavior can win
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.mjs';

/** Max items visible at once before scrolling kicks in. */
const MAX_VISIBLE = 8;

function truncateText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function Picker({ items, onSelect, onCancel, onBack, onLeft, onRight, title, columns = 80 }) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex((i) => Math.min(Math.max(0, i), Math.max(0, items.length - 1)));
  }, [items.length]);

  useInput(
    useCallback(
      (input, key) => {
        if (key.upArrow) {
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i - 1 + total) % total : 0;
          });
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i + 1) % total : 0;
          });
          return;
        }
        if (key.pageUp) {
          setSelectedIndex((i) => Math.max(0, i - MAX_VISIBLE));
          return;
        }
        if (key.pageDown) {
          setSelectedIndex((i) => Math.min(items.length - 1, i + MAX_VISIBLE));
          return;
        }
        if (key.home) {
          setSelectedIndex(0);
          return;
        }
        if (key.end) {
          setSelectedIndex(items.length - 1);
          return;
        }
        if (key.leftArrow) {
          if (onLeft) onLeft(items[selectedIndex], selectedIndex);
          else if (onBack) onBack(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.rightArrow) {
          if (onRight) onRight(items[selectedIndex], selectedIndex);
          else onSelect(items[selectedIndex].value, items[selectedIndex]);
          return;
        }
        if (key.return) {
          onSelect(items[selectedIndex].value, items[selectedIndex]);
          return;
        }
        if (key.escape) {
          onCancel();
          return;
        }
      },
      [items, selectedIndex, onSelect, onCancel, onBack, onLeft, onRight],
    ),
  );

  // Clamp selected index when items change length.
  if (items.length === 0) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.subtle}
          paddingX={1}
          height={4}
          width="100%"
        >
          <Text color={theme.panelTitle}>{title || 'Picker'}</Text>
          <Text color={theme.inactive}> (empty) </Text>
        </Box>
      </Box>
    );
  }

  // Scroll window centered on the selected item.
  const total = items.length;
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = Math.max(0, selectedIndex - half);
  let end = Math.min(total, start + MAX_VISIBLE);
  if (end - start < MAX_VISIBLE && start > 0) {
    start = Math.max(0, end - MAX_VISIBLE);
  }
  const visible = items.slice(start, end);

  // Compute max label width for alignment.
  const maxLabelWidth = visible.reduce((w, item) => Math.max(w, item.label.length), 0);
  const labelWidth = Math.min(maxLabelWidth, Math.max(12, Math.floor(columns * 0.32)));
  const descriptionWidth = Math.max(0, columns - labelWidth - 10);

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.promptBorder}
        paddingX={1}
        width="100%"
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>↑↓ · ← back · →/Enter open · Esc cancel</Text>
        </Box>
        {visible.map((item, i) => {
          const idx = start + i;
          const isSelected = idx === selectedIndex;
          return (
            <ItemRow
              key={item.value}
              label={item.label}
              description={item.description}
              labelWidth={labelWidth}
              descriptionWidth={descriptionWidth}
              isSelected={isSelected}
            />
          );
        })}
      </Box>
    </Box>
  );
}

const ItemRow = React.memo(function ItemRow({ label, description, labelWidth, descriptionWidth, isSelected }) {
  const displayLabel = truncateText(label, labelWidth);
  const displayDescription = truncateText(description, descriptionWidth);

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isSelected ? theme.userMessageBackground : undefined}>
      <Text color={isSelected ? theme.text : theme.inactive}>
        {isSelected ? '→ ' : '  '}
        {displayLabel.padEnd(labelWidth)}
      </Text>
      {displayDescription ? (
        <Text color={isSelected ? theme.text : theme.inactive}>
          {'  '}
          {displayDescription}
        </Text>
      ) : null}
    </Box>
  );
});
