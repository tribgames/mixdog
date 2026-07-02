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
  summarizeToolResult,
} from '../runtime/shared/tool-surface.mjs';
import { isBackgroundErrorOnlyBody, presentErrorText } from '../runtime/shared/err-text.mjs';
import {
  isModelVisibleToolCompletionWrapper,
  modelVisibleToolCompletionMessage,
} from '../runtime/shared/tool-execution-contract.mjs';
import { listThemes, getThemeSetting, setThemeSetting } from './theme.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from './markdown/streaming-markdown.mjs';

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

const TOOL_APPROVAL_TIMEOUT_MS = (() => {
  const value = Number(process.env.MIXDOG_TOOL_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : 120_000;
})();

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

function formatElapsedSeconds(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value <= 0) return '0s';
  return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

function compactEventLabel(event = {}) {
  const status = String(event.status || '').toLowerCase();
  const reactive = String(event.trigger || '').toLowerCase() === 'reactive';
  if (status === 'failed') return reactive ? 'Compact failed (overflow retry)' : 'Compact failed';
  if (status === 'skipped') return 'Compact skipped';
  if (status === 'no_change') return 'Compact checked';
  return reactive ? 'Compact complete (overflow recovery)' : 'Compact complete';
}

function compactEventDetail(event = {}) {
  // Keep the elapsed time as the lead detail, but no longer discard the rest of
  // the compact metadata. Surface type/trigger and the boundary/pressure so the
  // statusdone marker reflects what actually fired.
  const parts = [];
  const elapsed = formatElapsedSeconds(Number(event.durationMs ?? event.elapsedMs ?? 0));
  if (elapsed) parts.push(elapsed);
  const type = String(event.compactType || event.type || '').trim();
  if (type && type !== 'semantic') parts.push(type);
  const trigger = String(event.trigger || '').toLowerCase();
  if (trigger === 'reactive') parts.push('reactive');
  else if (trigger === 'manual') parts.push('manual');
  const before = Number(event.beforeTokens ?? event.pressureTokens ?? 0);
  const after = Number(event.afterTokens ?? 0);
  const fmtTok = (n) => {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
    return `${Math.round(v)}`;
  };
  if (before > 0 && after > 0 && after !== before) parts.push(`${fmtTok(before)}→${fmtTok(after)}`);
  return parts.join(' · ');
}

function projectNameFromPath(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text || '(current)';
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
  if (Array.isArray(content)) {
    return content.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
  }
  if (typeof content === 'object') {
    if (Array.isArray(content.content)) {
      const nested = content.content.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    } else if (content.content != null && typeof content.content === 'object') {
      const nested = toolResultPartText(content.content);
      if (nested) return nested;
    }
    if (Array.isArray(content.parts)) {
      const nested = content.parts.map((c) => toolResultPartText(c)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    const fromPart = toolResultPartText(content);
    if (fromPart) return fromPart;
    if (content?.type === 'tool_result') return '';
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

const TOOL_RESULT_PART_MAX_DEPTH = 12;
const TOOL_RESULT_JSON_FALLBACK_MAX = 480;
// Absolute cap for a collapsed tool detail line (the second row under the ⎿
// gutter). Terminal-width independent so a wide terminal never lets a long line
// stretch the row; lockstep with ToolExecution RESULT_LINE_HARD_MAX (80).
const TOOL_DETAIL_LINE_MAX = 80;

function compactToolResultObjectFallback(obj) {
  if (obj?.type === 'tool_result') return '';
  try {
    const json = JSON.stringify(obj);
    if (!json || json === '{}') return '';
    if (json.length <= TOOL_RESULT_JSON_FALLBACK_MAX) return json;
    return `${json.slice(0, TOOL_RESULT_JSON_FALLBACK_MAX - 1)}…`;
  } catch {
    return String(obj);
  }
}

function toolResultPartText(part, depth = 0) {
  if (part == null) return '';
  if (depth > TOOL_RESULT_PART_MAX_DEPTH) return '';
  if (typeof part === 'string') return part;
  if (part?.type === 'image' || part?.type === 'input_image') {
    return `[image: ${part.mimeType || part.mediaType || part.source?.media_type || 'image'}]`;
  }
  if (part?.type === 'tool_result') {
    const inner = part.content;
    if (typeof inner === 'string') return inner;
    if (Array.isArray(inner)) {
      return inner.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
    }
    if (inner != null && typeof inner === 'object') {
      return toolResultPartText(inner, depth + 1);
    }
    return '';
  }
  if (part?.type === 'text' || part?.type === 'output_text' || part?.type === 'input_text') {
    return part.text ?? '';
  }
  if (Array.isArray(part)) {
    return part.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
  }
  if (typeof part === 'object') {
    if (Array.isArray(part.content)) {
      const nested = part.content.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    if (part.content != null && typeof part.content === 'object') {
      const nested = toolResultPartText(part.content, depth + 1);
      if (nested) return nested;
    }
    if (Array.isArray(part.parts)) {
      const nested = part.parts.map((c) => toolResultPartText(c, depth + 1)).filter((t) => t !== '').join('\n');
      if (nested) return nested;
    }
    if (typeof part.text === 'string' && part.text) return part.text;
    if (typeof part.output === 'string' && part.output) return part.output;
    if (typeof part.message === 'string' && part.message) return part.message;
    if (typeof part.content === 'string') return part.content;
    if (part.source?.type === 'base64' && part.source?.data) {
      return `[image: ${part.source.media_type || part.source.mediaType || 'base64'}]`;
    }
    return compactToolResultObjectFallback(part);
  }
  return '';
}

function toolAggregateDetailFallback(detailText, rawResult) {
  if (String(detailText || '').trim()) return detailText;
  const raw = String(rawResult || '').replace(/\s+$/, '').trim();
  if (!raw) return detailText;
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) || '';
  if (!line) return detailText;
  return line.length > TOOL_DETAIL_LINE_MAX ? `${line.slice(0, TOOL_DETAIL_LINE_MAX - 3)}…` : line;
}

function toolGroupedDisplayFallback(resultText, text, rawText) {
  if (String(resultText || '').trim()) return resultText;
  const body = String(text || rawText || '').trim();
  if (body) return text || rawText;
  return resultText;
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

function parseAgentResultEnvelope(text, fallback = {}) {
  const value = String(text ?? '').trim();
  if (!/^agent result\b/i.test(value)) return null;
  const [head = '', ...restLines] = value.split('\n');
  const body = stripSyntheticAgentTags(restLines.join('\n'));
  const attrs = {};
  const attrRe = /([a-zA-Z][\w-]*)=("[^"]*"|'[^']*'|\S+)/g;
  let match;
  while ((match = attrRe.exec(head))) {
    attrs[match[1].toLowerCase()] = String(match[2] || '').replace(/^["']|["']$/g, '');
  }
  const providerModel = /\s([a-zA-Z0-9_.-]+)\/([^\s]+)\s*$/i.exec(head);
  const agent = attrs.agent || fallback.agent || '';
  return {
    name: 'agent',
    label: String(fallback.status || attrs.status || 'completed').toLowerCase(),
    args: {
      type: 'result',
      status: fallback.status || attrs.status || 'completed',
      task_id: fallback.taskId || attrs.task_id || attrs.taskid || undefined,
      tag: fallback.tag || attrs.tag || undefined,
      agent: agent || undefined,
      provider: fallback.provider || attrs.provider || providerModel?.[1] || undefined,
      model: fallback.model || attrs.model || providerModel?.[2] || undefined,
      preset: fallback.preset || attrs.preset || undefined,
      effort: fallback.effort || attrs.effort || undefined,
      fast: fallback.fast ?? attrs.fast,
    },
    result: body || agentJobStatusText({ status: fallback.status || attrs.status || 'completed', taskId: fallback.taskId || attrs.task_id || attrs.taskid || '' }),
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(fallback.status || attrs.status || ''),
  };
}

export { toolResultText, toolAggregateDetailFallback, toolGroupedDisplayFallback };

export function parseBackgroundTaskEnvelope(text) {
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
  const errorText = fields.error || '';
  const agentResult = parseAgentResultEnvelope(body, {
    status,
    taskId,
    tag: fields.tag || fields.label || '',
    agent: fields.agent || '',
    provider: fields.provider || '',
    model: fields.model || '',
    preset: fields.preset || '',
    effort: fields.effort || '',
    fast: fields.fast,
  });
  if (agentResult) return { ...agentResult, rawResult: value };
  const errorOnlyBody = isBackgroundErrorOnlyBody(body, errorText);
  const resultBody = body && !errorOnlyBody ? body : '';
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
      tag: fields.tag || undefined,
      agent: fields.agent || undefined,
      provider: fields.provider || undefined,
      model: fields.model || undefined,
      preset: fields.preset || undefined,
      effort: fields.effort || undefined,
      fast: fields.fast || undefined,
      error: errorText || undefined,
      startedAt: fields.started || fields.startedat || undefined,
      finishedAt: fields.finished || fields.finishedat || undefined,
    },
    result: resultBody || (!errorText ? [status ? `status: ${status}` : '', taskId ? `task_id: ${taskId}` : ''].filter(Boolean).join(' · ') : ''),
    rawResult: value,
    isError: /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status) || /^error:/i.test(body) || Boolean(errorText),
  };
}

function isStatusOnlyAgentCompletionNotification(text) {
  const background = parseBackgroundTaskEnvelope(text);
  if (background?.name === 'agent' && /^(completed|cancelled|canceled)$/i.test(background.label || '')) {
    return !(hasAgentResponseResultText(background.result) || hasAgentResponseResultText(text));
  }
  const parsed = parseAgentJob(text);
  const result = agentJobResultText(text, parsed);
  if (!parsed?.taskId || !/^(completed|cancelled|canceled)$/i.test(parsed.status || '')) return false;
  return !(hasAgentResponseResultText(result) || hasAgentResponseResultText(text));
}

function hasAgentResponseResultText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(value)) return false;
  if (/^(?:background task\b|agent task:|task_id:)/i.test(value) && !/\n\s*\n[\s\S]*\S/.test(value)) return false;
  return true;
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
  const agentResult = parseAgentResultEnvelope(value);
  if (agentResult) return agentResult;
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

// Ink renders through a maxFps throttle (120fps in index.jsx, ≈8.3ms). A plain
// setImmediate only yields to the event loop; if Ink already painted within the
// current throttle window, the next paint may still be queued and our following
// transcript mutation can coalesce into the same visible frame. Wait just past
// one render window when we intentionally split transcript commits for visual
// stability (preamble frame → tool-card frame).
const RENDER_THROTTLE_FLUSH_MS = 12;
const yieldToRenderer = () => new Promise((resolve) => {
  setTimeout(resolve, RENDER_THROTTLE_FLUSH_MS);
});

function parseAgentJob(text) {
  const value = String(text || '');
  const idMatch = /^agent task:\s*([^\s]+)/m.exec(value) || /^task_id:\s*([^\s]+)/m.exec(value);
  if (!idMatch) return null;
  const statusMatch = /^status:\s*([^\s(]+)/m.exec(value);
  const typeMatch = /^type:\s*(.+)$/m.exec(value);
  const targetMatch = /^target:\s*(.+)$/m.exec(value);
  const agentMatch = /^agent:\s*(.+)$/m.exec(value);
  const presetMatch = /^preset:\s*(.+)$/m.exec(value);
  const modelMatch = /^model:\s*([^/\s]+)\/(.+)$/m.exec(value);
  const effortMatch = /^effort:\s*(.+)$/m.exec(value);
  const fastMatch = /^fast:\s*(on|off|true|false)$/m.exec(value);
  return {
    taskId: idMatch[1],
    status: (statusMatch?.[1] || '').toLowerCase(),
    type: (typeMatch?.[1] || '').trim(),
    target: (targetMatch?.[1] || '').trim(),
    agent: (agentMatch?.[1] || '').trim(),
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
  // Queue priority defaults:
  // - user/bashed prompt input defaults to `next`, so it can be attached at the
  //   next model-send boundary while a turn is active.
  // - task notifications default to `later`, unless the caller explicitly marks
  //   them urgent (e.g. interactive shell stall/completion).
  return mode === 'task-notification' ? 'later' : 'next';
}

function isQueuedEntryEditable(entry) {
  const mode = entry?.mode || 'prompt';
  return mode !== 'task-notification' && mode !== 'pending-resume';
}

function isQueuedEntryVisible(entry) {
  // state.queued drives the user-command wait list above the prompt. Background
  // task completions stay in the internal pending queue, but should never look
  // like commands typed by the user while they wait to be drained.
  const mode = entry?.mode || 'prompt';
  if (mode === 'pending-resume') return false;
  return isQueuedEntryEditable(entry);
}

function isSlashQueuedEntry(entry) {
  if (entry?.skipSlashCommands) return false;
  const text = promptContentText(entry?.content ?? entry?.text ?? '');
  return text.trim().startsWith('/');
}

function firstQueueLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

function shortTextFingerprint(text) {
  const value = String(text || '').trim();
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
  const synthetic = parseSyntheticAgentMessage(text);
  if (synthetic?.name === 'agent' && String(synthetic.args?.type || '').toLowerCase() === 'result') {
    const taskId = String(synthetic.args?.task_id || '').trim();
    const executionId = String(meta.execution_id || '').trim();
    const tag = String(synthetic.args?.tag || '').trim();
    const resultId = taskId
      ? `task:${taskId}`
      : executionId
        ? `exec:${executionId}`
        : tag
          ? `tag:${tag}:${shortTextFingerprint(synthetic.result || text)}`
          : '';
    const agent = String(synthetic.args?.agent || '').trim();
    if (resultId || agent) return ['agent-result', resultId, agent].filter(Boolean).join(':');
  }
  const id = String(meta.execution_id || parsed?.taskId || '').trim();
  if (!id) return '';
  const type = String(meta.type || '').trim();
  const status = String(meta.status || parsed?.status || '').trim();
  const fallbackKind = String(text || '').split('\n', 1)[0]?.trim() || 'notification';
  // Distinguish a body-carrying completion from a header-only preview that
  // shares the same id/type/status. An early agent preview can arrive before
  // the session is persisted (no result body); the canonical notification that
  // follows DOES carry the body. Without this dimension the bodyless preview
  // would claim the dedupe key and suppress the real result. A blank-line gap
  // separates the task header block from the result body in the envelope.
  const hasBody = /\n\s*\n[\s\S]*\S/.test(String(text || '')) ? 'b1' : 'b0';
  return [id, type || fallbackKind, status, hasBody].filter(Boolean).join(':');
}

/** Pure delivery plan for runtime.onNotification execution envelopes (tests + handler). */
export function resolveTuiRuntimeNotificationDelivery(event, text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { action: 'ignore' };
  const parsed = parseAgentJob(trimmed);
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  if (!isExecutionNotification(event, trimmed, parsed)) {
    return { action: 'enqueue', displayText: trimmed, modelContent: trimmed };
  }
  if (isStatusOnlyAgentCompletionNotification(trimmed)) {
    return { action: 'status-only', displayText: trimmed, modelContent: '' };
  }
  const modelContent = modelVisibleToolCompletionMessage(trimmed, meta);
  return {
    action: 'execution-ui',
    displayText: trimmed,
    modelContent,
  };
}

function isExecutionNotification(event, text, parsed) {
  const meta = event?.meta && typeof event.meta === 'object' ? event.meta : {};
  if (meta.execution_id || meta.execution_surface) return true;
  if (parseAgentResultEnvelope(text)) return true;
  if (parseBackgroundTaskEnvelope(text)) return true;
  return Boolean(parsed?.taskId && /^(?:agent task:|task_id:)/mi.test(String(text || '')));
}

function agentArgsWithResultMetadata(args, parsed) {
  if (!parsed) return args;
  const next = { ...(args && typeof args === 'object' ? args : {}) };
  const requestedAction = String(next.type || next.action || next.mode || '').trim().toLowerCase();
  if (parsed.type) {
    // Job status envelopes report the original job type (usually "spawn").
    // Preserve the user's current agent tool action ("status", "read", …) so
    // manual checks render as "Reviewer status" instead of another
    // "Spawning Reviewer" card. Keep the job type as metadata for detail.
    if (!requestedAction || /^(notification|result|completion)$/i.test(requestedAction)) next.type = parsed.type;
    else next.jobType = parsed.type;
  }
  if (parsed.status) next.status = parsed.status;
  if (parsed.taskId) next.task_id = parsed.taskId;
  if (parsed.agent) next.agent = parsed.agent;
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
  remote = false,
} = {}) {
  const startedAt = performance.now();
  bootProfile('engine:create:start', { provider: providerName, model, toolMode, remote });
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
  const runtime = await createMixdogSessionRuntime({ provider: providerName, model, toolMode, remote });
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
  const baseRouteState = () => ({
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
    remoteEnabled: runtime.isRemoteEnabled?.() === true,
  });

  const routeState = () => ({
    ...baseRouteState(),
    displayContextWindow: state.displayContextWindow || 0,
    compactBoundaryTokens: state.compactBoundaryTokens || 0,
    autoCompactTokenLimit: state.autoCompactTokenLimit || 0,
  });

  function syncContextDisplayFields(ctx = null) {
    const status = ctx || runtime.contextStatus?.() || null;
    if (!status) return;
    const displayWindow = Number(status.contextWindow || 0);
    const compactBoundary = Number(status.compaction?.boundaryTokens || 0);
    const autoCompact = Number(
      status.compaction?.autoCompactTokenLimit
      || runtime.session?.autoCompactTokenLimit
      || 0,
    );
    if (displayWindow > 0) state.displayContextWindow = displayWindow;
    if (compactBoundary > 0) state.compactBoundaryTokens = compactBoundary;
    if (autoCompact > 0) state.autoCompactTokenLimit = autoCompact;
  }

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
    toolApproval: null,
    lastTurn: null,
    stats: createSessionStats(),
    ...baseRouteState(),
    displayContextWindow: 0,
    compactBoundaryTokens: 0,
    autoCompactTokenLimit: 0,
    ...initialAgentState,
    toolMode: runtime.toolMode,
    cwd,
    themeEpoch: 0,
  };
  bootProfile('engine:route-state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  bootProfile('engine:state-ready', { ms: (performance.now() - stateStartedAt).toFixed(1) });
  let pendingSessionReset = false;
  const syncContextStats = ({ allowEstimated = false } = {}) => {
    if (pendingSessionReset) return null;
    const ctx = runtime.contextStatus?.() || null;
    if (!ctx) return null;
    syncContextDisplayFields(ctx);
    const hasProviderUsage = Number(state.stats.latestPromptTokens || state.stats.latestInputTokens || state.stats.inputTokens || 0) > 0;
    const hasApiContextUsage = Number(ctx?.lastApiRequestTokens ?? ctx?.usage?.lastContextTokens ?? 0) > 0;
    const hasTurnActivity = state.busy === true
      || state.spinner != null
      || state.thinking != null;
    const isFreshSession = !hasProviderUsage && !hasApiContextUsage && !hasTurnActivity;
    if (isFreshSession) {
      state.stats.currentEstimatedContextTokens = 0;
      state.stats.currentContextTokens = 0;
      state.stats.currentContextSource = null;
      state.stats.currentContextUpdatedAt = Date.now();
      return ctx;
    }
    const estimatedTokens = Math.max(0, Number(ctx.currentEstimatedTokens ?? ctx.usedTokens ?? 0));
    const usedTokens = Math.max(0, Number(ctx.usedTokens ?? estimatedTokens ?? 0));
    const usedSource = String(ctx.usedSource || '').toLowerCase();
    const shouldPublishEstimate = allowEstimated && (
      usedSource === 'estimated'
      || Number(ctx.currentEstimatedTokens) > 0
      || usedTokens > 0
    );
    if (!allowEstimated && !hasProviderUsage && usedSource !== 'last_api_request') return ctx;
    if (shouldPublishEstimate) {
      state.stats.currentEstimatedContextTokens = estimatedTokens;
      state.stats.currentContextSource = 'estimated';
      state.stats.currentContextTokens = 0;
    } else if (allowEstimated && (hasProviderUsage || hasApiContextUsage || hasTurnActivity)) {
      state.stats.currentEstimatedContextTokens = estimatedTokens;
      state.stats.currentContextSource = usedSource || (estimatedTokens > 0 ? 'estimated' : null);
      const publishedSource = String(state.stats.currentContextSource || '').toLowerCase();
      if (publishedSource === 'last_api_request') {
        const apiUsed = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        state.stats.currentContextTokens = apiUsed;
      } else if (publishedSource === 'estimated') {
        state.stats.currentContextTokens = 0;
      } else {
        state.stats.currentContextTokens = usedTokens > 0 ? usedTokens : 0;
      }
    } else {
      state.stats.currentEstimatedContextTokens = 0;
      if (usedSource === 'last_api_request' && Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0) > 0) {
        state.stats.currentContextTokens = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        state.stats.currentContextSource = 'last_api_request';
      } else {
        state.stats.currentContextTokens = 0;
        state.stats.currentContextSource = null;
      }
    }
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
  let flushDeferredBeforeImmediatePush = null;
  let pushingFromDeferredEntry = false;
  const pushItem = (item) => {
    if (!pushingFromDeferredEntry && flushDeferredBeforeImmediatePush) {
      flushDeferredBeforeImmediatePush();
    }
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
      rawResult: synthetic.rawResult ?? text,
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
    if (isModelVisibleToolCompletionWrapper(text)) return;
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
  const toolApprovalQueue = [];
  let activeToolApproval = null;
  function normalizeToolApprovalRequest(input = {}, id = nextId()) {
    const now = Date.now();
    const timeoutMs = TOOL_APPROVAL_TIMEOUT_MS;
    return {
      id,
      name: String(input?.name || input?.tool_name || 'tool'),
      args: input?.args ?? input?.tool_input ?? null,
      cwd: input?.cwd || null,
      sessionId: input?.sessionId || input?.session_id || null,
      toolCallId: input?.toolCallId || input?.tool_use_id || null,
      reason: String(input?.reason || input?.message || 'approval requested by hook').trim(),
      requestedAt: now,
      timeoutMs,
      expiresAt: now + timeoutMs,
    };
  }
  function presentNextToolApproval() {
    if (activeToolApproval || disposed) return;
    const entry = toolApprovalQueue.shift();
    if (!entry) {
      if (state.toolApproval) set({ toolApproval: null });
      return;
    }
    activeToolApproval = entry;
    entry.timer = setTimeout(() => {
      finishToolApproval(entry.id, false, 'approval timed out');
    }, entry.request.timeoutMs);
    entry.timer.unref?.();
    set({ toolApproval: entry.request });
  }
  function finishToolApproval(id, approved, reason = '') {
    const targetId = String(id || '');
    if (activeToolApproval && activeToolApproval.id === targetId) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      if (entry.timer) clearTimeout(entry.timer);
      set({ toolApproval: null });
      try { entry.resolve({ approved: approved === true, reason: String(reason || '') }); } catch {}
      presentNextToolApproval();
      return true;
    }
    const index = toolApprovalQueue.findIndex((entry) => entry.id === targetId);
    if (index >= 0) {
      const [entry] = toolApprovalQueue.splice(index, 1);
      if (entry?.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: approved === true, reason: String(reason || '') }); } catch {}
      return true;
    }
    return false;
  }
  function denyAllToolApprovals(reason = 'approval cancelled') {
    if (activeToolApproval) {
      const entry = activeToolApproval;
      activeToolApproval = null;
      if (entry.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: false, reason }); } catch {}
    }
    while (toolApprovalQueue.length > 0) {
      const entry = toolApprovalQueue.shift();
      if (entry?.timer) clearTimeout(entry.timer);
      try { entry.resolve({ approved: false, reason }); } catch {}
    }
    if (state.toolApproval) set({ toolApproval: null });
  }
  function requestToolApproval(input = {}) {
    if (disposed) return Promise.resolve({ approved: false, reason: 'runtime disposed' });
    return new Promise((resolve) => {
      const id = nextId();
      toolApprovalQueue.push({ id, request: normalizeToolApprovalRequest(input, id), resolve, timer: null });
      presentNextToolApproval();
    });
  }
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
    if (pendingSessionReset) return;
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
  let executionResumeKickDeferred = false;

  function kickExecutionPendingResume() {
    if (disposed) return;
    if (state.busy) {
      executionResumeKickDeferred = true;
      return;
    }
    if (pending.some((entry) => entry.mode === 'pending-resume')) {
      executionResumeKickDeferred = true;
      return;
    }
    executionResumeKickDeferred = false;
    pending.push(makeQueueEntry('', { mode: 'pending-resume', priority: 'next' }));
    void drain();
  }

  function flushDeferredExecutionPendingResumeKick() {
    if (!executionResumeKickDeferred || disposed || state.busy) return;
    kickExecutionPendingResume();
  }

  function scheduleExecutionPendingResumeKick() {
    // notifyFnForSession enqueues the model-visible body after onNotification
    // returns; defer the kick so askSession pre-drain sees session pending.
    queueMicrotask(() => kickExecutionPendingResume());
  }

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
      const delivery = resolveTuiRuntimeNotificationDelivery(event, text);
      if (delivery.action === 'ignore') return;
      if (delivery.action === 'status-only') {
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        return true;
      }
      if (delivery.action === 'execution-ui') {
        const firstDelivery = !notificationKey || !displayedExecutionNotificationKeys.has(notificationKey);
        if (firstDelivery) {
          if (notificationKey) displayedExecutionNotificationKeys.add(notificationKey);
          pushUserOrSyntheticItem(delivery.displayText, nextId());
        }
        if (parsed?.taskId) set(agentStatusState({ force: true }));
        if (String(delivery.modelContent || '').trim()) {
          scheduleExecutionPendingResumeKick();
        }
        return true;
      }
      if (parsed?.taskId) {
        set(agentStatusState({ force: true }));
      }
      const modelContent = String(delivery.modelContent ?? delivery.displayText ?? text).trim();
      if (!modelContent) return true;
      enqueue(modelContent, {
        mode: 'task-notification',
        priority: 'next',
        key: notificationKey || undefined,
        displayText: delivery.displayText || text,
      });
      return true;
    });
  }

  const CANCELLED_RESULT_STATUS_LINE = '[status: cancelled]';

  function normalizedResultStatusToken(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
    if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
    if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
    if (/^(cancelled|canceled|cancel)$/.test(raw)) return 'cancelled';
    return '';
  }

  function resultTextTerminalStatus(text) {
    const body = String(text || '');
    const tagged = body.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
    if (tagged) return normalizedResultStatusToken(tagged);
    const bracketed = body.match(/^\[status:\s*([^\]]*)\]/mi)?.[1]?.trim();
    if (bracketed) return normalizedResultStatusToken(bracketed);
    const inline = body.match(/^(?:status|state):\s*([^\s·,;]+)/mi)?.[1]?.trim();
    return normalizedResultStatusToken(inline);
  }

  function itemHasKnownTerminalStatus(item, texts = []) {
    const settled = (token) => token === 'completed' || token === 'failed' || token === 'cancelled';
    if (settled(normalizedResultStatusToken(item?.args?.status))) return true;
    for (const text of texts) {
      if (settled(resultTextTerminalStatus(text))) return true;
    }
    return false;
  }

  function withCancelledResultMarker(text, item) {
    const body = String(text || '');
    // Do NOT inspect item.rawResult here: aggregate rawResult is child tool
    // output (`1. grep\n<result>…`) that can incidentally contain a `status:`
    // line, which would false-positive as an already-terminal status and skip
    // the cancelled marker. Only result/text/body are engine-controlled
    // collapsed detail (empty / status word / an existing marker), so they are
    // the trustworthy terminal-status sources.
    const sources = [item?.result, item?.text, body];
    if (itemHasKnownTerminalStatus(item, sources)) return body;
    if (!body.trim()) return `${CANCELLED_RESULT_STATUS_LINE}\n`;
    return `${CANCELLED_RESULT_STATUS_LINE}\n${body}`;
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
    for (const result of group.results || []) {
      const line = String(result?.text || '').trim();
      if (line) return result.text;
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
      if (rec?.resolved !== true) continue;
      let text = String(rec?.resultText || '').replace(/\s+$/, '');
      if (!text.trim()) continue;
      const label = String(rec?.name || rec?.category || 'tool').trim() || 'tool';
      chunks.push(`${chunks.length + 1}. ${label}\n${text}`);
    }
    return chunks.join('\n\n');
  }

  function aggregateBucketForCategory(category) {
    // Merge consecutive tool calls of the SAME category into one aggregate card;
    // a different category opens a fresh card (no cross-category merge). The
    // bucket key is the category itself, so a run of Search calls collapses into
    // one Search card while an adjacent Read/Patch stays separate. Falls back to
    // 'default' when a call has no resolved category. Hook/approval denials keep
    // their dedicated ToolHookDenialCard path in App.jsx.
    const key = String(category || '').trim();
    return key ? `category:${key}` : 'default';
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
    // A result for this card arrived (possibly before its deferred push delay
    // elapsed) — surface the card now so the patch below has a live item and the
    // fast tool paints a completed card directly, no pending placeholder stage.
    // ensureVisible flushes this card AND every earlier-created still-deferred
    // card in order, so transcript order always matches call order.
    (card.aggregate?.ensureVisible || card.ensureVisible)?.();
    const rawText = toolResultText(message?.content);
    const isError = message?.isError === true || message?.toolKind === 'error' || /^\s*\[?error/i.test(rawText) || isErrorToolStatus(toolResultStatus(rawText));
    const text = isError ? toolErrorDisplay(rawText, card?.name || 'tool') : rawText;

    // Aggregate card handling — collect semantic summaries per call
    const aggregate = card.aggregate;
    if (aggregate && card.itemId === aggregate.itemId) {
      const callRec = callId ? aggregate.calls.get(callId) : null;
      if (!callRec) return false;
      if (callRec.resolved) {
        card.done = true;
        if (callId) done.add(callId);
        return false;
      }
      callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
      assignAggregateSummaryOrder(aggregate, callRec);
      callRec.isError = isError;
      callRec.resultText = text;
      callRec.resolved = true;
      const allCalls = [...aggregate.calls.values()];
      const completed = allCalls.filter((r) => r.resolved).length;
      const errors = allCalls.filter((r) => r.isError).length;
      // Collapsed detail is status-only (no per-result summary). Failures keep a
      // bare 'N Failed' status so an error stays visible while collapsed.
      const succeeded = completed - errors;
      const detailText = errors > 0
        ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
        : '';
      const currentItem = state.items.find((it) => it.id === card.itemId);
      const earlyCompleted = allCalls.filter((r) => r.resolved || r.completedEarly).length;
      const visualCompleted = Math.max(completed, earlyCompleted, Math.min(allCalls.length, Number(currentItem?.completedCount || 0)));
      const rawResult = aggregateRawResult(allCalls);
      // Collapsed aggregate detail carries no per-result summary — the card body
      // shows only a status word ('Finished') or, on failure, 'N Failed'. The
      // numbered+labelled raw (rawResult) is preserved for ctrl+o expansion.
      const displayDetail = detailText;
      patchItem(card.itemId, {
        result: displayDetail,
        text: displayDetail,
        rawResult: rawResult || null,
        isError: errors > 0,
        errorCount: errors,
        count: allCalls.length,
        completedCount: visualCompleted,
        completedAt: Number(currentItem?.completedAt) || Date.now(),
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
    const displayResult = toolGroupedDisplayFallback(resultText, text, rawText);
    const patch = {
      result: displayResult,
      text: displayResult,
      isError: group.errors > 0,
      errorCount: group.errors,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
    };
    if (group.count <= 1) {
      const body = String(text || rawText || '').trim();
      if (body) patch.rawResult = text || rawText;
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

  const flushToolResults = (messages, toolCards, cardByCallId, toolGroups, done, { finalize = false, cancelled = false } = {}) => {
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
      // Finalize must surface any still-deferred card before patching its result
      // so the completed/cancelled card is never silently dropped.
      (card.aggregate?.ensureVisible || card.ensureVisible)?.();
      // Aggregate finalize — mark any remaining calls as done
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const allCalls = [...aggregate.calls.values()];
        // Never let a call that truly never resolved be presented as a real
        // completion. Stamp it resolved so completedCount reflects an honest
        // (if degenerate) accounting instead of manufacturing success out of
        // a call that never came back. A record already marked completedEarly
        // (via __earlyNotify) already carries a real isError/resultText/summary
        // from its actual result — preserve those; only blank-fill for calls
        // truly never heard from (no completedEarly, no resolved).
        for (const rec of allCalls) {
          if (rec.resolved) continue;
          rec.resolved = true;
          if (!rec.completedEarly) {
            rec.isError = false;
            rec.resultText = rec.resultText || '';
          }
        }
        const completed = allCalls.filter((r) => r.resolved).length;
        const totalCompleted = completed;
        const errors = allCalls.filter((r) => r.isError).length;
        const succeeded = completed - errors;
        const rawResult = aggregateRawResult(allCalls);
        // Collapsed detail is status-only: no per-result summary. Failures keep a
        // bare 'N Failed' status. The numbered+labelled raw is kept for ctrl+o.
        let displayDetail = errors > 0
          ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
          : '';
        if (cancelled) {
          // Cancelled aggregates MUST keep the [status: cancelled] marker on the
          // result so terminalStatus parsing resolves to 'cancelled'. Only normal
          // completions drop the summary; cancelled ones prepend the marker.
          const currentItem = state.items.find((it) => it.id === card.itemId);
          displayDetail = withCancelledResultMarker(displayDetail, currentItem);
        }
        patchItem(card.itemId, {
          result: displayDetail,
          text: displayDetail,
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
      let resultText = groupedToolResultText(group);
      if (cancelled) {
        const currentItem = state.items.find((it) => it.id === card.itemId);
        resultText = withCancelledResultMarker(resultText, currentItem);
      }
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
    let askResult = null;
    let turnFinishedNormally = false;
    const itemsAtTurnStart = state.items.length;
    const cardByCallId = new Map();
    const toolCards = [];
    const toolGroups = new Map();
    const resultsDone = new Set();
    // Streaming providers can deliver eager onToolResult before onToolCall registers
    // cards (send() still in flight). Hold those by callId until the batch lands.
    const earlyResultBuffer = new Map();
    const aggregateCards = []; // active aggregate cards in the current consecutive tool block
    const aggregateByBucket = new Map(); // per-bucket reusable card for the current consecutive tool block; cleared on block seal

    // ── Deferred tool-card push (scroll/text sync) ────────────────────────────
    // A tool card used to enter the transcript the instant onToolCall fired,
    // reserving its estimated height (margin+header+detail) while ToolExecution
    // only painted blank placeholder rows for TOOL_PENDING_SHOW_DELAY_MS. With a
    // bottom-fixed viewport that shoved the body up BEFORE any glyph appeared, so
    // the scroll ran ahead of the text. We now hold each card off-screen for the
    // same delay and push it only when its real header/detail will paint (delay
    // elapsed) OR a result lands first (fast tool → completed card, no pending
    // flicker). Either way the pushed spec is stamped `deferredDisplayReady` so
    // ToolExecution renders the real header + 'Running' detail immediately
    // instead of the blank pre-delay placeholder — this matters for the
    // result-forced chain push (flushDeferredUpTo), where earlier-seq sibling
    // cards are pushed alongside the result-bearing one before their own delay
    // elapses and would otherwise paint an empty reserved band.
    // Mirrors components/ToolExecution.jsx TOOL_PENDING_SHOW_DELAY_MS.
    const TOOL_CARD_PUSH_DELAY_MS = 1000;
    let deferredSeqCounter = 0;
    const deferredEntries = []; // creation-order list; each is pushed at most once
    // Push this entry AND every earlier-created still-deferred entry, in order,
    // so transcript order always matches call order even when a later card's
    // result/timer fires before an earlier one's.
    const flushDeferredUpTo = (entry) => {
      if (!entry) return;
      for (const e of deferredEntries) {
        if (e.seq > entry.seq) break;
        if (e.pushed) continue;
        e.pushed = true;
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        try { e.push(); } catch {}
      }
    };
    flushDeferredBeforeImmediatePush = () => {
      if (!deferredEntries.length) return;
      const last = deferredEntries[deferredEntries.length - 1];
      if (last) flushDeferredUpTo(last);
    };
    const registerDeferredCard = (card) => {
      const entry = {
        seq: deferredSeqCounter++,
        pushed: false,
        timer: null,
        push: () => {
          card.pushed = true;
          if (!card.spec) return;
          card.spec.deferredDisplayReady = true;
          pushingFromDeferredEntry = true;
          try { pushItem(card.spec); } finally { pushingFromDeferredEntry = false; }
        },
      };
      card.deferred = entry;
      card.ensureVisible = () => flushDeferredUpTo(entry);
      deferredEntries.push(entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (disposed) return;
        flushDeferredUpTo(entry);
      }, TOOL_CARD_PUSH_DELAY_MS);
      entry.timer.unref?.();
    };
    const registerDeferredAggregate = (aggregate) => {
      const entry = {
        seq: deferredSeqCounter++,
        pushed: false,
        timer: null,
        push: () => {
          aggregate.pushed = true;
          if (!aggregate.pendingSpec) return;
          aggregate.pendingSpec.deferredDisplayReady = true;
          pushingFromDeferredEntry = true;
          try { pushItem(aggregate.pendingSpec); } finally { pushingFromDeferredEntry = false; }
        },
      };
      aggregate.deferred = entry;
      aggregate.ensureVisible = () => flushDeferredUpTo(entry);
      deferredEntries.push(entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (disposed) return;
        flushDeferredUpTo(entry);
      }, TOOL_CARD_PUSH_DELAY_MS);
      entry.timer.unref?.();
    };
    const clearDeferredTimers = () => {
      for (const e of deferredEntries) {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      }
    };

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
        // Seal not-yet-pushed specs too, so a card that pushes later (timer)
        // enters already-finalized instead of flashing the active header form.
        if (card && card.pushed === false && card.spec) card.spec.headerFinalized = true;
      }
      for (const aggregate of aggregateCards || []) {
        if (aggregate?.itemId) ids.add(aggregate.itemId);
        if (aggregate && aggregate.pushed === false && aggregate.pendingSpec) aggregate.pendingSpec.headerFinalized = true;
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
        aggregate.ensureVisible?.();
        const errors = allCalls.filter((r) => r.isError).length;
        const completed = allCalls.filter((r) => r.resolved).length;
        const succeeded = completed - errors;
        const rawResult = aggregateRawResult(allCalls);
        // Status-only collapsed detail (see patchToolCardResult): no per-result
        // summary; failures keep 'N Failed'. Raw preserved for ctrl+o expansion.
        const displayDetail = errors > 0
          ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
          : '';
        patchItem(aggregate.itemId, {
          result: displayDetail,
          text: displayDetail,
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
      // Seal the block: same-bucket calls after this point must open a fresh
      // card, never continue one from before the seal (assistant text/turn
      // end boundary). Cross-block behavior is unchanged by the in-block
      // reuse relaxation below.
      aggregateByBucket.clear();
    };

    const rememberActiveAggregate = (aggregate) => {
      if (!aggregate) return;
      if (!aggregateCards.includes(aggregate)) aggregateCards.push(aggregate);
      aggregateByBucket.set(aggregate.bucket, aggregate);
    };

    const ensureAggregateCard = (bucket) => {
      // Reuse any same-bucket aggregate created earlier in the SAME consecutive
      // tool block, even when a different-category card was interleaved after
      // it (Read, Search, Read → the two Reads merge into one card; the Search
      // stays separate). The block is only sealed — forcing a fresh card per
      // bucket — by clearAggregateContinuation (assistant text lands or the
      // turn ends), which clears aggregateByBucket. Reusing a pushed, non-tail
      // card is safe: the aggregate card body is a fixed header+1-detail-row
      // height, so patching its count/completedCount later never reflows the
      // cards that were pushed after it.
      const cached = aggregateByBucket.get(bucket);
      if (cached) {
        rememberActiveAggregate(cached);
        return cached;
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
      // Arm the deferred push once at creation; syncAggregateHeader only keeps
      // pendingSpec current until the timer/result flushes it in call order.
      registerDeferredAggregate(aggregate);
      rememberActiveAggregate(aggregate);
      return aggregate;
    };

    const syncAggregateHeader = (aggregate) => {
      if (!aggregate?.itemId) return;
      const patch = {
        args: { categoryOrder: aggregate.categoryOrder.slice() },
        count: aggregate.calls.size,
        completedCount: [...aggregate.calls.values()].filter((r) => r.resolved || r.completedEarly).length,
        categories: Object.fromEntries(aggregate.categories),
      };
      if (aggregate.pushed) {
        patchItem(aggregate.itemId, patch);
        return;
      }
      // Not yet visible: keep the latest header spec current. The deferred entry
      // (armed at creation) pushes pendingSpec when its timer fires or a result
      // forces it visible, preserving call order via flushDeferredUpTo.
      aggregate.pendingSpec = {
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
      };
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
    let compactingActive = false;

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
        // there is a completed line with VISIBLE content to show. Until the
        // first '\n' the only pending state is the spinner; the row appears
        // together with its first visible line, so no empty "●-only" row
        // flashes/scrolls ahead of text. `.trim()` also guards the
        // whitespace-only case: a response that opens with leading newlines
        // ("\n\n# …") completes a blank line first, whose estimated height
        // still reserves rows and scrolls the transcript, but Markdown trims
        // the body to nothing — so the scroll advances onto an empty band for
        // a few seconds until a non-blank line lands. Don't create the row
        // until there is real content to paint.
        if (currentAssistantId || streamingVisibleText.trim()) {
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
          patch.spinner = { ...state.spinner, responseLength: responseLengthVal, thinking: false, thinkingLastEndedAt: _pendingThinkingLastEndedAt || state.spinner.thinkingLastEndedAt, mode: compactingActive ? 'compacting' : 'responding' };
        }
        if (Object.keys(patch).length > 0) set(patch);
        _pendingThinkingLastEndedAt = 0;
      }
      if (_pendingThinkFlush) {
        _pendingThinkFlush = false;
        const responseLengthVal = assistantText.length + thinkingText.length;
        const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
        const patch = { thinking: compactingActive ? null : thinkingText };
        if (state.spinner) {
          patch.spinner = compactingActive
            ? { ...state.spinner, responseLength: responseLengthVal, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: state.spinner.thinkingLastEndedAt || 0, mode: 'compacting' }
            : { ...state.spinner, responseLength: responseLengthVal, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' };
        }
        set(patch);
      }
    };

    const scheduleStreamFlush = () => {
      if (_batchTimer !== null) return; // already scheduled; do not re-arm
      _batchTimer = setTimeout(flushStreamBatch, STREAM_BATCH_INTERVAL_MS);
      if (_batchTimer?.unref) _batchTimer.unref(); // don't prevent process exit
    };

    // __earlyNotify: show 1-line summary + completedCount immediately; defer
    // rawResult/expand and resultsDone to the history flush.
    const markToolCardCompletedState = (callId, message) => {
      const card = cardByCallId.get(callId);
      if (!card) return;
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const callRec = aggregate.calls.get(callId);
        if (!callRec || callRec.resolved || callRec.completedEarly) return;
        aggregate.ensureVisible?.();
        const rawText = toolResultText(message?.content);
        const isError = message?.isError === true || message?.toolKind === 'error' || /^\s*\[?error/i.test(rawText) || isErrorToolStatus(toolResultStatus(rawText));
        const text = isError ? toolErrorDisplay(rawText, callRec.name || 'tool') : rawText;
        callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
        assignAggregateSummaryOrder(aggregate, callRec);
        callRec.isError = isError;
        callRec.resultText = text;
        callRec.completedEarly = true;
        const allCalls = [...aggregate.calls.values()];
        const completedCount = allCalls.filter((r) => r.resolved || r.completedEarly).length;
        const errors = allCalls.filter((r) => r.isError).length;
        const succeeded = completedCount - errors;
        const rawResult = aggregateRawResult(allCalls);
        // Status-only collapsed detail (no per-result summary); failures keep
        // 'N Failed'. Raw preserved for ctrl+o expansion.
        const displayDetail = errors > 0
          ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
          : '';
        const currentItem = state.items.find((it) => it.id === card.itemId);
        const visualCompleted = Math.max(
          completedCount,
          Math.min(allCalls.length, Number(currentItem?.completedCount || 0)),
        );
        const patch = {
          result: displayDetail,
          text: displayDetail,
          isError: errors > 0,
          errorCount: errors,
          count: allCalls.length,
          completedCount: visualCompleted,
        };
        if (visualCompleted >= allCalls.length) {
          patch.completedAt = Number(currentItem?.completedAt) || Date.now();
        }
        patchItem(card.itemId, patch);
        return;
      }
      // Non-aggregate eager tools are rare; flipping completedCount without
      // result changes pending/detail rendering and risks row jitter — wait for
      // the real history flush (unchanged behavior).
    };

    const deliverToolResultMessage = (message) => {
      if (message?.__earlyNotify === true) {
        const earlyCallId = toolResultCallId(message);
        if (earlyCallId) markToolCardCompletedState(earlyCallId, message);
        return;
      }
      flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
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
            // Any non-tool transcript item is a block boundary: seal the
            // aggregate continuation (not just finalize headers) so a later
            // same-category tool call opens a fresh card instead of reusing
            // one whose count would then change ABOVE this steered user item.
            clearAggregateContinuation();
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
          const committedAssistantSegment = commitAssistantSegment({ sealToolBlock: true });
          if (committedAssistantSegment) {
            // Let the pre-tool assistant preamble paint as its own frame before
            // the tool card reserves/pushes rows. When both enter the transcript
            // in the same render, the bottom-pinned viewport can appear to jump
            // upward by the combined height ("preamble + tool card" at once).
            await yieldToRenderer();
          }

          const touchedAggregates = new Set();
          for (let i = 0; i < batchCalls.length; i++) {
            const c = batchCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            // Category drives the aggregate bucket so only same-category calls
            // merge into one card; classify first, then bucket by it.
            const category = classifyToolCategory(name, args);
            const bucket = aggregateBucketForCategory(category);
            const callId = toolCallId(c);
            const callKey = callId || `__tool_${toolCards.length}_${i}`;

            if (!bucket) {
              const itemId = nextId();
              // Defer the visible push: hold the spec and only enter the
              // transcript when the real header/detail will paint (delay
              // elapsed) or its result lands first. Avoids reserving blank
              // placeholder height that scrolls the body ahead of the glyphs.
              const card = {
                itemId,
                callId: callKey,
                done: false,
                pushed: false,
                spec: {
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
                },
              };
              registerDeferredCard(card);
              if (callId) {
                cardByCallId.set(callId, card);
              }
              toolCards.push(card);
              continue;
            }

            const categoryEntry = aggregateToolCategoryEntry(name, args, category);
            const aggregateCard = ensureAggregateCard(bucket);
            if (!aggregateCard.categories.has(categoryEntry.key)) aggregateCard.categoryOrder.push(categoryEntry.key);
            const prevCategory = aggregateCard.categories.get(categoryEntry.key);
            aggregateCard.categories.set(categoryEntry.key, {
              ...categoryEntry,
              count: Number(prevCategory?.count || 0) + Number(categoryEntry.count || 1),
            });
            aggregateCard.calls.set(callKey, { name, args, category, summary: null, summarySeq: null, isError: false, resultText: null, resolved: false, completedEarly: false });
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
          if (committedAssistantSegment) {
            // A pre-tool assistant preamble has already had one render frame to
            // settle. Do not let the first grouped tool card sit off-screen until
            // the normal 1s deferred timer: when it later inserts its real 3 rows,
            // the already-wrapped preamble visibly jumps. Surface the first card
            // now via the existing deferredDisplayReady path, so the post-
            // preamble frame contains the intended Running tool card immediately
            // (no blank placeholder, no delayed row insertion).
            const firstTouchedAggregate = [...touchedAggregates][0] || null;
            firstTouchedAggregate?.ensureVisible?.();
          }
          for (const [bufferedCallId, bufferedMessage] of earlyResultBuffer) {
            if (!cardByCallId.has(bufferedCallId)) continue;
            deliverToolResultMessage(bufferedMessage);
            earlyResultBuffer.delete(bufferedCallId);
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          const callId = toolResultCallId(message);
          if (callId && !cardByCallId.has(callId) && !resultsDone.has(callId)) {
            earlyResultBuffer.set(callId, message);
            return;
          }
          deliverToolResultMessage(message);
        },
        onToolApproval: async (request) => {
          markPromptCommitted();
          flushStreamBatch();
          if (state.spinner) set({ spinner: { ...state.spinner, mode: 'tool-approval' } });
          return await requestToolApproval(request);
        },
        onCompactEvent: (event) => {
          flushStreamBatch();
          // Non-tool transcript item — same block-boundary rule as the
          // steered user item above: seal any live aggregate first so a
          // later same-category tool call doesn't reuse a card whose count
          // would then change above this statusdone item.
          clearAggregateContinuation();
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
          if (value === 'compacting') {
            compactingActive = true;
            const thinkingLastEndedAt = closeThinkingSegment();
            _pendingThinkFlush = false;
            set({
              thinking: null,
              spinner: {
                ...state.spinner,
                thinking: false,
                thinkingSegmentStartedAt: 0,
                thinkingAccumulatedMs: accumulatedThinkingMs,
                thinkingLastEndedAt: thinkingLastEndedAt || state.spinner.thinkingLastEndedAt || 0,
                mode: 'compacting',
              },
            });
            return;
          }
          if (value === 'requesting' || value === 'streaming') compactingActive = false;
          const mode = value === 'requesting'
            ? 'requesting'
            : value === 'streaming'
              ? (state.spinner.thinking ? 'thinking' : 'responding')
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
          syncContextStats({ allowEstimated: true });
          const currentTurnInput = Math.max(0, state.stats.inputTokens - inputBaseline);
          const currentTurnOutput = Math.max(0, state.stats.outputTokens - outputBaseline);
          if (state.spinner) {
            set({ stats: { ...state.stats }, spinner: { ...state.spinner, inputTokens: currentTurnInput, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...state.stats } });
          }
        },
      });
      askResult = result;
      markPromptCommitted();

      flushToolResults(session?.messages || [], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
      finalizeToolHeaders();
      flushStreamBatch(); // force-flush any batched streaming text before finalization writes
      syncContextStats({ allowEstimated: true });

      const finalText = result?.content != null ? String(result.content) : '';
      if (finalText.trim()) {
        // The persisted transcript is written from the provider's final content,
        // while the live TUI row is fed by streaming deltas. If a provider/parser
        // misses or suppresses an early delta, keeping the streamed buffer here
        // leaves the final on-screen assistant row missing leading characters even
        // though the transcript is correct. Always reconcile the active segment to
        // the final provider text when it is available.
        const id = currentAssistantId || ensureAssistant(finalText);
        currentAssistantText = finalText;
        patchItem(id, { text: finalText, streaming: false });
      } else if (currentAssistantId && (currentAssistantText.trim() || assistantText.trim())) {
        const streamedText = currentAssistantText || assistantText;
        patchItem(currentAssistantId, { text: streamedText, streaming: false });
      }
      turnFinishedNormally = true;
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
        flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true, cancelled: true });
        finalizeToolHeaders();
      } else {
        finalizeToolHeaders();
        pushNotice(toolErrorDisplay(error, 'turn'), 'error');
      }
    } finally {
      denyAllToolApprovals(cancelled ? 'turn cancelled' : 'turn finished');
      // Flush any still-deferred tool cards into the transcript and cancel their
      // pending push timers so nothing fires (or leaks) after the turn ends. The
      // finalize path above already patches results onto visible cards; this just
      // guarantees every registered card is materialized before the turn closes.
      if (deferredEntries.length) {
        const last = deferredEntries[deferredEntries.length - 1];
        if (last) flushDeferredUpTo(last);
        clearDeferredTimers();
      }
      flushDeferredBeforeImmediatePush = null;
      const producedTranscriptItem = state.items.length > itemsAtTurnStart;
      const reclaimed = cancelled && activePromptRestore?.reclaimed === true;
      activePromptRestore = null;
      closeThinkingSegment();
      const elapsedMs = Date.now() - startedAt;
      const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
      const finalOutputTokens = Math.max(0, Number(state.spinner?.outputTokens || 0), Math.round(Number(state.spinner?.responseLength || 0) / 4));
      const turnStatus = cancelled ? 'cancelled' : 'done';
      const resultContent = askResult?.content != null ? String(askResult.content).trim() : '';
      const assistantOutput = (currentAssistantText || assistantText || '').trim();
      // Suppress only true pending-resume no-ops: no transcript items added and no model output; cancelled/error turns and any visible turn stay marked.
      const isNoOpTurn = turnFinishedNormally
        && !cancelled
        && toolCards.length === 0
        && !resultContent
        && !assistantOutput
        && !producedTranscriptItem;
      if (!isNoOpTurn) {
        state.stats.turns = (state.stats.turns || 0) + 1;
      }
      // Pin the post-think summary into the transcript right after this turn's
      // output so it scrolls up with the answer and stays in the scrollback,
      // in scrollback. (Previously TurnDone rendered only in the
      // bottom-fixed live-status slot and vanished on the next turn.)
      if (!reclaimed && !isNoOpTurn) {
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
      flushDeferredExecutionPendingResumeKick();
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
      skipSlashCommands: options.skipSlashCommands === true,
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

  function dequeueQueueBatch(maxPriority = 'later', options = {}) {
    if (pending.length === 0) return [];
    const max = queuePriorityValue(maxPriority);
    const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    const limit = Math.max(1, Number(options.limit) || Infinity);
    let bestPriority = Infinity;
    let targetMode = null;
    for (const entry of pending) {
      if (!predicate(entry)) continue;
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
      if (predicate(entry) && (entry.mode || 'prompt') === targetMode && queuePriorityValue(entry.priority) === bestPriority) {
        batch.push(entry);
        pending.splice(i, 1);
        if (batch.length >= limit) break;
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(batch);
    return batch;
  }

  async function drain() {
    if (draining) return;
    if (autoClearRunning) return;
    draining = true;
    let firstBatch = true;
    try {
      while (pending.length > 0) {
        // Drain one priority/mode bucket at a time (unified command queue):
        // unified command queue semantics: prompt steering stays editable and
        // task notifications stay non-editable but model-visible.
        const batch = dequeueQueueBatch('later', { limit: firstBatch ? 1 : Infinity });
        firstBatch = false;
        if (batch.length === 0) break;
        const ids = new Set(batch.map((e) => e.id));
        const merged = mergePromptContents(batch);
        for (const entry of batch) {
          if (entry.mode === 'pending-resume') continue;
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
      else flushDeferredExecutionPendingResumeKick();
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
    // Mid-turn steering drain:
    // Injects queued user prompts (steering) plus non-editable internal entries
    // into the CURRENT provider pre-send window so the user can redirect a turn
    // that is already running. Slash commands are still excluded: they must run
    // through the normal command processor after the turn, not be sent as plain
    // text. Consumed entries are spliced out of `pending` here, so the post-turn
    // drain() loop will not re-execute them.
    const batch = dequeueQueueBatch('next', { predicate: (entry) => !isSlashQueuedEntry(entry) });
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
      // Give Ink one event-loop turn to paint the auto-clear status before the
      // clear/compact path starts doing synchronous session/transcript work.
      // Without this, long idle clears can look like a frozen prompt followed by
      // an already-complete status row.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const compaction = runtime.getCompactionSettings();
      const compactType = compaction.compactType || compaction.type;
      await runtime.clear({ compactType, requireCompactSuccess: !!compactType });
      resetStats();
      clearUiActivityBeforeContextSync();
      syncContextStats({ allowEstimated: true });
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
      pushItem({
        kind: 'statusdone',
        id: nextId(),
        label: 'Auto-clear complete',
        detail: formatElapsedSeconds(Date.now() - startedAt),
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
      void drain();
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
  const clearUiActivityBeforeContextSync = () => {
    state.items = replaceItems([]);
    state.toasts = [];
    state.queued = [];
    state.thinking = null;
    state.spinner = null;
    state.lastTurn = null;
    state.busy = false;
  };
  const resetTuiForPendingSessionReset = () => {
    pendingSessionReset = true;
    clearUiActivityBeforeContextSync();
    resetStats();
    state.stats.currentContextTokens = 0;
    state.stats.currentEstimatedContextTokens = 0;
    state.stats.currentContextSource = null;
    state.stats.currentContextUpdatedAt = Date.now();
    state.displayContextWindow = 0;
    state.compactBoundaryTokens = 0;
    state.autoCompactTokenLimit = 0;
  };
  const snapshotTuiBeforeSessionReset = () => ({
    items: state.items.slice(),
    toasts: state.toasts.slice(),
    queued: state.queued.slice(),
    thinking: state.thinking,
    spinner: state.spinner,
    lastTurn: state.lastTurn,
    busy: state.busy,
    stats: { ...state.stats },
    sessionId: state.sessionId,
  });
  const restoreTuiAfterFailedSessionReset = (snapshot) => {
    if (!snapshot) return;
    pendingSessionReset = false;
    state.items = replaceItems(snapshot.items);
    state.toasts = snapshot.toasts.slice();
    state.queued = snapshot.queued.slice();
    state.thinking = snapshot.thinking;
    state.spinner = snapshot.spinner;
    state.lastTurn = snapshot.lastTurn;
    state.busy = snapshot.busy;
    state.stats = { ...snapshot.stats };
    syncContextStats({ allowEstimated: true });
    set({
      items: state.items,
      toasts: state.toasts,
      queued: state.queued,
      thinking: state.thinking,
      spinner: state.spinner,
      lastTurn: state.lastTurn,
      busy: state.busy,
      ...routeState(),
      stats: { ...state.stats },
      ...agentStatusState(),
    });
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
     // Prompt input queued while a turn is active keeps the
     // default `next` priority, so it is injected at the next tool/model
     // boundary. Explicit options.priority still wins.
     const priority = options.priority;
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
      if (autoClearRunning) {
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
        // Model changes apply to the NEXT session only (default setRoute
        // behavior) — never rewrite the live session's provider/model, which
        // would force a full prompt-cache rewrite mid-conversation.
        await runtime.setRoute({ model: m });
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
    getUpdateSettings: () => runtime.getUpdateSettings?.() || null,
    setAutoUpdate: (enabled) => runtime.setAutoUpdate?.(enabled),
    checkForUpdate: (input = {}) => runtime.checkForUpdate?.(input),
    runUpdateNow: () => runtime.runUpdateNow?.(),
    getUpdateStatus: () => runtime.getUpdateStatus?.() || { phase: 'idle' },
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
    setCwd: (path, options = {}) => {
      const next = runtime.setCwd(path);
      set({ cwd: next });
      if (options?.notice !== false) {
        pushNotice(options?.message || `Project set: ${projectNameFromPath(next)}`, 'info');
      }
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
      if (state.busy) {
        pushNotice('Compact skipped: turn in progress', 'info');
        return { changed: false, reason: 'compact skipped: turn in progress' };
      }
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
      denyAllToolApprovals('interrupted by user');
      const restoreState = activePromptRestore;
      // A queued steering prompt means the user already redirected the turn:
      // interrupting should just cancel the running turn and let the steering
      // prompt run next, NOT resurrect the in-flight prompt back into the draft.
      const hasPendingSteering = pending.some((entry) => isQueuedEntryEditable(entry));
      const canRestore = restoreState?.restorable && !hasPendingSteering;
      const restoreText = canRestore ? restoreState.text : '';
      const restorePastedImages = canRestore && restoreState?.pastedImages ? restoreState.pastedImages : null;
      // When steering suppresses the restore, the interrupted prompt's pasted
      // images never get committed (onCommitted won't fire) nor re-installed into
      // the draft, so hand them back for cleanup to avoid a stale `[Image #id]`
      // lingering in the paste snapshot.
      const discardPastedImages = restoreState?.restorable && hasPendingSteering && restoreState?.pastedImages
        ? restoreState.pastedImages
        : null;
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
      return { aborted, restoreText, pastedImages: restorePastedImages, discardPastedImages };
    },
    resolveToolApproval: (id, decision = {}) => {
      const approved = decision === true || decision?.approved === true;
      return finishToolApproval(id, approved, decision?.reason || (approved ? 'approved by user' : 'denied by user'));
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
      const beforeRouteState = routeState();
      const optimisticSearchRoute = opts?.provider && opts?.model
        ? {
            provider: String(opts.provider).trim(),
            model: String(opts.model).trim(),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.fast === true ? { fast: true } : {}),
            ...(opts.toolType ? { toolType: opts.toolType } : {}),
          }
        : null;
      set({ commandBusy: true });
      try {
        if (optimisticSearchRoute?.provider && optimisticSearchRoute.model) {
          set({ searchRoute: optimisticSearchRoute });
        }
        const result = await runtime.setSearchRoute?.(opts);
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } catch (e) {
        set({ searchRoute: beforeRouteState.searchRoute || null });
        throw e;
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
        const result = await runtime.setWorkflow?.(workflowId);
        set({ ...routeState(), stats: { ...state.stats } });
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    // Toggle Discord remote mode for this session. Flips the runtime's
    // remoteEnabled flag (booting/stopping the channel worker) and returns the
    // NEW enabled state so the caller can render an ON/OFF notice.
    toggleRemote: () => {
      const enabled = runtime.isRemoteEnabled?.() === true;
      if (enabled) runtime.stopRemote?.();
      else runtime.startRemote?.();
      const next = runtime.isRemoteEnabled?.() === true;
      set({ remoteEnabled: next });
      return next;
    },
    isRemoteEnabled: () => runtime.isRemoteEnabled?.() === true,
    // Theme is a TUI-local concern (no runtime round-trip). listThemes returns
    // picker metadata; getTheme reports the active id; setTheme applies the
    // palette in-place + persists ui.theme and bumps a themeEpoch so the React
    // tree re-renders (markdown/status/spinner colorizers re-resolve).
    listThemes: () => listThemes(),
    getTheme: () => getThemeSetting(),
    setTheme: (id, options = {}) => {
      const applied = setThemeSetting(id, options);
      set({ themeEpoch: (state.themeEpoch || 0) + 1 });
      return applied;
    },
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    setDefaultProvider: async (provider) => {
      return await runtime.setDefaultProvider?.(provider);
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
    skipOnboarding: () => {
      // Completed-marking only; no route/agent/provider writes.
      return runtime.skipOnboarding?.() || null;
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
    getChannelWorkerStatus: () => runtime.getChannelWorkerStatus?.(),
    setBackend: (name) => runtime.setBackend?.(name),
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
    saveTelegramToken: (token) => {
      const result = runtime.saveTelegramToken?.(token);
      pushNotice('telegram token saved', 'info');
      return result;
    },
    forgetTelegramToken: () => {
      const result = runtime.forgetTelegramToken?.();
      pushNotice('telegram token forgotten', 'info');
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
        const routeOpts = opts && typeof opts === 'object' ? opts : {};
        // Default: apply to the NEXT session only. Only an explicit
        // `applyToCurrentSession: true` rewrites the live session in place.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const { applyToCurrentSession: _drop, ...nextRoute } = routeOpts;
        await runtime.setRoute(nextRoute, { applyToCurrentSession });
        if (applyToCurrentSession) syncContextStats({ allowEstimated: true });
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
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: state.items,
        toasts: state.toasts,
        queued: state.queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...state.stats },
      });
      try {
        await runtime.clear({ recoverAgent: true });
        clearUiActivityBeforeContextSync();
        pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        lastUserActivityAt = Date.now();
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        pendingSessionReset = false;
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
      resetAllStreamingMarkdownStablePrefixes();
      const rollbackSnapshot = snapshotTuiBeforeSessionReset();
      resetTuiForPendingSessionReset();
      set({
        items: state.items,
        toasts: state.toasts,
        queued: state.queued,
        thinking: null,
        spinner: null,
        lastTurn: null,
        sessionId: null,
        stats: { ...state.stats },
      });
      try {
        await runtime.newSession();
        clearUiActivityBeforeContextSync();
        pendingSessionReset = false;
        resetStatsAndSyncContext();
        set({ items: replaceItems([]), toasts: [], queued: [], thinking: null, spinner: null, lastTurn: null, ...routeState(), stats: { ...state.stats } });
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        pendingSessionReset = false;
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
                  rawResult: synthetic.rawResult ?? text,
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
      denyAllToolApprovals('runtime closing');
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
