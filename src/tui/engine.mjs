/**
 * src/tui/engine.mjs - the engine<->React bridge (React-free).
 *
 * Runs mixdog's session manager outside React and exposes a tiny subscribable
 * store. The React/ink layer consumes it via useSyncExternalStore
 * (see hooks/useEngine.mjs).
 */
import { performance } from 'node:perf_hooks';
import { SPINNER_VERBS } from './spinner-verbs.mjs';
import {
  aggregateToolCategoryEntry,
  classifyToolCategory,
  formatAggregateDetail,
  summarizeToolResult,
} from '../runtime/shared/tool-surface.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { formatDuration } from './time-format.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';

const BOOT_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
const BOOT_PROFILE_START = globalThis.__mixdogBootProfileStart || (globalThis.__mixdogBootProfileStart = performance.now());

function bootProfile(event, fields = {}) {
  if (!BOOT_PROFILE_ENABLED) return;
  const elapsedMs = performance.now() - BOOT_PROFILE_START;
  const parts = [`[mixdog-boot] +${elapsedMs.toFixed(1)}ms`, `tui:${event}`];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
  }
  try { process.stderr.write(`${parts.join(' ')}\n`); } catch {}
}

// Session-usage accumulator - inlined (not imported from ui/statusline.mjs) so
// engine.mjs has no static dependency on the vendored statusline closure.
function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCachedTokens: 0,
    latestCacheWriteTokens: 0,
    latestPromptTokens: 0,
    currentContextTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  const inputTokens = num(delta.deltaInput);
  const outputTokens = num(delta.deltaOutput);
  const cachedTokens = num(delta.deltaCachedRead);
  const cacheWriteTokens = num(delta.deltaCacheWrite);
  const promptTokens = num(delta.deltaPrompt);
  stats.inputTokens += inputTokens;
  stats.outputTokens += outputTokens;
  stats.cachedTokens += cachedTokens;
  stats.cacheWriteTokens += cacheWriteTokens;
  stats.promptTokens += promptTokens;
  stats.latestInputTokens = inputTokens;
  stats.latestOutputTokens = outputTokens;
  stats.latestCachedTokens = cachedTokens;
  stats.latestCacheWriteTokens = cacheWriteTokens;
  stats.latestPromptTokens = promptTokens;
  stats.costUsd += num(delta.costUsd);
  return stats;
}

// Source tests resolve from src/tui/engine.mjs; the built bundle resolves from
// src/tui/dist/index.mjs.
const SESSION_RUNTIME_MODULE = import.meta.url.replace(/\\/g, '/').includes('/tui/dist/')
  ? '../../mixdog-session-runtime.mjs'
  : '../mixdog-session-runtime.mjs';

let _idSeq = 0;
const nextId = () => `it_${++_idSeq}`;

function pickVerb(turn) {
  return SPINNER_VERBS[(turn * 7 + 3) % SPINNER_VERBS.length];
}

const TURN_DONE_VERBS = [
  'Thought',
  'Reasoned',
  'Mapped',
  'Checked',
  'Solved',
  'Composed',
  'Synthesized',
  'Wrapped',
];

function pickDoneVerb(turn) {
  return TURN_DONE_VERBS[(turn * 5 + 2) % TURN_DONE_VERBS.length];
}

function formatIdleDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value >= 3_600_000 && value % 3_600_000 === 0) return `${value / 3_600_000}h`;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  if (value < 1_000) return '';
  return `${Math.floor(value / 1000)}s`;
}

function formatTokenCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function compactEventLabel(event = {}) {
  const status = String(event.status || '').toLowerCase();
  if (status === 'failed') return 'Compact failed';
  if (status === 'skipped') return 'Compact skipped';
  if (status === 'no_change') return 'Compact checked';
  return 'Compact complete';
}

function compactEventDetail(event = {}) {
  const beforeTokens = Number(event.beforeTokens ?? event.messageTokensEst ?? 0);
  const afterTokens = Number(event.afterTokens ?? 0);
  const tokenPart = beforeTokens || afterTokens
    ? `${formatTokenCount(beforeTokens)}→${formatTokenCount(afterTokens)} tokens`
    : '';
  const elapsedPart = formatDuration(Number(event.durationMs ?? event.elapsedMs ?? 0));
  return [
    elapsedPart,
    tokenPart,
    event.error ? presentErrorText(event.error, { surface: 'compact', max: 160 }) : '',
  ].filter(Boolean).join(' · ');
}

const FAILED_NOTICE_ACTIONS = new Map([
  ['api key save', 'save API key'],
  ['auth-forget', 'forget auth'],
  ['auto-clear', 'update auto-clear'],
  ['autoclear', 'update auto-clear'],
  ['agent', 'run agent command'],
  ['channels', 'load channels'],
  ['channels update', 'update channels'],
  ['clear', 'clear chat'],
  ['compact', 'compact context'],
  ['copy', 'copy'],
  ['core memory', 'load core memory'],
  ['cwd', 'update working directory'],
  ['effort switch', 'switch effort'],
  ['fast', 'update fast mode'],
  ['hook rule update', 'update hook rule'],
  ['hook toggle', 'toggle hook'],
  ['hook update', 'update hook'],
  ['hooks status', 'load hooks'],
  ['local provider update', 'update local provider'],
  ['mcp add', 'add MCP server'],
  ['mcp reconnect', 'reconnect MCP server'],
  ['mcp status', 'load MCP status'],
  ['mcp toggle', 'toggle MCP server'],
  ['memory', 'run memory command'],
  ['memory status', 'load memory status'],
  ['model save', 'save model'],
  ['model switch', 'switch model'],
  ['oauth code', 'finish OAuth login'],
  ['oauth login', 'start OAuth login'],
  ['output style switch', 'switch output style'],
  ['OpenAI usage auth save', 'save OpenAI usage auth'],
  ['OpenCode Go usage auth save', 'save OpenCode Go usage auth'],
  ['plugin add', 'add plugin'],
  ['plugin MCP enable', 'enable plugin MCP'],
  ['plugin uninstall', 'uninstall plugin'],
  ['plugin update', 'update plugin'],
  ['plugins status', 'load plugins'],
  ['providers', 'load providers'],
  ['recall', 'run recall'],
  ['resume', 'resume chat'],
  ['schedule toggle', 'toggle schedule'],
  ['setup save', 'save setup'],
  ['settings update', 'update settings'],
  ['skill add', 'add skill'],
  ['skills status', 'load skills'],
  ['tools status', 'load tool status'],
  ['usage', 'load usage'],
  ['webhook toggle', 'toggle webhook'],
  ['workflow switch', 'switch workflow'],
]);

function polishNoticeAction(action) {
  const value = String(action || '').trim();
  if (!value) return 'finish';
  const key = value.toLowerCase();
  for (const [candidate, replacement] of FAILED_NOTICE_ACTIONS.entries()) {
    if (candidate.toLowerCase() === key) return replacement;
  }
  const suffixes = [
    [' save', 'save'],
    [' switch', 'switch'],
    [' update', 'update'],
    [' toggle', 'toggle'],
    [' reconnect', 'reconnect'],
    [' enable', 'enable'],
    [' uninstall', 'uninstall'],
    [' add', 'add'],
  ];
  for (const [suffix, verb] of suffixes) {
    if (!key.endsWith(suffix)) continue;
    const subject = value.slice(0, -suffix.length).trim();
    return subject ? `${verb} ${subject}` : verb;
  }
  return value;
}

function sentenceStart(text) {
  const value = String(text || '').trim();
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function polishNoticeText(text) {
  let value = String(text ?? '').trim().replace(/^✓\s*/, '');
  if (!value) return '';
  const error = /^error\s*:\s*(.+)$/i.exec(value);
  if (error?.[1]) value = error[1].trim();
  const couldNot = /^could not\s+(.+?)(?::\s*(.+))?$/i.exec(value);
  if (couldNot) {
    return couldNot[2]
      ? `Couldn’t ${couldNot[1]}: ${couldNot[2]}`
      : `Couldn’t ${couldNot[1]}.`;
  }
  const failed = /^(.+?)\s+failed(?::\s*(.+))?$/i.exec(value);
  if (failed) {
    const action = polishNoticeAction(failed[1]);
    return failed[2] ? `Couldn’t ${action}: ${failed[2]}` : `Couldn’t ${action}.`;
  }
  const busy = /^(.+?)\s+already in progress\.?$/i.exec(value);
  if (busy) return `${sentenceStart(polishNoticeAction(busy[1]))} is already running.`;
  const required = /^(.+?)\s+is required(?:\s+for\s+(.+))?\.?$/i.exec(value);
  if (required) {
    const subject = required[1].trim();
    const target = required[2]?.trim();
    return `${subject}${target ? ` required for ${target}` : ' required'}.`;
  }
  return value;
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content)
    ? content
    : (content && typeof content === 'object' && Array.isArray(content.content) ? content.content : null);
  if (parts) {
    return parts.map((c) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'image') return `[image: ${c.mimeType || c.mediaType || c.source?.media_type || 'image'}]`;
      return c?.text ?? '';
    }).filter(Boolean).join('\n');
  }
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

function toolErrorDisplay(value, surface = 'tool') {
  const text = presentErrorText(value, { surface });
  if (/^(?:Search failed|Fetch failed|No first response|The .+ went stale|(?:Web search agent|Agent|Tool) (?:stopped|was cancelled))/i.test(text)) {
    return text;
  }
  return /^error\s*:/i.test(text) ? text : `Error: ${text}`;
}

function toolCallId(call) {
  return call?.id ?? call?.toolCallId ?? call?.tool_call_id ?? call?.call_id;
}

function toolResultCallId(message) {
  return message?.toolCallId
    ?? message?.tool_call_id
    ?? message?.tool_use_id
    ?? message?.call_id
    ?? message?.id;
}

function toolCallName(call) {
  return call?.name ?? call?.function?.name ?? call?.toolName ?? call?.tool_name ?? 'tool';
}

function toolCallArgs(call) {
  return call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments;
}

function textBetweenTag(text, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(String(text ?? ''));
  return match ? match[1].trim() : '';
}

function stripSyntheticAgentTags(text) {
  const value = String(text ?? '').trim();
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) return finalAnswer;
  const taskResult = textBetweenTag(value, 'result');
  if (taskResult) return taskResult;
  return value
    .replace(/^agent result[^\n]*(?:\n|$)/i, '')
    .replace(/<\/?(?:final-answer|task-notification|task-id|tool-use-id|output-file|result|status|summary|usage|total_tokens|tool_uses|duration_ms|worktree|worktreePath|worktreeBranch)[^>]*>/gi, '')
    .trim();
}

function splitBridgeEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!value) return { head: '', body: '' };
  const match = /\n\s*\n/.exec(value);
  if (!match) return { head: value, body: '' };
  return {
    head: value.slice(0, match.index).trim(),
    body: value.slice(match.index + match[0].length).trim(),
  };
}

