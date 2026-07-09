/**
 * components/tool-execution/surface-detail.mjs — agent/background-task/shell
 * surface detection, title/summary/detail derivation, and status-color logic
 * for the tool card. Pure helpers (no React). Extracted verbatim from
 * ToolExecution.jsx — behavior unchanged.
 */
import { theme } from '../../theme.mjs';
import { formatElapsed } from '../../time-format.mjs';
import { displayModelName } from '../../../runtime/shared/tool-surface.mjs';
import { backgroundTaskFailureStatusLabel, isBackgroundErrorOnlyBody } from '../../../runtime/shared/err-text.mjs';
import {
  plural,
  displayTerminalStatus,
  normalizeTerminalStatus,
  shellResultStatus,
} from './text-format.mjs';

export function isShellTool(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run';
}

export function shellDisplayStatus({ pending = false, failedCount = 0, isError = false, result = '' } = {}) {
  const status = shellResultStatus(result);
  if (pending || /^(running|pending|queued)$/.test(status)) return 'running';
  if (/^cancel/.test(status)) return 'cancelled';
  if (/^(failed|error|killed|timeout)$/.test(status) || isError || failedCount > 0) return 'failed';
  return 'completed';
}

export function shellHeader(status, count = 1) {
  const n = Math.max(1, Number(count) || 1);
  const object = `${n} ${plural(n, 'command')}`;
  if (status === 'running') return `Running ${object}`;
  return `Ran ${object}`;
}

export function isAgentTool(normalizedName) {
  return normalizedName === 'agent';
}

export const SKILL_SURFACE_NAMES = new Set([
  'skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill',
]);

