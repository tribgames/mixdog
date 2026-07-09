import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { makeAgentDispatch } from '../runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { loadConfig } from '../runtime/agent/orchestrator/config.mjs';
import { initProviders } from '../runtime/agent/orchestrator/providers/registry.mjs';
import { presentErrorText } from '../runtime/shared/err-text.mjs';
import { ensureProcessListenerHeadroom } from '../runtime/shared/process-listener-headroom.mjs';

ensureProcessListenerHeadroom(64);

// Ported from the original mixdog tool-defs.mjs `explore` entry.
// `aiWrapped` is dropped: in the standalone build there is no aiWrapped
// dispatch hub — execution is wired directly in the runtime executor below
// via makeAgentDispatch. The standalone surface is synchronous: it returns a
// bounded locator result in this tool call.
export const EXPLORE_TOOL = {
  name: 'explore',
  title: 'Explore',
  annotations: { title: 'Explore', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: 'Locator for broad/uncertain targets with no known path — repo anchors AND out-of-repo/machine-wide file locations (e.g. "where does X store its logs/config"). Searches dot-directories via the hardened find internally. Array = independent targets: when starting a task, decompose what you need to know into facets (implementation site / config-load path / tests / error origin, ...) and fan them out as one query[] call (max 8, parallel) — never send rephrasings of the same target.',
  inputSchema: {
    type: 'object',
    properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Narrow locator query; array = independent facets of the task (not rephrasings), fanned out in parallel.' },
      cwd: { type: 'string', description: 'Project/root directory.' },
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
// Mechanical turn cap per explorer sub-session: 3 free turns (contract: tool
// turn 1 = whole batched search, turns 2-3 = miss recovery), then the agent
// loop forces one tool-less final-answer turn. Overridable for tuning.
export const EXPLORE_MAX_LOOP_ITERATIONS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_MAX_LOOP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
})();
const EXPLORE_RESULT_CACHE_MAX_ENTRIES = 64;
const EXPLORE_RESULT_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_RESULT_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5 * 60_000;
})();
// Hard ceiling for one explorer compute. The dispatch-level watchdog is the
// primary abort; this race is the last line of defence so a wedged compute can
// never hang the awaiting tool call (and its cache key) forever.
export const EXPLORE_COMPUTE_HARD_TIMEOUT_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_HARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10 * 60_000;
})();
const EXPLORE_RESULT_CACHE = new Map(); // key -> { ts, value?, promise? }
// Fan-out launch stagger: when >1 query, dispatch the first sub-session
// immediately and delay the rest by this many ms so they can reuse the first
// sub's provider prompt-cache write instead of racing cold. Default 0 (off):
// live A/B (2026-07-07) showed 800ms produced zero cross-sub iter1 cache
// reads (the first sub's write lands only after its iter1 completes, ~2.5s+)
// while costing every later sub the full delay. Cross-BATCH reuse works
// without stagger now that iter1 writes the prefix breakpoint. Env knob kept
// for tuning experiments.
const EXPLORE_FANOUT_STAGGER_MS = (() => {
  const raw = Number(process.env.MIXDOG_EXPLORE_FANOUT_STAGGER_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
})();

function withExploreHardTimeout(promise) {
  if (!(EXPLORE_COMPUTE_HARD_TIMEOUT_MS > 0)) return promise;
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`explorer timed out after ${EXPLORE_COMPUTE_HARD_TIMEOUT_MS}ms`)),
      EXPLORE_COMPUTE_HARD_TIMEOUT_MS,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mirrors buildExplorerPrompt from the original ai-wrapped-dispatch: each
