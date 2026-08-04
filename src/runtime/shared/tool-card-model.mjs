/**
 * runtime/shared/tool-card-model.mjs — the ONE collapsed tool-card text model.
 *
 * Every surface (TUI ToolExecution, desktop ToolCard) derives its tool-card
 * header label, parenthesized arg summary, and collapsed `└ detail` row from
 * deriveToolCardModel() so per-tool formats, casing, status merging
 * ("Failed · cause", "Exit 1", "Running · 12s") can never drift between
 * clients. The pure surface/status helpers here were moved verbatim from
 * src/tui/components/tool-execution/{text-format,surface-detail}.mjs — those
 * TUI modules now re-export from this file; width fitting and theme colors
 * stay surface-side.
 */
import stripAnsi from 'strip-ansi';
import {
  AGENT_SURFACE_BRIEF_MAX,
  displayModelName,
  formatAggregateHeader,
  formatToolActionHeader,
  formatToolSurface,
  summarizeAgentSurfaceBrief,
  summarizeToolResult,
} from './tool-surface.mjs';
import { backgroundTaskFailureStatusLabel, isBackgroundErrorOnlyBody } from './err-text.mjs';
import { normalizeToolTerminalStatus, toolResultTerminalStatus } from './tool-status.mjs';
import { formatElapsed } from './time-format.mjs';

export const MIN_RESULT_LINE_CHARS = 24;
// Hard cap for the collapsed result detail row (the second line under the ⎿
// gutter). Independent of terminal width so a wide terminal never lets a long
// line (e.g. an agent response brief) stretch the whole row — anything past
// this is truncated with an ellipsis. Expanding still shows the full body.
export const RESULT_LINE_HARD_MAX = 80;
// Hard cap for the parenthesized header arg summary so a long path/query does
// not eat the whole header line; anything longer is truncated with an ellipsis.
export const SUMMARY_MAX_CHARS = 48;
export const HEADER_FAILURE_STATUS_MAX = 32;