export function isBackgroundTaskTool(normalizedName) {
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

export function titleizeAgentName(value) {
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

export function agentModelLabel(args) {
  const a = args && typeof args === 'object' ? args : {};
  const provider = String(a.provider || a.providerId || a.provider_id || '').trim();
  const model = String(a.model || '').trim();
  const displayHint = String(a.modelDisplay || a.model_display || a.displayModel || '').trim();
  return displayModelName(model, provider, displayHint);
}

export function agentTagLabel(args) {
  // The real spawn tag (engine fills parsedArgs.tag from the envelope target).
  // Never fall back to task_id — only the human-meaningful spawn tag belongs in
  // the header parentheses.
  return String(args?.tag || '').trim();
}

export function withModelAndTag(label, args) {
  const model = agentModelLabel(args);
  const tag = agentTagLabel(args);
  const inner = [model, tag].filter(Boolean).join(', ');
  return inner ? `${label} (${inner})` : label;
}

// Append an agent name to a base action word without leaving a trailing space
// when the agent is unknown (no generic "Agent" fallback).
export function joinActionAgent(action, agent) {
  return agent ? `${action} ${agent}` : action;
}

export function agentResponseTitle(args) {
  const name = titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
  // The agent + model identify the responder; the response summary itself
  // is hidden in the collapsed card (ctrl+o expand still shows the full body).
  // No generic "Agent" fallback — render just "Response" when the agent is empty.
  return withModelAndTag(joinActionAgent('Response', name), args);
}

export function agentActionTitle(args) {
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

export function agentActionSummary(args, summary) {
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

export function hasAgentResponseResult(value) {
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

export function parseBackgroundTaskResult(value) {
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

export function backgroundTaskMetaFromArgs(args = {}) {
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

export function resolveBackgroundTaskMeta(parsedArgs = {}, resultText = '') {
  const parsed = parseBackgroundTaskResult(resultText);
  if (parsed) {
    if (!parsed.error && parsedArgs?.error) parsed.error = parsedArgs.error;
    if (!parsed.status && parsedArgs?.status) parsed.status = String(parsedArgs.status).toLowerCase();
    if (!parsed.surface && parsedArgs?.surface) parsed.surface = parsedArgs.surface;
    return parsed;
  }
  return backgroundTaskMetaFromArgs(parsedArgs);
}

export function backgroundTaskElapsed(meta = {}, fallback = '') {
  const startedMs = Date.parse(meta.startedAt || '');
  const finishedMs = Date.parse(meta.finishedAt || '');
  if (Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    const elapsedMs = finishedMs - startedMs;
    return elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  }
  return fallback || '';
}

export function prefixElapsed(detail, elapsed = '') {
  const text = String(detail || '').trim();
  const time = String(elapsed || '').trim();
  if (!time) return text;
  // Unified convention: the elapsed time ALWAYS goes at the END, ` · ` separated.
  // Guard against a double-append when the text already ends with the same time.
  if (text && text.endsWith(`· ${time}`)) return text;
  return text ? `${text} · ${time}` : time;
}

export function mergeTerminalDetail(status, detail = '') {
  const label = displayTerminalStatus(status);
  const text = String(detail || '').trim();
  if (!label) return text;
  if (label === 'Finished' && text) return text;
  if (!text) return label;
  if (text.toLowerCase().startsWith(label.toLowerCase())) return text;
  return `${label} · ${text}`;
}

export function shouldPrefixSyncElapsed(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'explore' || l === 'explore' || n === 'search' || l === 'search' || l === 'web search';
}

export function backgroundTaskDisplayName(normalizedName, meta = {}) {
  const surface = String(meta.surface || normalizedName || '').toLowerCase();
  if (surface === 'explore') return 'Explore';
  if (surface === 'search') return 'Search';
  if (surface === 'shell' || surface === 'bash' || surface === 'bash_session' || surface === 'shell_command' || surface === 'task') return 'Shell';
  return titleizeAgentName(surface || normalizedName || 'Task');
}

export function backgroundTaskResultTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (display === 'Shell') return 'Shell output';
  if (display === 'Search') return 'Search results';
  return `${display} response`;
}

export function backgroundTaskActionTitle(normalizedName, meta = {}) {
  const display = backgroundTaskDisplayName(normalizedName, meta);
  if (/^(running|pending|queued)$/i.test(meta.status || '')) return `Started ${display}`;
  if (meta.hasResponse) return backgroundTaskResultTitle(normalizedName, meta);
  return `${display} status`;
}

export function backgroundTaskFailureDetail(meta = {}, parsedArgs = {}) {
  const status = meta.status || parsedArgs?.status;
  const error = meta.error || parsedArgs?.error;
  if (!error) return '';
  const surface = meta.surface || parsedArgs?.surface || '';
  return backgroundTaskFailureStatusLabel(status, error, { surface });
}

export function backgroundTaskDetail(meta = {}, elapsed = '', parsedArgs = {}) {
  const parts = [];
  const status = displayTerminalStatus(meta.status);
  if (status) parts.push(status);
  if (meta.taskId) parts.push(`task_id: ${meta.taskId}`);
  const firstBodyLine = String(meta.body || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstBodyLine && /^(running|pending|queued)$/i.test(meta.status || '')) parts.push(firstBodyLine);
  return prefixElapsed(parts.join(' · '), elapsed);
}

export function isBackgroundTaskResponseArgs(normalizedName, args = {}) {
  if (!isBackgroundTaskTool(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  return type === 'result' || type === 'completion' || (/^(completed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id));
}

export function isOutputDetailTool(normalizedName, label) {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return new Set([
    'shell', 'bash', 'bash_session', 'shell_command', 'job_wait',
    'read', 'view_image', 'read_mcp_resource',
    'grep', 'glob', 'search', 'search_query', 'image_query', 'web_search', 'web_search_call', 'explore', 'web_fetch', 'fetch',
    'list', 'ls', 'code_graph',
    'recall', 'recall_memory', 'search_memories', 'remember', 'save_memory', 'update_memory',
  ]).has(n) || l === 'read' || l === 'search' || l === 'web search' || l === 'run';
}

export function genericCompletedDetail({ normalizedName, label, hasResult, firstResultLine, isError }) {
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

export function toolSearchLoadedSummary(resultText) {
  let parsed;
  try {
    parsed = JSON.parse(String(resultText || ''));
  } catch {
    const text = String(resultText || '');
    const match = /^Loaded deferred tools:\s*(.+)$/m.exec(text);
    if (!match) return '';
    return [...new Set(match[1].split(',').map((name) => name.trim()).filter(Boolean))].join(', ');
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

export function agentTerminalDetail(status, isError, elapsed, error = '') {
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

export function clampFailureCount(errorCount, groupCount, isError) {
  const explicit = Number(errorCount);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(groupCount, Math.floor(explicit)));
  return isError ? groupCount : 0;
}

// Single source of truth for the tool-card dot (●) color. Both the aggregate
// and normal (single-tool) render paths must call this with a resolved
// `terminalStatus` — do not recompute color inline elsewhere.
//   running/pending  -> theme.text (white; blink handled by caller)
//   success          -> theme.success
//   partial failure  -> mixdogOrange || warning (some, not all, of the group failed)
//   all failed       -> theme.error
//   cancelled        -> theme.warning
// The RED/orange failure color is driven ONLY by real tool-call errors
// (`callFailedCount` — backend isError / error toolKind), NOT by command/result
// failures like a shell non-zero exit or a `[status: failed]` result. Those
// keep the card's L2 detail showing "Failed" but leave the dot on the success
// color. `terminalStatus` is still consulted so a cancelled card stays warning.
export function toolStatusColor({ pending, groupCount, callFailedCount = 0, terminalStatus = '' }) {
  if (pending) return theme.text;
  const status = normalizeTerminalStatus(terminalStatus);
  if (status === 'cancelled') return theme.warning;
  if (callFailedCount <= 0) return theme.success;
  if (groupCount > 1 && callFailedCount < groupCount) return theme.mixdogOrange || theme.warning;
  return theme.error;
}