// explorer receives ONLY its own query, with a trailing descriptive-only
// reminder. The full no-verdict contract lives at system level
// (rules/agent/30-explorer.md).
export function buildExplorerPrompt(query) {
  return `<query>${escapeXml(query)}</query>\nReminder: RULE ZERO is a binary gate after every tool result: >=1 path:line matching a SPECIFIC query token (product/library/domain name) -> STOP and answer NOW with those exact coordinates, this IS your final turn; zero -> one more batch if budget remains. Turns 2-3 exist SOLELY as zero-hit recovery (the previous turn matched ZERO specific tokens); spending a turn to confirm, refine, or upgrade an anchor you already hold is a defect. A generic-word-only match (schema, handler, config, resolver, index, error...) while the query's specific tokens match nowhere counts as ZERO, not a hit. There is no third branch: "hits exist but I want better ones" IS branch one — answer now. A code_graph symbol hit (find_symbol/symbol_search returning path:line) IS an anchor — emit it directly, never re-locate it with grep. Credibility is mechanical (specific-token match), never judged: "is this the real implementation / final handler / just a wrapper" are caller questions, FORBIDDEN here; mark weak anchors ? and answer anyway. Flow/how/trigger queries: first matching definition/entry anchors ARE the complete answer — never trace the chain, one anchor per concept. You locate WHERE, never WHY. Scope is ALWAYS the session working directory: omit path or pass only a path seen in an earlier result; inventing a directory (/workspace/..., another repo's layout) is a defect — on zero hits change TOKENS, never guess paths. HARD max 3 tool turns; counter line (turn 1/3, turn 2/3, turn 3/3) on every tool message; expected shape is turn 1 -> answer, turns 2-3 are miss-recovery only (previous turn had ZERO matching lines), with changed tokens; after turn 3/3 you MUST answer best-so-far. Each turn = ONE maximal batch: a single grep whose pattern[] packs ALL token variants PLUS code_graph/find/glob in the SAME message; a single-tool turn is a wasted turn. Before emitting EXPLORATION_FAILED re-scan ALL earlier results: any line matching a specific query token -> answer with that anchor (? if weak) — a weak anchor beats a false miss; EXPLORATION_FAILED only when all 3 turns found zero token-matching lines. Output only anchor lines formatted as path:line — symbol/name — short reason, max 3 lines, or EXPLORATION_FAILED. No preamble, bullets, numbering, headings, summary, code quotes, analysis, verdicts, ratings, or recommendations.`;
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

function settledExplorerResult(result, cwd = null) {
  if (result?.status !== 'fulfilled') {
    return { ok: false, text: `[explorer error] ${result?.reason?.message || String(result?.reason)}` };
  }
  const text = cleanExplorerText(typeof result.value === 'string' ? result.value : responseText(result.value), cwd);
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
  return /\b(?:quota|quota_exceeded|insufficient_quota|rate[_ -]?limit|too many requests|resource exhausted|unauthorized|authentication|forbidden|permission denied|invalid api key|token expired)\b/i.test(text);
}

function fatalExploreError(settled) {
  return (settled || []).find((r) => r?.status === 'rejected' && isFatalExploreError(r.reason))?.reason || null;
}

function mergeSettled(settled, queries, cwd = null) {
  const single = queries.length === 1;
  if (single) {
    const { text: body } = settledExplorerResult(settled[0], cwd);
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
    const { text: body } = settledExplorerResult(settled[i], cwd);
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

function exploreResultCacheEnabled() {
  return EXPLORE_RESULT_CACHE_TTL_MS > 0
    && !/^(?:0|false|off|no)$/i.test(String(process.env.MIXDOG_EXPLORE_RESULT_CACHE || '1'));
}

function exploreResultCacheKey({ cwd, presetName, query }) {
  return JSON.stringify({
    cwd: String(cwd || ''),
    presetName: String(presetName || ''),
    query: String(query || ''),
  });
}

function findConfigPreset(config, presetName) {
  const wanted = clean(presetName);
  if (!wanted) return null;
  return (Array.isArray(config?.presets) ? config.presets : [])
    .find((preset) => clean(preset?.id) === wanted || clean(preset?.name) === wanted)
    || null;
}

async function ensureExploreProviderReady(config) {
  const route = config?.maintenance?.explore;
  // Route object ({provider,model}) is the current shape; a string is a
  // legacy preset NAME resolved against config.presets.
  const provider = (route && typeof route === 'object')
    ? clean(route.provider)
    : clean(findConfigPreset(config, route)?.provider);
  if (!provider) return;
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  await initProviders(providers);
}

function scheduleExploreCodeGraphPrewarm(cwd) {
  if (/^(?:1|true|on|yes)$/i.test(String(process.env.MIXDOG_DISABLE_EXPLORE_CODE_GRAPH_PREWARM || ''))) return;
  void import('../runtime/agent/orchestrator/tools/code-graph.mjs')
    .then((mod) => mod?.prewarmCodeGraphIfProject?.(cwd))
    .catch(() => { /* best-effort */ });
}

// Best-effort: warm the find/enumeration cache the explorer's turn-1 `find`
// will hit, in parallel with provider warmup. The export may not exist yet —
// tolerate its absence.
function scheduleExploreFindPrewarm(cwd) {
  void import('../runtime/agent/orchestrator/tools/builtin/list-tool.mjs')
    .then((mod) => mod?.prewarmFindEnumeration?.(cwd))
    .catch(() => { /* best-effort; export may not exist yet */ });
}

function getCachedExploreResult(key) {
  if (!exploreResultCacheEnabled()) return null;
  const entry = EXPLORE_RESULT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > EXPLORE_RESULT_CACHE_TTL_MS) {
    EXPLORE_RESULT_CACHE.delete(key);
    return null;
  }
  if (typeof entry.value === 'string') {
    EXPLORE_RESULT_CACHE.delete(key);
    EXPLORE_RESULT_CACHE.set(key, entry);
    return entry.value;
  }
  return null;
}

async function runExploreCached(key, compute) {
  const cached = getCachedExploreResult(key);
  if (cached !== null) return cached;
  if (!exploreResultCacheEnabled()) return await withExploreHardTimeout(compute());
  const entry = EXPLORE_RESULT_CACHE.get(key);
  if (entry?.promise) {
    // Pending in-flight dedup — but never trust a pending entry forever: a
    // compute that outlived the hard timeout is wedged (its own race should
    // have rejected); drop the poisoned key and recompute fresh.
    if (!(EXPLORE_COMPUTE_HARD_TIMEOUT_MS > 0) || Date.now() - entry.ts <= EXPLORE_COMPUTE_HARD_TIMEOUT_MS) {
      return await entry.promise;
    }
    EXPLORE_RESULT_CACHE.delete(key);
  }
  const promise = Promise.resolve()
    .then(() => withExploreHardTimeout(compute()))
    .then((value) => {
      const text = typeof value === 'string' ? value : responseText(value);
      const cleaned = cleanExplorerText(text);
      if (cleaned && cleaned !== 'EXPLORATION_FAILED') {
        EXPLORE_RESULT_CACHE.set(key, { ts: Date.now(), value: text });
        while (EXPLORE_RESULT_CACHE.size > EXPLORE_RESULT_CACHE_MAX_ENTRIES) {
          const oldest = EXPLORE_RESULT_CACHE.keys().next().value;
          if (!oldest) break;
          EXPLORE_RESULT_CACHE.delete(oldest);
        }
      } else {
        EXPLORE_RESULT_CACHE.delete(key);
      }
      return value;
    })
    .catch((err) => {
      EXPLORE_RESULT_CACHE.delete(key);
      throw err;
    });
  EXPLORE_RESULT_CACHE.set(key, { ts: Date.now(), promise });
  return await promise;
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
const ANCHOR_PATH_CAPTURE_RE = /(?:^|\s)((?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+)):\d+\b/;
// Coordinate (path:line) capture used as the dedup key: the same anchor
// restated with different reason wording must collapse to one line.
const ANCHOR_COORD_CAPTURE_RE = /(?:^|\s)((?:[A-Za-z]:[\\/][^:\n]+|\.{0,2}[\\/][^:\n]+|src[\\/][^:\n]+|[\w.-]+[\\/][^:\n]+):\d+(?:-\d+)?)\b/;
// Path-only anchor: line starts with a path token (contains a separator) and
// is followed by a dash separator or end of line — the `path — reason` shape
// without a :line suffix. Keeps such answers while dropping prose narration.
const ANCHOR_PATHONLY_CAPTURE_RE = /^(\S+[\\/][^\s:]+)(?=\s+[—–-]|\s*$)/;
// Explorer self-count markers ("turn 1/3") belong on tool messages only;
// strip them defensively if they leak into the final answer.
const TURN_COUNTER_LINE_RE = /^turn\s+\d+\s*\/\s*\d+\b/i;
// Contract cap: anchor answers are max 3 lines per query; extra anchors are
// cost, not quality (rules/agent/30-explorer.md).
const EXPLORE_MAX_ANCHOR_LINES = 3;
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

// Anchor existence filter: a locator answer citing a file that does not exist
// is a hallucination — drop the line. Only enforced when cwd is known.
function anchorLineExists(line, cwd, captureRe = ANCHOR_PATH_CAPTURE_RE) {
  const m = line.match(captureRe);
  if (!m) return true;
  const p = m[1].trim();
  try { return existsSync(isAbsolute(p) ? p : resolve(cwd, p)); } catch { return true; }
}

export function cleanExplorerText(text, cwd = null) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const anchors = [];
  const pathOnly = [];
  const passthrough = [];
  const seen = new Set();
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = normalizeExplorerLine(sourceLine);
    if (!line || /^-{3,}$/.test(line) || /^#+\s+/.test(line) || TURN_COUNTER_LINE_RE.test(line)) continue;
    if (/^EXPLORATION_FAILED\b/i.test(line)) return 'EXPLORATION_FAILED';
    const coord = line.match(ANCHOR_COORD_CAPTURE_RE)?.[1]
      ?? line.match(ANCHOR_PATHONLY_CAPTURE_RE)?.[1];
    const key = (coord ?? line).toLowerCase().replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    if (ANCHOR_LINE_RE.test(line)) anchors.push(line);
    else if (ANCHOR_PATHONLY_CAPTURE_RE.test(line)) pathOnly.push(line);
    else passthrough.push(sourceLine);
  }
  if (anchors.length) {
    const real = (cwd ? anchors.filter((l) => anchorLineExists(l, cwd)) : anchors)
      .slice(0, EXPLORE_MAX_ANCHOR_LINES);
    // All anchors pointed at nonexistent paths: fail harmlessly instead of
    // forwarding hallucinated locations.
    return real.length ? real.join('\n') : 'EXPLORATION_FAILED';
  }
  if (pathOnly.length) {
    const real = (cwd ? pathOnly.filter((l) => anchorLineExists(l, cwd, ANCHOR_PATHONLY_CAPTURE_RE)) : pathOnly)
      .slice(0, EXPLORE_MAX_ANCHOR_LINES);
    if (real.length) return real.join('\n');
    return 'EXPLORATION_FAILED';
  }
  if (FAILED_RE.test(raw)) return 'EXPLORATION_FAILED';
  return passthrough.join('\n').trim() || raw;
}

/**
 * Standalone explore executor.
 *
 * Dispatches the hidden `explorer` read-only filesystem role (one ephemeral
 * sub-session per query) via makeAgentDispatch — the same path recall/search-style
 * hidden roles use. Runs query items concurrently (Promise.allSettled), then
 * aggregates the findings into one bounded text result.
 *
 * Runs synchronously and returns the bounded locator result in this tool call.
 *
 * @param {object} args         — tool args ({ query, cwd }).
 * @param {object} ctx          — { callerCwd, callerSessionId }.
 */
export async function runExplore(args = {}, ctx = {}) {
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
  scheduleExploreCodeGraphPrewarm(resolvedCwd);
  scheduleExploreFindPrewarm(resolvedCwd);
  const config = loadConfig();
  await ensureExploreProviderReady(config);
  const route = config?.maintenance?.explore;
  const presetName = (route && typeof route === 'object')
    ? `${clean(route.provider)}/${clean(route.model)}`
    : (route || '');
  // Turn budget is enforced BOTH ways: the prompt contract (rules/agent/
  // 30-explorer.md, "hard max 3 tool turns, expected 1") steers the model,
  // and maxLoopIterations mechanically backstops it — live traces showed
  // explorers overshooting to 4+ tool turns on compound queries despite the
  // prompt. At the cap the loop grants ONE tool-less final turn ("answer
  // with your best result from context"), so a capped explorer still emits
  // its anchors instead of an empty/failed result. The wall-clock hard
  // timeout (EXPLORE_COMPUTE_HARD_TIMEOUT_MS) remains the runaway guard.
  const llm = makeAgentDispatch({
    agent: 'explorer',
    cwd: resolvedCwd,
    brief: true,
    parentSessionId: ctx.callerSessionId || null,
    clientHostPid: ctx.clientHostPid || null,
    config,
    maxLoopIterations: EXPLORE_MAX_LOOP_ITERATIONS,
  });

  // Stagger cold sub-session launches so later subs reuse the first sub's
  // provider prompt-cache write. Index 0 fires immediately; a cached-result
  // query resolves without delay regardless of index.
  const stagger = working.length > 1 ? EXPLORE_FANOUT_STAGGER_MS : 0;
  const settled = await Promise.allSettled(working.map((q, i) => {
    const key = exploreResultCacheKey({ cwd: resolvedCwd, presetName, query: q });
    return runExploreCached(key, () => {
      const delay = (stagger > 0 && i > 0) ? new Promise((r) => setTimeout(r, stagger)) : null;
      return delay
        ? delay.then(() => llm({ prompt: buildExplorerPrompt(q) }))
        : llm({ prompt: buildExplorerPrompt(q) });
    });
  }));

  const fatal = fatalExploreError(settled);
  if (fatal) return fail(presentErrorText(fatal, { surface: 'explore' }));

  const merged = mergeSettled(settled, working, resolvedCwd);
  const allFailed = settled.every((r) => !settledExplorerResult(r, resolvedCwd).ok);
  const out = capNotice + merged;
  return allFailed ? fail(out) : ok(out);
}
