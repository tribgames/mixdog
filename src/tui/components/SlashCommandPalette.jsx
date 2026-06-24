/**
 * components/SlashCommandPalette.jsx — live slash command palette.
 *
 * This is intentionally display-only: PromptInput owns keyboard focus and
 * forwards arrow / enter / escape decisions to App, so the prompt caret stays
 * anchored while the palette updates above it.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';

const MAX_VISIBLE = 8;

export function SlashCommandPalette({ commands, selectedIndex = 0, title = 'Commands', columns = 80 }) {
  const visible = commands.slice(0, MAX_VISIBLE);
  const labelWidth = Math.min(
    visible.reduce((w, item) => Math.max(w, item.usage.length), 0),
    Math.max(12, Math.floor(columns * 0.28)),
  );

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
          <Text color={theme.subtle}>↑↓ select · Enter run · Tab complete · Esc close</Text>
        </Box>
        {visible.map((item, index) => (
          <CommandRow
            key={item.name}
            command={item}
            isSelected={index === selectedIndex}
            labelWidth={labelWidth}
          />
        ))}
        {commands.length > MAX_VISIBLE ? (
          <Text color={theme.subtle}>1-{MAX_VISIBLE} of {commands.length}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

const CommandRow = React.memo(function CommandRow({ command, isSelected, labelWidth }) {
  const label = command.usage.length > labelWidth
    ? `${command.usage.slice(0, Math.max(1, labelWidth - 1))}…`
    : command.usage;

  return (
    <Box flexDirection="row">
      <Text color={isSelected ? theme.text : theme.inactive}>
        {isSelected ? '→ ' : '  '}
        {label.padEnd(labelWidth)}
      </Text>
      <Text color={isSelected ? theme.inactive : theme.subtle}>
        {'  '}
        {command.description}
      </Text>
    </Box>
  );
});