function agentJobStatusText(parsed) {
  if (!parsed) return '';
  const parts = [];
  if (parsed.status) parts.push(`status: ${parsed.status}`);
  if (parsed.taskId) parts.push(`task_id: ${parsed.taskId}`);
  return parts.join(' · ');
}

function agentJobResultText(text, parsed = parseAgentJob(text)) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  if (parsed?.taskId) {
    const { body } = splitBridgeEnvelope(value);
    const cleanBody = stripSyntheticAgentTags(body);
    if (cleanBody) return cleanBody;
    return agentJobStatusText(parsed);
  }
  return stripSyntheticAgentTags(value) || value;
}

function parseBackgroundTaskEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!/^background task\b/i.test(value)) return null;
  const allLines = value.split('\n');
  const rest = allLines.slice(1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body = blank >= 0 ? rest.slice(blank + 1).join('\n').trim() : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const surface = String(fields.surface || fields.operation || 'task').toLowerCase();
  const name = surface === 'explore' || surface === 'search' || surface === 'shell' || surface === 'agent' ? surface : 'task';
  const status = String(fields.status || '').toLowerCase();
  const taskId = fields.task_id || fields.taskid || '';
  return {
    name,
    label: status || 'notification',
    args: {
      type: body ? 'result' : (fields.operation || 'status'),
      status,
      task_id: taskId || undefined,
      surface,
      operation: fields.operation || undefined,
      label: fields.label || undefined,
      startedAt: fields.started || fields.startedat || undefined,
      finishedAt: fields.finished || fields.finishedat || undefined,
    },
    result: body || [status ? `status: ${status}` : '', taskId ? `task_id: ${taskId}` : ''].filter(Boolean).join(' · ') || 'background task',
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status) || /^error:/i.test(body),
  };
}

function bracketField(text, name) {
  const re = new RegExp(`^\\[${name}:\\s*([^\\]]*)\\]`, 'mi');
  return re.exec(String(text ?? ''))?.[1]?.trim() || '';
}

function toolResultStatus(text) {
  const value = String(text ?? '');
  const tagged = textBetweenTag(value, 'status');
  if (tagged) return tagged.trim();
  const bracketed = bracketField(value, 'status');
  if (bracketed) return bracketed.trim();
  const inline = /^(?:status|state):\s*([^\s·,;]+)/mi.exec(value);
  return inline ? inline[1].trim() : '';
}

function isErrorToolStatus(status) {
  return /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(String(status || '').trim());
}

function parseSyntheticAgentMessage(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const finalAnswer = textBetweenTag(value, 'final-answer');
  if (finalAnswer) {
    return {
      name: 'agent',
      label: 'final',
      args: { type: 'read', description: 'agent result' },
      result: finalAnswer,
    };
  }
  const backgroundTask = parseBackgroundTaskEnvelope(value);
  if (backgroundTask) return backgroundTask;
  const shellTaskId = bracketField(value, 'task_id');
  if (shellTaskId) {
    const status = bracketField(value, 'status') || 'done';
    const exit = bracketField(value, 'exit');
    const command = bracketField(value, 'command');
    return {
      name: 'shell',
      label: status,
      args: { type: 'result', task_id: shellTaskId, command },
      result: value,
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(status) || (exit && exit !== '0' && exit !== 'n/a'),
    };
  }
  const agentJob = parseAgentJob(value);
  if (agentJob?.taskId) {
    const label = agentJob.status || 'notification';
    const result = agentJobResultText(value, agentJob);
    return {
      name: 'agent',
      label,
      args: agentArgsWithResultMetadata({ type: agentJob.type || 'notification', description: 'agent notification' }, agentJob),
      result: result || agentJobStatusText(agentJob) || 'agent notification',
      isError: /^(failed|error|timeout|cancelled|killed)$/i.test(label),
    };
  }
  if (/<task-notification\b/i.test(value)) {
    const status = textBetweenTag(value, 'status') || 'completed';
    const summary = textBetweenTag(value, 'summary') || `Agent ${status}`;
    const taskId = textBetweenTag(value, 'task-id');
    const result = stripSyntheticAgentTags(value);
    return {
      name: 'agent',
      label: status,
      taskId,
      summary,
      result: result || summary,
    };
  }
  return null;
}

function normalizeToolName(name) {
  return String(name || 'tool')
    .replace(/^mcp__.*__/, '')
    .replace(/^functions\./, '')
    .replace(/-/g, '_')
    .toLowerCase();
}

function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof args === 'object' ? args : {};
}

const yieldToRenderer = () => new Promise((resolve) => setImmediate(resolve));

function parseAgentJob(text) {
  const value = String(text || '');
  const idMatch = /^agent task:\s*([^\s]+)/m.exec(value) || /^task_id:\s*([^\s]+)/m.exec(value);
  if (!idMatch) return null;
  const statusMatch = /^status:\s*([^\s(]+)/m.exec(value);
  const typeMatch = /^type:\s*(.+)$/m.exec(value);
  const targetMatch = /^target:\s*(.+)$/m.exec(value);
  const roleMatch = /^(?:agent|role):\s*(.+)$/m.exec(value);
  const presetMatch = /^preset:\s*(.+)$/m.exec(value);
  const modelMatch = /^model:\s*([^/\s]+)\/(.+)$/m.exec(value);
  const effortMatch = /^effort:\s*(.+)$/m.exec(value);
  const fastMatch = /^fast:\s*(on|off|true|false)$/m.exec(value);
  return {
    taskId: idMatch[1],
    status: (statusMatch?.[1] || '').toLowerCase(),
    type: (typeMatch?.[1] || '').trim(),
    target: (targetMatch?.[1] || '').trim(),
    role: (roleMatch?.[1] || '').trim(),
    preset: (presetMatch?.[1] || '').trim(),
    provider: (modelMatch?.[1] || '').trim(),
    model: (modelMatch?.[2] || '').trim(),
    effort: (effortMatch?.[1] || '').trim(),
    fast: fastMatch ? /^(on|true)$/i.test(fastMatch[1]) : undefined,
  };
}

const QUEUE_PRIORITY = { now: 0, next: 1, later: 2 };

function queuePriorityValue(value) {
  return QUEUE_PRIORITY[String(value || 'next')] ?? QUEUE_PRIORITY.next;
}

function defaultQueuePriority(mode) {
  return mode === 'task-notification' ? 'next' : 'later';
}

function isQueuedEntryEditable(entry) {
  return (entry?.mode || 'prompt') !== 'task-notification';
}

function isQueuedEntryVisible(entry) {
  // state.queued drives the user-command wait list above the prompt. Background
  // task completions stay in the internal pending queue, but should never look
  // like commands typed by the user while they wait to be drained.
  return isQueuedEntryEditable(entry);
}

function firstQueueLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function notificationDisplayText(text) {
  const parsed = parseAgentJob(text);
  const result = agentJobResultText(text, parsed);
  const synthetic = parseSyntheticAgentMessage(text);
  return firstQueueLine(synthetic?.result || result || text) || 'agent notification';
}

function promptContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'image') return '[Image]';
      return part?.text || '';
    }).filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

function timestampMs(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasModelVisibleConversation(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
    const text = promptContentText(message.content).trim();
    if (role === 'user' && text.startsWith('<system-reminder>')) return false;
    if (role === 'assistant' && text === '.' && !Array.isArray(message.toolCalls)) return false;
    return !!text || role === 'assistant' || role === 'tool';
  });
}

function sessionActivityTimestamp(session, fallback = 0) {
  if (!hasModelVisibleConversation(session)) return 0;
  return timestampMs(session?.lastUsedAt)
    || timestampMs(session?.updatedAt)
    || timestampMs(fallback);
}

function hasCompactSummary(session) {
  return (Array.isArray(session?.messages) ? session.messages : []).some((message) => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(SUMMARY_PREFIX)
  ));
}

function promptDisplayText(content, options = {}) {
  if (typeof options.displayText === 'string') return options.displayText;
  return promptContentText(content);
}

function mergePromptContents(entries) {
  const batch = Array.isArray(entries) ? entries : [];
  if (batch.every((entry) => typeof entry?.content === 'string')) {
    return batch.map((entry) => entry.content).filter((text) => String(text || '').trim()).join('\n');
  }
  const parts = [];
  for (const entry of batch) {
    const content = entry?.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      parts.push(...content);
    }
    parts.push({ type: 'text', text: '\n' });
  }
  while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n') parts.pop();
  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts;
}

