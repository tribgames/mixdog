/**
 * components/ConfirmBar.jsx — horizontal text-button bar for onboarding steps.
 *
 * Pure render + helpers. Owns NO keyboard state: the parent Picker manages
 * `focusedIndex` (0..n-1) and dispatches Enter to `onConfirm`. Kept side-effect
 * free so it can be reused under any picker without stealing input focus.
 *
 * Props:
 *   buttons:      [{ value, label }]  — button descriptors
 *   focusedIndex: number              — highlighted button (-1 = none/list focus)
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

/** Clamp a focus index into the valid button range, or -1 when list-focused. */
export function clampConfirmFocus(index, count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return -1;
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0) return -1;
  return Math.min(i, n - 1);
}

export function ConfirmBar({ buttons = [], focusedIndex = -1 }) {
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if (list.length === 0) return null;
  return (
    <Box flexDirection="row" width="100%" justifyContent="flex-end">
      {list.map((button, index) => {
        const isFocused = index === focusedIndex;
        return (
          <Text key={button.value ?? index}>
            {index > 0 ? <Text color={theme.subtle}>{'   '}</Text> : null}
            <Text
              color={isFocused ? theme.selectionText : theme.text}
              backgroundColor={isFocused ? theme.selectionBackground : undefined}
              bold={isFocused}
            >
              {` ${button.label} `}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
