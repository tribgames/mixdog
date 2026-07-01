/**
 * components/ToolExecution.jsx — a tool call + its result.
 *
 * Tool call + result layout:
 *   - The call line: `● Tool Name(summary)` where the dot is BLACK_CIRCLE
 *     (2-wide gutter), the tool name is the user-facing label and the argument
 *     summary sits in muted parentheses. NOT raw MCP/internal names.
 *   - The result hangs under a single dim `  ⎿  ` gutter — the gutter is placed
 *     once, not repeated per wrapped line.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { displayWidth } from '../display-width.mjs';
import { theme, TURN_MARKER, RESULT_GUTTER, RESULT_GUTTER_CONT } from '../theme.mjs';
import { formatElapsed } from '../time-format.mjs';
import { BULLET_OPERATOR } from '../figures.mjs';
import {
  displayToolName as surfaceDisplayToolName,
  formatToolSurface,
  summarizeToolResult as surfaceSummarizeToolResult,
  formatAggregateHeader,
  formatToolActionHeader,
  displayModelName,
  summarizeAgentSurfaceBrief,
  AGENT_SURFACE_BRIEF_MAX,
} from '../../runtime/shared/tool-surface.mjs';
import { backgroundTaskFailureStatusLabel, isBackgroundErrorOnlyBody } from '../../runtime/shared/err-text.mjs';
import { formatExpandedResult, wrapExpandedResultLines } from './tool-output-format.mjs';

const MIN_RESULT_LINE_CHARS = 24;
// Hard cap for the collapsed result detail row (the second line under the ⎿
// gutter). Independent of terminal width so a wide terminal never lets a long
// line (e.g. an agent response brief) stretch the whole row — anything past
// this is truncated with an ellipsis. ctrl+o expand still shows the full body.
const RESULT_LINE_HARD_MAX = 80;
// Hard cap for the parenthesized header arg summary so a long path/query does
// not eat the whole header line; anything longer is truncated with an ellipsis.
const SUMMARY_MAX_CHARS = 48;
const HEADER_FAILURE_STATUS_MAX = 32;

export function displayToolName(name, args) {
  return surfaceDisplayToolName(name, args);
}

const TOOL_BLINK_MS = 500;
const TOOL_BLINK_LIMIT_MS = 3000;
const TOOL_PENDING_SHOW_DELAY_MS = 1000;
// Read `theme.subtle` at use-time (not captured here) so a live `/theme`
// switch re-tones the tool hints. `theme` is mutated in-place on switch.
// Collapsed tool headers/details are laid out as single terminal rows. Never let
// raw C0/control bytes (CR, tabs, cursor escapes, etc.) reach those rows: a
// terminal can apply them after Ink has already clipped/measured the row, which
// makes a scrolled tool card appear to write through the prompt/statusline.
const INLINE_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

function safeInlineText(value) {
  return stripAnsi(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(INLINE_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function normalizeCountMap(value = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (raw && typeof raw === 'object') {
      out[key] = { ...raw, count: normalizeCount(raw.count) };
    } else {
      out[key] = normalizeCount(raw);
    }
  }
  return out;
}

function deltaColor(token) {
  return String(token || '').startsWith('+') ? theme.success : theme.error;
}

function deltaTextParts(text) {
  const value = String(text ?? '');
  const parts = [];
  const re = /(^|[\s([,{·])([+-]\s*\d+)(?=\s+Lines?\b)/gi;
  let last = 0;
  let match;
  while ((match = re.exec(value))) {
    const prefix = match[1] || '';
    const token = (match[2] || '').replace(/\s+/g, '');
    const tokenStart = match.index + prefix.length;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    if (prefix) parts.push({ text: prefix });
    if (token) parts.push({ text: token, color: deltaColor(token) });
    last = tokenStart + (match[2] || '').length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

function renderDeltaText(text) {
  return deltaTextParts(text).map((part, index) => (
    part.color ? <Text key={index} color={part.color}>{part.text}</Text> : part.text
  ));
}

// Shared multi-line result body: `└` on the first row, `│` continuation rail on
// every following row, body text in one flex column so wrapping stays aligned
// under the head gutter.
//
// Two render paths:
//   - COLLAPSED (raw=false): a single fitted summary line, diff(+/-) colored via
//     renderDeltaText.
//   - EXPANDED (raw=true): formatExpandedResult then wrapExpandedResultLines so
//     each physical row fits the body width before render (rail rows stay 1:1;
//     ink does not re-wrap). Physical row mount cap: MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES
//     (default 600; 0 disables). Shell/script bodies keep the newest tail when capped.
function ResultBody({ lines, rawText, pathArg = '', isShell = false, columns, color, raw }) {
  const renderLines = raw
    ? wrapExpandedResultLines(
      formatExpandedResult(rawText, { pathArg, isShell }),
      columns,
      { isShell },
    )
    : (lines || []);
  if (!renderLines || renderLines.length === 0) return null;
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} flexDirection="column">
        {renderLines.map((_, i) => (
          <Text key={i} color={theme.subtle}>{i === 0 ? RESULT_GUTTER : RESULT_GUTTER_CONT}</Text>
        ))}
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        {renderLines.map((line, i) => (
          <Text key={i} color={raw ? undefined : color} wrap="truncate">
            {raw
              ? (line || ' ')
              : renderDeltaText(fitResultLine(line || ' ', columns))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function plural(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

function isShellTool(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run';
}

function shellResultStatus(value) {
  const match = String(value || '').match(/(?:^|\b)status:\s*(running|pending|queued|completed|failed|cancelled|canceled)\b/im);
  return match ? String(match[1] || '').toLowerCase() : '';
}

function normalizeTerminalStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
  if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
  if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
  if (/^(cancelled|canceled|cancel)$/.test(raw)) return 'cancelled';
  return '';
}

function displayTerminalStatus(value) {
  const status = normalizeTerminalStatus(value);
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Finished';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  return '';
}

function resultTerminalStatus(value) {
  const text = String(value || '');
  const tagged = text.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  if (tagged) return normalizeTerminalStatus(tagged);
  const bracketed = text.match(/^\[status:\s*([^\]]*)\]/mi)?.[1]?.trim();
  if (bracketed) return normalizeTerminalStatus(bracketed);
  const inline = text.match(/^(?:status|state):\s*([^\s·,;]+)/mi)?.[1]?.trim();
  return normalizeTerminalStatus(inline);
}

const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

function stripLeadingStatusMarkerLines(lines) {
  const out = Array.isArray(lines) ? lines.slice() : [];
  if (out.length > 0 && LEADING_STATUS_MARKER_LINE_RE.test(String(out[0] ?? '').trim())) out.shift();
  return out;
}

function stripLeadingStatusMarkerFromText(text) {
  return stripLeadingStatusMarkerLines(String(text || '').split('\n')).join('\n');
}

function shellDisplayStatus({ pending = false, failedCount = 0, isError = false, result = '' } = {}) {
  const status = shellResultStatus(result);
  if (pending || /^(running|pending|queued)$/.test(status)) return 'running';
  if (/^cancel/.test(status)) return 'cancelled';
  if (/^(failed|error|killed|timeout)$/.test(status) || isError || failedCount > 0) return 'failed';
  return 'completed';
}

function shellHeader(status, count = 1) {
  const n = Math.max(1, Number(count) || 1);
  const object = `${n} ${plural(n, 'command')}`;
  if (status === 'running') return `Running ${object}`;
  return `Ran ${object}`;
}

function shellResultElapsed(value) {
  const match = String(value || '').match(/^\[elapsed:\s*(\d+)\s*ms\]/mi);
  if (!match) return '';
  const elapsedMs = Number(match[1]);
  return Number.isFinite(elapsedMs) && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
}

function statusCopy(name, label, count, doneCount, pending, isError, args = {}) {
  // No stableVerbWidth padding: it padded the done verb to the active ("-ing")
  // width, which Ink trims at the line END (vendor output trimEnd) so it never
  // stabilized the pending→done flip — it only left an UGLY mid-header gap
  // ("Searched  1 pattern", "Read    1 file"). The header is wrap="truncate"
  // behind a fixed gutter and the fullscreen full-clear repaints the row, so
  // dropping the pad just normalizes the spacing.
  return formatToolActionHeader(name, args, { pending, count });
}

function fitResultLine(line, columns) {
  const max = Math.min(RESULT_LINE_HARD_MAX, Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7));
  const text = safeInlineText(line);
  return displayWidth(text) > max ? truncateToWidth(text, max) : text;
}

/** Trim text from the end (by display width) so it fits maxWidth, appending '…'. */
function truncateToWidth(text, maxWidth) {
  const str = safeInlineText(text);
  if (maxWidth < 1) return '';
  if (displayWidth(str) <= maxWidth) return str;
  const chars = Array.from(str);
  let out = '';
  for (const ch of chars) {
    if (displayWidth(out + ch + '…') > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

function isAgentTool(normalizedName) {
  return normalizedName === 'agent';
}

const SKILL_SURFACE_NAMES = new Set([
  'skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill',
]);

function isBackgroundTaskTool(normalizedName) {
  return new Set(['explore', 'search', 'shell', 'bash', 'bash_session', 'shell_command', 'task']).has(String(normalizedName || '').toLowerCase());
}

const AGENT_DISPLAY_NAMES = new Map([
  ['explore', 'Explore'],
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

function agentModelLabel(args) {
  const a = args && typeof args === 'object' ? args : {};
  const provider = String(a.provider || a.providerId || a.provider_id || '').trim();
  const model = String(a.model || '').trim();
  const displayHint = String(a.modelDisplay || a.model_display || a.displayModel || '').trim();
  return displayModelName(model, provider, displayHint);
}

function agentTagLabel(args) {
  // The real spawn tag (engine fills parsedArgs.tag from the envelope target).
  // Never fall back to task_id — only the human-meaningful spawn tag belongs in
  // the header parentheses.
  return String(args?.tag || '').trim();
}

function withModelAndTag(label, args) {
  const model = agentModelLabel(args);
  const tag = agentTagLabel(args);
  const inner = [model, tag].filter(Boolean).join(', ');
  return inner ? `${label} (${inner})` : label;
}

// Append an agent name to a base action word without leaving a trailing space
// when the agent is unknown (no generic "Agent" fallback).
function joinActionAgent(action, agent) {
  return agent ? `${action} ${agent}` : action;
}

function agentResponseTitle(args) {
  const name = titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
  // The agent + model identify the responder; the response summary itself
  // is hidden in the collapsed card (ctrl+o expand still shows the full body).
  // No generic "Agent" fallback — render just "Response" when the agent is empty.
  return withModelAndTag(joinActionAgent('Response', name), args);
}

function agentActionTitle(args) {
  const name = titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
  // Runtime treats an omitted type/action as "spawn" (see agent-tool.mjs default),
  // so mirror that contract here instead of falling through to the generic
  // "Called agent" status copy.
  const action = String(args?.type || args?.action || 'spawn').toLowerCase();
  // Fixed action verbs regardless of running/completed status. No generic
  // "Agent" fallback for the agent: when the agent is unknown render the action
  // word alone ("Spawn") instead of "Spawn Agent".
  if (action === 'spawn') return withModelAndTag(joinActionAgent('Spawn', name), args);
  if (action === 'send') return withModelAndTag(joinActionAgent('Send', name), args);
  if (action === 'list') return 'Agent status';
  if (action === 'cancel') return withModelAndTag(joinActionAgent('Cancel', name), args);
  if (action === 'close') return withModelAndTag(joinActionAgent('Close', name), args);
  if (action === 'cleanup') return withModelAndTag(joinActionAgent('Cleanup', name), args);
  if (action === 'read' || action === 'status') return withModelAndTag(joinActionAgent('Status', name), args);
  return '';
}

function agentActionSummary(args, summary) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const name = titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
  if (name && text === name) return '';
  let rest = name && text.startsWith(`${name} · `) ? text.slice(name.length + 3).trim() : text;
  // The agent/model/tag surface summary ("Heavy Worker · Opus 4.8") is now folded
  // into the header label itself ("Spawn Heavy Worker (Opus 4.8, tag)"), so drop
  // the model and tag tokens from the parenthesized summary to avoid showing
  // them twice.
  const model = agentModelLabel(args);
  if (model && rest === model) return '';
  const tag = agentTagLabel(args);
  if (tag && rest === tag) return '';
  return rest;
}

function hasAgentResponseResult(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^(?:undefined|null)$/i.test(text)) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(text)) return false;
  const isBridgeEnvelope = /^(?:agent task:|background task\b|agent message queued\b|agent close:)/i.test(text)
    || /^(?:agents|tasks):\s*\d/i.test(text)
    || /^\(no agents or tasks\)$/i.test(text)
    || (/^task_id:\s*\S+/mi.test(text) && /^(?:surface|operation|status):\s*/mi.test(text));
  if (!isBridgeEnvelope) return true;
  let sawBlank = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      sawBlank = true;
      continue;
    }
    if (/^agent result\b/i.test(trimmed)) continue;
    if (/^(?:undefined|null)$/i.test(trimmed)) continue;
    if (/^<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i.test(trimmed)) continue;
    if (!sawBlank && /^(?:agent task|background task|agent message queued\b|agent close:|task_id|surface|operation|label|status|type|target|agent|preset|model|effort|fast|limits|started|finished|error|notification|queueDepth):?\s*/i.test(trimmed)) continue;
    if (!sawBlank && /^(?:agents|tasks):\s*/i.test(trimmed)) continue;
    if (/^\(no agents or tasks\)$/i.test(trimmed)) continue;
    if (!sawBlank && /^-\s+\S+/i.test(trimmed)) continue;
    return true;
  }
  return false;
}

