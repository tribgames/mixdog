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

function compactParts(parts) {
  return parts.filter((part) => part != null && String(part).trim()).map((part) => String(part).trim()).join(' · ');
}

function quoted(value) {
  const text = truncate(value || '');
  return text ? `"${text}"` : '';
}

function firstText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function summarizeLineWindow(a) {
  const offset = a.offset ?? a.start_line ?? a.startLine ?? a.line;
  const limit = a.limit ?? a.line_count ?? a.lineCount ?? a.lines;
  if (offset == null && limit == null) return '';
  const start = Number(offset);
  const count = Number(limit);
  if (Number.isFinite(start) && Number.isFinite(count) && count > 0) {
    return `lines ${start}-${Math.max(start, start + count - 1)}`;
  }
  if (Number.isFinite(start)) return `from line ${start}`;
  if (Number.isFinite(count)) return `${count} lines`;
  return '';
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
      return 'Update';
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
    case 'memory':
      return 'Memory';
    case 'recall':
    case 'search_memories':
      return 'Recall';
    case 'tool_search':
      return 'Tool Search';
    case 'cwd':
      return 'Working Directory';
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
      return compactParts([
        displayPath(a.path ?? a.file_path),
        a.pages ? `pages ${a.pages}` : summarizeLineWindow(a),
      ]);
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
      if (!a.pattern && !a.query) return '';
      return compactParts([
        quoted(a.pattern ?? a.query),
        a.path ? `in ${displayPath(a.path)}` : '',
        a.glob ? `glob ${a.glob}` : '',
      ]);
    case 'glob':
      if (!a.pattern && !a.glob) return '';
      return compactParts([
        quoted(a.pattern ?? a.glob),
        a.path ? `in ${displayPath(a.path)}` : '',
      ]);
    case 'list':
      return displayPath(a.path ?? a.dir ?? '.') || '.';
    case 'search':
      return quoted(a.query || '');
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
    case 'memory':
      return compactParts([
        a.action || a.type || a.operation || 'status',
        truncate(firstText(a.query, a.key, a.name, a.text, a.value), 80),
      ]);
    case 'recall':
    case 'search_memories':
      return compactParts([
        quoted(firstText(a.query, a.text, a.input)),
        a.limit || a.topK ? `top ${a.limit ?? a.topK}` : '',
      ]);
    case 'tool_search':
      return quoted(firstText(a.query, a.q, a.text));
    case 'bridge':
      return compactParts([
        a.type || a.action || a.mode || '',
        a.role || a.tag || a.sessionId || a.jobId || '',
        truncate(firstText(a.description, a.prompt, a.message), 80),
      ]);
    case 'code_graph':
      return compactParts([
        a.mode || a.action || '',
        truncate(firstText(a.symbol, a.file, a.path, a.query), 80),
      ]);
    case 'cwd':
      return truncate(firstText(a.path, a.cwd, a.dir));
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

export function ToolExecution({ name, args, result, isError, expanded, globalExpanded = false, columns = 80, attached = false }) {
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
