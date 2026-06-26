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
import React, { useEffect, useRef, useState } from 'react';
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
const TOOL_BLINK_LIMIT_MS = 3000;
const TOOL_PENDING_SHOW_DELAY_MS = 1000;
const TOOL_HINT_DONE_COLOR = theme.subtle;
const COUNT_TWEEN_MS = 700;
const COUNT_TWEEN_FRAME_MS = 70;

function normalizeCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function baselineCount(value) {
  return normalizeCount(value) > 0 ? 1 : 0;
}

function easeOutCubic(t) {
  const clamped = Math.max(0, Math.min(1, Number(t) || 0));
  return 1 - Math.pow(1 - clamped, 3);
}

function tweenCount(from, to, progress) {
  const start = normalizeCount(from);
  const end = normalizeCount(to);
  if (end <= start) return end;
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  if (clamped >= 1) return end;
  return Math.min(end - 1, Math.max(start, Math.floor(start + ((end - start) * easeOutCubic(clamped)))));
}

function useCountUp(target, enabled = true) {
  const normalized = normalizeCount(target);
  const initial = enabled ? normalized : baselineCount(normalized);
  const [display, setDisplay] = useState(initial);
  const displayRef = useRef(initial);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!enabled) {
      const baseline = baselineCount(normalized);
      displayRef.current = baseline;
      setDisplay(baseline);
      return undefined;
    }
    const from = normalizeCount(displayRef.current);
    const to = normalized;
    if (to <= from) {
      displayRef.current = to;
      setDisplay(to);
      return undefined;
    }
    const started = Date.now();
    const tick = () => {
      const progress = Math.min(1, (Date.now() - started) / COUNT_TWEEN_MS);
      const next = tweenCount(from, to, progress);
      displayRef.current = next;
      setDisplay(next);
      if (progress >= 1 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    displayRef.current = from;
    setDisplay(from);
    const timer = setInterval(tick, COUNT_TWEEN_FRAME_MS);
    timerRef.current = timer;
    timer.unref?.();
    return () => {
      clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = null;
    };
  }, [normalized, enabled]);

  return display;
}

function normalizeCountMap(value = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) out[key] = normalizeCount(raw);
  return out;
}

function baselineCountMap(value = {}) {
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) out[key] = baselineCount(raw);
  return out;
}

function countMapSignature(value = {}) {
  return Object.keys(value || {})
    .sort()
    .map((key) => `${key}:${normalizeCount(value[key])}`)
    .join('|');
}

function useCountUpMap(targets = {}, enabled = true) {
  const normalizedTargets = normalizeCountMap(targets);
  const signature = countMapSignature(normalizedTargets);
  const initial = enabled ? normalizedTargets : baselineCountMap(normalizedTargets);
  const [display, setDisplay] = useState(initial);
  const displayRef = useRef(initial);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!enabled) {
      const baseline = baselineCountMap(normalizedTargets);
      displayRef.current = baseline;
      setDisplay(baseline);
      return undefined;
    }
    const from = {};
    let needsTween = false;
    for (const [key, to] of Object.entries(normalizedTargets)) {
      const current = normalizeCount(displayRef.current?.[key]);
      from[key] = current;
      if (to > current) needsTween = true;
    }
    if (!needsTween) {
      displayRef.current = normalizedTargets;
      setDisplay(normalizedTargets);
      return undefined;
    }
    const started = Date.now();
    const tick = () => {
      const progress = Math.min(1, (Date.now() - started) / COUNT_TWEEN_MS);
      const next = {};
      for (const [key, to] of Object.entries(normalizedTargets)) {
        const start = normalizeCount(from[key]);
        next[key] = tweenCount(start, to, progress);
      }
      displayRef.current = next;
      setDisplay(next);
      if (progress >= 1 && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    displayRef.current = from;
    setDisplay(from);
    const timer = setInterval(tick, COUNT_TWEEN_FRAME_MS);
    timerRef.current = timer;
    timer.unref?.();
    return () => {
      clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = null;
    };
  }, [signature, enabled]);

  return display;
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

function shellDisplayStatus({ pending = false, failedCount = 0, isError = false, result = '' } = {}) {
  const status = shellResultStatus(result);
  if (pending || /^(running|pending|queued)$/.test(status)) return 'running';
  if (/^cancel/.test(status)) return 'cancelled';
  if (/^(failed|error|killed|timeout)$/.test(status) || isError || failedCount > 0) return 'failed';
  return 'completed';
}