function parseBackgroundTaskResult(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const allLines = text.split('\n');
  const start = allLines.findIndex((line) => line.trim() === 'background task');
  if (start < 0) return null;
  const rest = allLines.slice(start + 1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body = blank >= 0 ? rest.slice(blank + 1).join('\n').trim() : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const status = String(fields.status || '').toLowerCase();
  const error = fields.error || '';
  return {
    taskId: fields.task_id || fields.taskid || '',
    surface: fields.surface || '',
    operation: fields.operation || '',
    label: fields.label || '',
    status,
    startedAt: fields.started || fields.startedat || '',
    finishedAt: fields.finished || fields.finishedat || '',
    body,
    error,
    hasResponse: Boolean(body) && !isBackgroundErrorOnlyBody(body, error) && !/^(running|pending|queued)$/i.test(status),
  };
}

function backgroundTaskMetaFromArgs(args = {}) {
  const taskId = String(args.task_id || args.taskId || '').trim();
  if (!taskId) return null;
  return {
    taskId,
    surface: args.surface || '',
    operation: args.operation || '',
    label: args.label || '',
    status: String(args.status || '').toLowerCase(),
    startedAt: args.startedAt || args.started || '',
    finishedAt: args.finishedAt || args.finished || '',
    error: args.error || '',
    body: '',
    hasResponse: false,
  };
}

function resolveBackgroundTaskMeta(parsedArgs = {}, resultText = '') {
  const parsed = parseBackgroundTaskResult(resultText);
  if (parsed) {
    if (!parsed.error && parsedArgs?.error) parsed.error = parsedArgs.error;
    if (!parsed.status && parsedArgs?.status) parsed.status = String(parsedArgs.status).toLowerCase();
    if (!parsed.surface && parsedArgs?.surface) parsed.surface = parsedArgs.surface;
    return parsed;
  }
  return backgroundTaskMetaFromArgs(parsedArgs);
}

function backgroundTaskElapsed(meta = {}, fallback = '') {
  const startedMs = Date.parse(meta.startedAt || '');
  const finishedMs = Date.parse(meta.finishedAt || '');
  if (Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    const elapsedMs = finishedMs - startedMs;
    return elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  }
  return fallback || '';
}

function prefixElapsed(detail, elapsed = '') {
  const text = String(detail || '').trim();
  const time = String(elapsed || '').trim();
  if (!time) return text;
  // Unified convention: the elapsed time ALWAYS goes at the END, ` · ` separated.
  // Guard against a double-append when the text already ends with the same time.
  if (text && text.endsWith(`· ${time}`)) return text;
  return text ? `${text} · ${time}` : time;
}

function mergeTerminalDetail(status, detail = '') {
  const label = displayTerminalStatus(status);
  const text = String(detail || '').trim();
  if (!label) return text;
  if (label === 'Finished' && text) return text;
  if (!text) return label;
  if (text.toLowerCase().startsWith(label.toLowerCase())) return text;
  return `${label} · ${text}`;
}

function shouldPrefixSyncElapsed(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'explore' || l === 'explore' || n === 'search' || l === 'search' || l === 'web search';
}

function backgroundTaskDisplayName(normalizedName, meta = {}) {
  const surface = String(meta.surface || normalizedName || '').toLowerCase();
  if (surface === 'explore') return 'Explore';
  if (surface === 'search') return 'Search';
  if (surface === 'shell' || surface === 'bash' || surface === 'bash_session' || surface === 'shell_command' || surface === 'task') return 'Shell';
  return titleizeAgentName(surface || normalizedName || 'Task');
}

function backgroundTaskResultTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (display === 'Shell') return 'Shell output';
  if (display === 'Search') return 'Search results';
  return `${display} response`;
}

function backgroundTaskActionTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (/^(running|pending|queued)$/i.test(meta.status || '')) return `Started ${display}`;
  if (meta.hasResponse) return backgroundTaskResultTitle(normalizedName, meta);
  return `${display} status`;
}

function backgroundTaskFailureDetail(meta = {}, parsedArgs = {}) {
  const status = meta.status || parsedArgs?.status;
  const error = meta.error || parsedArgs?.error;
  if (!error) return '';
  const surface = meta.surface || parsedArgs?.surface || '';
  return backgroundTaskFailureStatusLabel(status, error, { surface });
}

function backgroundTaskDetail(meta = {}, elapsed = '', parsedArgs = {}) {
  const parts = [];
  const status = displayTerminalStatus(meta.status);
  if (status) parts.push(status);
  if (meta.taskId) parts.push(`task_id: ${meta.taskId}`);
  const firstBodyLine = String(meta.body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstBodyLine && /^(running|pending|queued)$/i.test(meta.status || '')) parts.push(firstBodyLine);
  return prefixElapsed(parts.join(' · '), elapsed);
}

function isBackgroundTaskResponseArgs(normalizedName, args = {}) {
  if (!isBackgroundTaskTool(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  return type === 'result' || type === 'completion' || (/^(completed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id));
}

function isOutputDetailTool(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return new Set([
    'shell', 'bash', 'bash_session', 'shell_command', 'job_wait',
    'read', 'view_image', 'read_mcp_resource',
    'grep', 'glob', 'search', 'search_query', 'image_query', 'web_search', 'web_search_call', 'explore', 'web_fetch', 'fetch', 'download_attachment',
    'list', 'ls', 'code_graph',
    'recall', 'recall_memory', 'search_memories', 'remember', 'save_memory', 'update_memory',
  ]).has(n) || l === 'read' || l === 'search' || l === 'web search' || l === 'run';
}

function genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  if (isError) return hasResult ? firstResultLine : 'Failed';
  if (n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait') {
    return '';
  }
  if (isOutputDetailTool(n, l)) {
    return hasResult ? firstResultLine : '';
  }
  return '';
}

function toolSearchLoadedSummary(resultText) {
  let parsed;
  try {
    parsed = JSON.parse(String(resultText || ''));
  } catch {
    return '';
  }
  const tools = parsed?.selected?.tools;
  if (!tools || typeof tools !== 'object') return '';
  const names = [
    ...(Array.isArray(tools.added) ? tools.added : []),
    ...(Array.isArray(tools.already) ? tools.already : []),
  ]
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return [...new Set(names)].join(', ');
}

function agentTerminalDetail(status, isError, elapsed, error = '') {
  const failureDetail = isError && error
    ? backgroundTaskFailureStatusLabel(status, error, { surface: 'agent' })
    : '';
  if (failureDetail) return failureDetail;
  const s = String(status || '').toLowerCase();
  const word = /cancel/.test(s)
    ? 'Cancelled'
    : /error|fail|killed|timeout/.test(s) || isError
      ? 'Failed'
      : /done|success|complete|closed/.test(s)
        ? 'Finished'
        : '';
  // Unified ` · <time>` convention (previously "Finished after 12s").
  return word ? `${word}${elapsed ? ` · ${elapsed}` : ''}` : '';
}

function clampFailureCount(errorCount, groupCount, isError) {
  const explicit = Number(errorCount);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(groupCount, Math.floor(explicit)));
  return isError ? groupCount : 0;
}

