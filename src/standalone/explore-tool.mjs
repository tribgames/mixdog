import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  cancelBackgroundTask,
  getBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskList,
  resolveExecutionMode,
  startBackgroundTask,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { makeBridgeLlm } from '../runtime/agent/orchestrator/smart-bridge/bridge-llm.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';

// Ported from the original mixdog tool-defs.mjs `explore` entry.
// `aiWrapped` is dropped: in the standalone build there is no aiWrapped
// dispatch hub — execution is wired directly in the runtime executor below
// via makeBridgeLlm. The standalone surface is synchronous: it returns a
// bounded locator result in this tool call.
export const EXPLORE_TOOL = {
  name: 'explore',
  title: 'Explore',
  annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: `분석용이 아니라 특정 파일, 함수, 심볼, 라인 등 관련 위치를 파악하기 위한 짧은 위치 탐색기로 사용하세요. First-choice tool for broad or unclear repo/code location questions. Use explore when you need to find where a feature, behavior, file group, or implementation area lives before reading exact files. Always use mode:"async"; never use mode:"sync". If the result is needed before continuing, pause the dependent path and wait for the async completion notification. Do not poll status/read; those controls are for manual recovery only. ${TOOL_ASYNC_EXECUTION_CONTRACT} Use code_graph/grep/glob instead only when you already have a specific symbol, term, file kind, or config key. One short location question.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'One short location question, or an array only for unrelated topics. Do not use for a known symbol/term/config key; use code_graph/grep first. Never pass a whole brief/context dump.' },
      cwd: { type: 'string', description: 'Project/root directory to explore; narrow to the relevant repo or subtree.' },
      mode: { type: 'string', enum: ['async'], description: `Always use mode:"async". ${TOOL_ASYNC_EXECUTION_CONTRACT}` },
      action: { type: 'string', enum: ['run', 'list', 'status', 'read', 'cancel'], description: 'Default run. list/status/read/cancel are manual recovery controls for async explore tasks.' },
      task_id: { type: 'string', description: 'Shared background task id for manual status/read/cancel recovery.' },
      background: { type: 'boolean', description: 'Legacy alias for mode=async.' },
    },
    required: [],
    additionalProperties: false,
  },
};

// Total merged-output character cap. The original source uses a very large cap
// (50MB) plus a smart-read summariser downstream; the standalone path returns
// the merged text in-turn, so we keep a sane bound to protect the Lead context.
export const EXPLORE_OUTPUT_CHAR_CAP = 24_000;
const EXPLORE_TRUNCATION_MARKER = '\n\n[explore: output truncated; narrow cwd or split queries to see more]';
// Bound fan-out so a hostile/poisoned query array cannot spawn unbounded subs.
export const MAX_FANOUT_QUERIES = 8;

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mirrors buildExplorerPrompt from the original ai-wrapped-dispatch: each
// explorer receives ONLY its own query, with a trailing descriptive-only
// reminder. The full no-verdict contract lives at system level
// (rules/bridge/30-explorer.md).
export function buildExplorerPrompt(query) {
  return `<query>${escapeXml(query)}</query>\nReminder: output only anchor lines formatted as path:line — symbol/name — short reason, or EXPLORATION_FAILED. No preamble, bullets, numbering, headings, summary, code quotes, analysis, or verdicts.`;
}

export function normalizeExploreQueries(rawQuery) {
  let raw = rawQuery;
  // Some clients JSON-stringify arrays when the schema field is loosely typed.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) raw = parsed;
      } catch { /* not a JSON array — keep as plain string */ }
    }
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter(Boolean);
}

function resolveExploreCwd(input, callerCwd) {
  const base = (typeof callerCwd === 'string' && callerCwd) ? callerCwd : process.cwd();
  if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim();
    const expanded = trimmed.startsWith('~') ? trimmed.replace(/^~/, homedir()) : trimmed;
    return isAbsolute(expanded) ? expanded : resolve(base, expanded);
  }
  return base;
}

function settledExplorerResult(result) {
  if (result?.status !== 'fulfilled') {
    return { ok: false, text: `[explorer error] ${result?.reason?.message || String(result?.reason)}` };
  }
  const text = cleanExplorerText(typeof result.value === 'string' ? result.value : responseText(result.value));
  if (!text) return { ok: false, text: '[explorer error] empty response' };
  return { ok: true, text };
}

function isFatalExploreError(error) {
  if (!error) return false;
  const status = Number(error.httpStatus || error.status || error.response?.status || 0) || 0;
  if (status === 401 || status === 403 || status === 429) return true;
  if (error.providerQuota === true || error.quotaExceeded === true) return true;
  const code = String(error.code || '').toUpperCase();
  if (code === 'PROVIDER_QUOTA' || code === 'EACCES' || code === 'EAUTH') return true;
  const name = String(error.name || '');
  if (/ProviderQuotaError|Auth|Authentication|Permission/i.test(name)) return true;
  const text = String(error.message || error.reason || error || '');
  return /\b(?:quota|rate ?limit|unauthorized|authentication|forbidden|permission denied|invalid api key|token expired)\b/i.test(text);
}

function fatalExploreError(settled) {
  return (settled || []).find((r) => r?.status === 'rejected' && isFatalExploreError(r.reason))?.reason || null;
}

function mergeSettled(settled, queries) {
  const single = queries.length === 1;
  if (single) {
    const { text: body } = settledExplorerResult(settled[0]);
    return body.length > EXPLORE_OUTPUT_CHAR_CAP
      ? body.slice(0, EXPLORE_OUTPUT_CHAR_CAP) + EXPLORE_TRUNCATION_MARKER
      : body;
  }
  const parts = [];
  let total = 0;
  const sep = '\n\n';
  let truncated = false;
  for (let i = 0; i < settled.length; i++) {
    const header = `Q${i + 1}: ${String(queries[i] ?? '').replace(/\s+/g, ' ').slice(0, 60)}`;
    const { text: body } = settledExplorerResult(settled[i]);
    const piece = `${header}\n${body}`;
    const addLen = (parts.length === 0 ? 0 : sep.length) + piece.length;
    if (total + addLen > EXPLORE_OUTPUT_CHAR_CAP) {
      const remaining = EXPLORE_OUTPUT_CHAR_CAP - total - (parts.length === 0 ? 0 : sep.length);
      if (remaining > 0) parts.push(piece.slice(0, remaining));
      truncated = true;
      break;
    }
    parts.push(piece);
    total += addLen;
  }
  const merged = parts.join(sep);
  return truncated ? merged + EXPLORE_TRUNCATION_MARKER : merged;
}

function ok(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function fail(msg) {
  return { content: [{ type: 'text', text: `[explore error] ${msg}` }], isError: true };
}

function clean(value) {
  return String(value ?? '').trim();
}

function responseText(response) {
  if (typeof response === 'string') return response;
  const parts = Array.isArray(response?.content) ? response.content : [];
  const text = parts
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text || JSON.stringify(response, null, 2);
}

const ANCHOR_LINE_RE = /(?:^|\s)(?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+):\d+\b/;
const FAILED_RE = /\b(?:EXPLORATION_FAILED|exploration failed|no credible (?:anchor|location)|no relevant (?:anchor|location)|not found|could(?: not|n't) find)\b/i;

function normalizeExplorerLine(line) {
  return String(line || '')
    .trim()
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function cleanExplorerText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const anchors = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = normalizeExplorerLine(sourceLine);
    if (!line || /^-{3,}$/.test(line) || /^#+\s+/.test(line)) continue;
    if (/^EXPLORATION_FAILED\b/i.test(line)) return 'EXPLORATION_FAILED';
    if (ANCHOR_LINE_RE.test(line)) anchors.push(line);
  }
  if (anchors.length) return anchors.join('\n');
  if (FAILED_RE.test(raw)) return 'EXPLORATION_FAILED';
  return raw;
}

function controlExploreTask(action, args, ctx = {}) {
  if (action === 'list') return ok(renderBackgroundTaskList({ surface: 'explore', context: ctx }));
  const taskId = taskIdFromArgs(args);
  if (!taskId) return fail('task_id is required');
  const task = getBackgroundTask(taskId, { surface: 'explore', context: ctx });
  if (!task) return fail(`task not found: ${taskId}`);
  if (action === 'cancel') {
    cancelBackgroundTask(taskId, 'cancelled by explore control');
    return ok(renderBackgroundTask(task, { includeResult: true }));
  }
  return ok(renderBackgroundTask(task, { includeResult: action === 'read' }));
}

/**
 * Standalone explore executor.
 *
 * Dispatches the hidden `explorer` read-only filesystem role (one ephemeral
 * sub-session per query) via makeBridgeLlm — the same path recall/search-style
 * hidden roles use. Runs query items concurrently (Promise.allSettled), then
 * aggregates the findings into one bounded text result.
 *
 * Runs asynchronously by default: registers a shared background task and
 * delivers completion to the owner session.
 *
 * @param {object} args         — tool args ({ query, cwd, background }).
 * @param {object} ctx          — { callerCwd, callerSessionId }.
 */
export async function runExplore(args = {}, ctx = {}) {
  const action = clean(args.action || 'run').toLowerCase();
  if (['list', 'status', 'read', 'cancel'].includes(action)) return controlExploreTask(action, args, ctx);

  const mode = resolveExecutionMode(args, 'async');
  if (mode === 'async') {
    const queries = normalizeExploreQueries(args.query);
    if (queries.length === 0) return fail('query is required (one or more non-empty strings)');
    const task = startBackgroundTask({
      surface: 'explore',
      operation: 'explore',
      label: queries[0].replace(/\s+/g, ' ').slice(0, 120),
      input: { query: args.query, cwd: args.cwd || null },
      context: ctx,
      resultType: 'explore_task_result',
      renderResult: responseText,
      run: async () => {
        const response = await runExploreSync(args, ctx);
        if (response?.isError) throw new Error(responseText(response));
        return response;
      },
    });
    return ok(renderBackgroundTask(task));
  }
  return runExploreSync(args, ctx);
}

async function runExploreSync(args = {}, ctx = {}) {
  const queries = normalizeExploreQueries(args.query);
  if (queries.length === 0) return fail('query is required (one or more non-empty strings)');

  let working = queries;
  let capNotice = '';
  if (working.length > MAX_FANOUT_QUERIES) {
    capNotice = `[capped ${working.length}->${MAX_FANOUT_QUERIES} queries]\n`;
    working = working.slice(0, MAX_FANOUT_QUERIES);
  }

  const resolvedCwd = resolveExploreCwd(args.cwd, ctx.callerCwd);

  const settled = await Promise.allSettled(working.map((q) => {
    const llm = makeBridgeLlm({
      role: 'explorer',
      cwd: resolvedCwd,
      brief: true,
      parentSessionId: ctx.callerSessionId || null,
      clientHostPid: ctx.clientHostPid || null,
    });
    return llm({ prompt: buildExplorerPrompt(q) });
  }));

  const fatal = fatalExploreError(settled);
  if (fatal) return fail(presentErrorText(fatal, { surface: 'explore' }));

  const merged = mergeSettled(settled, working);
  const allFailed = settled.every((r) => !settledExplorerResult(r).ok);
  const out = capNotice + merged;
  return allFailed ? fail(out) : ok(out);
}
