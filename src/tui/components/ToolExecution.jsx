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
import { theme, TURN_MARKER, RESULT_GUTTER } from '../theme.mjs';
import { formatElapsed } from '../time-format.mjs';
import { BULLET_OPERATOR } from '../figures.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  summarizeToolArgs as surfaceSummarizeToolArgs,
  summarizeToolResult as surfaceSummarizeToolResult,
  formatAggregateHeader,
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

function plural(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

function statusCopy(normalizedName, label, count, doneCount, pending, isError) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  const completed = Math.max(0, Number(doneCount || 0));
  const suffix = pending && completed > 0 ? ` (${completed}/${count})` : '';

  const copy = (active, done, noun, pluralNoun = `${noun}s`) => {
    const object = `${count} ${plural(count, noun, pluralNoun)}`;
    if (count === 1) return pending ? active : done;
    return `${pending ? active : done} ${object}${suffix}`;
  };

  const copyTarget = (active, done, target, pluralTarget = `${target}s`) => {
    if (count === 1) return `${pending ? active : done} ${target}`;
    return `${pending ? active : done} ${count} ${plural(count, target, pluralTarget)}${suffix}`;
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
    case 'list':
    case 'ls':
      return copy('Searching', 'Searched', 'item');
    case 'search':
    case 'search_query':
    case 'image_query':
    case 'web_search':
    case 'web_search_call':
    case 'firecrawl_search':
    case 'web_fetch':
    case 'fetch':
    case 'download_attachment':
      return copyTarget('Researching', 'Researched', 'web', 'web items');
    case 'tool_search':
      return copy('Searching', 'Searched', 'tool');
    case 'explore':
      return pending ? 'Exploring' : 'Explored';
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return copy('Running', 'Ran', 'command');
    case 'bridge':
    case 'agent':
    case 'task':
      return copyTarget('Calling', 'Called', 'agent');
    case 'recall':
    case 'recall_memory':
    case 'search_memories':
      return copyTarget('Checking', 'Checked', 'memory', 'memories');
    case 'remember':
    case 'save_memory':
    case 'update_memory':
      return copyTarget('Writing', 'Wrote', 'memory', 'memories');
    default:
      if (l === 'web search') return copyTarget('Researching', 'Researched', 'web', 'web items');
      if (l === 'search') return copy('Searching', 'Searched', 'tool');
      if (l === 'explore') return pending ? 'Exploring' : 'Explored';
      if (l === 'update') return copy('Editing', 'Edited', 'file');
      if (l === 'read') return copy('Reading', 'Read', 'file');
      if (l === 'run') return copy('Running', 'Ran', 'command');
      if (l === 'setup') return copy('Setting Up', 'Set Up', 'item');
      if (l === 'memory') return copyTarget('Checking', 'Checked', 'memory', 'memories');
      if (l === 'agent') return copyTarget('Calling', 'Called', 'agent');
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

const AGENT_DISPLAY_NAMES = new Map([
  ['explore', 'Explore'],
  ['web-researcher', 'Web Researcher'],
  ['maintainer', 'Maintainer'],
  ['worker', 'Worker'],
  ['heavy-worker', 'Heavy Worker'],
  ['reviewer', 'Reviewer'],
  ['debugger', 'Debugger'],
]);

function titleizeAgentName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = text.toLowerCase().replace(/[\s_]+/g, '-');
  if (AGENT_DISPLAY_NAMES.has(key)) return AGENT_DISPLAY_NAMES.get(key);
  return text
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

function agentResponseTitle(args) {
  const name = titleizeAgentName(args?.agent || args?.role || args?.subagent_type || args?.name || '');
  return `${name || 'Agent'} response`;
}

function agentActionTitle(args) {
  const name = titleizeAgentName(args?.agent || args?.role || args?.subagent_type || args?.name || '');
  const agent = name || 'Agent';
  const action = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  if (action === 'spawn') return /^(running|pending|queued)$/i.test(status) ? `Spawning ${agent}` : `Spawned ${agent}`;
  if (action === 'send') return /^(running|pending|queued)$/i.test(status) ? `Sending to ${agent}` : `Sent to ${agent}`;
  return '';
}

function agentActionSummary(args, summary) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const name = titleizeAgentName(args?.agent || args?.role || args?.subagent_type || args?.name || '');
  if (name && text === name) return '';
  if (name && text.startsWith(`${name} · `)) return text.slice(name.length + 3).trim();
  return text;
}

function hasAgentResponseResult(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(text)) return false;
  const isBridgeEnvelope = /^(?:bridge task:|bridge job:|background task\b|bridge mode:|bridge message queued\b|bridge close:)/i.test(text)
    || (/^task_id:\s*\S+/mi.test(text) && /^(?:surface|operation|status):\s*/mi.test(text));
  if (!isBridgeEnvelope) return true;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^bridge result\b/i.test(trimmed)) continue;
    if (/^<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i.test(trimmed)) continue;
    if (/^(?:bridge job|bridge task|background task|task_id|surface|operation|label|status|type|target|role|agent|preset|model|effort|fast|limits|started|finished|error|notification|queueDepth):\s*/i.test(trimmed)) continue;
    return true;
  }
  return false;
}

