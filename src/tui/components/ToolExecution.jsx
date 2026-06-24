/**
 * components/ToolExecution.jsx — a tool call + its result.
 *
 * Ported from Claude Code's AssistantToolUseMessage.tsx / MessageResponse.tsx:
 *   - The call line: `● Tool Name(summary)` where the dot is BLACK_CIRCLE
 *     (2-wide gutter), the tool name is the user-facing label and the argument
 *     summary sits in muted parentheses. NOT raw MCP/internal names.
 *   - The result hangs under a single dim `  ⎿  ` gutter — the gutter is placed
 *     once, not repeated per wrapped line (CC MessageResponse.tsx style).
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme, TURN_MARKER } from '../theme.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  summarizeToolArgs as surfaceSummarizeToolArgs,
} from '../../runtime/shared/tool-surface.mjs';

const MIN_RESULT_LINE_CHARS = 24;

export function displayToolName(name, args) {
  return surfaceDisplayToolName(name, args);
}

/** Claude Code-style one-line renderToolUseMessage summary. */
export function summarizeArgs(name, args) {
  return surfaceSummarizeToolArgs(name, args);
}

export const MAX_RESULT_LINES = 8;
const TOOL_BLINK_MS = 500;
const TOOL_HINT_DONE_COLOR = theme.subtle;

function plural(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

function statusCopy(normalizedName, label, count, doneCount, pending, isError) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  const completed = Math.max(0, Number(doneCount || 0));
  const suffix = pending && completed > 0 ? ` · ${completed}/${count} done` : '';

  const copy = (active, done, noun, pluralNoun = `${noun}s`) => {
    const object = `${count} ${plural(count, noun, pluralNoun)}`;
    if (count === 1) return pending ? active : done;
    return `${pending ? active : done} ${object}${suffix}`;
  };

  switch (n) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return copy('Reading', 'Read', 'file');
    case 'write':
    case 'edit':
    case 'apply_patch':
      return copy('Editing', 'Edited', 'file');
    case 'grep':
    case 'glob':
    case 'search':
    case 'tool_search':
      return copy('Searching', 'Searched', 'tool');
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return copy('Running', 'Ran', 'command');
    case 'list':
    case 'ls':
      return copy('Listing', 'Listed', 'directory', 'directories');
    case 'recall':
    case 'recall_memory':
    case 'search_memories':
      return copy('Searching', 'Searched', 'memory', 'memories');
    case 'remember':
    case 'save_memory':
    case 'update_memory':
      return copy('Writing', 'Wrote', 'memory', 'memories');
    default:
      if (l === 'search' || l === 'web search') return copy('Searching', 'Searched', 'tool');
      if (l === 'update') return copy('Editing', 'Edited', 'file');
      if (l === 'read') return copy('Reading', 'Read', 'file');
      if (l === 'run') return copy('Running', 'Ran', 'command');
      if (l === 'setup') return copy('Setting up', 'Set up', 'item');
      if (l === 'memory') return copy('Using', 'Used', 'memory', 'memories');
      if (l === 'agent') return copy('Running', 'Ran', 'agent');
      return copy('Calling', 'Called', 'tool');
  }
}

function fitResultLine(line, columns) {
  const max = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const text = String(line ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function ToolExecution({ name, args, result, isError, expanded, globalExpanded = false, columns = 80, attached = false, count = 1, completedCount = 0 }) {
  const [blinkOn, setBlinkOn] = useState(true);
  const { label, summary, normalizedName } = formatToolSurface(name, args);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const resultText = result == null ? null : String(result).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const grouped = groupCount > 1;
  const hasResult = result != null && String(resultText || '').trim();
  const lines = resultText ? resultText.split('\n') : [];
  const totalLines = lines.length;
  const shortOneLineResult = totalLines === 1 && String(resultText || '').length <= Math.max(40, Number(columns || 80) - 7);
  const showResult = hasResult && (isError || expanded || (!grouped && shortOneLineResult));
  const expandable = totalLines > MAX_RESULT_LINES;
  const displayedLines = expanded ? lines : lines.slice(0, MAX_RESULT_LINES);
  const hiddenCount = totalLines - displayedLines.length;
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const clippedLineCount = displayedLines.filter((line) => String(line ?? '').length > maxResultChars).length;
  const resultColor = isError ? theme.error : theme.text;

  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const dotColor = pending ? theme.subtle : isError ? theme.error : theme.success;
  const dotText = pending && !blinkOn ? ' ' : TURN_MARKER;
  const labelText = grouped
    ? statusCopy(normalizedName, label, groupCount, doneCount, pending, isError)
    : label;
  const summaryText = grouped ? '' : summary;
  const showHeaderExpandHint = !expanded && !globalExpanded && (pending || hiddenCount > 0);
  const expandHintColor = pending ? theme.thinkingText : TOOL_HINT_DONE_COLOR;
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1}>
      <Box flexDirection="row">
        <Box flexShrink={0} minWidth={2}>
          <Text color={dotColor}>{dotText}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={theme.text}>{labelText}</Text>
        </Box>
        {summaryText ? <Text color={theme.text}>{`(${summaryText})`}</Text> : null}
        {pending ? <Text color={theme.inactive}>…</Text> : null}
        {showHeaderExpandHint && !pending ? <Text color={theme.inactive}> </Text> : null}
        {showHeaderExpandHint ? <Text color={expandHintColor}> {'(ctrl+o to expand)'}</Text> : null}
      </Box>

      {showResult ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.subtle}>{'  ⎿  '}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1} flexGrow={1}>
            {displayedLines.length === 0 ? (
              <Text color={theme.inactive}>(no output)</Text>
            ) : (
              displayedLines.map((line, i) => (
                <Text key={i} color={resultColor}>{fitResultLine(line || ' ', columns)}</Text>
              ))
            )}
            {clippedLineCount > 0 ? (
              <Text color={theme.subtle}>{`… (${clippedLineCount} long line${clippedLineCount === 1 ? '' : 's'} clipped to terminal width)`}</Text>
            ) : null}
            {!expanded && hiddenCount > 0 ? (
              <Text color={TOOL_HINT_DONE_COLOR}>{`… (+${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}) · ctrl+o expand all`}</Text>
            ) : null}
            {expanded && expandable ? (
              <Text color={TOOL_HINT_DONE_COLOR}>{globalExpanded ? 'ctrl+o collapse all' : 'ctrl+o collapse'}</Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