// Collapsed tool headers/details are laid out as single rows. Never let raw
// C0/control bytes (CR, tabs, cursor escapes, etc.) reach those rows.
const INLINE_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export function safeInlineText(value) {
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

export function normalizeCountMap(value = {}) {
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

export function plural(count, singular, pluralText = `${singular}s`) {
  return count === 1 ? singular : pluralText;
}

export function shellResultStatus(value) {
  const match = String(value || '').match(/(?:^|\b)status:\s*(running|pending|queued|completed|failed|cancelled|canceled)\b/im);
  return match ? String(match[1] || '').toLowerCase() : '';
}

export function normalizeTerminalStatus(value) {
  return normalizeToolTerminalStatus(value);
}

export function displayTerminalStatus(value) {
  // 'exit' is a shell-only pseudo-status (command RAN but exited non-zero); it
  // is intentionally NOT a normalized terminal status so it never colors red.
  if (String(value || '').trim().toLowerCase() === 'exit') return 'Exit';
  const status = normalizeTerminalStatus(value);
  if (status === 'running') return 'Running';
  if (status === 'completed') return 'Finished';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'denied') return 'Denied';
  return '';
}

export function resultTerminalStatus(value) {
  return toolResultTerminalStatus(value);
}

const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

export function stripLeadingStatusMarkerLines(lines) {
  const out = Array.isArray(lines) ? lines.slice() : [];
  if (out.length > 0 && LEADING_STATUS_MARKER_LINE_RE.test(String(out[0] ?? '').trim())) out.shift();
  return out;
}

export function stripLeadingStatusMarkerFromText(text) {
  return stripLeadingStatusMarkerLines(String(text || '').split('\n')).join('\n');
}

export function shellResultElapsed(value) {
  const match = String(value || '').match(/^\[elapsed:\s*(\d+)\s*ms\]/mi);
  if (!match) return '';
  const elapsedMs = Number(match[1]);
  return Number.isFinite(elapsedMs) && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
}

// `+N`/`-N` line-delta tokens inside a detail row ("+177 lines"). Surfaces
// color the token (TUI theme / desktop CSS); the SPLIT lives here so both
// recognize the same grammar.
const LINE_DELTA_RE = /(^|[\s([,{·])([+-]\s*\d+)(?=\s+Lines?\b)/gi;

export function splitLineDeltaTokens(text) {
  const value = String(text ?? '');
  const parts = [];
  let last = 0;
  let match;
  LINE_DELTA_RE.lastIndex = 0;
  while ((match = LINE_DELTA_RE.exec(value))) {
    const prefix = match[1] || '';
    const token = (match[2] || '').replace(/\s+/g, '');
    const tokenStart = match.index + prefix.length;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    if (prefix) parts.push({ text: prefix });
    if (token) parts.push({ text: token, delta: token.startsWith('+') ? '+' : '-' });
    last = tokenStart + (match[2] || '').length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

export function isShellTool(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run';
}

export function shellDisplayStatus({ pending = false, failedCount = 0, exitFailedCount = 0, isError = false, result = '' } = {}) {
  const status = shellResultStatus(result);
  if (pending || /^(running|pending|queued)$/.test(status)) return 'running';
  if (/^cancel/.test(status)) return 'cancelled';
  if (/^(failed|error|killed|timeout)$/.test(status)) return 'failed';
  // A command that RAN but exited non-zero is a command-exit, not a real
  // failure: render the neutral "Exit" state unless there is ALSO a real
  // tool-call/result failure in the group.
  const realFailed = Math.max(0, Number(failedCount) - Number(exitFailedCount));
  if (realFailed > 0) return 'failed';
  if (Number(exitFailedCount) > 0) return 'exit';
  if (isError || failedCount > 0) return 'failed';
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

export function agentResponseTitle(args, count = 1) {
  const total = Math.max(1, Number(count) || 1);
  if (total > 1) return `Responses ${total} agents`;
  const name = titleizeAgentName(args?.agent || args?.subagent_type || args?.name || '');
  // The agent + model identify the responder; the response summary itself
  // is hidden in the collapsed card (expanding still shows the full body).
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

function backgroundTaskDisplayName(normalizedName, meta = {}) {
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

function isOutputDetailTool(normalizedName, label) {
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
    const loaded = /^Loaded deferred tools:\s*(.+)$/m.exec(text)?.[1] || '';
    const already = /^Already active:\s*(.+)$/m.exec(text)?.[1] || '';
    return [
      ...(loaded ? [`Loaded: ${loaded}`] : []),
      ...(already ? [`Already active: ${already}`] : []),
    ].join(' · ');
  }
  const tools = parsed?.selected?.tools;
  if (!tools || typeof tools !== 'object') return '';
  const uniqueNames = (names) => [...new Set((Array.isArray(names) ? names : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean))];
  const loaded = uniqueNames(tools.added);
  const already = uniqueNames(tools.already);
  return [
    ...(loaded.length ? [`Loaded: ${loaded.join(', ')}`] : []),
    ...(already.length ? [`Already active: ${already.join(', ')}`] : []),
  ].join(' · ');
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

function clipPlain(text, maxChars) {
  const value = safeInlineText(text);
  const max = Math.max(1, Number(maxChars) || 1);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Derive the collapsed tool-card text model shared by every surface.
 *
 * Mirrors ToolExecution's derivation exactly; the TUI consumes this and adds
 * width fitting/colors, the desktop consumes this and adds CSS/ellipsis.
 *
 * @param {object} input Tool item fields (name/args/result/rawResult/isError/
 *   errorCount/callErrorCount/exitErrorCount/count/completedCount/startedAt/
 *   completedAt/aggregate/categories/doneCategories/headerFinalized/nowMs).
 * @param {object} options { truncate(text,width), maxResultChars }.
 */
export function deriveToolCardModel(input = {}, options = {}) {
  const {
    name = '', args = {}, result = null, rawResult = null,
    isError = false, errorCount, callErrorCount, exitErrorCount,
    count = 1, completedCount, startedAt = 0, completedAt = 0,
    aggregate = false, categories = {}, doneCategories = null,
    headerFinalized = true,
  } = input;
  const nowMs = Number(input.nowMs || Date.now());
  const truncate = typeof options.truncate === 'function' ? options.truncate : clipPlain;
  const maxResultChars = Math.max(MIN_RESULT_LINE_CHARS,
    Math.min(RESULT_LINE_HARD_MAX, Number(options.maxResultChars ?? RESULT_LINE_HARD_MAX)));

  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount ?? (result == null ? 0 : groupCount))));
  const rt = result == null ? null : String(result).replace(/\s+$/, '');
  const rawRt = rawResult == null ? null : String(rawResult).replace(/\s+$/, '');
  const pending = doneCount < groupCount;
  const headerPending = pending || headerFinalized === false;
  const hasResult = result != null && Boolean(String(rt || '').trim());
  const hasRawResult = rawResult != null && Boolean(String(rawRt || '').trim());
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const elapsedMs = startedAtMs ? Math.max(0, (pending ? nowMs : (completedAtMs || nowMs)) - startedAtMs) : 0;
  const elapsed = elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '';
  const failedCount = clampFailureCount(errorCount, groupCount, isError);
  const callFailedCount = clampFailureCount(callErrorCount, groupCount, false);
  const exitFailedCount = clampFailureCount(exitErrorCount, groupCount, false);

  if (aggregate) {
    const displayCategories = normalizeCountMap(categories || {});
    const normalizedDone = doneCategories ? normalizeCountMap(doneCategories) : displayCategories;
    const hasDoneCounts = Object.values(normalizedDone || {}).some(
      (v) => (v && typeof v === 'object' ? Number(v.count || 0) : Number(v || 0)) > 0,
    );
    const displayDone = hasDoneCounts ? normalizedDone : displayCategories;
    const headerOrder = Array.isArray(args?.categoryOrder) ? args.categoryOrder : null;
    const labelText = safeInlineText(formatAggregateHeader(
      (headerPending ? displayCategories : displayDone) || {},
      { pending: headerPending, order: headerOrder },
    ));
    const detailText = hasResult ? safeInlineText(rt) : '';
    const terminalStatus = pending
      ? 'running'
      : (resultTerminalStatus(rt) || (isError || failedCount > 0 ? 'failed' : 'completed'));
    return {
      aggregate: true, pending, headerPending, groupCount, doneCount, elapsed,
      failedCount, callFailedCount, exitFailedCount, terminalStatus,
      labelText, summaryText: '', headerFailureText: '',
      detailLine: detailText || (pending ? 'Running' : 'Finished'),
      detailIsPlaceholder: !detailText,
      hasResult, hasRawResult,
      displayedResultBodyText: rt || '',
      firstResultLine: detailText, totalLines: detailText ? 1 : 0,
      resultSummary: detailText || null, toolArgPath: '',
      normalizedName: '', label: '', parsedArgs: args,
      isShellSurface: false, isSkillSurface: false, isAgentSurfaceCard: false,
      isAgentResponse: false, isBackgroundResponse: false, isBackgroundMetadataResult: false,
      backgroundMeta: null,
    };
  }

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
  const resultSummary = !pending && hasDisplayBody
    ? summarizeToolResult(name, args, displayedResultBodyText, isError)
    : null;
  const firstResultLine = hasDisplayResult ? String(lines[0] ?? '') : '';
  const shellStatus = isShellSurface
    ? shellDisplayStatus({ pending, failedCount, exitFailedCount, isError, result: displayedResultText })
    : '';
  const shellElapsed = isShellSurface ? (shellResultElapsed(displayedResultText) || elapsed) : '';
  const backgroundElapsed = backgroundMeta
    ? backgroundTaskElapsed(backgroundMeta, elapsed)
    : (isBackgroundTaskTool(normalizedName) ? backgroundTaskElapsed(parsedArgs, elapsed) : '');
  const toolArgPath = parsedArgs?.path ?? parsedArgs?.file_path ?? parsedArgs?.file ?? '';
  const imageDetail = normalizedName === 'view_image' && toolArgPath && !isError ? String(toolArgPath) : '';
  const isBackgroundResult = !pending && isBackgroundTaskTool(normalizedName) && Boolean(backgroundMeta);
  const isBackgroundResponse = isBackgroundResult
    && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgs(normalizedName, parsedArgs));
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
  const headerFailureText = backgroundMetadataHeaderFailure || agentHeaderFailure || '';
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
  const pendingDetailPlaceholder = pending && !isSkillSurface
    ? (elapsed ? `Running · ${elapsed}` : 'Running')
    : '';
  const shellCollapsedSummary = isShellSurface && !pending && hasDisplayResult
    ? (resultSummary || truncate(firstResultLine, Math.min(120, maxResultChars)))
    : resultSummary;
  const collapsedDetail = pending
    ? pendingDetailPlaceholder
    : isShellSurface
      ? prefixElapsed(mergeTerminalDetail(shellStatus, shellCollapsedSummary), shellElapsed)
      : mergeTerminalDetail(terminalStatus, nonShellDetail);

  const isAgentResult = !isBackgroundResult && !pending && isAgentTool(normalizedName) && hasDisplayResult;
  const isAgentResponse = isAgentResult && hasAgentResponseResult(rt);
  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || '', { isError, isResponse: isAgentResponse })
    : '';
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncate(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : '';

  // Collapsed visible detail line (skill/agent gating identical to the TUI).
  let detailLine = collapsedDetail;
  if (isSkillSurface) {
    detailLine = isError && collapsedDetail ? collapsedDetail : '';
  } else if (isBackgroundMetadataResult && backgroundMetadataHeaderFailure) {
    detailLine = '';
  } else if (isAgentSurfaceCard) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || 'Running') : 'Finished');
    const agentDetailLine = agentSurfaceBrief
      || truncate(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    const agentFailureText = /\b(Cancelled|Canceled|Failed)\b/i.test(agentSurfaceBrief || collapsedDetail || '');
    const keepAgentDetail = (isError || agentFailureText) && !(agentHeaderFailure && !agentSurfaceBrief);
    detailLine = keepAgentDetail ? agentDetailLine : '';
  }

  let labelText;
  if (isAgentResponse) labelText = agentResponseTitle(parsedArgs, groupCount);
  else if (isBackgroundResponse) labelText = backgroundTaskResultTitle(normalizedName, backgroundMeta || parsedArgs);
  else if (isBackgroundMetadataResult) labelText = backgroundTaskActionTitle(normalizedName, backgroundMeta);
  else if (isShellSurface) labelText = shellHeader(shellStatus, groupCount);
  else labelText = (isAgentTool(normalizedName) ? agentActionTitle(parsedArgs) : '')
    || formatToolActionHeader(name, args, { pending: headerPending, count: groupCount });
  labelText = safeInlineText(labelText);
  const toolSearchSummary = !pending && normalizedName === 'load_tool' && hasResult
    ? toolSearchLoadedSummary(displayedResultText)
    : '';
  const rawSummaryText = safeInlineText(isAgentResponse || isBackgroundResponse
    ? ''
    : toolSearchSummary || (isAgentTool(normalizedName) ? agentActionSummary(parsedArgs, summary) : summary));
  // Drop the parenthesized arg summary when it is a bare "<n> <unit>" count
  // that the header verb already spells out.
  const summaryIsHeaderCount = rawSummaryText
    && /^\d+\s+\S+$/.test(rawSummaryText)
    && labelText.endsWith(rawSummaryText);
  const summaryText = summaryIsHeaderCount ? '' : rawSummaryText;

  return {
    aggregate: false, pending, headerPending, groupCount, doneCount, elapsed,
    failedCount, callFailedCount, exitFailedCount, terminalStatus,
    labelText, summaryText, headerFailureText,
    detailLine, detailIsPlaceholder: Boolean(pendingDetailPlaceholder) && detailLine === pendingDetailPlaceholder,
    hasResult, hasRawResult, hasDisplayResult, hasDisplayBody,
    displayedResultBodyText, firstResultLine, totalLines, resultSummary,
    shellCollapsedSummary, agentSurfaceBrief, toolArgPath: String(toolArgPath || ''),
    normalizedName, label, parsedArgs,
    isShellSurface, isSkillSurface, isAgentSurfaceCard, isAgentResponse,
    isBackgroundResponse, isBackgroundMetadataResult, backgroundMeta,
  };
}
