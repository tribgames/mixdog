/**
 * components/ToolExecution.jsx — a tool call + its result.
 *
 * Ported from Claude Code's AssistantToolUseMessage.tsx / MessageResponse.tsx:
 *   - The call line: `● toolName(arg-summary)` where the dot is BLACK_CIRCLE
 *     (2-wide gutter), the tool name is bold in `theme.text` (white), and the
 *     argument summary sits in plain parentheses. NOT claude-orange.
 *   - The result hangs under a single dim `  ⎿  ` gutter — the gutter is placed
 *     once, not repeated per wrapped line (CC MessageResponse.tsx style).
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme, TURN_MARKER } from '../theme.mjs';

const MAX_RESULT_LINES = 8;

/** One-line argument summary per tool (path / command / pattern). */
function summarizeArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  const a = args;
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'apply_patch':
      return String(a.path ?? a.file ?? a.file_path ?? '');
    case 'bash':
    case 'bash_session':
      return String(a.command ?? a.cmd ?? '');
    case 'grep':
      return String(a.pattern ?? '');
    case 'glob':
      return String(a.pattern ?? a.glob ?? '');
    case 'list':
      return String(a.path ?? a.dir ?? '.');
    default: {
      try {
        const s = JSON.stringify(a);
        return s.length > 60 ? `${s.slice(0, 59)}…` : s;
      } catch {
        return '';
      }
    }
  }
}

export function ToolExecution({ name, args, result, isError }) {
  const summary = summarizeArgs(name, args);
  const resultText = result == null ? null : String(result).replace(/\s+$/, '');
  const lines = resultText ? resultText.split('\n') : [];
  const shown = lines.slice(0, MAX_RESULT_LINES);
  const overflow = lines.length - shown.length;
  const resultColor = isError ? theme.error : theme.inactive;

  // Status dot color mirrors CC's ToolUseLoader: in-progress (no result yet) is
  // plain white, a finished call is success-green, a failed one is error-red.
  const dotColor = result == null ? theme.text : isError ? theme.error : theme.success;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* call line: ● toolName(args) — dot signals status, name bold white, args plain */}
      <Box flexDirection="row">
        <Box flexShrink={0} minWidth={2}>
          <Text color={dotColor}>{TURN_MARKER}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text bold color={theme.text}>{name}</Text>
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
            {shown.length === 0 ? (
              <Text color={theme.inactive}>(no output)</Text>
            ) : (
              shown.map((line, i) => (
                <Text key={i} color={resultColor}>{line || ' '}</Text>
              ))
            )}
            {overflow > 0 ? (
              <Text color={theme.inactive}>{`… (+${overflow} more line${overflow === 1 ? '' : 's'})`}</Text>
            ) : null}
          </Box>
        </Box>
      )}
    </Box>
  );
}