function mergePastedImages(entries) {
  const out = {};
  for (const entry of entries || []) {
    const images = entry?.pastedImages;
    if (!images || typeof images !== 'object') continue;
    for (const [id, image] of Object.entries(images)) {
      if (image) out[id] = image;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function callCommitCallbacks(entries) {
  for (const entry of entries || []) {
    try { entry?.onCommitted?.(); } catch {}
  }
}

function notificationQueueKey(event, text, parsed) {
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  const id = String(meta.execution_id || parsed?.taskId || '').trim();
  if (!id) return '';
  const type = String(meta.type || '').trim();
  const status = String(meta.status || parsed?.status || '').trim();
  const fallbackKind = String(text || '').split('\n', 1)[0]?.trim() || 'notification';
  return [id, type || fallbackKind, status].filter(Boolean).join(':');
}

function isExecutionNotification(event, text, parsed) {
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  if (meta.execution_id || meta.execution_surface) return true;
  if (parseBackgroundTaskEnvelope(text)) return true;
  return Boolean(parsed?.taskId && /^(?:agent task:|task_id:)/mi.test(String(text || '')));
}

function agentArgsWithResultMetadata(args, parsed) {
  if (!parsed) return args;
  const next = { ...(args && typeof args === 'object' ? args : {}) };
  if (parsed.type) next.type = parsed.type;
  if (parsed.status) next.status = parsed.status;
  if (parsed.taskId) next.task_id = parsed.taskId;
  if (parsed.role) next.role = parsed.role;
  if (parsed.preset) next.preset = parsed.preset;
  if (parsed.provider) next.provider = parsed.provider;
  if (parsed.model) next.model = parsed.model;
  if (parsed.effort) next.effort = parsed.effort;
  if (parsed.fast !== undefined) next.fast = parsed.fast;
  if (!next.tag && parsed.target) {
    const target = parsed.target.split(/\s+/)[0];
    if (target && !target.startsWith('sess_')) next.tag = target;
  }
  return next;
}

export async function createEngineSession({
  provider: providerName,
  model,
  toolMode = 'full',
} = {}) {
  const startedAt = performance.now();
  bootProfile('engine:create:start', { provider: providerName, model, toolMode });
  // Silence provider/session diagnostics so they cannot tear through the
  // alternate-screen React/ink render.
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  process.env.MIXDOG_QUIET_SESSION_LOG = '1';
  process.env.MIXDOG_QUIET_MCP_LOG = '1';
  process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
  process.env.MIXDOG_PATCH_NATIVE_PREWARM ??= '0';

  const importStartedAt = performance.now();
  const { createMixdogSessionRuntime } = await import(SESSION_RUNTIME_MODULE);
  bootProfile('session-runtime:imported', { ms: (performance.now() - importStartedAt).toFixed(1) });
  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode });
  bootProfile('engine:create:runtime-ready', { ms: (performance.now() - startedAt).toFixed(1) });
  const cwd = runtime.cwd || process.cwd();
  const stateStartedAt = performance.now();
  const autoClearState = () => runtime.getAutoClear?.() || runtime.autoClear || { enabled: true, idleMs: 60 * 60 * 1000 };
  const AGENT_STATUS_CACHE_MS = 250;
  let agentStatusCache = null;
  let agentStatusCacheAt = 0;
  const agentStatusState = ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && agentStatusCache && now - agentStatusCacheAt < AGENT_STATUS_CACHE_MS) return agentStatusCache;
    const status = runtime.agentStatus?.() || {};
    agentStatusCache = {
      agentWorkers: Array.isArray(status.agentWorkers) ? status.agentWorkers : [],
      agentJobs: Array.isArray(status.agentJobs) ? status.agentJobs : [],
      agentScope: status.agentScope || null,
    };
    agentStatusCacheAt = now;
    return agentStatusCache;
  };
  const routeState = () => ({
    sessionId: runtime.id,
    clientHostPid: runtime.clientHostPid || null,
    model: runtime.model,
    provider: runtime.provider,
    effort: runtime.effort,
    effortOptions: runtime.effortOptions,
    fast: runtime.fast,
    fastCapable: runtime.fastCapable,
    contextWindow: runtime.contextWindow,
    rawContextWindow: runtime.rawContextWindow,
    effectiveContextWindowPercent: runtime.effectiveContextWindowPercent,
    cwd: runtime.cwd || process.cwd(),
    systemShell: runtime.systemShell || { source: 'auto', command: '', effective: '' },
    searchRoute: runtime.getSearchRoute?.() || runtime.searchRoute || null,
    autoClear: autoClearState(),
    workflow: runtime.workflow || null,
  });

  const routeStateStartedAt = performance.now();
  const initialRouteState = routeState();
  bootProfile('engine:route-state-ready', { ms: (performance.now() - routeStateStartedAt).toFixed(1) });
  const initialAgentState = {
    agentWorkers: [],
    agentJobs: [],
    agentScope: null,
  };
  let state = {
    items: [],
    toasts: [],
    busy: false,
    commandBusy: false,
    commandStatus: null,
    spinner: null,
    queued: [],
    thinking: null,
    lastTurn: null,
    stats: createSessionStats(),
    ...initialRouteState,
    ...initialAgentState,
    toolMode: runtime.toolMode,
    cwd,
  };
  bootProfile('engine:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  const syncContextStats = ({ allowEstimated = false } = {}) => {
    const ctx = runtime.contextStatus?.() || null;
    const hasProviderUsage = Number(state.stats.latestPromptTokens || state.stats.latestInputTokens || state.stats.inputTokens || 0) > 0;
    const estimatedTokens = Number(ctx?.currentEstimatedTokens || 0);
    const used = Number(ctx?.usedTokens || 0);
    if (!allowEstimated && !hasProviderUsage && ctx?.usedSource !== 'last_api_request') return ctx;
    if (Number.isFinite(used) && used > 0) state.stats.currentContextTokens = Math.max(0, used);
    else state.stats.currentContextTokens = 0;
    state.stats.currentEstimatedContextTokens = Number.isFinite(estimatedTokens) ? Math.max(0, estimatedTokens) : 0;
    state.stats.currentContextSource = ctx?.usedSource || (estimatedTokens > 0 ? 'estimated' : null);
    state.stats.currentContextUpdatedAt = Date.now();
    return ctx;
  };
  const contextStartedAt = performance.now();
  syncContextStats({ allowEstimated: true });
  bootProfile('engine:context-ready', { ms: (performance.now() - contextStartedAt).toFixed(1) });
  const listeners = new Set();
  // Coalesce store notifications: a single onToolCall batch / finalize path
  // fires many set() calls in one synchronous block (aggregate header sync,
  // spinner, item pushes). Notifying React on every set() painted the
  // intermediate layouts ("툭툭" header/count jitter). Collapsing the
  // notifications into one microtask means listeners see only the final state
  // of the current tick — "draw twice, keep the last one". getState() stays
  // synchronous and always returns the latest snapshot, so useSyncExternalStore
  // never tears.
  let emitScheduled = false;
  const flushEmit = () => {
    emitScheduled = false;
    for (const l of listeners) l();
  };
  const emit = () => {
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(flushEmit);
  };
  const set = (patch) => {
    if (!patch || typeof patch !== 'object') return false;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.is(state[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    state = { ...state, ...patch };
    emit();
    return true;
  };

  const itemIndexById = new Map();
  const replaceItems = (items) => {
    const nextItems = Array.isArray(items) ? items : [];
    itemIndexById.clear();
    for (let i = 0; i < nextItems.length; i++) {
      const id = nextItems[i]?.id;
      if (id != null) itemIndexById.set(id, i);
    }
    return nextItems;
  };
  const pushItem = (item) => {
    const index = state.items.length;
    const items = [...state.items, item];
    if (item?.id != null) itemIndexById.set(item.id, index);
    set({ items });
  };
  const upsertSyntheticToolItem = (text, id = nextId(), parsed = null) => {
    const synthetic = parseSyntheticAgentMessage(text);
    if (!synthetic) return false;
    const label = synthetic.label || 'notification';
    const args = synthetic.args || {
      type: label,
      task_id: synthetic.taskId || parsed?.taskId || undefined,
      description: synthetic.summary || 'agent notification',
    };
    const isError = synthetic.isError ?? /^(failed|error|timeout|killed|cancelled)$/i.test(label);
    pushItem({
      kind: 'tool',
      id,
      name: synthetic.name || 'agent',
      args,
      result: synthetic.result,
      isError,
      expanded: false,
      count: 1,
      completedCount: 1,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    return true;
  };
  const pushUserOrSyntheticItem = (text, id = nextId()) => {
    if (upsertSyntheticToolItem(text, id)) return;
    pushItem({ kind: 'user', id, text });
  };
  const pushToast = (text, tone = 'info', ttlMs = 3000) => {
    const id = nextId();
    const value = String(text ?? '').trim();
    if (!value) return null;
    set({ toasts: [...state.toasts.filter((toast) => toast.id !== id), { id, text: value, tone }] });
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      if (disposed) return;
      set({ toasts: state.toasts.filter((toast) => toast.id !== id) });
    }, ttlMs);
    toastTimers.add(timer);
    timer.unref?.();
    return id;
  };
  const pushNotice = (text, tone = 'info', options = {}) => {
    const value = polishNoticeText(text);
    if (!value) return null;
    const forceTranscript = options.transcript === true;
    if (!forceTranscript) return pushToast(value, tone, options.ttlMs);
    const id = nextId();
    pushItem({ kind: 'notice', id, text: value, tone });
    return id;
  };
  const patchItem = (id, patch) => {
    let index = itemIndexById.get(id);
    if (!Number.isInteger(index) || state.items[index]?.id !== id) {
      index = state.items.findIndex((it) => it.id === id);
      if (index >= 0) itemIndexById.set(id, index);
    }
    if (index < 0) return false;
    const current = state.items[index];
    let changed = false;
    for (const [key, value] of Object.entries(patch || {})) {
      if (!Object.is(current[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    const items = state.items.slice();
    items[index] = { ...current, ...patch };
    set({ items });
    return true;
  };
  const toastTimers = new Set();
  let disposed = false;
  const runtimePulseTimer = setInterval(() => {
    if (disposed) return;
    syncContextStats({ allowEstimated: true });
    set({
      ...routeState(),
      stats: { ...state.stats },
      ...agentStatusState(),
    });
  }, 2000);
  runtimePulseTimer.unref?.();

  function clearToastTimers() {
    for (const timer of toastTimers) {
      clearTimeout(timer);
    }
    toastTimers.clear();
  }

  let unsubscribeRuntimeNotifications = null;
  let lastUserActivityAt = Date.now();
  let autoClearRunning = false;
  const pendingNotificationKeys = new Set();
  const displayedExecutionNotificationKeys = new Set();

  function updateAgentJobCard(itemId, text, isError = false) {
    const parsed = parseAgentJob(text);
    const current = state.items.find((it) => it.id === itemId);
    const rawDisplayText = agentJobResultText(text, parsed) || String(text ?? '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'agent') : rawDisplayText;
    patchItem(itemId, {
      result: displayText,
      text: displayText,
      isError,
      errorCount: isError ? 1 : 0,
      ...(parsed ? { args: agentArgsWithResultMetadata(current?.args, parsed) } : {}),
    });
  }

  if (typeof runtime.onNotification === 'function') {
    unsubscribeRuntimeNotifications = runtime.onNotification((event) => {
      if (disposed) return;
      const text = String(event?.content ?? event?.text ?? event ?? '').trim();
      if (!text) return;
      const parsed = parseAgentJob(text);
      const notificationKey = notificationQueueKey(event, text, parsed);
      if (isExecutionNotification(event, text, parsed)) {
        const firstDelivery = !notificationKey || !displayedExecutionNotificationKeys.has(notificationKey);
        if (firstDelivery) {
          if (notificationKey) displayedExecutionNotificationKeys.add(notificationKey);
          enqueue(text, {
            mode: 'task-notification',
            priority: 'next',
            key: notificationKey || undefined,
          });
        }
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        return true;
      }
      if (parsed?.taskId) {
        set(agentStatusState({ force: true }));
      }
      enqueue(text, {
        mode: 'task-notification',
        priority: 'next',
        key: notificationKey || undefined,
      });
      return true;
    });
  }

  function groupedToolResultText(group) {
    const completed = Math.min(group.count, group.completed);
    if (group.count <= 1) return group.results.at(-1)?.text ?? '';
    if (group.errors > 0) {
      const succeeded = Math.max(0, completed - group.errors);
      const reasons = group.results
        .filter((result) => result?.isError)
        .map((result) => firstErrorLine(result?.text))
        .filter(Boolean);
      const uniqueReasons = [...new Set(reasons)].slice(0, 2);
      const base = succeeded > 0
        ? `${succeeded} Ok · ${group.errors} Failed`
        : `${group.errors} Failed`;
      return [
        `${base}${uniqueReasons[0] ? ` · ${uniqueReasons[0]}` : ''}`,
        ...uniqueReasons.slice(1),
      ].join('\n');
    }
    return '';
  }

  function firstErrorLine(text) {
    const clean = toolErrorDisplay(text, 'tool');
    if (clean) return clean;
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(Error|\[?error|FAIL\b)/i.test(trimmed)) return trimmed;
    }
    return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  }

  function aggregateRawResult(calls) {
    const chunks = [];
    for (const rec of calls || []) {
      const text = String(rec?.resultText || '').replace(/\s+$/, '');
      if (!text.trim()) continue;
      const label = String(rec?.name || rec?.category || 'tool').trim() || 'tool';
      chunks.push(`${chunks.length + 1}. ${label}\n${text}`);
    }
    return chunks.join('\n\n');
  }

  function aggregateBucketForCategory(category) {
    switch (category) {
      case 'Read':
      case 'Search':
        return 'local-discovery';
      case 'Web Research':
        return 'web-research';
      case 'Memory':
        return 'memory';
      case 'Explore':
        return 'explore';
      case 'Patch':
        return 'patch';
      default:
        // Shell/Agent/Channel/Setup/Other stay as their own cards so risky or
        // semantically distinct actions do not disappear inside a discovery log.
        return null;
    }
  }

  function aggregateSummaries(aggregate) {
    return [...(aggregate?.calls?.values?.() || [])]
      .filter((r) => r.summary)
      .sort((a, b) => Number(a.summarySeq ?? 0) - Number(b.summarySeq ?? 0))
      .map((r) => r.summary);
  }

  function assignAggregateSummaryOrder(aggregate, callRec) {
    if (!aggregate || !callRec?.summary || callRec.summarySeq != null) return;
    const next = Math.max(0, Number(aggregate.nextSummarySeq || 0));
    callRec.summarySeq = next;
    aggregate.nextSummarySeq = next + 1;
  }

  function patchToolCardResult(card, message, toolGroups, done) {
    if (!card || card.done) return false;
    const callId = toolResultCallId(message) || card.callId;
    if (callId && done.has(callId)) return false;
    const rawText = toolResultText(message?.content);
    const isError = message?.isError === true || message?.toolKind === 'error' || /^\s*\[?error/i.test(rawText) || isErrorToolStatus(toolResultStatus(rawText));
    const text = isError ? toolErrorDisplay(rawText, card?.name || 'tool') : rawText;

    // Aggregate card handling — collect semantic summaries per call
    const aggregate = card.aggregate;
    if (aggregate && card.itemId === aggregate.itemId) {
      const callRec = callId ? aggregate.calls.get(callId) : null;
      if (callRec) {
        callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
        assignAggregateSummaryOrder(aggregate, callRec);
        callRec.isError = isError;
        callRec.resultText = text;
        callRec.resolved = true;
      }
      const allCalls = [...aggregate.calls.values()];
      const completed = allCalls.filter((r) => r.resolved).length;
      const errors = allCalls.filter((r) => r.isError).length;
      const summaries = aggregateSummaries(aggregate);
      let detailText;
      if (errors > 0 && summaries.length === 0) {
        const succeeded = completed - errors;
        detailText = succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`;
      } else {
        detailText = formatAggregateDetail(summaries) || '';
      }
      const currentItem = state.items.find((it) => it.id === card.itemId);
      const visualCompleted = Math.max(completed, Math.min(allCalls.length, Number(currentItem?.completedCount || 0)));
      const rawResult = aggregateRawResult(allCalls);
      patchItem(card.itemId, {
        result: detailText,
        text: detailText,
        rawResult: rawResult || null,
        isError: errors > 0,
        errorCount: errors,
        count: allCalls.length,
        completedCount: visualCompleted,
        completedAt: Date.now(),
      });
      card.done = true;
      if (callId) done.add(callId);
      return true;
    }

    // Non-aggregate (legacy agent-job cards, etc.)
    const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
    group.completed = Math.min(group.count, group.completed + 1);
    group.errors += isError ? 1 : 0;
    group.results.push({ text, isError });
    toolGroups.set(card.itemId, group);
    const resultText = groupedToolResultText(group);
    const patch = {
      result: resultText,
      text: resultText,
      isError: group.errors > 0,
      errorCount: group.errors,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
    };
    if (group.count <= 1) {
      const parsedAgent = parseAgentJob(rawText);
      if (parsedAgent) {
        patch.args = agentArgsWithResultMetadata(state.items.find((it) => it.id === card.itemId)?.args, parsedAgent);
        set(agentStatusState({ force: true }));
      }
    }
    patchItem(card.itemId, patch);
    if (group.count <= 1) updateAgentJobCard(card.itemId, rawText, isError);
    card.done = true;
    if (callId) done.add(callId);
    return true;
  }

  const flushToolResults = (messages, toolCards, cardByCallId, toolGroups, done, { finalize = false } = {}) => {
    const results = [];
    for (const m of messages || []) {
      if (!m || m.role !== 'tool') continue;
      const callId = toolResultCallId(m);
      results.push({ message: m, callId, used: false });
      if (!callId || done.has(callId)) continue;
      const card = cardByCallId.get(callId);
      if (patchToolCardResult(card, m, toolGroups, done)) {
        results[results.length - 1].used = true;
      }
    }

    const openCards = (toolCards || []).filter((card) => !card.done);
    if (openCards.length === 0) return;

    const unusedResults = results.filter((result) => !result.used);
    const fallbackResults = unusedResults.slice(-openCards.length);
    for (let i = 0; i < fallbackResults.length; i++) {
      const card = openCards[i];
      const result = fallbackResults[i];
      if (!card || !result || card.done) continue;
      if (patchToolCardResult(card, result.message, toolGroups, done)) {
        if (result.callId) done.add(result.callId);
        result.used = true;
      }
    }

    if (!finalize) return;
    for (const card of toolCards || []) {
      if (card.done) continue;
      // Aggregate finalize — mark any remaining calls as done
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const allCalls = [...aggregate.calls.values()];
        const completed = allCalls.filter((r) => r.resolved).length;
        const remaining = allCalls.length - completed;
        const totalCompleted = remaining > 0 ? completed + remaining : completed;
        const errors = allCalls.filter((r) => r.isError).length;
        const summaries = aggregateSummaries(aggregate);
        const detailText = formatAggregateDetail(summaries) || '';
        const rawResult = aggregateRawResult(allCalls);
        patchItem(card.itemId, {
          result: detailText,
          text: detailText,
          rawResult: rawResult || null,
          isError: errors > 0,
          errorCount: errors,
          count: allCalls.length,
          completedCount: totalCompleted,
          completedAt: Date.now(),
        });
        for (const sibling of toolCards || []) {
          if (sibling.itemId !== card.itemId) continue;
          sibling.done = true;
          if (sibling.callId) done.add(sibling.callId);
        }
        continue;
      }
      // Non-aggregate finalize
      const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
      group.completed = Math.min(group.count, group.completed + 1);
      toolGroups.set(card.itemId, group);
      const resultText = groupedToolResultText(group);
      patchItem(card.itemId, { result: resultText, text: resultText, isError: group.errors > 0, errorCount: group.errors, count: group.count, completedCount: group.completed, completedAt: Date.now() });
      card.done = true;
      if (card.callId) done.add(card.callId);
    }
  };

  async function runTurn(userText, options = {}) {
    const turnIndex = state.stats.turns || 0;
    const startedAt = Date.now();
    const inputBaseline = state.stats.inputTokens;
    const outputBaseline = state.stats.outputTokens;
    const submittedIds = Array.isArray(options.submittedIds) ? options.submittedIds : [];
    const displayText = promptDisplayText(userText, options);
    let promptCommittedCallbackCalled = false;
    activePromptRestore = {
      text: String(displayText || '').trim(),
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
      restorable: options.restorable !== false,
      submittedIds,
      reclaimed: false,
      committed: false,
      requeueEntries: Array.isArray(options.requeueOnAbort) ? options.requeueOnAbort.slice() : [],
    };
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, responseLength: 0, inputTokens: 0, outputTokens: 0, mode: 'requesting' } });

    let assistantText = '';
    let currentAssistantId = null;
    let currentAssistantText = '';
    let thinkingText = '';
    let thinkingStartedAt = 0;
    let thinkingSegmentStartedAt = 0;
    let accumulatedThinkingMs = 0;
    let cancelled = false;
    const cardByCallId = new Map();
    const toolCards = [];
    const toolGroups = new Map();
    const resultsDone = new Set();
    const aggregateCards = []; // active aggregate cards in the current consecutive tool block
    const aggregateByBucket = new Map(); // tail-continuation cache; append only while still the last visible item
    let openAggregateCard = null;

    const markPromptCommitted = () => {
      if (activePromptRestore) {
        if (!promptCommittedCallbackCalled && typeof activePromptRestore.onCommitted === 'function') {
          promptCommittedCallbackCalled = true;
          try { activePromptRestore.onCommitted(); } catch {}
        }
        activePromptRestore.restorable = false;
        activePromptRestore.committed = true;
        activePromptRestore.requeueEntries = [];
        activePromptRestore.pastedImages = null;
      }
    };

    const finalizeToolHeaders = () => {
      const ids = new Set();
      for (const card of toolCards || []) {
        if (card?.itemId) ids.add(card.itemId);
      }
      for (const aggregate of aggregateCards || []) {
        if (aggregate?.itemId) ids.add(aggregate.itemId);
      }
      if (ids.size === 0) return false;
      let changed = false;
      const items = state.items.map((item) => {
        if (!ids.has(item?.id) || item.kind !== 'tool' || item.headerFinalized !== false) return item;
        changed = true;
        return { ...item, headerFinalized: true };
      });
      if (changed) set({ items });
      return changed;
    };

    const completeAggregateVisual = () => {
      for (const aggregate of aggregateCards) {
        const allCalls = [...aggregate.calls.values()];
        if (allCalls.length === 0) continue;
        const errors = allCalls.filter((r) => r.isError).length;
        const summaries = aggregateSummaries(aggregate);
        const detailText = formatAggregateDetail(summaries) || '';
        const rawResult = aggregateRawResult(allCalls);
        patchItem(aggregate.itemId, {
          result: detailText,
          text: detailText,
          rawResult: rawResult || null,
          isError: errors > 0,
          count: allCalls.length,
          completedCount: allCalls.length,
          completedAt: Date.now(),
        });
      }
    };

    const clearAggregateContinuation = () => {
      completeAggregateVisual();
      finalizeToolHeaders();
      aggregateCards.length = 0;
      openAggregateCard = null;
    };

    const isAggregateTail = (aggregate) => {
      if (!aggregate?.itemId) return false;
      const last = state.items[state.items.length - 1];
      return last?.kind === 'tool' && last.aggregate === true && last.id === aggregate.itemId;
    };

    const rememberActiveAggregate = (aggregate) => {
      if (!aggregate) return;
      if (!aggregateCards.includes(aggregate)) aggregateCards.push(aggregate);
      aggregateByBucket.set(aggregate.bucket, aggregate);
    };

    const ensureAggregateCard = (bucket) => {
      // Reuse the open aggregate when it is either still the transcript tail OR
      // has not been pushed yet. The not-yet-pushed case matters for parallel
      // tool batches: every call in one onToolCall batch is collected first and
      // the card is pushed once afterward (syncAggregateHeader), so the 2nd+
      // same-bucket call in the SAME batch must merge even though the card is
      // not yet visible in state.items (isAggregateTail would be false).
      if (openAggregateCard?.bucket === bucket
          && (!openAggregateCard.pushed || isAggregateTail(openAggregateCard))) return openAggregateCard;
      // If the previous aggregate was finalized/closed but is still the tail of
      // the transcript (or was never pushed), continue that exact card instead
      // of pushing a duplicate directly below it. Never reach past a visible
      // assistant/tool/status item: that would make an older card's count change
      // "in the middle" of history.
      const tailAggregate = aggregateByBucket.get(bucket);
      if (tailAggregate && (!tailAggregate.pushed || isAggregateTail(tailAggregate))) {
        openAggregateCard = tailAggregate;
        rememberActiveAggregate(tailAggregate);
        return tailAggregate;
      }
      const itemId = nextId();
      const aggregate = {
        itemId,
        bucket,
        categories: new Map(),
        categoryOrder: [],
        calls: new Map(),
        nextSummarySeq: 0,
        pushed: false,
        startedAt: Date.now(),
      };
      rememberActiveAggregate(aggregate);
      openAggregateCard = aggregate;
      return aggregate;
    };

    const syncAggregateHeader = (aggregate) => {
      if (!aggregate?.itemId) return;
      const patch = {
        args: { categoryOrder: aggregate.categoryOrder.slice() },
        count: aggregate.calls.size,
        completedCount: [...aggregate.calls.values()].filter((r) => r.resolved).length,
        categories: Object.fromEntries(aggregate.categories),
      };
      if (aggregate.pushed) {
        patchItem(aggregate.itemId, patch);
        return;
      }
      aggregate.pushed = true;
      pushItem({
        kind: 'tool',
        id: aggregate.itemId,
        name: '__aggregate__',
        ...patch,
        aggregate: true,
        result: null,
        rawResult: null,
        isError: false,
        expanded: false,
        headerFinalized: false,
        startedAt: aggregate.startedAt || Date.now(),
      });
    };

    const ensureAssistant = (initialText = '') => {
      if (!currentAssistantId) {
        currentAssistantId = nextId();
        // Do NOT reset currentAssistantText here. The first onTextDelta has
        // already accumulated the opening chunk before this batched flush runs;
        // wiping it dropped the leading characters and forced a later set() to
        // re-add them. Segment resets are owned by closeAssistantSegment().
        // Seed the new row with the already-visible text so the ● gutter and the
        // first body line appear in the SAME set()/emit() — no empty "●-only"
        // row that scrolls once on its own and again when the body lands.
        pushItem({ kind: 'assistant', id: currentAssistantId, text: String(initialText || ''), streaming: true });
      }
      return currentAssistantId;
    };

    const closeAssistantSegment = () => {
      currentAssistantId = null;
      currentAssistantText = '';
    };

    const commitAssistantSegment = ({ sealToolBlock = false } = {}) => {
      const text = currentAssistantText || '';
      if (!text.trim()) {
        closeAssistantSegment();
        return false;
      }
      if (sealToolBlock) clearAggregateContinuation();
      const id = currentAssistantId || ensureAssistant(text);
      patchItem(id, { text, streaming: false });
      closeAssistantSegment();
      return true;
    };

    const startThinkingSegment = () => {
      const now = Date.now();
      if (!thinkingStartedAt) thinkingStartedAt = now;
      if (!thinkingSegmentStartedAt) thinkingSegmentStartedAt = now;
      return now;
    };

    const closeThinkingSegment = () => {
      if (!thinkingSegmentStartedAt) return;
      const now = Date.now();
      accumulatedThinkingMs += Math.max(0, now - thinkingSegmentStartedAt);
      thinkingSegmentStartedAt = 0;
      return now;
    };

    // --- Streaming-delta batcher ---
    // onTextDelta and onReasoningDelta fire on every tiny chunk (often <10 chars).
    // Each call previously called set() → emit() → full React reconcile. We
    // batch accumulated text and flush at most once per STREAM_BATCH_INTERVAL_MS
    // (≈16ms / 60fps cap). A forced flush happens before any tool call,
    // finalization, or error so those code paths see the correct text state.
    // Flush cadence for streamed text/thinking. 8ms (~120fps) matches the Ink
    // render maxFps (index.jsx render({ maxFps: 120 })), so a queued batch is
    // never held back waiting for the next Ink frame. 16ms (~60fps) left every
    // other Ink frame idle, which made fast provider streams visibly land in
    // coarse chunks ("10 chars at a time").
    const STREAM_BATCH_INTERVAL_MS = 8;
    let _batchTimer = null;
    let _pendingTextFlush = false;   // true when a text/spinner update is queued
    let _pendingThinkFlush = false;  // true when a thinking update is queued
    let _pendingThinkingLastEndedAt = 0;

    const flushStreamBatch = () => {
      if (_batchTimer !== null) {
        clearTimeout(_batchTimer);
        _batchTimer = null;
      }
      if (_pendingTextFlush) {
        _pendingTextFlush = false;
        // Show only COMPLETED lines while streaming. The in-progress trailing
        // line stays hidden until its '\n' arrives, so the visible text never
        // grows a glyph at a time (no "무"→pause→"무슨 일…" partial reveal, no
        // CJK-width reflow jitter). The final non-streaming patch
        // (streaming:false) always carries the full text, so the tail line that
        // never got a newline still lands once at finalize.
        const newlineIdx = currentAssistantText.lastIndexOf('\n');
        const streamingVisibleText = newlineIdx >= 0
          ? currentAssistantText.slice(0, newlineIdx + 1)
          : '';
        const patch = {};
        // Do NOT create the assistant row (and scroll the transcript) before
        // there is a completed line to show. Until the first '\n' the only
        // pending state is the spinner; the row appears together with its first
        // visible line, so no empty "●-only" row flashes/scrolls ahead of text.
        if (currentAssistantId || streamingVisibleText) {
          const id = ensureAssistant(streamingVisibleText);
          // Emit the accumulated assistant text and spinner update together so a
          // streaming batch costs one set() → one emit() → one React reconcile.
          const index = state.items.findIndex((it) => it.id === id);
          if (index >= 0) {
            const current = state.items[index];
            if (!Object.is(current.text, streamingVisibleText) || current.streaming !== true) {
              const items = state.items.slice();
              items[index] = { ...current, text: streamingVisibleText, streaming: true };
              patch.items = items;
            }
          }
        }
        const responseLengthVal = assistantText.length + thinkingText.length;
        if (state.spinner) {
          patch.spinner = { ...state.spinner, responseLength: responseLengthVal, thinking: false, thinkingLastEndedAt: _pendingThinkingLastEndedAt || state.spinner.thinkingLastEndedAt, mode: 'responding' };
        }
        if (Object.keys(patch).length > 0) set(patch);
        _pendingThinkingLastEndedAt = 0;
      }
      if (_pendingThinkFlush) {
        _pendingThinkFlush = false;
        const responseLengthVal = assistantText.length + thinkingText.length;
        const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
        const patch = { thinking: thinkingText };
        if (state.spinner) {
          patch.spinner = { ...state.spinner, responseLength: responseLengthVal, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' };
        }
        set(patch);
      }
    };

    const scheduleStreamFlush = () => {
      if (_batchTimer !== null) return; // already scheduled; do not re-arm
      _batchTimer = setTimeout(flushStreamBatch, STREAM_BATCH_INTERVAL_MS);
      if (_batchTimer?.unref) _batchTimer.unref(); // don't prevent process exit
    };

    try {
      const { result, session } = await runtime.ask(userText, {
        drainSteering: () => drainPendingSteering(),
        onSteerMessage: (text) => {
          // Steering can be injected after a terminal no-tool response has
          // already streamed but before runTurn finalizes. Seal the current
          // assistant segment first so the steered user turn and the next
          // assistant response do not get visually merged into one bubble.
          flushStreamBatch();
          if (currentAssistantId) {
            patchItem(currentAssistantId, { text: currentAssistantText || assistantText, streaming: false });
            closeAssistantSegment();
          }
          assistantText = '';
          const value = String(text || '').trim();
          if (value) {
            finalizeToolHeaders();
            pushUserOrSyntheticItem(value);
          }
        },
        onToolCall: async (_iter, calls) => {
          markPromptCommitted();
          // Always flush any buffered mid-turn assistant text before the tool
          // card appears. Without this, when neither a thinking panel nor a
          // spinner is active the buffered text was dropped by the following
          // closeAssistantSegment(), so the message above the tool card vanished.
          flushStreamBatch();
          if (thinkingText && state.thinking) {
            const thinkingLastEndedAt = closeThinkingSegment();
            set({ thinking: null, spinner: state.spinner ? { ...state.spinner, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingLastEndedAt, mode: 'tool-use' } : state.spinner });
          } else if (state.spinner) {
            set({ spinner: { ...state.spinner, mode: 'tool-use' } });
          }
          const batchCalls = (calls || []).filter(Boolean);
          if (batchCalls.length === 0) return;
          commitAssistantSegment({ sealToolBlock: true });

          const touchedAggregates = new Set();
          for (let i = 0; i < batchCalls.length; i++) {
            const c = batchCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            const category = classifyToolCategory(name, args);
            const bucket = aggregateBucketForCategory(category);
            const categoryEntry = aggregateToolCategoryEntry(name, args, category);
            const callId = toolCallId(c);
            const callKey = callId || `__tool_${toolCards.length}_${i}`;

            if (!bucket) {
              openAggregateCard = null;
              const itemId = nextId();
              pushItem({
                kind: 'tool',
                id: itemId,
                name,
                args,
                result: null,
                isError: false,
                expanded: false,
                headerFinalized: false,
                count: 1,
                completedCount: 0,
                startedAt: Date.now(),
              });
              const card = { itemId, callId: callKey, done: false };
              if (callId) {
                cardByCallId.set(callId, card);
              }
              toolCards.push(card);
              continue;
            }

            const aggregateCard = ensureAggregateCard(bucket);
            if (!aggregateCard.categories.has(categoryEntry.key)) aggregateCard.categoryOrder.push(categoryEntry.key);
            const prevCategory = aggregateCard.categories.get(categoryEntry.key);
            aggregateCard.categories.set(categoryEntry.key, {
              ...categoryEntry,
              count: Number(prevCategory?.count || 0) + Number(categoryEntry.count || 1),
            });
            aggregateCard.calls.set(callKey, { name, args, category, summary: null, summarySeq: null, isError: false, resultText: null, resolved: false });
            touchedAggregates.add(aggregateCard);
            const card = { itemId: aggregateCard.itemId, callId: callKey, done: false, aggregate: aggregateCard };
            if (callId) {
              cardByCallId.set(callId, card);
            }
            toolCards.push(card);
          }

          for (const aggregateCard of touchedAggregates) {
            syncAggregateHeader(aggregateCard);
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
        },
        onCompactEvent: (event) => {
          flushStreamBatch();
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: compactEventLabel(event),
            detail: compactEventDetail(event),
          });
        },
        onStageChange: (stage) => {
          if (!state.spinner) return;
          const value = String(stage || '');
          const mode = value === 'requesting'
            ? 'requesting'
            : value === 'streaming'
              ? (state.spinner.thinking ? 'thinking' : 'responding')
              : value === 'compacting'
                ? 'compacting'
                : null;
          if (!mode || state.spinner.mode === mode) return;
          set({ spinner: { ...state.spinner, mode } });
        },
        onTextDelta: (chunk) => {
          const textChunk = String(chunk ?? '');
          if (!textChunk) return;
          markPromptCommitted();
          const thinkingLastEndedAt = closeThinkingSegment();
          if (state.thinking) set({ thinking: null }); // collapse thinking panel immediately, no batch delay
          assistantText += textChunk;
          currentAssistantText += textChunk;
          // Accumulate text and schedule a batched flush (≤1 render per
          // STREAM_BATCH_INTERVAL_MS). Without scheduling, mid-turn text only
          // surfaced via the tool-call/finalize flush, so a text→tool segment
          // with no spinner/thinking dropped the message above the tool card.
          _pendingTextFlush = true;
          if (thinkingLastEndedAt) _pendingThinkingLastEndedAt = thinkingLastEndedAt;
          scheduleStreamFlush();
        },
        onAssistantText: (text) => {
          // Mid-turn assistant text that precedes a tool call. Providers that
          // stream via onTextDelta already accumulated it into assistantText;
          // providers that only return the final response.content (no deltas)
          // never fired onTextDelta, so without this the preamble shows nothing
          // before the tool card. De-dup against already-streamed text so the
          // streaming path is unaffected.
          const full = String(text ?? '');
          if (!full.trim()) return;
          // If the streaming path already produced text for THIS segment,
          // onTextDelta owns the render — content is the same accumulated text
          // (or a superset), so skip to avoid double-printing the preamble.
          // Do not check turn-global assistantText: earlier closed preambles stay
          // there across tool calls, and would suppress later non-streaming
          // preambles even though currentAssistantText has been reset.
          if (currentAssistantText.trim()) return;
          markPromptCommitted();
          closeThinkingSegment();
          if (state.thinking) set({ thinking: null });
          assistantText += full;
          currentAssistantText += full;
          _pendingTextFlush = true;
          flushStreamBatch();
        },
        onReasoningDelta: (chunk) => {
          if (String(chunk ?? '')) markPromptCommitted();
          startThinkingSegment();
          thinkingText += String(chunk ?? '');
          // Accumulate reasoning text; fire at most one render per STREAM_BATCH_INTERVAL_MS.
          _pendingThinkFlush = true;
          scheduleStreamFlush();
        },
        onUsageDelta: (delta) => {
          applyUsageDelta(state.stats, delta);
          syncContextStats();
          const currentTurnInput = Math.max(0, state.stats.inputTokens - inputBaseline);
          const currentTurnOutput = Math.max(0, state.stats.outputTokens - outputBaseline);
          if (state.spinner) {
            set({ stats: { ...state.stats }, spinner: { ...state.spinner, inputTokens: currentTurnInput, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...state.stats } });
          }
        },
      });
      markPromptCommitted();

      flushToolResults(session?.messages || [], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
      finalizeToolHeaders();
      flushStreamBatch(); // force-flush any batched streaming text before finalization writes
      syncContextStats();

      const finalText = result?.content != null ? String(result.content) : '';
      if (finalText.trim()) {
        // The persisted transcript is written from the provider's final content,
        // while the live TUI row is fed by streaming deltas. If a provider/parser
        // misses or suppresses an early delta, keeping the streamed buffer here
        // leaves the final on-screen assistant row missing leading characters even
        // though the transcript is correct. Always reconcile the active segment to
        // the final provider text when it is available.
        const id = currentAssistantId || ensureAssistant();
        currentAssistantText = finalText;
        patchItem(id, { text: finalText, streaming: false });
      } else if (currentAssistantId && (currentAssistantText.trim() || assistantText.trim())) {
        const streamedText = currentAssistantText || assistantText;
        patchItem(currentAssistantId, { text: streamedText, streaming: false });
      }
      state.stats.turns = (state.stats.turns || 0) + 1;
    } catch (error) {
      flushStreamBatch(); // ensure any batched text lands before the error notice
      if (error?.name === 'SessionClosedError') {
        cancelled = true;
        if (assistantText.trim() && currentAssistantId) {
          patchItem(currentAssistantId, { text: currentAssistantText || assistantText, streaming: false });
        }
        // Finalize pending tool cards so they don't stay "Running..." forever
        // after cancellation. Without this, the spinner vanishes and TurnDone
        // shows "cancelled", but in-flight tool cards remain in a perpetual
        // pending/blinking state because the normal finalize path (line 992)
        // was skipped when the error interrupted the try block.
        flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
        finalizeToolHeaders();
      } else {
        finalizeToolHeaders();
        pushNotice(toolErrorDisplay(error, 'turn'), 'error');
      }
    } finally {
      const reclaimed = cancelled && activePromptRestore?.reclaimed === true;
      activePromptRestore = null;
      closeThinkingSegment();
      const elapsedMs = Date.now() - startedAt;
      const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
      const finalOutputTokens = Math.max(0, Number(state.spinner?.outputTokens || 0), Math.round(Number(state.spinner?.responseLength || 0) / 4));
      const turnStatus = cancelled ? 'cancelled' : 'done';
      // Pin the post-think summary into the transcript right after this turn's
      // output so it scrolls up with the answer and stays in the scrollback,
      // mirroring Claude Code. (Previously TurnDone rendered only in the
      // bottom-fixed live-status slot and vanished on the next turn.)
      if (!reclaimed) {
        pushItem({ kind: 'turndone', id: nextId(), elapsedMs, status: turnStatus, outputTokens: finalOutputTokens, thinkingElapsedMs, verb: pickDoneVerb(turnIndex) });
      }
      set({
        busy: false,
        spinner: null,
        thinking: null,
        lastTurn: null,
        stats: { ...state.stats },
        ...routeState(),
        toolMode: runtime.toolMode,
        ...agentStatusState({ force: true }),
      });
    }
    return cancelled ? 'cancelled' : 'done';
  }

  const pending = [];
  let draining = false;
  let activePromptRestore = null;

  function makeQueueEntry(text, options = {}) {
    const mode = options.mode || 'prompt';
    const priority = options.priority || defaultQueuePriority(mode);
    const displayText = promptDisplayText(text, options);
    return {
      id: options.id || nextId(),
      text: displayText,
      content: text,
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
      mode,
      priority,
      key: options.key || null,
      displayText: mode === 'task-notification' ? notificationDisplayText(displayText) : String(displayText || ''),
    };
  }

  function removeQueuedEntries(entries) {
    const ids = new Set(entries.map((entry) => entry.id));
    const keys = entries.map((entry) => entry.key).filter(Boolean);
    for (const key of keys) pendingNotificationKeys.delete(key);
    const queued = state.queued.filter((q) => !ids.has(q.id));
    if (queued.length !== state.queued.length) set({ queued });
  }

  function requeueEntriesFront(entries) {
    const restored = [];
    for (const entry of entries || []) {
      if (!entry || !String(entry.text || '').trim()) continue;
      const next = {
        ...entry,
        displayText: entry.displayText || (entry.mode === 'task-notification' ? notificationDisplayText(entry.text) : String(entry.text || '')),
      };
      if (next.mode === 'task-notification' && next.key) {
        if (pendingNotificationKeys.has(next.key)) continue;
        pendingNotificationKeys.add(next.key);
      }
      restored.push(next);
    }
    if (restored.length === 0) return false;
    pending.unshift(...restored);
    const visible = restored.filter(isQueuedEntryVisible);
    if (visible.length > 0) set({ queued: [...visible, ...state.queued] });
    return true;
  }

  function dequeueQueueBatch(maxPriority = 'later') {
    if (pending.length === 0) return [];
    const max = queuePriorityValue(maxPriority);
    let bestPriority = Infinity;
    let targetMode = null;
    for (const entry of pending) {
      const p = queuePriorityValue(entry.priority);
      if (p > max) continue;
      if (p < bestPriority) {
        bestPriority = p;
        targetMode = entry.mode || 'prompt';
      }
    }
    if (!targetMode) return [];
    const batch = [];
    for (let i = 0; i < pending.length;) {
      const entry = pending[i];
      if ((entry.mode || 'prompt') === targetMode && queuePriorityValue(entry.priority) === bestPriority) {
        batch.push(entry);
        pending.splice(i, 1);
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(batch);
    return batch;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0) {
        // Drain one priority/mode bucket at a time, matching Claude Code's
        // unified command queue semantics: prompt steering stays editable and
        // task notifications stay non-editable but model-visible.
        const batch = dequeueQueueBatch('later');
        if (batch.length === 0) break;
        const ids = new Set(batch.map((e) => e.id));
        const merged = mergePromptContents(batch);
        for (const entry of batch) {
          pushUserOrSyntheticItem(entry.text, entry.id);
        }
        const nonEditable = batch.filter((entry) => !isQueuedEntryEditable(entry));
        const batchPastedImages = mergePastedImages(batch);
        const turnStatus = await runTurn(merged, {
          displayText: batch.map((entry) => entry.text).filter((text) => String(text || '').trim()).join('\n'),
          pastedImages: batchPastedImages,
          onCommitted: () => callCommitCallbacks(batch),
          submittedIds: [...ids],
          restorable: nonEditable.length === 0,
          requeueOnAbort: nonEditable,
        });
        // If the user re-submits the reclaimed prompt while the cancelled turn
        // is still unwinding, enqueue() cannot start another drain because this
        // drain loop is still active. Continue when pending work appeared during
        // cancellation so the fresh submit does not get stuck in queued state.
        if (turnStatus === 'cancelled' && pending.length === 0) break;
      }
    } finally {
      draining = false;
      if (pending.length > 0) void drain();
    }
  }
  function enqueue(text, options = {}) {
    const entry = makeQueueEntry(text, options);
    if (entry.mode === 'task-notification' && entry.key) {
      if (pendingNotificationKeys.has(entry.key)) return false;
      pendingNotificationKeys.add(entry.key);
    }
    pending.push(entry);
    if (isQueuedEntryVisible(entry)) set({ queued: [...state.queued, entry] });
    void drain();
    return true;
  }

  function drainPendingSteering() {
    const batch = dequeueQueueBatch('next');
    if (batch.length === 0) return [];
    const out = batch
      .map((entry) => {
        const content = entry.content;
        if (typeof content === 'string') return content.trim();
        return { text: String(entry.text || '').trim(), content };
      })
      .filter((entry) => {
        if (typeof entry === 'string') return entry.length > 0;
        if (Array.isArray(entry?.content)) return entry.content.length > 0;
        return String(entry?.content ?? '').trim().length > 0;
      });
    callCommitCallbacks(batch);
    return out;
  }

  async function autoClearBeforeSubmit() {
    const cfg = autoClearState();
    const now = Date.now();
    const activityAt = sessionActivityTimestamp(runtime.session, lastUserActivityAt);
    const idleMs = activityAt ? now - activityAt : 0;
    if (!cfg.enabled || state.busy || pending.length > 0 || autoClearRunning || idleMs < cfg.idleMs) {
      if (!activityAt) lastUserActivityAt = now;
      return false;
    }
    autoClearRunning = true;
    const startedAt = Date.now();
    set({ commandStatus: { active: true, verb: 'Auto-clearing idle conversation', startedAt, mode: 'auto-clear' } });
    try {
      const beforeContext = runtime.contextStatus?.() || null;
      await runtime.clear({ compactType: cfg.compactType || null, requireCompactSuccess: !!cfg.compactType });
      resetStats();
      const afterContext = syncContextStats({ allowEstimated: true }) || runtime.contextStatus?.() || null;
      const afterCompaction = runtime.session?.compaction || afterContext?.compaction || {};
      const idleLabel = formatIdleDuration(idleMs);
      const thresholdLabel = formatIdleDuration(cfg.idleMs);
      const beforeTokens = Number(beforeContext?.usedTokens || beforeContext?.currentEstimatedTokens || beforeContext?.usage?.lastContextTokens || 0);
      const afterTokens = Number(afterContext?.usedTokens || afterContext?.currentEstimatedTokens || afterContext?.usage?.lastContextTokens || 0);
      const contextDetail = beforeTokens > 0 || afterTokens > 0
        ? `context ${formatTokenCount(beforeTokens)}→${formatTokenCount(afterTokens)}`
        : 'context reset';
      set({
        items: replaceItems([]),
        toasts: [],
        queued: [],
        thinking: null,
        spinner: null,
        lastTurn: null,
        ...routeState(),
        stats: { ...state.stats },
      });
      const compactType = afterCompaction.lastClearCompactType || cfg.compactType || '';
      const compactLabel = compactType ? `compact ${compactType}` : '';
      const summaryLabel = cfg.compactType ? (hasCompactSummary(runtime.session) ? 'summary kept' : 'summary missing') : '';
      pushItem({
        kind: 'statusdone',
        id: nextId(),
        label: 'Auto-clear complete',
        detail: [idleLabel ? `idle ${idleLabel}` : '', contextDetail, compactLabel, summaryLabel, thresholdLabel ? `threshold ${thresholdLabel}` : '']
          .filter(Boolean)
          .join(' · '),
      });
      return true;
    } catch (error) {
      const message = presentErrorText(error, { surface: 'auto-clear' });
      pushItem({
        kind: 'statusdone',
        id: nextId(),
        label: 'Auto-clear skipped',
        detail: `conversation kept · ${message}`,
      });
      pushNotice(`auto-clear skipped: ${message}`, 'error');
      return false;
    } finally {
      lastUserActivityAt = Date.now();
      autoClearRunning = false;
      set({ commandStatus: null });
    }
  }

  function restoreQueued(currentText = '') {
    const queued = [];
    for (let i = 0; i < pending.length;) {
      const entry = pending[i];
      if (isQueuedEntryEditable(entry)) {
        queued.push(entry);
        pending.splice(i, 1);
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(queued);
    const queuedText = queued.map((item) => item.text).filter((text) => String(text || '').trim()).join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    return { count: queued.length, text: combinedText, pastedImages: mergePastedImages(queued) };
  }

  const resetStats = () => {
    state.stats = createSessionStats();
    return state.stats;
  };
  const resetStatsAndSyncContext = () => {
    resetStats();
    syncContextStats({ allowEstimated: true });
    return state.stats;
  };

  return {
    getState: () => state,
    patchItem,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: (text, options = {}) => {
      const t = promptDisplayText(text, options).trim();
      if (!t || state.commandBusy) return false;
      const mode = options.mode || 'prompt';
     // Plain user input entered while a turn is busy must NOT steer into the
     // active turn. Steering (priority 'next') depends on drain points inside
     // the agent loop (pre-send / final-pre-send) that are not available during
     // the gap between the first provider send and the first response; input
     // that lands there is misaligned at the turn boundary and causes the
     // ongoing turn to be cancelled. Use the default queue priority ('later')
     // so the input is safely dequeued after the current turn finishes as a
     // regular follow-up. Explicit options.priority overrides still win for
     // callers (e.g. task-notifications) that intentionally request steering.
     const priority = options.priority || (state.busy && mode === 'prompt' ? defaultQueuePriority(mode) : undefined);
      const queueOptions = {
        ...options,
        mode,
        displayText: promptDisplayText(text, options),
        priority,
      };
      if (state.busy) {
        enqueue(text, queueOptions);
        return true;
      }
      void autoClearBeforeSubmit().then(() => enqueue(text, queueOptions));
      return true;
    },
    restoreQueued,
    setModel: async (m) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute({ model: m });
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    setEffort: async (value) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setEffort(value);
        set({ ...routeState() });
        return runtime.effort || 'auto';
      } finally {
        set({ commandBusy: false });
      }
    },
    setFast: async (value) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.setFast(value);
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    toggleFast: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const enabled = await runtime.toggleFast();
        set({ ...routeState() });
        return enabled;
      } finally {
        set({ commandBusy: false });
      }
    },
    setToolMode: (m) => {
      void runtime.setToolMode(m)
        .then(() => {
          resetStatsAndSyncContext();
          set({ ...routeState(), toolMode: runtime.toolMode, stats: { ...state.stats } });
        })
        .catch((error) => pushNotice(toolErrorDisplay(error, 'tool'), 'error'));
    },
    getAutoClear: () => autoClearState(),
    setAutoClear: (input = {}) => {
      const next = runtime.setAutoClear?.(input) || autoClearState();
      set({ autoClear: next });
      return next;
    },
    getProfile: () => runtime.getProfile?.() || { title: '', language: 'system', languages: [] },
    setProfile: (input = {}) => {
      const next = runtime.setProfile?.(input) || runtime.getProfile?.() || null;
      return next;
    },
    getCompactionSettings: () => {
      return runtime.getCompactionSettings?.() || {};
    },
    setCompactionSettings: async (input = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = runtime.setCompactionSettings?.(input) || {};
        syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...state.stats } });
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    getMemorySettings: () => {
      return runtime.getMemorySettings?.() || { enabled: true };
    },
    setMemoryEnabled: async (enabled) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = await runtime.setMemoryEnabled?.(enabled);
        syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...state.stats } });
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    getChannelSettings: (options = {}) => {
      return runtime.getChannelSettings?.(options) || {
        enabled: true,
        ...(options?.includeStatus === false ? {} : { status: runtime.getChannelWorkerStatus?.() }),
      };
    },
    setChannelsEnabled: async (enabled) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const next = await runtime.setChannelsEnabled?.(enabled);
        set({ ...routeState(), stats: { ...state.stats } });
        return next;
      } finally {
        set({ commandBusy: false });
      }
    },
    agentControl: async (args = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.agentControl(args);
        const text = String(result ?? '').trim();
        const itemId = nextId();
        pushItem({
          kind: 'tool',
          id: itemId,
          name: 'agent',
          args,
          result: null,
          isError: false,
          expanded: false,
          count: 1,
          completedCount: 0,
          startedAt: Date.now(),
        });
        updateAgentJobCard(itemId, text, /^error:/i.test(text));
        set(agentStatusState({ force: true }));
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    toolsStatus: (query = '') => {
      return runtime.toolsStatus?.(query) || { mode: state.toolMode, count: 0, activeCount: 0, tools: [] };
    },
    selectTools: (names) => {
      const result = runtime.selectTools?.(names) || { added: [], already: [], blocked: [], missing: [] };
      const added = result.added?.length ? `added ${result.added.join(', ')}` : '';
      const already = result.already?.length ? `already ${result.already.join(', ')}` : '';
      const blocked = result.blocked?.length ? `blocked ${result.blocked.map((row) => row.name).join(', ')}` : '';
      const missing = result.missing?.length ? `missing ${result.missing.join(', ')}` : '';
      pushNotice(
        [added, already, blocked, missing].filter(Boolean).join(' - ') || 'no tool changes',
        result.blocked?.length || result.missing?.length ? 'warn' : 'info',
      );
      return result;
    },
    setCwd: (path) => {
      const next = runtime.setCwd(path);
      set({ cwd: next });
      pushNotice(`cwd -> ${next}`, 'info');
      return next;
    },
    getSystemShell: () => {
      return runtime.getSystemShell?.() || runtime.systemShell || { source: 'auto', command: '', effective: '' };
    },
    setSystemShell: (command) => {
      const next = runtime.setSystemShell?.(command) || { source: 'auto', command: '', effective: '' };
      set({ ...routeState(), systemShell: next });
      pushNotice(`system shell -> ${next.effective || 'auto'}`, 'info');
      return next;
    },
    mcpStatus: () => {
      return runtime.mcpStatus?.() || { servers: [], configuredCount: 0, connectedCount: 0, failedCount: 0 };
    },
    reconnectMcp: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reconnectMcp?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(
          `mcp reconnect: ${status?.connectedCount || 0}/${status?.configuredCount || 0} connected${status?.failedCount ? ` - ${status.failedCount} failed` : ''}`,
          status?.failedCount ? 'warn' : 'info',
        );
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addMcpServer: async (input) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addMcpServer?.(input);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp added: ${result?.name || input?.name || 'server'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removeMcpServer: async (name) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.removeMcpServer?.(name);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp removed: ${name}`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    setMcpServerEnabled: async (name, enabled) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.setMcpServerEnabled?.(name, enabled);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`mcp ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    skillsStatus: () => {
      return runtime.skillsStatus?.() || { cwd: state.cwd, count: 0, skills: [] };
    },
    skillContent: (name) => {
      return runtime.skillContent?.(name);
    },
    addSkill: async (input) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addSkill?.(input);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`skill added: ${result?.skill?.name || input?.name || 'skill'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    reloadSkills: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadSkills?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`skills reload: ${status?.count || 0} available`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    pluginsStatus: () => {
      return runtime.pluginsStatus?.() || { count: 0, plugins: [] };
    },
    reloadPlugins: async () => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const status = await runtime.reloadPlugins?.();
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugins reload: ${status?.count || 0} detected`, 'info');
        return status;
      } finally {
        set({ commandBusy: false });
      }
    },
    addPlugin: async (source) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.addPlugin?.(source);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin added: ${result?.plugin?.title || result?.plugin?.name || source}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    updatePlugin: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.updatePlugin?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin updated: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    removePlugin: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.removePlugin?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin uninstalled: ${result?.plugin?.title || result?.plugin?.name || plugin?.name || plugin}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    enablePluginMcp: async (plugin) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.enablePluginMcp?.(plugin);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice(`plugin MCP enabled: ${result?.serverName || plugin?.name || 'plugin'}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    hooksStatus: () => {
      return runtime.hooksStatus?.() || { enabled: false, events: [], recent: [] };
    },
    contextStatus: () => {
      return runtime.contextStatus?.() || null;
    },
    addHookRule: (rule) => {
      const rules = runtime.addHookRule?.(rule) || [];
      pushNotice(`hook rule added (${rules.length} total)`, 'info');
      return rules;
    },
    setHookRuleEnabled: (index, enabled) => {
      const rules = runtime.setHookRuleEnabled?.(index, enabled) || [];
      pushNotice(`hook rule ${index + 1} ${enabled ? 'enabled' : 'disabled'}`, 'info');
      return rules;
    },
    deleteHookRule: (index) => {
      const rules = runtime.deleteHookRule?.(index) || [];
      pushNotice(`hook rule ${index + 1} deleted`, 'info');
      return rules;
    },
    memoryControl: async (args = {}, options = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.memoryControl(args);
        const text = String(result || '').trim() || '(empty memory result)';
        if (!options.silent) pushNotice(text, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    recall: async (query, args = {}) => {
      if (state.commandBusy) return null;
      const startedAt = Date.now();
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Recalling memory', startedAt, mode: 'recalling' } });
      try {
        const result = await runtime.recall(query, args);
        pushNotice(String(result || '').trim() || '(empty recall result)', 'info');
        return result;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    compact: async () => {
      if (state.commandBusy) return null;
      const startedAt = Date.now();
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Compacting conversation', startedAt, mode: 'compacting' } });
      try {
        const result = await runtime.compact({ recoverAgent: true });
        syncContextStats({ allowEstimated: true });
        set({ ...routeState(), stats: { ...state.stats } });
        if (result) {
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: result.error ? 'Compact failed' : (result.changed === false ? 'Compact checked' : 'Compact complete'),
            detail: compactEventDetail({
              stage: 'manual',
              trigger: 'manual',
              status: result.error ? 'failed' : (result.changed === false ? 'no_change' : 'compacted'),
              compactType: result.compactType,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
              beforeMessages: result.beforeMessages,
              afterMessages: result.afterMessages,
              semantic: result.semanticCompact,
              recallFastTrack: result.recallFastTrack,
              durationMs: Date.now() - startedAt,
              error: result.error,
            }),
          });
        }
        return result;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    abort: () => {
      if (!state.busy) return false;
      const restoreState = activePromptRestore;
      const restoreText = restoreState?.restorable ? restoreState.text : '';
      const restorePastedImages = restoreState?.restorable && restoreState?.pastedImages ? restoreState.pastedImages : null;
      const requeueEntries = restoreState && !restoreState.committed && Array.isArray(restoreState.requeueEntries)
        ? restoreState.requeueEntries.slice()
        : [];
      const aborted = runtime.abort('cli-react-abort');
      if (restoreState) {
        if ((restoreText || requeueEntries.length > 0) && aborted !== false) {
          restoreState.reclaimed = true;
          const idSet = new Set((restoreState.submittedIds || []).filter((id) => id != null));
          const patch = { spinner: null, thinking: null, lastTurn: null };
          if (idSet.size > 0) {
            const items = state.items.filter((item) => !idSet.has(item?.id));
            if (items.length !== state.items.length) {
              patch.items = replaceItems(items);
            }
          }
          set(patch);
          if (requeueEntries.length > 0) requeueEntriesFront(requeueEntries);
        }
        restoreState.restorable = false;
        restoreState.requeueEntries = [];
      }
      return { aborted, restoreText, pastedImages: restorePastedImages };
    },
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: (options = {}) => {
      return runtime.listProviderModels(options);
    },
    getSearchRoute: () => {
      return runtime.getSearchRoute?.() || runtime.searchRoute || null;
    },
    listSearchModels: (options = {}) => {
      return runtime.listSearchModels?.(options) || [];
    },
    setSearchRoute: async (opts) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setSearchRoute?.(opts);
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    getOutputStyle: () => {
      return runtime.getOutputStyle?.() || runtime.listOutputStyles?.() || null;
    },
    listOutputStyles: () => {
      return runtime.listOutputStyles?.() || runtime.getOutputStyle?.() || { styles: [], current: null, configured: 'default' };
    },
    setOutputStyle: async (styleId) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.setOutputStyle?.(styleId);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    setWorkflow: async (workflowId) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = runtime.setWorkflow?.(workflowId);
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
    },
    getUsageDashboard: async (options = {}) => {
      return await runtime.getUsageDashboard?.(options);
    },
    getOnboardingStatus: () => {
      return runtime.getOnboardingStatus?.() || { completed: true, workflowRoutes: {} };
    },
    completeOnboarding: async (payload = {}) => {
      if (state.commandBusy) return null;
      set({ commandBusy: true });
      try {
        const result = await runtime.completeOnboarding?.(payload);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        pushNotice('first-run setup saved', 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    loginOAuthProvider: async (provider) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.loginOAuthProvider(provider);
        pushNotice(`provider oauth ok: ${result.provider}`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    beginOAuthProviderLogin: async (provider) => {
      if (state.commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        const result = await runtime.beginOAuthProviderLogin(provider);
        pushNotice(`provider oauth started: ${result.provider}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushNotice(`provider api key saved: ${result.provider}`, 'info');
      return true;
    },
    saveOpenCodeGoUsageAuth: (opts) => {
      const result = runtime.saveOpenCodeGoUsageAuth(opts);
      pushNotice(result.workspaceId
        ? `OpenCode Go usage auth saved: ${result.workspaceId}`
        : 'OpenCode Go usage auth saved',
        'info');
      return true;
    },
    saveOpenAIUsageSessionKey: (secret) => {
      runtime.saveOpenAIUsageSessionKey(secret);
      pushNotice('OpenAI usage auth saved', 'info');
      return true;
    },
    setLocalProvider: (provider, opts) => {
      const result = runtime.setLocalProvider(provider, opts);
      pushNotice(`local provider ${result.enabled ? 'enabled' : 'disabled'}: ${result.provider}`, 'info');
      return true;
    },
    authenticateProvider: async (provider, secret) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        const result = await runtime.authenticateProvider(provider, secret);
        pushNotice(`provider auth ok: ${result.provider} (${result.type})`, 'info');
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    forgetProviderAuth: (provider) => {
      const result = runtime.forgetProviderAuth(provider);
      pushNotice(`provider auth forgotten: ${result.provider}`, 'info');
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    saveDiscordToken: (token) => {
      const result = runtime.saveDiscordToken(token);
      pushNotice('discord token saved', 'info');
      return result;
    },
    forgetDiscordToken: () => {
      const result = runtime.forgetDiscordToken();
      pushNotice('discord token forgotten', 'info');
      return result;
    },
    saveWebhookAuthtoken: (token) => {
      const result = runtime.saveWebhookAuthtoken(token);
      pushNotice('webhook/ngrok authtoken saved', 'info');
      return result;
    },
    forgetWebhookAuthtoken: () => {
      const result = runtime.forgetWebhookAuthtoken();
      pushNotice('webhook/ngrok authtoken forgotten', 'info');
      return result;
    },
    saveChannel: (entry) => {
      const result = runtime.saveChannel(entry);
      pushNotice(`channel saved: ${entry.name}`, 'info');
      return result;
    },
    deleteChannel: (name) => {
      const result = runtime.deleteChannel(name);
      pushNotice(`channel deleted: ${name}`, 'info');
      return result;
    },
    setWebhookConfig: (patch) => {
      const result = runtime.setWebhookConfig(patch);
      pushNotice('webhook config updated', 'info');
      return result;
    },
    saveSchedule: (entry) => {
      const result = runtime.saveSchedule(entry);
      pushNotice(`schedule saved: ${result.name}`, 'info');
      return result;
    },
    deleteSchedule: (name) => {
      const result = runtime.deleteSchedule(name);
      pushNotice(`schedule deleted: ${name}`, 'info');
      return result;
    },
    setScheduleEnabled: (name, enabled) => {
      const result = runtime.setScheduleEnabled(name, enabled);
      pushNotice(`schedule ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    saveWebhook: (entry) => {
      const result = runtime.saveWebhook(entry);
      pushNotice(`webhook saved: ${result.name}`, 'info');
      return result;
    },
    deleteWebhook: (name) => {
      const result = runtime.deleteWebhook(name);
      pushNotice(`webhook deleted: ${name}`, 'info');
      return result;
    },
    setWebhookEnabled: (name, enabled) => {
      const result = runtime.setWebhookEnabled(name, enabled);
      pushNotice(`webhook ${enabled ? 'enabled' : 'disabled'}: ${name}`, 'info');
      return result;
    },
    setRoute: async (opts) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      try {
        await runtime.setRoute(opts);
        resetStatsAndSyncContext();
        set({ ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    pushNotice,
    clear: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      try {
        await runtime.clear({ recoverAgent: true });
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        lastUserActivityAt = Date.now();
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    listSessions: () => {
      return runtime.listSessions();
    },
    newSession: async () => {
      if (state.commandBusy) return false;
      set({ commandBusy: true });
      clearToastTimers();
      try {
        await runtime.newSession();
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        return true;
      } finally {
        set({ commandBusy: false });
      }
    },
    resume: async (id) => {
      if (state.commandBusy) return false;
      set({ commandBusy: true, commandStatus: { active: true, verb: 'Resuming conversation', startedAt: Date.now(), mode: 'resuming' } });
      clearToastTimers();
      try {
        const r = await runtime.resume(id);
        if (!r) return false;
        resetStatsAndSyncContext();
        const items = [];
        for (const m of r.messages || []) {
          if (m.role === 'user') {
            // content may be a string OR an array of parts (text/tool-call
            // interleaving) — toolResultText coerces both to readable text so
            // array-content messages aren't silently dropped.
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (text) {
              const synthetic = parseSyntheticAgentMessage(text);
              if (synthetic) {
                const label = synthetic.label || 'notification';
                items.push({
                  kind: 'tool',
                  id: nextId(),
                  name: synthetic.name || 'agent',
                  args: synthetic.args || {
                    type: label,
                    task_id: synthetic.taskId || undefined,
                    description: synthetic.summary || 'agent notification',
                  },
                  result: synthetic.result,
                  isError: synthetic.isError ?? /^(failed|error|killed|cancelled)$/i.test(label),
                  expanded: false,
                  count: 1,
                  completedCount: 1,
                  startedAt: Date.now(),
                  completedAt: Date.now(),
                });
              } else {
                items.push({ kind: 'user', id: nextId(), text });
              }
            }
          } else if (m.role === 'assistant') {
            const text = (typeof m.content === 'string' ? m.content : toolResultText(m.content)).trim();
            if (text) items.push({ kind: 'assistant', id: nextId(), text });
          }
        }
        set({
          items: replaceItems(items),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          ...routeState(),
          stats: { ...state.stats },
        });
        return true;
      } finally {
        set({ commandBusy: false, commandStatus: null });
      }
    },
    dispose: async (reason = 'cli-react-exit', options = {}) => {
      if (disposed) return;
      disposed = true;
      clearToastTimers();
      try { clearInterval(runtimePulseTimer); } catch {}
      try { unsubscribeRuntimeNotifications?.(); } catch {}
      unsubscribeRuntimeNotifications = null;
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
