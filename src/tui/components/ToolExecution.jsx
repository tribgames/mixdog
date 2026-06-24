/**
 * components/ToolExecution.jsx — a tool call + its result.
 *
 * Ported from Claude Code's AssistantToolUseMessage.tsx / MessageResponse.tsx:
 *   - The call line: `● Tool Name(summary)` where the dot is BLACK_CIRCLE
 *     (2-wide gutter), the tool name is the user-facing label in bold
 *     `theme.text` (white), and the argument summary sits in plain
 *     parentheses. NOT raw MCP/internal names, and NOT claude-orange.
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

function fitResultLine(line, columns) {
  const max = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const text = String(line ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function ToolExecution({ name, args, result, isError, expanded, globalExpanded = false, columns = 80, attached = false }) {
  const [blinkOn, setBlinkOn] = useState(true);
  const { label, summary } = formatToolSurface(name, args);
  const resultText = result == null ? null : String(result).replace(/\s+$/, '');
  const lines = resultText ? resultText.split('\n') : [];
  const totalLines = lines.length;
  const expandable = totalLines > MAX_RESULT_LINES;
  const displayedLines = expanded ? lines : lines.slice(0, MAX_RESULT_LINES);
  const hiddenCount = totalLines - displayedLines.length;
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const clippedLineCount = displayedLines.filter((line) => String(line ?? '').length > maxResultChars).length;
  const resultColor = isError ? theme.error : theme.inactive;

  // Status dot color mirrors CC's ToolUseLoader: in-progress (no result yet) is
  // a dim blinking dot, a finished call is success-green, a failed one is
  // error-red. The label stays stable so it does not blink with the loader.
  useEffect(() => {
    if (result != null) return undefined;
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [result]);
  const dotColor = result == null ? theme.inactive : isError ? theme.error : theme.success;
  const dotText = result == null && !blinkOn ? ' ' : TURN_MARKER;

  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1}>
      {/* call line: ● Tool Name(args) — dot signals status, label bold white, args plain */}
      <Box flexDirection="row">
        <Box flexShrink={0} minWidth={2}>
          <Text color={dotColor}>{dotText}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={theme.text}>{label}</Text>
        </Box>
        {summary ? <Text color={theme.text}>{`(${summary})`}</Text> : null}
      </Box>

      {/* result: single dim `  ⎿  ` gutter + a column body that wraps on its own */}
      {result == null ? null : (
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
              <Text color={theme.subtle}>{`… (+${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}) · ctrl+o expand all`}</Text>
            ) : null}
            {expanded && expandable ? (
              <Text color={theme.subtle}>{globalExpanded ? 'ctrl+o collapse all' : 'ctrl+o collapse'}</Text>
            ) : null}
          </Box>
        </Box>
      )}
    </Box>
  );
}
