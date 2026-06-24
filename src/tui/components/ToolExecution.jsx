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
import stringWidth from 'string-width';
import { theme, TURN_MARKER } from '../theme.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  summarizeToolArgs as surfaceSummarizeToolArgs,
  summarizeToolResult as surfaceSummarizeToolResult,
} from '../../runtime/shared/tool-surface.mjs';

const MIN_RESULT_LINE_CHARS = 24;
// Hard cap for the parenthesized header arg summary so a long path/query does
// not eat the whole header line; anything longer is truncated with an ellipsis.
const SUMMARY_MAX_CHARS = 48;

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

function formatElapsed(ms) {
  const n = Math.max(0, Number(ms || 0));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  const seconds = n / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

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
      return copy('Searching', 'Searched', 'file');
    case 'search':
      return copy('Searching', 'Searched', 'search', 'searches');
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

/** Trim text from the end (by display width) so it fits maxWidth, appending '…'. */
function truncateToWidth(text, maxWidth) {
  const str = String(text ?? '');
  if (maxWidth < 1) return '';
  if (stringWidth(str) <= maxWidth) return str;
  const chars = Array.from(str);
  let out = '';
  for (const ch of chars) {
    if (stringWidth(out + ch + '…') > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

function isAgentTool(normalizedName) {
  return normalizedName === 'bridge' || normalizedName === 'agent' || normalizedName === 'task';
}

function isOutputDetailTool(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return new Set([
    'bash', 'bash_session', 'shell_command',
    'read', 'view_image', 'read_mcp_resource',
    'grep', 'glob', 'search', 'web_fetch', 'fetch', 'crawl',
    'list', 'ls', 'code_graph',
    'recall', 'search_memories',
  ]).has(n) || l === 'read' || l === 'search' || l === 'web search' || l === 'run';
}

function genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (isError) return hasResult ? firstResultLine : 'failed';
  if (n === 'bash' || n === 'bash_session' || n === 'shell_command') {
    return hasResult ? firstResultLine : '(no output)';
  }
  if (isOutputDetailTool(n, l)) {
    return hasResult ? firstResultLine : 'completed';
  }
  if (l === 'update' || n === 'write' || n === 'edit' || n === 'apply_patch') return 'completed · no summary';
  return 'completed';
}

export function ToolExecution({ name, args, result, isError, expanded, globalExpanded = false, columns = 80, attached = false, count = 1, completedCount = 0, startedAt = 0, completedAt = 0 }) {
  const [blinkOn, setBlinkOn] = useState(true);
  const { label, summary, normalizedName, args: parsedArgs } = formatToolSurface(name, args);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const resultText = result == null ? null : String(result).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const hasResult = result != null && Boolean(String(resultText || '').trim());
  const lines = resultText ? resultText.split('\n') : [];
  const totalLines = lines.length;
  // Semantic one-line summary derived purely from name/args/result text.
  // Shown in the collapsed, non-error view in place of the raw result block.
  // Grouped cards ("Searched N files" / "Read N files") get the same treatment
  // as single calls: a one-line semantic summary stands in for the raw block.
  const resultSummary = !pending && hasResult
    ? surfaceSummarizeToolResult(name, args, resultText, isError)
    : null;
  // Same fit budget fitResultLine() uses, to detect a line that will be clipped.
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const resultColor = isError ? theme.error : theme.text;
  const firstResultLine = hasResult ? String(lines[0] ?? '') : '';
  const firstResultLineClipped = hasResult && firstResultLine.length > maxResultChars;
  const hasHiddenDetail = !pending && hasResult && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));

  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  const imageDetail = normalizedName === 'view_image' && toolArgPath ? String(toolArgPath) : '';
  const elapsed = !pending && startedAt && completedAt ? formatElapsed(completedAt - startedAt) : '';
  const agentDetail = !pending && isAgentTool(normalizedName)
    ? `${isError ? 'failed' : 'completed'}${elapsed ? ` in ${elapsed}` : ''}`
    : '';
  const genericDetail = !pending && !agentDetail && !imageDetail && !resultSummary
    ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
    : '';
  const collapsedDetail = pending
    ? (groupCount > 1 ? `pending · ${doneCount}/${groupCount} done` : 'pending')
    : agentDetail || imageDetail || resultSummary || genericDetail;
  const showRawResult = expanded && hasResult;
  const detailLines = showRawResult ? lines : [collapsedDetail];
  const detailIsSynthetic = pending || agentDetail || resultSummary || imageDetail || (genericDetail && genericDetail !== firstResultLine);
  const detailColor = detailIsSynthetic
    ? isError ? theme.error : theme.subtle
    : hasResult
      ? resultColor
      : theme.inactive;

  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const dotColor = pending ? theme.subtle : isError ? theme.error : theme.success;
  const dotText = pending && !blinkOn ? ' ' : TURN_MARKER;
  const labelText = statusCopy(normalizedName, label, groupCount, doneCount, pending, isError);
  // Show the parenthesized arg summary for grouped cards too, matching single
  // calls so the header carries the same context.
  const summaryText = summary;
  const showHeaderExpandHint = hasHiddenDetail;
  const expandHintColor = TOOL_HINT_DONE_COLOR;

  // Build a single-line header that never wraps: reserve width for the fixed
  // trailing expand hint plus the dot gutter and a 1-col Windows last-column
  // safety margin, then truncate label/summary to fit. Pending state is already
  // shown by the verb (Running/Reading/etc.), the blinking dot, and the detail
  // row, so avoid an extra standalone ellipsis between parenthesized segments.
  const gutter = 2;
  const hintLabel = showHeaderExpandHint ? `ctrl+o ${expanded ? 'collapse' : 'expand'}` : '';
  const hintText = hintLabel ? ` · ${hintLabel}` : '';
  const avail = Math.max(
    1,
    (Number(columns) || 80) - 1 - gutter - stringWidth(hintText),
  );
  let labelOut;
  let summaryOut;
  if (stringWidth(labelText) >= avail) {
    labelOut = truncateToWidth(labelText, avail);
    summaryOut = '';
  } else {
    labelOut = labelText;
    const summaryBudget = avail - stringWidth(labelText) - (summaryText ? stringWidth(' ()') : 0);
    // Cap by both the remaining header width and a fixed max so long
    // paths/queries get an ellipsis instead of dominating the line.
    const summaryWidth = Math.max(0, Math.min(summaryBudget, SUMMARY_MAX_CHARS));
    const truncatedSummary = summaryText && summaryWidth > 0
      ? truncateToWidth(summaryText, summaryWidth)
      : '';
    summaryOut = truncatedSummary ? ` (${truncatedSummary})` : '';
  }
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1}>
      <Box flexDirection="row">
        <Box flexShrink={0} minWidth={2}>
          <Text color={dotColor}>{dotText}</Text>
        </Box>
        <Text wrap="truncate">
          <Text bold color={theme.text}>{labelOut}</Text>
          {summaryOut ? <Text color={theme.text}>{summaryOut}</Text> : null}
          {showHeaderExpandHint ? <Text color={expandHintColor}>{hintText}</Text> : null}
        </Text>
      </Box>

      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={theme.subtle}>{'  ⎿  '}</Text>
        </Box>
        <Box flexDirection="column" flexShrink={1} flexGrow={1}>
          {detailLines.length === 0 ? (
            <Text color={theme.inactive}>(no output)</Text>
          ) : (
            detailLines.map((line, i) => (
              <Text key={i} color={showRawResult ? resultColor : detailColor}>{fitResultLine(line || ' ', columns)}</Text>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}