function isOutputDetailTool(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return new Set([
    'shell', 'bash', 'bash_session', 'shell_command', 'job_wait',
    'read', 'view_image', 'read_mcp_resource',
    'grep', 'glob', 'search', 'search_query', 'image_query', 'web_search', 'web_search_call', 'firecrawl_search', 'explore', 'web_fetch', 'fetch', 'download_attachment',
    'list', 'ls', 'code_graph',
    'recall', 'recall_memory', 'search_memories', 'remember', 'save_memory', 'update_memory',
  ]).has(n) || l === 'read' || l === 'search' || l === 'web search' || l === 'run';
}

function progressDetail({ normalizedName, label, doneCount, groupCount, elapsed }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  const suffix = elapsed ? ` - ${elapsed}` : '';
  const progress = groupCount > 1 ? ` (${doneCount}/${groupCount})` : '';
  if (isAgentTool(n) || l === 'agent') return `Calling Agent${progress}${suffix}`;
  if (n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run') return `Running${progress}${suffix}`;
  if (n === 'search' || n === 'search_query' || n === 'image_query' || n === 'web_search' || n === 'web_search_call' || n === 'firecrawl_search' || n === 'web_fetch' || n === 'fetch' || n === 'download_attachment' || l === 'web search') return `Researching Web${progress}${suffix}`;
  if (n === 'explore' || l === 'explore') return `Exploring${progress}${suffix}`;
  if (n === 'grep' || n === 'glob' || n === 'list' || n === 'ls' || l === 'search') return `Searching${progress}${suffix}`;
  if (n === 'read' || n === 'view_image' || n === 'read_mcp_resource' || l === 'read') return `Reading${progress}${suffix}`;
  if (n === 'write' || n === 'edit' || n === 'apply_patch' || l === 'update') return `Editing${progress}${suffix}`;
  if (n === 'recall' || n === 'recall_memory' || n === 'search_memories' || l === 'memory') return `Checking Memory${progress}${suffix}`;
  if (l === 'setup') return `Setting Up${progress}${suffix}`;
  return `Working${progress}${suffix}`;
}

function genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (isError) return hasResult ? firstResultLine : 'Failed';
  if (n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait') {
    return hasResult ? firstResultLine : '';
  }
  if (isOutputDetailTool(n, l)) {
    return hasResult ? firstResultLine : '';
  }
  return '';
}

function agentTerminalDetail(status, isError, elapsed) {
  const s = String(status || '').toLowerCase();
  const word = /cancel/.test(s)
    ? 'Cancelled'
    : /error|fail|killed|timeout/.test(s) || isError
      ? 'Failed'
      : /done|success|complete|closed/.test(s)
        ? 'Finished'
        : '';
  return word ? `${word}${elapsed ? ` after ${elapsed}` : ''}` : '';
}

function clampFailureCount(errorCount, groupCount, isError) {
  const explicit = Number(errorCount);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(groupCount, Math.floor(explicit)));
  return isError ? groupCount : 0;
}

function toolStatusColor({ pending, groupCount, failedCount }) {
  if (pending) return theme.subtle;
  if (failedCount <= 0) return theme.success;
  if (groupCount > 1 && failedCount < groupCount) return theme.mixdogOrange || theme.warning;
  return theme.error;
}

