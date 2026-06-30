/**
 * components/SlashCommandPalette.jsx — live slash command palette.
 *
 * This is intentionally display-only: PromptInput owns keyboard focus and
 * forwards arrow / enter / escape decisions to App, so the prompt caret stays
 * anchored while the palette updates above it.
 */
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';

const MAX_VISIBLE = 8;
const COMMAND_LABEL_WIDTH = 18;
const SLASH_HELP = '↑/↓ select · ←/→ change · Enter run · Esc cancel';
const SLASH_DESCRIPTION = 'Type to filter · Enter runs the highlighted command.';
const ACRONYM_LABELS = new Map([
  ['mcp', 'MCP'],
]);

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

function padCells(value, width) {
  const text = String(value || '');
  return `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`;
}

function queryMatchesAlias(command, query) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return false;
  return (command?.aliases || []).some((alias) => String(alias || '').toLowerCase().startsWith(needle));
}

function commandDisplayLabel(command, query) {
  const usage = String(command?.usage || command?.name || '').replace(/^\/+/, '');
  const aliasText = command?.showAliasUsage !== false && queryMatchesAlias(command, query) && Array.isArray(command?.aliasUsage) && command.aliasUsage.length > 0
    ? ` (${command.aliasUsage.join(', ')})`
    : '';
  const label = ACRONYM_LABELS.get(usage.toLowerCase()) || (usage ? `${usage.charAt(0).toUpperCase()}${usage.slice(1)}` : usage);
  return `${label}${aliasText}`;
}

export function SlashCommandPalette({ commands, selectedIndex = 0, title = 'Commands', columns = 80, query = '' }) {
  const total = commands.length;
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = Math.max(0, selectedIndex - half);
  let end = Math.min(total, start + MAX_VISIBLE);
  if (end - start < MAX_VISIBLE && start > 0) {
    start = Math.max(0, end - MAX_VISIBLE);
  }
  const visible = commands.slice(start, end);
  const blankRows = Math.max(0, MAX_VISIBLE - visible.length);
  const labelWidth = Math.max(12, Math.min(COMMAND_LABEL_WIDTH, Math.max(12, Math.floor(columns * 0.45))));
  const descriptionWidth = Math.max(0, columns - labelWidth - 12);
  // Standard panel rhythm: title row, blank, description/hint row, blank, content.
  const description = truncateText(SLASH_DESCRIPTION, Math.max(0, columns - 4));
  const titleWidth = stringWidth(String(title || ''));
  const help = truncateText(SLASH_HELP, Math.max(0, columns - titleWidth - 7));

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.promptBorder}
        paddingX={1}
        width="100%"
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle} wrap="truncate">{title}</Text>
          <Text color={theme.subtle} wrap="truncate">{help}</Text>
        </Box>
        <Text> </Text>
        <Text color={theme.subtle}>{description || ' '}</Text>
        <Text> </Text>
        {visible.map((item, index) => (
          <CommandRow
            key={item.name}
            command={item}
            isSelected={start + index === selectedIndex}
            labelWidth={labelWidth}
            descriptionWidth={descriptionWidth}
            query={query}
          />
        ))}
        {Array.from({ length: blankRows }).map((_, index) => (
          <Text key={`blank-${index}`}> </Text>
        ))}
      </Box>
    </Box>
  );
}

const CommandRow = React.memo(function CommandRow({ command, isSelected, labelWidth, descriptionWidth, query }) {
  const label = truncateText(commandDisplayLabel(command, query), labelWidth);
  const description = truncateText(command.description, descriptionWidth);

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isSelected ? theme.userMessageBackground : undefined}>
      <Text color={theme.text}>
        {padCells(label, labelWidth)}
      </Text>
      {description ? (
        <Text color={theme.text}>
          {'  '}
          {description}
        </Text>
      ) : null}
    </Box>
  );
});
