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

function truncateText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function SlashCommandPalette({ commands, selectedIndex = 0, title = 'Commands', columns = 80 }) {
  const visible = commands.slice(0, MAX_VISIBLE);
  const labelWidth = Math.min(
    visible.reduce((w, item) => Math.max(w, item.usage.length), 0),
    Math.max(12, Math.floor(columns * 0.28)),
  );
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
          <Text color={theme.claude}>{title}</Text>
          <Text color={theme.subtle}>↑↓ select · Enter run · Tab complete · Esc close</Text>
        </Box>
        {visible.map((item, index) => (
          <CommandRow
            key={item.name}
            command={item}
            isSelected={index === selectedIndex}
            labelWidth={labelWidth}
            descriptionWidth={descriptionWidth}
          />
        ))}
        {commands.length > MAX_VISIBLE ? (
          <Text color={theme.subtle}>1-{MAX_VISIBLE} of {commands.length}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

const CommandRow = React.memo(function CommandRow({ command, isSelected, labelWidth, descriptionWidth }) {
  const label = truncateText(command.usage, labelWidth);
  const description = truncateText(command.description, descriptionWidth);

  return (
    <Box flexDirection="row">
      <Text color={isSelected ? theme.text : theme.inactive}>
        {isSelected ? '→ ' : '  '}
        {label.padEnd(labelWidth)}
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
