#!/usr/bin/env node
// routing-corpus.mjs — mine the local agent trace for REAL tool-routing
// patterns and freeze them as a fixed corpus. The corpus (input) is captured
// ONCE with --save; rule changes are then A/B-evaluated against that frozen
// set by re-running --eval before/after (input constant, only rules change).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { resolvePluginData } from '../src/runtime/shared/plugin-paths.mjs';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

function parseDuration(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^now$/i.test(raw)) return Date.now();
  if (/^\d+$/.test(raw)) { const n = Number(raw); return n > 10_000_000_000 ? n : n * 1000; }
  const rel = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]); const u = rel[2].toLowerCase();
    const mult = u === 'ms' ? 1 : u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultTracePath() {
  const data = process.env.MIXDOG_DATA_DIR || resolvePluginData() || resolve(homedir(), '.mixdog', 'data');
  return resolve(data, 'history', 'agent-trace.jsonl');
}

function readRows(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* best-effort */ }
  }
  return out;
}
function payload(row) { return row?.payload && typeof row.payload === 'object' ? row.payload : {}; }
function field(row, name) { if (row && row[name] != null) return row[name]; const p = payload(row); return p[name] != null ? p[name] : null; }
function sessionId(row) { return String(row?.session_id || row?.sessionId || field(row, 'session_id') || ''); }
function shortId(id) { const s = String(id || ''); return s.length <= 18 ? s : `${s.slice(0, 10)}…${s.slice(-6)}`; }
function shortModel(m) { const s = String(m || '-'); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) { const k = keyFn(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  return map;
}

function argsSummary(tool, args) {
  if (!args || typeof args !== 'object') return '';
  const clip = (v, n = 60) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const arr = (v) => Array.isArray(v) ? `[${v.length}:${clip(v[0], 40)}]` : clip(v, 50);
  switch (tool) {
    case 'grep': return clip(Array.isArray(args.pattern) ? `[${args.pattern.length}]${args.pattern[0]}` : args.pattern);
    case 'read': return clip(basename(String(Array.isArray(args.path) ? args.path[0] : args.path || '')));
    case 'code_graph': return clip(`${args.mode || '?'}:${args.symbol || args.file || ''}`);
    case 'explore': return arr(args.query);
    case 'find': return clip(args.query);
    case 'glob': return clip(Array.isArray(args.pattern) ? args.pattern[0] : args.pattern);
    case 'list': return clip(basename(String(args.path || '')));
    case 'apply_patch': return '(edit)';
    case 'shell': return clip(args.command);
    default: return clip(JSON.stringify(args), 40);
  }
}

function normGrep(args) {
  const p = args?.pattern;
  return String(Array.isArray(p) ? p.join('|') : (p ?? '')).trim().toLowerCase();
}

function buildCase(sid, toolRows) {
  const sorted = [...toolRows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const agent = field(sorted[0], 'agent') || field(sorted.find((r) => field(r, 'agent')), 'agent') || null;
  const model = field(sorted[0], 'model') || null;
  const iters = new Set();
  const sequence = [];
  for (const r of sorted) {
    const it = field(r, 'iteration');
    if (it != null) iters.add(it);
    const tool = field(r, 'tool_name') || '?';
    sequence.push({ it: it ?? null, tool, args: argsSummary(tool, field(r, 'tool_args')), rawArgs: field(r, 'tool_args') });
  }
  // per-iteration tool counts for serial detection
  const perIt = new Map();
  for (const s of sequence) { if (s.it == null) continue; perIt.set(s.it, (perIt.get(s.it) || 0) + 1); }
  const itOrder = [...perIt.keys()].sort((a, b) => a - b);
  let longestSingleRun = 0, run = 0;
  for (const it of itOrder) { if (perIt.get(it) === 1) { run += 1; longestSingleRun = Math.max(longestSingleRun, run); } else run = 0; }

  const names = sequence.map((s) => s.tool);
  const hasAnchor = names.some((n) => n === 'grep' || n === 'code_graph' || n === 'find' || n === 'read');
  const exploreCalls = sequence.filter((s) => s.tool === 'explore');
  const flags = [];
  if (exploreCalls.length && hasAnchor) flags.push('explore_overuse');
  if (exploreCalls.some((s) => Array.isArray(s.rawArgs?.query))) flags.push('explore_multiquery');
  if (names[0] === 'explore') flags.push('explore_first');
  if (sequence.some((s) => s.tool === 'code_graph' && s.rawArgs?.mode === 'find_symbol' && !s.rawArgs?.file)) flags.push('find_symbol_noscope');
  if (longestSingleRun >= 4) flags.push('serial_single_tool');
  // read fragmentation
  const readCounts = new Map();
  for (const s of sequence) { if (s.tool !== 'read') continue; const k = String(s.rawArgs?.path ?? s.args); readCounts.set(k, (readCounts.get(k) || 0) + 1); }
  if ([...readCounts.values()].some((c) => c >= 3)) flags.push('read_fragmentation');
  // grep retry
  const grepCounts = new Map();
  for (const s of sequence) { if (s.tool !== 'grep') continue; const k = normGrep(s.rawArgs); if (!k) continue; grepCounts.set(k, (grepCounts.get(k) || 0) + 1); }
  if ([...grepCounts.values()].some((c) => c >= 2)) flags.push('grep_retry');

  return {
    session_id: sid,
    short_id: shortId(sid),
    agent, model,
    turns: iters.size || itOrder.length,
    tools: sequence.length,
    first_tool: names[0] || null,
    longest_single_run: longestSingleRun,
    flags,
    max_ts: Math.max(...sorted.map((r) => Number(r.ts || 0))),
    sequence: sequence.map((s) => ({ it: s.it, tool: s.tool, args: s.args })),
  };
}

const FLAG_KEYS = ['explore_overuse', 'explore_multiquery', 'explore_first', 'find_symbol_noscope', 'serial_single_tool', 'read_fragmentation', 'grep_retry'];

function buildCorpus(rows, { limit, sinceTs, agentFilter }) {
  let filtered = rows.filter((r) => r.kind === 'tool' && sessionId(r));
  if (sinceTs != null) filtered = filtered.filter((r) => Number(r.ts || 0) >= sinceTs);
  if (agentFilter) { const q = String(agentFilter).toLowerCase(); filtered = filtered.filter((r) => String(field(r, 'agent') || '').toLowerCase().includes(q)); }
  const bySession = groupBy(filtered, sessionId);
  const cases = [...bySession.entries()].map(([sid, tr]) => buildCase(sid, tr))
    .sort((a, b) => Number(b.max_ts || 0) - Number(a.max_ts || 0));
  const emitted = cases.slice(0, limit);
  const summary = {};
  for (const k of FLAG_KEYS) {
    const count = emitted.filter((c) => c.flags.includes(k)).length;
    summary[k] = { count, pct: emitted.length ? Math.round((count / emitted.length) * 100) : 0 };
  }
  return { scanned: bySession.size, emitted: emitted.length, summary, cases: emitted };
}

function scoreCorpus(cases) {
  // A single健全 index: sum of flagged cases per KPI (lower is better).
  const summary = {};
  let flaggedCases = 0;
  for (const k of FLAG_KEYS) summary[k] = cases.filter((c) => c.flags.includes(k)).length;
  for (const c of cases) if (c.flags.length) flaggedCases += 1;
  return { total: cases.length, flagged_cases: flaggedCases, clean_pct: cases.length ? Math.round(((cases.length - flaggedCases) / cases.length) * 100) : 0, by_flag: summary };
}

function renderText(corpus, showCases) {
  const L = [];
  L.push(`routing corpus: scanned ${corpus.scanned} sessions, emitted ${corpus.emitted} cases`);
  L.push('anti-pattern summary:');
  for (const k of FLAG_KEYS) L.push(`- ${k.padEnd(20)} ${String(corpus.summary[k].count).padStart(3)} (${corpus.summary[k].pct}%)`);
  if (showCases) {
    L.push('');
    corpus.cases.forEach((c, i) => {
      L.push(`#${i + 1} agent=${c.agent || '-'} model=${shortModel(c.model)} turns=${c.turns} tools=${c.tools} flags=[${c.flags.join(',')}] sess=${c.short_id}`);
      const shown = c.sequence.slice(0, 8).map((s) => `${s.tool}(${s.args})`).join(' → ');
      const more = c.sequence.length > 8 ? ` +${c.sequence.length - 8} more` : '';
      L.push(`  seq: ${shown}${more}`);
    });
  }
  return L.join('\n');
}

// ---- main ----
const tracePath = argValue('--trace') ? resolve(argValue('--trace')) : defaultTracePath();
const sinceTs = parseDuration(argValue('--since', null));
const limit = Number.parseInt(argValue('--limit', '50'), 10) || 50;
const agentFilter = argValue('--agent', null);
const jsonMode = hasFlag('--json');
const savePath = argValue('--save', null);   // freeze the corpus (session id list + cases) to a file
const evalPath = argValue('--eval', null);   // re-score a frozen corpus's sessions against CURRENT trace

if (evalPath) {
  // A/B: load frozen corpus, re-extract those exact sessions from the current
  // trace, and score. (Sessions are immutable once finished, so this is stable;
  // the value is comparing two frozen corpora captured before/after a rule change.)
  const frozen = JSON.parse(readFileSync(resolve(evalPath), 'utf8'));
  const wantIds = new Set((frozen.cases || []).map((c) => c.session_id));
  const rows = readRows(tracePath).filter((r) => r.kind === 'tool' && wantIds.has(sessionId(r)));
  const bySession = groupBy(rows, sessionId);
  const cases = [...bySession.entries()].map(([sid, tr]) => buildCase(sid, tr));
  const score = scoreCorpus(cases);
  if (jsonMode) console.log(JSON.stringify({ eval: resolve(evalPath), ...score }, null, 2));
  else {
    console.log(`routing eval of frozen corpus (${resolve(evalPath)})`);
    console.log(`cases=${score.total} flagged=${score.flagged_cases} clean=${score.clean_pct}%`);
    for (const k of FLAG_KEYS) console.log(`- ${k.padEnd(20)} ${score.by_flag[k]}`);
  }
  process.exit(0);
}

const corpus = buildCorpus(readRows(tracePath), { limit, sinceTs, agentFilter });
if (savePath) {
  writeFileSync(resolve(savePath), JSON.stringify(corpus, null, 2));
  console.error(`saved ${corpus.emitted} cases → ${resolve(savePath)}`);
}
if (jsonMode) console.log(JSON.stringify(corpus, null, 2));
else console.log(renderText(corpus, true));