function shellHeader(status, count = 1) {
  const noun = plural(Number(count) || 1, 'command');
  if (status === 'running') return `Running ${noun}`;
  if (status === 'failed') return `Failed ${noun}`;
  if (status === 'cancelled') return `Cancelled ${noun}`;
  return `Ran ${noun}`;
}

function shellDetail(status, elapsed = '') {
  return elapsed ? `${elapsed} · ${status}` : status;
}

function shellResultElapsed(value) {
  const match = String(value || '').match(/^\[elapsed:\s*(\d+)\s*ms\]/mi);
  if (!match) return '';
  const elapsedMs = Number(match[1]);
  return Number.isFinite(elapsedMs) && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
}

function statusCopy(normalizedName, label, count, doneCount, pending, isError) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();

  const copy = (active, done, noun, pluralNoun = `${noun}s`) => {
    if (pending) return active;
    const object = `${count} ${plural(count, noun, pluralNoun)}`;
    return `${done} ${object}`;
  };

  const copyTarget = (active, done, target, pluralTarget = `${target}s`) => {
    if (pending) return `${active} ${target}`;
    const singularTarget = pluralTarget === 'web items' ? 'web item' : target;
    return `${done} ${count} ${plural(count, singularTarget, pluralTarget)}`;
  };

  if (l === 'mcp') return copy('Using MCP', 'Used', 'MCP tool', 'MCP tools');

  switch (n) {
    case 'read':
    case 'view_image':
    case 'read_mcp_resource':
      return copy('Reading', 'Read', 'file');
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
    case 'tool_search': {
      const target = String(label || '').replace(/^load\s+/i, '').trim();
      const lowerTarget = target.toLowerCase();
      if (pending) return target ? `Loading ${target}` : 'Loading Tools';
      if (lowerTarget === 'mcp') return copy('Loading MCP', 'Loaded', 'MCP tool', 'MCP tools');
      if (lowerTarget === 'skills') return copy('Loading Skills', 'Loaded', 'skill');
      if (lowerTarget === 'tools') return copy('Loading Tools', 'Loaded', 'tool');
      return copy('Loading', 'Loaded', 'item');
    }
    case 'explore':
      return copy('Exploring', 'Explored', 'item');
    case 'shell':
    case 'bash':
    case 'bash_session':
    case 'shell_command':
    case 'job_wait':
      return shellHeader(pending ? 'running' : (isError ? 'failed' : 'completed'), count);
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
    case 'skill_view':
    case 'skills_list':
      return copy('Loading Skill', 'Loaded', 'skill');
    case 'skill':
    case 'skill_execute':
    case 'use_skill':
      return copy('Using Skill', 'Used', 'skill');
    case 'reply':
    case 'react':
    case 'edit_message':
    case 'activate_channel_bridge':
    case 'inject_command':
      return copyTarget('Sending', 'Sent', 'message');
    case 'request_user_input':
      return pending ? 'Asking User' : 'Asked User';
    case 'update_plan':
      return pending ? 'Updating Plan' : 'Updated Plan';
    case 'diagnostics':
    case 'open_config':
    case 'provider_status':
    case 'channel_status':
    case 'schedule_status':
    case 'schedule_control':
    case 'reload_config':
    case 'list_mcp_resources':
    case 'list_mcp_resource_templates':
    case 'cwd':
    case 'trigger_schedule':
      return copy('Setting Up', 'Set Up', 'item');
    default:
      if (l === 'skill') return copy('Loading Skill', 'Loaded', 'skill');
      if (l === 'web search') return copyTarget('Researching', 'Researched', 'web', 'web items');
      if (l === 'search') return copy('Searching', 'Searched', 'tool');
      if (l === 'explore') return copy('Exploring', 'Explored', 'item');
      if (l === 'update') return copy('Editing', 'Edited', 'file');
      if (l === 'read') return copy('Reading', 'Read', 'file');
      if (l === 'run') return shellHeader(pending ? 'running' : (isError ? 'failed' : 'completed'), count);
      if (l === 'setup') return copy('Setting Up', 'Set Up', 'item');
      if (l === 'memory') return copyTarget('Checking', 'Checked', 'memory', 'memories');
      if (l === 'agent') return copyTarget('Calling', 'Called', 'agent');
      if (l === 'channel') return copyTarget('Sending', 'Sent', 'message');
      if (l === 'ask user') return pending ? 'Asking User' : 'Asked User';
      if (l === 'plan') return pending ? 'Updating Plan' : 'Updated Plan';
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

function isBackgroundTaskTool(normalizedName) {
  return new Set(['explore', 'search', 'shell', 'bash', 'bash_session', 'shell_command', 'task']).has(String(normalizedName || '').toLowerCase());
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
  if (action === 'list') return 'Agent status';
  if (action === 'cancel') return status && !/unknown/i.test(status) ? 'Cancelled Agent' : 'Cancel Agent';
  if (action === 'close') return status && !/unknown/i.test(status) ? 'Closed Agent' : 'Close Agent';
  if (action === 'cleanup') return 'Cleaned Agent State';
  if (action === 'read' || action === 'status') return `${agent} status`;
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
  if (/^(?:undefined|null)$/i.test(text)) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(text)) return false;
  const isBridgeEnvelope = /^(?:bridge task:|bridge job:|background task\b|bridge mode:|bridge message queued\b|bridge close:)/i.test(text)
    || (/^task_id:\s*\S+/mi.test(text) && /^(?:surface|operation|status):\s*/mi.test(text));
  if (!isBridgeEnvelope) return true;
  let sawBlank = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      sawBlank = true;
      continue;
    }
    if (/^bridge result\b/i.test(trimmed)) continue;
    if (/^(?:undefined|null)$/i.test(trimmed)) continue;
    if (/^<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>$/i.test(trimmed)) continue;
    if (!sawBlank && /^(?:bridge job|bridge task|background task|bridge message queued\b|bridge close:|task_id|surface|operation|label|status|type|target|role|agent|preset|model|effort|fast|limits|started|finished|error|notification|queueDepth):?\s*/i.test(trimmed)) continue;
    if (!sawBlank && /^(?:bridge mode|agents|tasks):\s*/i.test(trimmed)) continue;
    if (/^\(no bridge agents or tasks\)$/i.test(trimmed)) continue;
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
  return {
    taskId: fields.task_id || fields.taskid || '',
    surface: fields.surface || '',
    operation: fields.operation || '',
    label: fields.label || '',
    status,
    startedAt: fields.started || fields.startedat || '',
    finishedAt: fields.finished || fields.finishedat || '',
    body,
    hasResponse: Boolean(body) && !/^(running|pending|queued)$/i.test(status),
  };
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
  return text ? `${time} · ${text}` : time;
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

