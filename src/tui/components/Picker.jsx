/**
 * components/Picker.jsx — selectable list picker for slash commands.
 *
 * Renders a bordered, scrollable list of items with up/down navigation,
 * Enter confirm and Escape cancel. Used by /model and /resume to let the
 * user pick from available presets or saved sessions.
 *
 * Keyboard:
 *   ↑ / ↓      — move selection (wraps at ends)
 *   Enter       — confirm selection, calls onSelect(value)
 *   Escape      — cancel, calls onCancel()
 *   Ctrl+C      — falls through to App's exit handler (not intercepted)
 */
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.mjs';

/** Max items visible at once before scrolling kicks in. */
const MAX_VISIBLE = 8;

export function Picker({ items, onSelect, onCancel, title, columns = 80 }) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    useCallback(
      (input, key) => {
        if (key.upArrow) {
          setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0));
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
      [items, selectedIndex, onSelect, onCancel],
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
          height={3}
        >
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
          <Text color={theme.claude}>{title}</Text>
          <Text color={theme.subtle}>↑↓ select · Enter choose · Esc cancel</Text>
        </Box>
        {visible.map((item, i) => {
          const idx = start + i;
          const isSelected = idx === selectedIndex;
          return (
            <ItemRow
              key={item.value}
              label={item.label}
              description={item.description}
              labelWidth={Math.min(maxLabelWidth, Math.max(12, Math.floor(columns * 0.32)))}
              isSelected={isSelected}
            />
          );
        })}
        {total > MAX_VISIBLE ? (
          <Box>
            <Text color={theme.subtle}>
              {start + 1}–{Math.min(end, total)} of {total}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

const ItemRow = React.memo(function ItemRow({ label, description, labelWidth, isSelected }) {
  const displayLabel = label.length > labelWidth
    ? label.slice(0, Math.max(1, labelWidth - 1)) + '…'
    : label;

  return (
    <Box flexDirection="row">
      <Text color={isSelected ? theme.text : theme.inactive}>
        {isSelected ? '→ ' : '  '}
        {displayLabel.padEnd(labelWidth)}
      </Text>
      {description ? (
        <Text color={isSelected ? theme.inactive : theme.subtle}>
          {'  '}
          {description}
        </Text>
      ) : null}
    </Box>
  );
});