export function ToolExecution({ name, args, result, rawResult, isError, errorCount, expanded, globalExpanded = false, columns = 80, attached = false, count = 1, completedCount = 0, startedAt = 0, completedAt = 0, aggregate = false, categories = {}, headerFinalized = true }) {
  const [blinkOn, setBlinkOn] = useState(true);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const elapsedMs = startedAt ? ((pending ? Date.now() : completedAt) - startedAt) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  const statusColor = toolStatusColor({ pending, groupCount, failedCount });

  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [pending]);

  // ── Aggregate card ──────────────────────────────────────────────
  if (aggregate) {
    // Keep the aggregate header stable while results stream in; progress lives
    // in the detail row. This avoids the header bouncing between
    // "Reading/Searching" and "Read/Searched" as completedCount changes.
    const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
    const headerText = formatAggregateHeader(categories || {}, { pending: headerPending, order: headerOrder });
    let detailText;
    if (hasResult) {
      const progress = pending && groupCount > 1 ? `, Running ${doneCount}/${groupCount}` : '';
      detailText = `${rt}${progress}`;
    } else if (pending) {
      const progress = groupCount > 1 ? `Running ${doneCount}/${groupCount}` : 'Running';
      detailText = `${progress}` + (elapsed ? ` - ${elapsed}` : '');
    } else {
      detailText = '';
    }

    const dotColor = statusColor;
    const dotText = pending && !blinkOn ? ' ' : TURN_MARKER;
    const gutter = 2;
    const showHeaderExpandHint = hasRawResult;
    const hintLabel = showHeaderExpandHint ? `ctrl+o ${expanded ? 'collapse' : 'expand'}` : '';
    const hintText = hintLabel ? ` ${BULLET_OPERATOR} ${hintLabel}` : '';
    const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - stringWidth(hintText));
    const clippedHeader = stringWidth(headerText) > avail
      ? truncateToWidth(headerText, avail)
      : headerText;
    const detailLines = expanded && hasRawResult ? rawRt.split('\n') : (detailText ? [detailText] : []);
    const aggregateDetailColor = theme.text;
    return (
      <Box flexDirection="column" marginTop={attached ? 0 : 1}>
        <Box flexDirection="row">
          <Box flexShrink={0} minWidth={2}>
            <Text color={dotColor}>{dotText}</Text>
          </Box>
          <Text wrap="truncate">
            <Text bold color={theme.text}>{clippedHeader}</Text>
            {showHeaderExpandHint ? <Text color={TOOL_HINT_DONE_COLOR}>{hintText}</Text> : null}
          </Text>
        </Box>
        {detailLines.length > 0 ? (
          <Box flexDirection="row">
            <Box flexShrink={0}>
              <Text color={theme.subtle}>{RESULT_GUTTER}</Text>
            </Box>
            <Box flexDirection="column" flexShrink={1} flexGrow={1}>
              {detailLines.map((line, i) => (
                <Text key={i} color={aggregateDetailColor}>
                  {fitResultLine(line || ' ', columns)}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  }

  // ── Normal (non-aggregate) tool card ────────────────────────────
  const { label, summary, normalizedName, args: parsedArgs } = formatToolSurface(name, args);
  const lines = rt ? rt.split('\n') : [];
  const totalLines = lines.length;
  // Semantic one-line summary derived purely from name/args/result text.
  // Shown in the collapsed, non-error view in place of the raw result block.
  // Grouped cards ("Searched N files" / "Read N files") get the same treatment
  // as single calls: a one-line semantic summary stands in for the raw block.
  const resultSummary = !pending && hasResult
    ? surfaceSummarizeToolResult(name, args, rt, isError)
    : null;
  // Same fit budget fitResultLine() uses, to detect a line that will be clipped.
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const resultColor = theme.text;
  const firstResultLine = hasResult ? String(lines[0] ?? '') : '';
  const firstResultLineClipped = hasResult && firstResultLine.length > maxResultChars;
  const hasHiddenDetail = !pending && hasResult && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));

  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  const imageDetail = normalizedName === 'view_image' && toolArgPath ? String(toolArgPath) : '';
  const agentCompletionDetail = !pending && isAgentTool(normalizedName)
    ? agentTerminalDetail(parsedArgs?.status, isError, elapsed)
    : '';
  const agentDetail = !pending && isAgentTool(normalizedName) && !hasResult
    ? agentCompletionDetail
    : '';
  const pendingDetail = pending
    ? progressDetail({ normalizedName, label, doneCount, groupCount, elapsed })
    : '';
  const genericDetail = !pending && !agentDetail && !imageDetail && !resultSummary
    ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
    : '';
  const collapsedDetail = pending
    ? pendingDetail
    : (/^(Cancelled|Failed|Finished)$/i.test(resultSummary || '') && agentCompletionDetail
      ? agentCompletionDetail
      : resultSummary) || agentDetail || imageDetail || genericDetail;
  const showRawResult = expanded && hasResult;
  const detailLines = showRawResult ? lines : (collapsedDetail ? [collapsedDetail] : []);
  const detailIsSynthetic = pending || agentDetail || resultSummary || imageDetail || (genericDetail && genericDetail !== firstResultLine);
  const detailColor = theme.text;

  const isAgentResponse = !pending && isAgentTool(normalizedName) && hasResult && hasAgentResponseResult(rt);
  const dotColor = statusColor;
  const dotText = pending && !blinkOn ? ' ' : TURN_MARKER;
  const labelText = isAgentResponse
    ? agentResponseTitle(parsedArgs)
    : (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '') || statusCopy(normalizedName, label, groupCount, doneCount, headerPending, isError);
  // Show the parenthesized arg summary for grouped cards too, matching single
  // calls so the header carries the same context.
  const summaryText = isAgentResponse ? '' : (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary);
  const showHeaderExpandHint = hasHiddenDetail;
  const expandHintColor = TOOL_HINT_DONE_COLOR;

  // Build a single-line header that never wraps: reserve width for the fixed
  // trailing expand hint plus the dot gutter and a 1-col Windows last-column
  // safety margin, then truncate label/summary to fit. Pending state is already
  // shown by the verb (Running/Reading/etc.), the blinking dot, and the detail
  // row, so avoid an extra standalone ellipsis between parenthesized segments.
  const gutter = 2;
  const hintLabel = showHeaderExpandHint ? `ctrl+o ${expanded ? 'collapse' : 'expand'}` : '';
  const hintText = hintLabel ? ` ${BULLET_OPERATOR} ${hintLabel}` : '';
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

      {detailLines.length > 0 ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.subtle}>{RESULT_GUTTER}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1} flexGrow={1}>
            {detailLines.map((line, i) => (
              <Text key={i} color={showRawResult ? resultColor : detailColor}>
                {fitResultLine(line || ' ', columns)}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