function toolStatusColor({ pending, groupCount, failedCount, terminalStatus = '' }) {
  if (pending) return theme.success;
  const status = normalizeTerminalStatus(terminalStatus);
  if (status === 'failed') return theme.error;
  if (status === 'cancelled') return theme.warning || theme.mixdogOrange || theme.subtle;
  if (failedCount <= 0) return theme.success;
  if (groupCount > 1 && failedCount < groupCount) return theme.mixdogOrange || theme.warning;
  return theme.error;
}

export function ToolExecution({ name, args, result, rawResult, isError, errorCount, expanded, columns = 80, attached = false, count = 1, completedCount = 0, startedAt = 0, completedAt = 0, aggregate = false, categories = {}, headerFinalized = true, deferredDisplayReady = false }) {
  const rowWidth = Math.max(1, Number(columns || 80));
  const [blinkOn, setBlinkOn] = useState(true);
  const [blinkExpired, setBlinkExpired] = useState(false);
  const [pendingDelayElapsed, setPendingDelayElapsed] = useState(false);
  const [, setElapsedTick] = useState(0);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const pendingAgeMs = pending && startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0;
  // A card that is still pending but already has something to paint (a result
  // landed, or at least one of an aggregate's parallel calls completed) must
  // SKIP the blank placeholder: it was pushed early (engine ensureVisible on a
  // result before the push-delay) so its startedAt is recent and pendingAgeMs <
  // delay, but it has real header counts + a summary to show. Rendering the
  // placeholder instead made an empty card scroll up first and only fill in as
  // each parallel result arrived. Treating "has visible content" as ready lets
  // the card appear already populated and simply grow taller as more results
  // land — no empty band.
  const hasVisibleProgress = doneCount > 0 || Boolean(String(rt || '').trim());
  const pendingDisplayReady = !pending || !startedAtMs || pendingDelayElapsed || pendingAgeMs >= TOOL_PENDING_SHOW_DELAY_MS || hasVisibleProgress || deferredDisplayReady;
  // Keep the action verb in its active form until the engine explicitly seals
  // the tool block. Fast tool batches often complete before the next provider
  // iteration decides whether to call more tools or emit assistant text; flipping
  // "Finding" -> "Found" -> "Finding" during that gap makes the transcript jump.
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const elapsedMs = startedAtMs ? Math.max(0, (pending ? Date.now() : (completedAtMs || Date.now())) - startedAtMs) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  const statusColor = toolStatusColor({ pending, groupCount, failedCount });
  const displayGroupCount = groupCount;
  const displayCategories = normalizeCountMap(categories || {});

  useEffect(() => {
    if (!pending) {
      setPendingDelayElapsed(false);
      return undefined;
    }
    const started = Number(startedAt || 0);
    if (!started) {
      setPendingDelayElapsed(true);
      return undefined;
    }
    const remaining = TOOL_PENDING_SHOW_DELAY_MS - Math.max(0, Date.now() - started);
    if (remaining <= 0) {
      setPendingDelayElapsed(true);
      return undefined;
    }
    setPendingDelayElapsed(false);
    const timer = setTimeout(() => setPendingDelayElapsed(true), remaining);
    return () => clearTimeout(timer);
  }, [pending, startedAt]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady || blinkExpired) {
      setBlinkOn(true);
      return undefined;
    }
    const timer = setInterval(() => setBlinkOn((on) => !on), TOOL_BLINK_MS);
    return () => clearInterval(timer);
  }, [pending, pendingDisplayReady, blinkExpired]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady) {
      setBlinkExpired(false);
      return undefined;
    }
    const started = Number(startedAt || 0);
    const remaining = TOOL_BLINK_LIMIT_MS - (started ? Math.max(0, Date.now() - started) : 0);
    if (remaining <= 0) {
      setBlinkExpired(true);
      return undefined;
    }
    setBlinkExpired(false);
    const timer = setTimeout(() => setBlinkExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [pending, pendingDisplayReady, startedAt]);

  useEffect(() => {
    if (!pending || !pendingDisplayReady || !startedAtMs) return undefined;
    const timer = setInterval(() => setElapsedTick((tick) => (tick + 1) % 1000000), 1000);
    return () => clearInterval(timer);
  }, [pending, pendingDisplayReady, startedAtMs]);

  // While a freshly-started tool is still inside its pending-show delay we used
  // to `return null` (0 rendered rows). But estimateTranscriptItemRows() in
  // App.jsx counts a collapsed tool item from the moment it is pushed (1 row for
  // a skill surface, 2 rows otherwise), so the scroll/window math reserved that
  // height while the component painted 0. The moment the delay elapsed (or the
  // tool completed) the real card popped in, the rendered transcript grew and
  // shoved the content above it — the "new tool card jumps up/down as it
  // settles" bug. Reserve the SAME height the estimator predicts with blank
  // content instead, so the card occupies a constant height for its whole
  // lifecycle and nothing reflows when the real header/detail fill in place.
  if (pending && !pendingDisplayReady) {
    // Mirror estimateTranscriptItemRows: a non-aggregate skill surface collapses
    // to a single header row; everything else reserves header + one detail row.
    const placeholderNormalizedName = String(formatToolSurface(name, args)?.normalizedName || '').toLowerCase();
    // Skill surfaces collapse to a single header row; agent surfaces reserve
    // header + one brief detail row (see estimateTranscriptItemRows).
    const placeholderSingleRow = !aggregate && SKILL_SURFACE_NAMES.has(placeholderNormalizedName);
    return (
      <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
        <Text> </Text>
        {placeholderSingleRow ? null : <Text> </Text>}
      </Box>
    );
  }

  // ── Aggregate card ──────────────────────────────────────────────
  if (aggregate) {
    // Pending aggregate headers omit counts so intermediate tool batches do not
    // bounce between "Reading 1 item" and "Reading 4 items". Final counts and
    // result summaries appear only after completion.
    const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
    // No stableVerbWidth: see statusCopy — the padding only left a mid-header
    // gap ("Searched  1 pattern, Read    1 file") since Ink trims trailing
    // spaces and never stabilized the flip.
    const headerText = safeInlineText(formatAggregateHeader(displayCategories || {}, { pending: headerPending, order: headerOrder }));
    let detailText;
    if (hasResult) {
      // The aggregate card reserves EXACTLY ONE detail row when it is not
      // expanded-with-raw (App.jsx estimateTranscriptItemRows counts
      // margin + header + 1 detail row for the no-raw aggregate case). The
      // summary `rt` can be multiline; a single <Text> containing '\n' renders
      // MULTIPLE terminal rows, which desyncs the estimate and makes the card
      // "settle" taller than reserved. Collapse to a single logical line
      // (whitespace-normalized); fitResultLine below trims it to the column
      // width so it can never exceed one terminal row.
      detailText = safeInlineText(rt);
    } else {
      detailText = '';
    }

    // statusColor (line ~650) is computed WITHOUT terminalStatus, so it stays
    // success even for a cancelled/failed aggregate. The non-aggregate path adds
    // terminalStatus far below (line ~880), after this early return. Recompute
    // the aggregate dot color here from what the aggregate actually controls:
    // the collapsed detail `rt` (which carries the `[status: cancelled]` marker
    // for a cancelled aggregate) plus isError/failedCount for failures. Pending
    // stays success; a clean completion stays success (no marker, no errors).
    const aggregateTerminalStatus = pending
      ? 'running'
      : (resultTerminalStatus(rt) || (isError || failedCount > 0 ? 'failed' : 'completed'));
    const aggregateStatusColor = toolStatusColor({ pending, groupCount, failedCount, terminalStatus: aggregateTerminalStatus });
    const dotColor = !hasResult && !pending ? theme.subtle : aggregateStatusColor;
    const dotText = pending && !blinkExpired && !blinkOn ? ' ' : TURN_MARKER;
    const gutter = 2;
    const showHeaderExpandHint = hasRawResult;
    const hintLabel = `ctrl+o ${expanded ? 'collapse' : 'expand'}`;
    const hintText = ` ${BULLET_OPERATOR} ${hintLabel}`;
    // The header right-side trailing slot only ever shows the ctrl+o hint. The
    // pending elapsed meta was removed from the header — it lives on the detail
    // row now (`Running · 12s`) so a per-second digit change never reflows the
    // header. Still reserve the hint slot for the whole lifecycle so the body
    // clip point stays fixed when the hint appears on completion.
    const rightReserve = stringWidth(hintText);
    const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - rightReserve);
    const trailingText = showHeaderExpandHint ? hintText : '';
    const trailingColor = theme.subtle;
    const clippedHeader = stringWidth(headerText) > avail
      ? truncateToWidth(headerText, avail)
      : headerText;
    // Trailing content (ctrl+o hint only; pending elapsed lives on the detail
    // row) sits immediately after the header body — no fixed right-edge pin — so
    // it never jumps to the right edge and snaps back on the pending→done flip.
    // Keep the aggregate card at a fixed height (header + one detail row) for
    // its whole lifecycle. Pending cards have no result yet, so reserve the
    // detail row up front instead of growing from 1→2 rows when the summary
    // lands on completion — that late row push is the "줄 튐" jump. The empty
    // placeholder renders as a blank line under the ⎿ gutter; the final summary
    // simply fills it in place. This matches estimateTranscriptItemRows (always
    // 2 + resultRows), so windowing/scroll stay in lockstep too.
    // When there is no summary yet (pending) or none could be derived, fill the
    // reserved detail row with a status word instead of a blank line so the area
    // under the ⎿ gutter never looks empty. Real summaries keep the normal text
    // color; the status placeholder is rendered dim.
    const isPlaceholderDetail = !(expanded && hasRawResult) && !detailText;
    const showRawAggregate = expanded && hasRawResult;
    // Pending placeholder carries the elapsed time (`Running · 12s`) once it
    // reaches >=1s — this is still ONE logical detail row (only its text
    // changes), so estimateTranscriptItemRows stays in lockstep.
    const pendingPlaceholder = headerPending
      ? (elapsed ? `Running · ${elapsed}` : 'Running')
      : 'Finished';
    const detailLines = showRawAggregate
      ? rawRt.split('\n')
      : (detailText ? [detailText] : [pendingPlaceholder]);
    const aggregateDetailColor = isPlaceholderDetail ? theme.subtle : theme.text;
    return (
      <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
        <Box flexDirection="row" width={rowWidth} overflow="hidden">
          <Box flexShrink={0} minWidth={2}>
            <Text color={dotColor}>{dotText}</Text>
          </Box>
          <Text wrap="truncate">
            <Text bold color={theme.text}>{clippedHeader}</Text>
            {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
          </Text>
        </Box>
        <ResultBody
          lines={detailLines}
          rawText={rawRt || ''}
          columns={columns}
          color={aggregateDetailColor}
          raw={showRawAggregate}
        />
      </Box>
    );
  }

  // ── Normal (non-aggregate) tool card ────────────────────────────
  const { label, summary, normalizedName, args: parsedArgs } = formatToolSurface(name, args);
  const isShellSurface = isShellTool(normalizedName, label);
  const isSkillSurface = SKILL_SURFACE_NAMES.has(String(normalizedName || '').toLowerCase());
  const backgroundMeta = !pending && isBackgroundTaskTool(normalizedName)
    ? resolveBackgroundTaskMeta(parsedArgs, rt || '')
    : null;
  const backgroundError = backgroundMeta?.error || parsedArgs?.error || '';
  const errorOnlyResult = Boolean(rt) && isBackgroundErrorOnlyBody(rt, backgroundError);
  const backgroundResultText = backgroundMeta?.hasResponse ? backgroundMeta.body : '';
  const displayedResultText = backgroundResultText || (errorOnlyResult ? '' : (rt || ''));
  const hasDisplayResult = Boolean(String(displayedResultText || '').trim());
  const displayedResultBodyText = stripLeadingStatusMarkerFromText(displayedResultText);
  const hasDisplayBody = Boolean(String(displayedResultBodyText || '').trim());
  const lines = displayedResultBodyText ? displayedResultBodyText.split('\n') : [];
  const totalLines = lines.length;
  // Semantic one-line summary derived purely from name/args/result text.
  // Shown in the collapsed, non-error view in place of the raw result block.
  // Grouped cards ("Searched N files" / "Read N files") get the same treatment
  // as single calls: a one-line semantic summary stands in for the raw block.
  const resultSummary = !pending && hasDisplayBody
    ? surfaceSummarizeToolResult(name, args, displayedResultBodyText, isError)
    : null;
  // Same fit budget fitResultLine() uses, to detect a line that will be clipped.
  const maxResultChars = Math.min(RESULT_LINE_HARD_MAX, Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7));
  const resultColor = theme.text;
  const firstResultLine = hasDisplayResult ? String(lines[0] ?? '') : '';
  const firstResultLineClipped = hasDisplayBody && stringWidth(firstResultLine) > maxResultChars;
  const hasHiddenDetail = !pending && hasDisplayBody && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));
  const shellStatus = isShellSurface ? shellDisplayStatus({ pending, failedCount, isError, result: displayedResultText }) : '';
  const shellElapsed = isShellSurface ? (shellResultElapsed(displayedResultText) || elapsed) : '';
  const backgroundElapsed = backgroundMeta
    ? backgroundTaskElapsed(backgroundMeta, elapsed)
    : (isBackgroundTaskTool(normalizedName) ? backgroundTaskElapsed(parsedArgs, elapsed) : '');

  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  const imageDetail = normalizedName === 'view_image' && toolArgPath ? String(toolArgPath) : '';
  const isBackgroundResult = !pending && isBackgroundTaskTool(normalizedName) && Boolean(backgroundMeta);
  const isBackgroundResponse = isBackgroundResult && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
  const isBackgroundMetadataResult = isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta);
  const backgroundMetadataFailureLabel = isBackgroundMetadataResult
    ? backgroundTaskFailureDetail(backgroundMeta, parsedArgs)
    : '';
  const backgroundMetadataHeaderFailure = Boolean(backgroundMetadataFailureLabel) && !hasDisplayResult
    ? backgroundMetadataFailureLabel
    : '';
  const agentHeaderFailure = !pending && isAgentTool(normalizedName) && isError && parsedArgs?.error && !hasDisplayResult
    ? backgroundTaskFailureStatusLabel(parsedArgs?.status, parsedArgs?.error, { surface: 'agent' })
    : '';
  const headerFailureStatus = backgroundMetadataHeaderFailure || agentHeaderFailure || '';
  const agentCompletionDetail = !pending && isAgentTool(normalizedName) && !agentHeaderFailure
    ? agentTerminalDetail(parsedArgs?.status, isError, elapsed, parsedArgs?.error)
    : '';
  const agentDetail = !pending && isAgentTool(normalizedName) && !hasDisplayResult
    ? agentCompletionDetail
    : '';
  const genericDetail = !pending && !isShellSurface && !agentDetail && !imageDetail && !resultSummary
    ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
    : '';
  const terminalStatus = pending
    ? 'running'
    : (shellStatus || normalizeTerminalStatus(backgroundMeta?.status) || normalizeTerminalStatus(parsedArgs?.status) || resultTerminalStatus(displayedResultText) || (isError || failedCount > 0 ? 'failed' : 'completed'));
  const backgroundMetadataDetail = isBackgroundMetadataResult && !backgroundMetadataHeaderFailure
    ? backgroundTaskDetail(backgroundMeta, backgroundElapsed, parsedArgs)
    : '';
  const backgroundResponseDetail = isBackgroundResponse && resultSummary
    ? prefixElapsed(resultSummary, backgroundElapsed)
    : resultSummary;
  const syncElapsedDetail = !isBackgroundResponse && shouldPrefixSyncElapsed(normalizedName, label)
    ? prefixElapsed(backgroundResponseDetail, elapsed)
    : backgroundResponseDetail;
  const nonShellDetail = backgroundMetadataDetail || (/^(Cancelled|Failed|Finished)$/i.test(resultSummary || '') && agentCompletionDetail
    ? agentCompletionDetail
    : syncElapsedDetail) || agentDetail || imageDetail || genericDetail;
  // A pending non-aggregate tool used to drop its detail row entirely
  // (collapsedDetail = ''), so the card rendered as a single header row. But
  // estimateTranscriptItemRows() in App.jsx reserves 2 rows for a collapsed
  // non-aggregate tool (1 only for skill surfaces). That left a 1-row gap that
  // closed the instant the result landed — the surviving "튐". Reserve the same
  // dim placeholder detail row the aggregate card uses (`Running`) for the whole
  // pending lifecycle so the height stays fixed at header + one detail row and
  // the final summary just fills in place. Skill surfaces collapse to a single
  // row in BOTH the estimate and the render (visibleDetailLines drops the row
  // for isSkillSurface below), so they get no placeholder.
  const pendingDetailPlaceholder = pending && !isSkillSurface
    ? (elapsed ? `Running · ${elapsed}` : 'Running')
    : '';
  const shellCollapsedSummary = isShellSurface && !pending && hasDisplayResult
    ? (resultSummary || truncateToWidth(firstResultLine, Math.min(120, maxResultChars)))
    : resultSummary;
  const collapsedDetail = pending
    ? pendingDetailPlaceholder
    : isShellSurface
      ? prefixElapsed(mergeTerminalDetail(shellStatus, shellCollapsedSummary), shellElapsed)
      : mergeTerminalDetail(terminalStatus, nonShellDetail);
  const backgroundMetadataExpandable = isBackgroundMetadataResult && hasRawResult && !pending;
  const showRawResult = expanded && (hasDisplayBody || hasRawResult)
    && (!isBackgroundMetadataResult || hasRawResult);
  const detailLines = showRawResult
    ? (hasDisplayBody ? lines : (rawRt ? stripLeadingStatusMarkerLines(rawRt.split('\n')) : []))
    : (collapsedDetail ? [collapsedDetail] : []);
  const isPendingPlaceholderDetail = !showRawResult && Boolean(pendingDetailPlaceholder);
  const detailColor = isPendingPlaceholderDetail ? theme.subtle : theme.text;

  const isAgentResult = !isBackgroundResult && !pending && isAgentTool(normalizedName) && hasDisplayResult;
  const isAgentResponse = isAgentResult && hasAgentResponseResult(rt);
  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard && !showRawResult
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || '', { isError, isResponse: isAgentResponse })
    : '';
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncateToWidth(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : '';
  // Skill loads carry the skill name in the header already
  // ("Loaded 1 skill (name)"); the collapsed detail row just repeats it, so
  // drop it and keep the card a single line. Expanding (ctrl+o) still shows the
  // full skill body via the raw-result path.
  // Agent spawn/send/response cards show a tight brief under the ⎿ gutter when
  // collapsed; ctrl+o expand still surfaces the full body.
  let visibleDetailLines = detailLines;
  if (isSkillSurface && !showRawResult) {
    visibleDetailLines = [];
  } else if (isBackgroundMetadataResult && backgroundMetadataHeaderFailure && !showRawResult) {
    visibleDetailLines = [];
  } else if (isAgentSurfaceCard && !showRawResult) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || 'Running') : 'Finished');
    const agentDetailLine = agentSurfaceBrief
      || truncateToWidth(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    visibleDetailLines = agentHeaderFailure && !agentSurfaceBrief ? [] : [agentDetailLine];
  }
  const finalStatusColor = toolStatusColor({ pending, groupCount, failedCount, terminalStatus });
  const dotColor = finalStatusColor;
  const dotText = pending && !blinkExpired && !blinkOn ? ' ' : TURN_MARKER;
  let labelText;
  if (isAgentResponse) labelText = agentResponseTitle(parsedArgs);
  else if (isBackgroundResponse) labelText = backgroundTaskResultTitle(normalizedName, backgroundMeta || parsedArgs);
  else if (isBackgroundMetadataResult) labelText = backgroundTaskActionTitle(normalizedName, backgroundMeta);
  else if (isShellSurface) labelText = shellHeader(shellStatus, displayGroupCount);
  else labelText = (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '') || statusCopy(name, label, displayGroupCount, doneCount, headerPending, isError, parsedArgs);
  labelText = safeInlineText(labelText);
  // Show the parenthesized arg summary for grouped cards too, matching single
  // calls so the header carries the same context.
  const toolSearchSummary = !pending && normalizedName === 'tool_search' && hasResult
    ? toolSearchLoadedSummary(displayedResultText)
    : '';
  const rawSummaryText = safeInlineText(isAgentResponse || isBackgroundResponse
    ? ''
    : toolSearchSummary || (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary));
  // Drop the parenthesized arg summary when it is a bare "<n> <unit>" count
  // that the header verb already spells out (e.g. header "Searching 6 patterns"
  // + summary "6 patterns"). Multi-arg array calls hit this; single calls keep
  // their descriptive summary ("pattern: \"foo\"") since it never matches the
  // header tail. Channel surfaces are unaffected — they build the summary from
  // summarizeToolArgs directly and never render this header verb.
  const summaryIsHeaderCount = rawSummaryText
    && /^\d+\s+\S+$/.test(rawSummaryText)
    && labelText.endsWith(rawSummaryText);
  const summaryText = summaryIsHeaderCount ? '' : rawSummaryText;
  // Agent cards hide their collapsed body but still expose ctrl+o expand only
  // when expanding would actually reveal something: an agent response body, or a
  // multiline / clipped raw result (e.g. the "agents: N …" worker list). A
  // status-only single-line metadata result has nothing extra to show, so it
  // gets no hint.
  const agentHasExpandableBody = isAgentSurfaceCard && !pending && hasResult
    && (isAgentResponse || totalLines > 1 || firstResultLineClipped);
  // Agent cards gate the hint solely on agentHasExpandableBody — never on
  // hasHiddenDetail, which goes true for any single-line resultSummary and would
  // wrongly show ctrl+o on a status-only one-liner that has nothing to expand.
  const shellHasExpandableBody = isShellSurface && !pending && hasDisplayResult
    && hasDisplayBody
    && (totalLines > 1 || firstResultLineClipped || Boolean(shellCollapsedSummary && shellCollapsedSummary !== firstResultLine));
  const showHeaderExpandHint = (isShellSurface ? shellHasExpandableBody : (isAgentSurfaceCard ? agentHasExpandableBody : (hasHiddenDetail || backgroundMetadataExpandable)))
    && normalizedName !== 'tool_search';
  const expandHintColor = theme.subtle;

  // Build a single-line header that never wraps: reserve width for the fixed
  // trailing expand hint plus the dot gutter and a 1-col Windows last-column
  // safety margin, then truncate label/summary to fit. Pending state is already
  // shown by the verb (Running/Reading/etc.), the blinking dot, and the detail
  // row, so avoid an extra standalone ellipsis between parenthesized segments.
  const gutter = 2;
  const hintLabel = showHeaderExpandHint ? `ctrl+o ${expanded ? 'collapse' : 'expand'}` : '';
  const hintText = hintLabel ? ` ${BULLET_OPERATOR} ${hintLabel}` : '';
  // The header right-side trailing slot only ever shows the ctrl+o hint. The
  // pending elapsed meta was removed from the header — it lives on the detail
  // row now (`Running · 12s`) so a per-second digit change (9s→10s) or the
  // pending→done swap never reflows the header. The hint slot is reserved for
  // the whole lifecycle (even while pending) so its later appearance on
  // completion does not push the body clip point.
  const hintReserveLabel = `ctrl+o ${expanded ? 'collapse' : 'expand'}`;
  const hintReserveText = ` ${BULLET_OPERATOR} ${hintReserveLabel}`;
  const headerFailureText = headerFailureStatus
    ? truncateToWidth(headerFailureStatus, HEADER_FAILURE_STATUS_MAX)
    : '';
  const inlineFailureText = headerFailureText ? ` ${BULLET_OPERATOR} ${headerFailureText}` : '';
  const rightReserve = stringWidth(hintReserveText) + stringWidth(inlineFailureText);
  const avail = Math.max(1, (Number(columns) || 80) - 1 - gutter - rightReserve);
  const trailingText = showHeaderExpandHint ? hintText : '';
  const trailingColor = expandHintColor;
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
  // Keep trailing content (ctrl+o hint only; pending elapsed lives on the detail
  // row) attached directly after the body for the whole lifecycle. The
  // fixed-column pin previously used for elapsed is what made the trailing text
  // jump to the right edge and snap back on the pending→done flip, so there is no
  // pad. `avail` stays reserved (rightReserve) so the body clip point never reflows.
  return (
    <Box flexDirection="column" marginTop={attached ? 0 : 1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1} overflow="hidden" minWidth={0}>
          <Box flexDirection="row">
            <Box flexShrink={0} minWidth={2}>
              <Text color={dotColor}>{dotText}</Text>
            </Box>
            <Text wrap="truncate">
              <Text bold color={theme.text}>{labelOut}</Text>
              {summaryOut ? <Text color={theme.text}>{summaryOut}</Text> : null}
              {inlineFailureText ? <Text color={theme.error}>{inlineFailureText}</Text> : null}
              {trailingText ? <Text color={trailingColor}>{trailingText}</Text> : null}
            </Text>
          </Box>
        </Box>
      </Box>

      <ResultBody
        lines={visibleDetailLines}
        rawText={hasDisplayBody ? displayedResultBodyText : stripLeadingStatusMarkerFromText(rawRt || '')}
        pathArg={toolArgPath}
        isShell={isShellSurface}
        columns={columns}
        color={showRawResult ? resultColor : detailColor}
        raw={showRawResult}
      />
    </Box>
  );
}
