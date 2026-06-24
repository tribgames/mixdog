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

const MAX_SUMMARY_CHARS = 160;
const MIN_RESULT_LINE_CHARS = 24;

function stripToolPrefix(name) {
  return String(name || 'tool')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^functions\./, '');
}

function normalizeName(name) {
  return stripToolPrefix(name).replace(/-/g, '_').toLowerCase();
}

function truncate(value, max = MAX_SUMMARY_CHARS) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : { value: args };
    } catch {
      return { value: args };
    }
  }
  if (typeof args === 'object') {
    if (args.input && typeof args.input === 'object') return args.input;
    return args;
  }
  return { value: args };
}

function displayPath(path) {
  const text = String(path ?? '');
  return text.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || text;
}

function titleizeToolName(name) {
  return stripToolPrefix(name)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'ui') return 'UI';
      if (lower === 'mcp') return 'MCP';
      if (lower === 'id') return 'ID';
      return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
    })
    .join(' ') || 'Tool';
}

export function displayToolName(name) {
  switch (normalizeName(name)) {
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'diagnostics':
      return 'Mixdog Diagnostics';
    case 'open_config':
      return 'Open Config UI';
    case 'job_wait':
      return 'Background Job Control';
    case 'edit':
    case 'apply_patch':
      return 'Edit';
    case 'bash':
    case 'bash_session':
    case 'shell_command':
      return 'Bash';
    case 'grep':
    case 'glob':
      return 'Search';
    case 'list':
      return 'List';
    case 'search':
      return 'Web Search';
    case 'web_fetch':
    case 'fetch':
      return 'Fetch';
    case 'view_image':
      return 'View Image';
    case 'read_mcp_resource':
      return 'Read Resource';
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return 'List Resources';
    case 'request_user_input':
      return 'Ask User';
    case 'update_plan':
      return 'Plan';
    case 'bridge':
      return 'Agent';
    case 'code_graph':
      return 'Code Graph';
    default:
      return titleizeToolName(name);
  }
}

function summarizePatch(patch, basePath) {
  const text = String(patch ?? '');
  const files = [];
  for (const line of text.split('\n')) {
    const match = /^\*\*\*\s+(?:Update|Add|Delete) File:\s+(.+)\s*$/.exec(line);
    if (match) files.push(displayPath(match[1]));
  }
  if (files.length === 1) return files[0];
  if (files.length > 1) return `${files.length} files`;
  if (basePath) return displayPath(basePath);
  return text ? 'patch' : '';
}

/** Claude Code-style one-line renderToolUseMessage summary. */
export function summarizeArgs(name, args) {
  const a = parseArgs(args);
  if (!a || typeof a !== 'object') return '';
  switch (normalizeName(name)) {
    case 'read':
      if (!a.path && !a.file_path) return '';
      if (a.pages) return `${displayPath(a.path ?? a.file_path)} · pages ${a.pages}`;
      return displayPath(a.path ?? a.file_path);
    case 'write':
    case 'edit':
      return displayPath(a.path ?? a.file ?? a.file_path ?? '');
    case 'apply_patch':
      return summarizePatch(a.patch, a.base_path);
    case 'bash':
    case 'bash_session':
    case 'shell_command':
      return truncate(a.description || a.command || a.cmd || '');
    case 'grep':
      if (!a.pattern) return '';
      return a.path
        ? `pattern: "${truncate(a.pattern)}", path: "${displayPath(a.path)}"`
        : `pattern: "${truncate(a.pattern)}"`;
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      return `pattern: "${truncate(a.pattern ?? a.glob)}"`;
    case 'list':
      return displayPath(a.path ?? a.dir ?? '.') || '.';
    case 'search':
      return truncate(a.query || '');
    case 'web_fetch':
    case 'fetch':
      return truncate(a.url || a.uri || '');
    case 'view_image':
      return displayPath(a.path || '');
    case 'read_mcp_resource':
      return truncate(a.uri || '');
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
      return truncate(a.server || 'all');
    case 'bridge':
      return truncate(a.description || a.prompt || a.message || a.role || '');
    case 'code_graph':
      return truncate(a.symbol || a.file || a.mode || '');
    default: {
      try {
        const s = JSON.stringify(a);
        return truncate(s, 80);
      } catch {
        return '';
      }
    }
  }
}

export const MAX_RESULT_LINES = 8;
const TOOL_BLINK_MS = 500;

function fitResultLine(line, columns) {
  const max = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const text = String(line ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function ToolExecution({ name, args, result, isError, expanded, globalExpanded = false, columns = 80 }) {
  const [blinkOn, setBlinkOn] = useState(true);
  const label = displayToolName(name);
  const summary = summarizeArgs(name, args);
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
    <Box flexDirection="column" marginTop={1}>
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
