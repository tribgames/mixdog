import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { makeBridgeLlm } from '../runtime/agent/orchestrator/smart-bridge/bridge-llm.mjs';

// Ported faithfully from the original mixdog tool-defs.mjs `explore` entry.
// `aiWrapped` is dropped: in the standalone build there is no aiWrapped
// dispatch hub — execution is wired directly in the runtime executor below
// via makeBridgeLlm. The schema + description are kept verbatim so the model's
// usage guidance matches the original intent.
export const EXPLORE_TOOL = {
  name: 'explore',
  title: 'Explore',
  annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Read-only codebase EXPLORATION for open-ended/unknown scope — locates and describes code, does not judge it (findings are UNVERIFIED leads; verify before acting). Shape each query as a location question (where/which/what implements X), not a verdict question. Fan-out runs items in parallel. Prefer it over a long grep/code_graph storm; a bounded/known-anchor lookup stays a direct code_graph/grep call.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Array of independent ONE-LINE questions: each item is ONE short question on ONE topic — do NOT pass a whole brief/context dump as one item; DECOMPOSE a multi-part task into several one-line per-topic questions here. Split by topic; never one broad query. Each item must be location/inventory-shaped (where/which/what), never verdict-shaped (is-it-correct / are-there-problems).' },
      cwd: { type: 'string' },
      background: { type: 'boolean', description: 'Lead default true (answer pushed via channel, avoids the 120s sync cap); bridge workers run sync.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// Total merged-output character cap. The original source uses a very large cap
// (50MB) plus a smart-read summariser downstream; the standalone path returns
// the merged text in-turn, so we keep a sane bound to protect the Lead context.
export const EXPLORE_OUTPUT_CHAR_CAP = 24_000;
const EXPLORE_TRUNCATION_MARKER = '\n\n[explore: output truncated; narrow cwd or split queries to see more]';
// Bound fan-out so a hostile/poisoned query array cannot spawn unbounded subs.
const MAX_FANOUT_QUERIES = 8;

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mirrors buildExplorerPrompt from the original ai-wrapped-dispatch: each
// explorer receives ONLY its own query, with a trailing descriptive-only
// reminder. The full no-verdict contract lives at system level
// (rules/bridge/30-explorer.md).
function buildExplorerPrompt(query) {
  return `<query>${escapeXml(query)}</query>\nReminder: describe with file:line evidence; no verdicts, ratings, or recommendations.`;
}

function normalizeQueries(rawQuery) {
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

/**
 * Standalone explore executor.
 *
 * Dispatches the hidden `explorer` read-only filesystem role (one ephemeral
 * sub-session per query) via makeBridgeLlm — the same path recall/search-style
 * hidden roles use. Runs query items concurrently (Promise.allSettled), then
 * aggregates the findings into one bounded text result.
 *
 * Standalone v1 deviation from the original: runs SYNC and returns the merged
 * text in-turn (no background channel-push). `background` is accepted but
 * ignored for now — flagged for Lead.
 *
 * @param {object} args         — tool args ({ query, cwd, background }).
 * @param {object} ctx          — { callerCwd, callerSessionId }.
 */
export async function runExplore(args = {}, ctx = {}) {
  const queries = normalizeQueries(args.query);
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
