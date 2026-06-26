import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  TOOL_SYNC_EXECUTION_CONTRACT,
  cancelBackgroundTask,
  executionModeSchemaDescription,
  getBackgroundTask,
  renderBackgroundTask,
  renderBackgroundTaskList,
  resolveExecutionMode,
  startBackgroundTask,
  taskIdFromArgs,
} from '../runtime/shared/background-tasks.mjs';
import { makeBridgeLlm } from '../runtime/agent/orchestrator/smart-bridge/bridge-llm.mjs';

// Ported from the original mixdog tool-defs.mjs `explore` entry.
// `aiWrapped` is dropped: in the standalone build there is no aiWrapped
// dispatch hub — execution is wired directly in the runtime executor below
// via makeBridgeLlm. The standalone surface is synchronous: it returns a
// bounded locator result in this tool call.
export const EXPLORE_TOOL = {
  name: 'explore',
  title: 'Explore',
  annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: `Broad-scope locator only; returns unverified leads. Prefer mode=async for broad exploration that can continue in parallel; use sync only when the next step must block on this locator result. ${TOOL_SYNC_EXECUTION_CONTRACT} ${TOOL_ASYNC_EXECUTION_CONTRACT} Use code_graph/grep/glob first when any symbol, term, file kind, or config clue exists. Use explore only after direct narrowing fails or topics are unrelated. One short location question.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'One short location question, or an array only for unrelated topics. Do not use for a known symbol/term/config key; use code_graph/grep first. Never pass a whole brief/context dump.' },
      cwd: { type: 'string' },
      mode: { type: 'string', enum: ['async', 'sync'], description: `${executionModeSchemaDescription('sync')} Prefer async for non-trivial exploration; choose sync only for an explicit blocking lookup.` },
      action: { type: 'string', enum: ['run', 'list', 'status', 'read', 'cancel'], description: 'Default run. list/status/read/cancel are manual recovery controls for async tasks.' },
      task_id: { type: 'string', description: 'Shared background task id for status/read/cancel.' },
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
  return `<query>${escapeXml(query)}</query>\nReminder: describe with file:line evidence; no verdicts, ratings, or recommendations.`;
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

function mergeSettled(settled, queries) {
  const single = queries.length === 1;
  if (single) {
    const r = settled[0];
    const body = r.status === 'fulfilled'
      ? (r.value || '(no response)')
      : `[explorer error] ${r.reason?.message || String(r.reason)}`;
    return body.length > EXPLORE_OUTPUT_CHAR_CAP
      ? body.slice(0, EXPLORE_OUTPUT_CHAR_CAP) + EXPLORE_TRUNCATION_MARKER
      : body;
  }
  const parts = [];
  let total = 0;
  const sep = '\n\n';
  let truncated = false;
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const header = `## Q${i + 1}: ${String(queries[i] ?? '').replace(/\s+/g, ' ').slice(0, 60)}`;
    const body = r.status === 'fulfilled'
      ? (r.value || '(no response)')
      : `[explorer error] ${r.reason?.message || String(r.reason)}`;
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
 * Runs synchronously by default. With mode=async/background:true, registers a
 * shared background task and delivers completion to the owner session.
 *
 * @param {object} args         — tool args ({ query, cwd, background }).
 * @param {object} ctx          — { callerCwd, callerSessionId }.
 */
export async function runExplore(args = {}, ctx = {}) {
  const action = clean(args.action || 'run').toLowerCase();
  if (['list', 'status', 'read', 'cancel'].includes(action)) return controlExploreTask(action, args, ctx);

  const mode = resolveExecutionMode(args, 'sync');
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
    });
    return llm({ prompt: buildExplorerPrompt(q) });
  }));

  const merged = mergeSettled(settled, working);
  const allFailed = settled.every((r) => r.status === 'rejected');
  const out = capNotice + merged;
  return allFailed ? fail(out) : ok(out);
}
