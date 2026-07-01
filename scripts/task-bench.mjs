#!/usr/bin/env node
// task-bench.mjs — quantify "how efficiently a task finished" and A/B compare.
//
// Thin wrapper over session-bench.mjs: it runs session-bench --json for a set
// of sessions, compresses the result into a one-line SCORECARD (wall / turns /
// tools / speed / context / cache / anti-patterns / completed), averages a
// group, and diffs two groups (before vs after a rule/brief change).
//
// Usage:
//   node scripts/task-bench.mjs --session <id[,id2,...]>          scorecard(s)
//   node scripts/task-bench.mjs --session a,b,c --group           one averaged card
//   node scripts/task-bench.mjs --vs before.json after.json       A/B diff
//   node scripts/task-bench.mjs --session a,b --save before.json  freeze a group
// Input is constant (finished sessions are immutable); only rules/briefs change
// between the two frozen groups you compare.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SESSION_BENCH = resolve(__dir, 'session-bench.mjs');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function uniq(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function runSessionBench(sessionId) {
  // Returns the parsed session-bench JSON for one session id (BOM-safe).
  const raw = execFileSync('node', [SESSION_BENCH, '--session', sessionId, '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const s = raw.replace(/^\uFEFF/, '');
  const i = s.indexOf('{');
  return JSON.parse(i >= 0 ? s.slice(i) : s);
}

// Compress a session-bench report into the scorecard metrics.
function scorecard(report) {
  const sum = report.summary || {};
  const cache = report.cache || {};
  const tools = report.tools || {};
  const tr = report.time_range || {};
  const route = Array.isArray(report.stages?.turns) ? report.stages.turns.find((t) => t?.model || t?.provider) : null;
  const tokenSession = Array.isArray(report.tokens?.sessions) ? report.tokens.sessions[0] : null;
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const antipatterns =
    (tools.read_fragmentation?.length || 0) +
    (tools.grep_sweeps?.length || 0) +
    (tools.sequential_tool_clusters?.length || 0) +
    (tools.duplicates?.length || 0) +
    (tools.failed_repeats?.length || 0);
  const turns = num(sum.turns);
  const toolCalls = num(sum.tool_calls);
  const promptTokens = num(cache.prompt_tokens);
  const cachedTokens = num(cache.cached_tokens);
  const uncachedTokens = tokenSession?.uncached_tokens != null
    ? num(tokenSession.uncached_tokens)
    : Math.max(0, promptTokens - cachedTokens);
  const outputTokens = tokenSession
    ? num(tokenSession.total_output) + num(tokenSession.total_thinking)
    : 0;
  // prompt growth = last prompt - first prompt across growth_turns if present
  const growth = report.tokens?.growth_turns || [];
  const promptGrowth = growth.length ? num(growth[growth.length - 1]?.prompt_tokens) - num(growth[0]?.prompt_tokens) : null;
  return {
    provider: route?.provider || null,
    model: route?.model || null,
    wall_ms: num(tr.span_ms),
    turns,
    tool_calls: toolCalls,
    tools_per_turn: turns ? Math.round((toolCalls / turns) * 10) / 10 : 0,
    total_tool_ms: num(sum.total_tool_ms),
    llm_stream_ms: num(sum.llm_stream_ms),
    cache_ratio: num(cache.usage_cache_ratio ?? sum.cache_ratio),
    cached_tokens: cachedTokens,
    prompt_tokens: promptTokens,
    uncached_tokens: uncachedTokens,
    output_tokens: outputTokens,
    cache_weighted_input_10: Math.max(0, uncachedTokens + cachedTokens * 0.1),
    cache_weighted_input_25: Math.max(0, uncachedTokens + cachedTokens * 0.25),
    prompt_growth: promptGrowth,
    antipatterns,
    issues: issues.length,
    issue_types: uniq(issues.map((i) => i?.type)),
    read_fragmentation_paths: uniq((tools.read_fragmentation || []).map((f) => f?.path)),
    grep_sweep_count: (tools.grep_sweeps || []).length,
  };
}

function averageCards(cards) {
  if (!cards.length) return null;
  const keys = Object.keys(cards[0]).filter((k) => cards.some((c) => typeof c[k] === 'number' && Number.isFinite(c[k])));
  const out = { n: cards.length };
  for (const k of keys) {
    const vals = cards.map((c) => num(c[k]));
    out[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  }
  return out;
}

function fmtMs(ms) { const n = num(ms); return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`; }
function fmtTok(n) { const v = num(n); return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)); }
function fmtPct(n) { return `${Math.round(num(n) * 100)}%`; }

const CARD_ORDER = ['wall_ms', 'turns', 'tool_calls', 'tools_per_turn', 'cache_ratio', 'cache_weighted_input_10', 'prompt_growth', 'antipatterns', 'issues'];
function fmtCardVal(k, v) {
  if (v == null) return '-';
  if (k === 'wall_ms' || k === 'total_tool_ms' || k === 'llm_stream_ms') return fmtMs(v);
  if (k === 'cache_ratio') return fmtPct(v);
  if (k === 'prompt_growth' || k === 'cache_weighted_input_10') return fmtTok(v);
  return String(v);
}
function renderCard(label, card) {
  const parts = CARD_ORDER.map((k) => `${k}=${fmtCardVal(k, card[k])}`);
  return `${label}: ${parts.join('  ')}`;
}

function pctDelta(before, after) {
  const b = num(before); const a = num(after);
  if (b === 0) return a === 0 ? '0%' : 'n/a';
  const d = Math.round(((a - b) / Math.abs(b)) * 100);
  return `${d > 0 ? '+' : ''}${d}%`;
}
// For these metrics LOWER is better (efficiency); cache_ratio higher is better.
const LOWER_BETTER = new Set(['wall_ms', 'turns', 'tool_calls', 'tools_per_turn', 'total_tool_ms', 'llm_stream_ms', 'prompt_growth', 'cache_weighted_input_10', 'cache_weighted_input_25', 'antipatterns', 'issues']);

function renderDiff(before, after) {
  const L = [];
  L.push(`A/B compare  (before n=${before.n || 1}  after n=${after.n || 1})`);
  for (const k of CARD_ORDER) {
    const b = before[k]; const a = after[k];
    const delta = pctDelta(b, a);
    let verdict = '';
    if (delta !== 'n/a' && delta !== '0%') {
      const improved = LOWER_BETTER.has(k) ? num(a) < num(b) : num(a) > num(b);
      verdict = improved ? ' ✓' : ' ✗';
    }
    L.push(`- ${k.padEnd(16)} ${fmtCardVal(k, b).padStart(9)} → ${fmtCardVal(k, a).padStart(9)}  ${delta.padStart(6)}${verdict}`);
  }
  return L.join('\n');
}

// ---- main ----
const jsonMode = hasFlag('--json');
const allowPartial = hasFlag('--allow-partial');
const vs = argValue('--vs', null);

if (vs) {
  // --vs before.json after.json : diff two frozen group cards
  const idx = process.argv.indexOf('--vs');
  const beforePath = process.argv[idx + 1];
  const afterPath = process.argv[idx + 2];
  if (!beforePath || !afterPath) { console.error('usage: --vs <before.json> <after.json>'); process.exit(1); }
  const before = JSON.parse(readFileSync(resolve(beforePath), 'utf8'));
  const after = JSON.parse(readFileSync(resolve(afterPath), 'utf8'));
  const b = before.group || before;
  const a = after.group || after;
  if (jsonMode) console.log(JSON.stringify({ before: b, after: a }, null, 2));
  else console.log(renderDiff(b, a));
  process.exit(0);
}

const sessionArg = argValue('--session', null);
if (!sessionArg) { console.error('usage: --session <id[,id2,...]> [--group] [--save file.json] [--json] [--allow-partial]  |  --vs before.json after.json'); process.exit(1); }
const ids = sessionArg.split(',').map((s) => s.trim()).filter(Boolean);
const cards = [];
const skipped = [];
for (const id of ids) {
  try { cards.push({ session: id, ...scorecard(runSessionBench(id)) }); }
  catch (e) {
    skipped.push({ session: id, error: e.message || String(e) });
    console.error(`skip ${id}: ${e.message}`);
  }
}
if (!cards.length) { console.error('no sessions scored'); process.exit(1); }
if (skipped.length && !allowPartial) {
  const partial = { error: `only scored ${cards.length}/${ids.length} sessions`, sessions: ids, skipped, cards, group: averageCards(cards.map(({ session, ...c }) => c)) };
  if (jsonMode) console.log(JSON.stringify(partial, null, 2));
  else console.error(partial.error);
  process.exit(1);
}

const group = hasFlag('--group') || argValue('--save', null);
const groupCard = averageCards(cards.map(({ session, ...c }) => c));
const savePath = argValue('--save', null);
if (savePath) {
  writeFileSync(resolve(savePath), JSON.stringify({ sessions: ids, cards, skipped, group: groupCard }, null, 2));
  console.error(`saved group (n=${cards.length}) → ${resolve(savePath)}`);
}
if (jsonMode) {
  console.log(JSON.stringify({ cards, skipped, group: groupCard }, null, 2));
} else if (group) {
  console.log(renderCard(`group (n=${cards.length})`, groupCard));
} else {
  for (const c of cards) console.log(renderCard(c.session.slice(0, 22), c));
}