function backgroundTaskDetail(meta = {}, elapsed = '') {
  const parts = [];
  if (meta.status) parts.push(`status: ${meta.status}`);
  if (meta.taskId) parts.push(`task_id: ${meta.taskId}`);
  const firstBodyLine = String(meta.body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstBodyLine && /^(running|pending|queued)$/i.test(meta.status || '')) parts.push(firstBodyLine);
  return prefixElapsed(parts.join(' · '), elapsed);
}

function isBackgroundTaskResponseArgs(normalizedName, args = {}) {
  if (!isBackgroundTaskTool(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  return type === 'result' || type === 'completion' || (/^(completed|failed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id));
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

function progressDetail({ normalizedName, label, elapsed }) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  const suffix = elapsed ? ` - ${elapsed}` : '';
  if (l === 'mcp') return `Using MCP${suffix}`;
  if (n === 'skill_view' || n === 'skills_list') return `Loading Skill${suffix}`;
  if (n === 'skill' || n === 'skill_execute' || n === 'use_skill' || l === 'skill') return `Using Skill${suffix}`;
  if (n === 'tool_search') {
    const target = String(label || '').replace(/^load\s+/i, '').trim();
    return `Loading ${target || 'Tools'}${suffix}`;
  }
  if (isAgentTool(n) || l === 'agent') return `Calling Agent${suffix}`;
  if (n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run') return `Running${suffix}`;
  if (n === 'search' || n === 'search_query' || n === 'image_query' || n === 'web_search' || n === 'web_search_call' || n === 'firecrawl_search' || n === 'web_fetch' || n === 'fetch' || n === 'download_attachment' || l === 'web search') return `Researching Web${suffix}`;
  if (n === 'explore' || l === 'explore') return `Exploring${suffix}`;
  if (n === 'grep' || n === 'glob' || n === 'list' || n === 'ls' || l === 'search') return `Searching${suffix}`;
  if (n === 'read' || n === 'view_image' || n === 'read_mcp_resource' || l === 'read') return `Reading${suffix}`;
  if (n === 'apply_patch' || l === 'update') return `Editing${suffix}`;
  if (n === 'recall' || n === 'recall_memory' || n === 'search_memories' || l === 'memory') return `Checking Memory${suffix}`;
  if (n === 'reply' || n === 'react' || n === 'edit_message' || n === 'activate_channel_bridge' || n === 'inject_command' || l === 'channel') return `Sending${suffix}`;
  if (n === 'request_user_input' || l === 'ask user') return `Asking User${suffix}`;
  if (n === 'update_plan' || l === 'plan') return `Updating Plan${suffix}`;
  if (l === 'setup') return `Setting Up${suffix}`;
  return `Working${suffix}`;
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
  const [blinkExpired, setBlinkExpired] = useState(false);
  const [pendingDelayElapsed, setPendingDelayElapsed] = useState(false);
  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount || (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const pendingAgeMs = pending && startedAtMs ? Math.max(0, Date.now() - startedAtMs) : 0;
  const pendingDisplayReady = !pending || !startedAtMs || pendingDelayElapsed || pendingAgeMs >= TOOL_PENDING_SHOW_DELAY_MS;
  const completedQuickly = !pending && startedAtMs > 0 && completedAtMs > 0 && Math.max(0, completedAtMs - startedAtMs) < TOOL_PENDING_SHOW_DELAY_MS;
  const headerPending = pending || (headerFinalized === false && !completedQuickly);
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const elapsedMs = startedAtMs ? Math.max(0, (pending ? Date.now() : (completedAtMs || Date.now())) - startedAtMs) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  const statusColor = toolStatusColor({ pending, groupCount, failedCount });
  const countsVisible = !headerPending;
  const displayGroupCount = useCountUp(groupCount, countsVisible);
  const displayCategories = useCountUpMap(categories || {}, aggregate === true && countsVisible);

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

  if (pending && !pendingDisplayReady) return null;

  // ── Aggregate card ──────────────────────────────────────────────
  if (aggregate) {
    // Pending aggregate headers omit counts so intermediate tool batches do not
    // bounce between "Reading 1 item" and "Reading 4 items". Final counts and
    // result summaries appear only after completion.
    const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
    const headerText = formatAggregateHeader(displayCategories || {}, { pending: headerPending, order: headerOrder });
    let detailText;
    if (hasResult) {
      detailText = rt;
    } else if (pending) {
      detailText = '';
    } else {
      detailText = '';
    }

    const dotColor = statusColor;
    const dotText = pending && !blinkExpired && !blinkOn ? ' ' : TURN_MARKER;
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
                  {renderDeltaText(fitResultLine(line || ' ', columns))}
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
  const isShellSurface = isShellTool(normalizedName, label);
  const backgroundMeta = !pending && hasResult && isBackgroundTaskTool(normalizedName)
    ? parseBackgroundTaskResult(rt)
    : null;
  const backgroundResultText = backgroundMeta?.hasResponse ? backgroundMeta.body : '';
  const displayedResultText = backgroundResultText || rt;
  const lines = displayedResultText ? displayedResultText.split('\n') : [];
  const totalLines = lines.length;
  // Semantic one-line summary derived purely from name/args/result text.
  // Shown in the collapsed, non-error view in place of the raw result block.
  // Grouped cards ("Searched N files" / "Read N files") get the same treatment
  // as single calls: a one-line semantic summary stands in for the raw block.
  const resultSummary = !isShellSurface && !pending && hasResult
    ? surfaceSummarizeToolResult(name, args, displayedResultText, isError)
    : null;
  // Same fit budget fitResultLine() uses, to detect a line that will be clipped.
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS, Number(columns || 80) - 7);
  const resultColor = theme.text;
  const firstResultLine = hasResult ? String(lines[0] ?? '') : '';
  const firstResultLineClipped = hasResult && firstResultLine.length > maxResultChars;
  const hasHiddenDetail = !pending && hasResult && (totalLines > 1 || firstResultLineClipped || Boolean(resultSummary));
  const shellStatus = isShellSurface ? shellDisplayStatus({ pending, failedCount, isError, result: displayedResultText }) : '';
  const shellElapsed = isShellSurface ? (shellResultElapsed(displayedResultText) || elapsed) : '';
  const shellStatusDetail = isShellSurface ? shellDetail(shellStatus, shellElapsed) : '';
  const backgroundElapsed = backgroundMeta
    ? backgroundTaskElapsed(backgroundMeta, elapsed)
    : (isBackgroundTaskTool(normalizedName) ? backgroundTaskElapsed(parsedArgs, elapsed) : '');

  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  const imageDetail = normalizedName === 'view_image' && toolArgPath ? String(toolArgPath) : '';
  const agentCompletionDetail = !pending && isAgentTool(normalizedName)
    ? agentTerminalDetail(parsedArgs?.status, isError, elapsed)
    : '';
  const agentDetail = !pending && isAgentTool(normalizedName) && !hasResult
    ? agentCompletionDetail
    : '';
  const pendingDetail = pending
    ? (isShellSurface ? shellStatusDetail : progressDetail({ normalizedName, label, elapsed }))
    : '';
  const genericDetail = !pending && !isShellSurface && !agentDetail && !imageDetail && !resultSummary
    ? genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError })
    : '';
  const isBackgroundResult = !pending && hasResult && isBackgroundTaskTool(normalizedName);
  const isBackgroundResponse = isBackgroundResult && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
  const isBackgroundMetadataResult = isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta);
  const backgroundMetadataDetail = isBackgroundMetadataResult ? backgroundTaskDetail(backgroundMeta, backgroundElapsed) : '';
  const backgroundResponseDetail = isBackgroundResponse && resultSummary
    ? prefixElapsed(resultSummary, backgroundElapsed)
    : resultSummary;
  const syncElapsedDetail = !isBackgroundResponse && shouldPrefixSyncElapsed(normalizedName, label)
    ? prefixElapsed(backgroundResponseDetail, elapsed)
    : backgroundResponseDetail;
  const collapsedDetail = isShellSurface
    ? shellStatusDetail
    : pending
      ? pendingDetail
      : backgroundMetadataDetail || (/^(Cancelled|Failed|Finished)$/i.test(resultSummary || '') && agentCompletionDetail
      ? agentCompletionDetail
      : syncElapsedDetail) || agentDetail || imageDetail || genericDetail;
  const showRawResult = expanded && hasResult && !isBackgroundMetadataResult;
  const detailLines = showRawResult ? lines : (collapsedDetail ? [collapsedDetail] : []);
  const detailColor = theme.text;

  const isAgentResult = !isBackgroundResult && !pending && isAgentTool(normalizedName) && hasResult;
  const isAgentResponse = isAgentResult && hasAgentResponseResult(rt);
  const isAgentMetadataResult = isAgentResult && !isAgentResponse;
  const visibleDetailLines = isAgentMetadataResult ? [] : detailLines;
  const dotColor = isShellSurface && shellStatus === 'running' ? theme.subtle : statusColor;
  const dotText = pending && !blinkExpired && !blinkOn ? ' ' : TURN_MARKER;
  let labelText;
  if (isAgentResponse) labelText = agentResponseTitle(parsedArgs);
  else if (isBackgroundResponse) labelText = backgroundTaskResultTitle(normalizedName, backgroundMeta || parsedArgs);
  else if (isBackgroundMetadataResult) labelText = backgroundTaskActionTitle(normalizedName, backgroundMeta);
  else if (isShellSurface) labelText = shellHeader(shellStatus, displayGroupCount);
  else labelText = (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '') || statusCopy(normalizedName, label, displayGroupCount, doneCount, headerPending, isError);
  // Show the parenthesized arg summary for grouped cards too, matching single
  // calls so the header carries the same context.
  const summaryText = isShellSurface || isAgentResponse || isBackgroundResponse ? '' : (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary);
  const showHeaderExpandHint = hasHiddenDetail && !isShellSurface && !isAgentMetadataResult && !isBackgroundMetadataResult;
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

      {visibleDetailLines.length > 0 ? (
        <Box flexDirection="row">
          <Box flexShrink={0}>
            <Text color={theme.subtle}>{RESULT_GUTTER}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1} flexGrow={1}>
            {visibleDetailLines.map((line, i) => (
              <Text key={i} color={showRawResult ? resultColor : detailColor}>
                {renderDeltaText(fitResultLine(line || ' ', columns))}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
