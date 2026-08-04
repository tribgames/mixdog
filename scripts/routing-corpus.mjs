#!/usr/bin/env node
// routing-corpus.mjs — mine the local agent trace for REAL tool-routing
// patterns and freeze them as a fixed corpus. The corpus (input) is captured
// ONCE with --save; rule changes are then A/B-evaluated against that frozen
// set by re-running --eval before/after (input constant, only rules change).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve, win32 } from 'node:path';
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
    case 'code_graph': {
      const values = args.symbols || args.files || args.symbol || args.file || '';
      return clip(`${args.mode || '?'}:${Array.isArray(values) ? `[${values.length}]${values[0] || ''}` : values}`);
    }
    case 'explore': return arr(args.query);
    case 'find': return clip(args.query);
    case 'glob': return clip(Array.isArray(args.pattern) ? args.pattern[0] : args.pattern);
    case 'list': return clip(basename(String(args.path || '')));
    case 'apply_patch': return '(edit)';
    case 'shell': return clip(args.command);
    default: return clip(JSON.stringify(args), 40);
  }
}

function isMutation(tool) {
  return ['apply_patch', 'edit', 'edit_many', 'write', 'shell'].includes(tool);
}
function failed(row) {
  const kind = field(row, 'result_kind');
  return /^(error|failed|failure|command-exit|timeout|permission)$/i.test(String(kind || ''));
}
function targetValues(tool, args) {
  if (!args || typeof args !== 'object') return [];
  let key = 'path';
  if (tool === 'code_graph') {
    const fileMode = ['overview', 'imports', 'dependents', 'related', 'impact'].includes(args.mode);
    const symbolMode = ['find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'].includes(args.mode);
    key = fileMode || (args.mode === 'symbols' && (args.files != null || args.file != null))
      ? (args.files != null ? 'files' : 'file')
      : symbolMode || args.mode === 'symbols' ? (args.symbols != null ? 'symbols' : 'symbol') : 'file';
  } else if (tool === 'grep' || tool === 'glob') key = 'pattern';
  else if (tool === 'find' || tool === 'explore') key = 'query';
  const value = args[key];
  return Array.isArray(value) ? value : value == null ? [] : [value];
}
function batchFields(tool, args) {
  if (tool === 'grep' || tool === 'glob') return ['pattern', 'path'];
  if (tool === 'code_graph') {
    const fileMode = ['overview', 'imports', 'dependents', 'related', 'impact'].includes(args?.mode);
    const symbolMode = ['find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'].includes(args?.mode);
    if (symbolMode && args?.files == null && args?.file == null) return ['symbols', 'symbol'];
    if (symbolMode) return [];
    return [fileMode || args?.mode === 'symbols'
      ? (args?.files != null ? 'files' : args?.file != null ? 'file' : args?.symbols != null ? 'symbols' : 'symbol')
      : null].filter(Boolean);
  }
  return [tool === 'read' || tool === 'list' ? 'path' : tool === 'find' || tool === 'explore' ? 'query' : null].filter(Boolean);
}
function compatibleBatchCalls(tool, left, right) {
  if (tool === 'read') {
    const nonBatch = Object.keys({ ...left, ...right }).filter((key) => !['path', 'offset', 'limit'].includes(key));
    return nonBatch.every((key) => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]));
  }
  const fields = batchFields(tool, left);
  if (!fields.length) return false;
  const differing = fields.filter((key) => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key]));
  if (differing.length !== 1) return false;
  const batchKey = differing[0];
  if ((Array.isArray(left?.[batchKey]) && left[batchKey].length !== 1) || (Array.isArray(right?.[batchKey]) && right[batchKey].length !== 1)) return false;
  return Object.keys({ ...left, ...right }).filter((key) => !fields.includes(key))
    .every((key) => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]));
}
function readTargets(args) {
  if (!args || typeof args !== 'object') return null;
  const values = Array.isArray(args.path) ? args.path : [args.path];
  return values.map((value) => {
    if (typeof value === 'string') return { path: value, offset: args.offset ?? null, limit: args.limit ?? null };
    if (value && typeof value === 'object' && typeof value.path === 'string') {
      return { path: value.path, offset: value.offset ?? null, limit: value.limit ?? null };
    }
    return null;
  }).filter(Boolean);
}
function batchSpec(tool, args, forcedField = null) {
  if (!args || typeof args !== 'object') return null;
  if (tool === 'code_graph') {
    if (!['symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees', 'overview', 'imports', 'dependents', 'related', 'impact'].includes(args.mode)) return null;
    const fileMode = ['overview', 'imports', 'dependents', 'related', 'impact'].includes(args.mode);
    const symbolMode = ['find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'].includes(args.mode);
    if (symbolMode && (args.files != null || args.file != null)) return null;
    const field = fileMode || (args.mode === 'symbols' && (args.files != null || args.file != null))
      ? (args.files != null ? 'files' : 'file')
      : (args.symbols != null ? 'symbols' : 'symbol');
    return { field, values: targetValues(tool, args) };
  }
  const fieldName = forcedField || (tool === 'read' || tool === 'list' ? 'path' : tool === 'grep' || tool === 'glob' ? 'pattern' : tool === 'find' || tool === 'explore' ? 'query' : null);
  if (!fieldName) return null;
  const value = args[fieldName];
  return { field: fieldName, values: Array.isArray(value) ? value : value == null ? [] : [value] };
}
function sameIterationBatchObservations(sequence) {
  let found = false;
  for (let i = 0; i < sequence.length; i += 1) {
    const first = sequence[i];
    if (isMutation(first.tool) || first.it == null) continue;
    const group = [first];
    for (let j = i + 1; j < sequence.length; j += 1) {
      const next = sequence[j];
      if (next.it !== first.it) break;
      if (isMutation(next.tool)) break;
      group.push(next);
    }
    for (const candidate of ['read', 'grep', 'find', 'glob', 'list', 'explore', 'code_graph']) {
      if (candidate === 'read') {
        const calls = group.filter((entry) => entry.tool === 'read' && !entry.failed).map((entry) => ({ entry, targets: readTargets(entry.rawArgs) })).filter(({ targets }) => targets?.length);
        if (calls.some(({ entry, targets }, index) => calls.some(({ entry: other, targets: otherTargets }, otherIndex) => (
          index < otherIndex
          && compatibleBatchCalls('read', entry.rawArgs, other.rawArgs)
          && targets.some((target) => otherTargets.some((otherTarget) => JSON.stringify(target) !== JSON.stringify(otherTarget)))
        )))) found = true;
        continue;
      }
      const firstArgs = group.find((entry) => entry.tool === candidate && !entry.failed)?.rawArgs;
      for (const field of batchFields(candidate, firstArgs || {})) {
        const calls = group.filter((entry) => entry.tool === candidate && !entry.failed).map((entry) => ({ entry, spec: batchSpec(candidate, entry.rawArgs, field) })).filter(({ spec }) => spec && spec.values.length === 1);
        if (calls.length < 2) continue;
        const distinct = new Set(calls.map(({ spec }) => JSON.stringify(spec.values[0])));
        const compatiblePair = calls.some(({ entry, spec }, index) => calls.some(({ entry: other, spec: otherSpec }, otherIndex) => (
          index < otherIndex
          && JSON.stringify(spec.values[0]) !== JSON.stringify(otherSpec.values[0])
          && compatibleBatchCalls(candidate, entry.rawArgs, other.rawArgs)
        )));
      if (distinct.size >= 2 && compatiblePair) found = true;
      }
    }
  }
  return found ? ['same_turn_batch_opportunity'] : [];
}

// shell used to INSPECT the filesystem (read/list/search/exists) instead of a
// dedicated tool — the anti-pattern the shell description targets. Concept, not
// an exhaustive list: a command whose leading verb only reads/lists/searches
// files and does not change state or run a program (git/node/npm/build/test).
const SHELL_INSPECT_VERB = /(?:^|[\s;|&(]|\bforeach-object\s*\{)\s*(get-content|get-childitem|gci|select-string|cat|type|ls|dir|head|tail|find|findstr|grep|rg|wc|test-path|resolve-path|readlink|realpath|stat)\b/i;
const SHELL_EXEC_VERB = /(?:^|[\s;|&])\s*(git|node|npm|npx|pnpm|yarn|python|cargo|go|make|docker|rm|remove-item|mkdir|new-item|set-content|out-file|move-item|copy-item|>>|>)\b/i;
function isShellInspect(command) {
  const c = String(command || '');
  if (!c.trim()) return false;
  // If the command also changes state or runs a program, it is legitimate.
  if (SHELL_EXEC_VERB.test(c)) return false;
  return SHELL_INSPECT_VERB.test(c);
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
    const rawArgs = field(r, 'tool_args');
    const summaryArgs = rawArgs;
    sequence.push({
      it: it ?? null,
      tool,
      args: argsSummary(tool, rawArgs),
      rawArgs,
      inspectArgs: summaryArgs,
      argsHash: field(r, 'tool_args_hash'),
      resultKind: field(r, 'result_kind'),
      resultLines: Number(field(r, 'result_lines_est') || 0),
      coverage: field(r, 'grep_coverage'),
      cwd: field(r, 'cwd') || '',
      failed: failed(r),
    });
  }
  const names = sequence.map((s) => s.tool);
  const flags = [];
  const observations = [];
  if (sequence.some((s) => s.tool === 'code_graph' && s.rawArgs?.mode === 'find_symbol' && !s.rawArgs?.file && !s.rawArgs?.files)) flags.push('find_symbol_noscope');
  // Exact duplicate requests are the only relookup signal available in tool
  // traces. Do not infer waste from counts, roles, turns, or explore→inspection:
  // exploration followed by inspection can be the intended route.
  const seenRequests = new Set();
  const readWindows = [];
  let pendingContextGrep = null;
  for (const s of sequence) {
    if (isMutation(s.tool)) {
      seenRequests.clear();
      readWindows.length = 0;
      pendingContextGrep = null;
      continue;
    }
    if (s.failed) continue;
    if (['grep', 'read'].includes(s.tool)) {
      const key = s.argsHash ? `${s.tool}:${s.argsHash}` : null;
      const duplicate = key && seenRequests.has(key);
      if (duplicate) flags.push(`${s.tool}_relookup`);
      if (key) seenRequests.add(key);
      if (s.tool === 'read' && !duplicate) {
        const normalize = (value, cwd) => {
          const raw = String(value);
          const base = String(cwd || process.cwd());
          const winStyle = /^[A-Za-z]:[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(base) || raw.includes('\\');
          const resolved = (winStyle ? win32.resolve(base, raw) : resolve(base, raw)).replace(/\\/g, '/');
          return winStyle ? resolved.toLowerCase() : resolved;
        };
        const bounded = (offset, limit) => Number.isFinite(Number(offset)) && Number(offset) >= 0
          && Number.isFinite(Number(limit)) && Number(limit) > 0;
        for (const target of readTargets(s.rawArgs) || []) {
          const start = bounded(target.offset, target.limit) ? Number(target.offset) : 0;
          const end = bounded(target.offset, target.limit) ? start + Number(target.limit) : Infinity;
          const path = normalize(target.path, s.cwd);
          if (!flags.includes('read_overlap') && readWindows.some((prior) => prior.path === path && start < prior.end && prior.start < end)) flags.push('read_overlap');
          readWindows.push({ path, start, end });
        }
      }
    }
    if (s.tool === 'grep' && Array.isArray(s.coverage) && s.coverage.length) {
      pendingContextGrep = s;
    } else if (s.tool === 'read' && pendingContextGrep) {
      // Coverage is emitted by the trace formatter from actual path:line
      // output. Missing/boundedness-unknown coverage intentionally stays
      // unclassified; whole-file reads are a documented residual limitation.
      const pathArg = s.rawArgs?.path;
      const bounded = (offset, limit) => Number.isFinite(Number(offset)) && Number(offset) >= 0
        && Number.isFinite(Number(limit)) && Number(limit) > 0;
      const region = typeof pathArg === 'string' && bounded(s.rawArgs.offset, s.rawArgs.limit)
        ? { path: pathArg, start: Number(s.rawArgs.offset) + 1, end: Number(s.rawArgs.offset) + Number(s.rawArgs.limit) }
        : pathArg && typeof pathArg === 'object' && pathArg.path && bounded(pathArg.offset, pathArg.limit)
          ? { path: pathArg.path, start: Number(pathArg.offset) + 1, end: Number(pathArg.offset) + Number(pathArg.limit) }
          : null;
      if (region) {
      const normalize = (value, cwd) => {
        const raw = String(value);
        const base = String(cwd || process.cwd());
        const winStyle = /^[A-Za-z]:[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(base) || raw.includes('\\');
        const resolved = resolve(base, raw).replace(/\\/g, '/');
        return winStyle ? resolved.toLowerCase() : resolved;
      };
        const wanted = normalize(region.path, s.cwd || pendingContextGrep.cwd);
        const covered = new Set((pendingContextGrep.coverage || [])
          .filter((item) => normalize(item.path, pendingContextGrep.cwd) === wanted)
          .map((item) => Number(item.line)));
        let complete = true;
        for (let line = region.start; line <= region.end; line += 1) if (!covered.has(line)) { complete = false; break; }
        if (complete) flags.push('grep_context_then_read');
      }
      pendingContextGrep = null;
    }
  }
  observations.push(...sameIterationBatchObservations(sequence));
  // shell used for filesystem inspection instead of dedicated tools
  if (sequence.some((s) => s.tool === 'shell' && isShellInspect(s.rawArgs?.command))) flags.push('shell_inspect');

  return {
    session_id: sid,
    short_id: shortId(sid),
    agent, model,
    turns: iters.size,
    tools: sequence.length,
    first_tool: names[0] || null,
    flags,
    observations,
    max_ts: Math.max(...sorted.map((r) => Number(r.ts || 0))),
    sequence: sequence.map((s) => ({ it: s.it, tool: s.tool, args: s.args, result_kind: s.resultKind, result_lines_est: s.resultLines, grep_coverage: s.coverage })),
  };
}

const FLAG_KEYS = ['find_symbol_noscope', 'read_relookup', 'read_overlap', 'grep_relookup', 'grep_context_then_read', 'missed_array_batch', 'shell_inspect'];

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
  // A single health index: sum of flagged cases per KPI (lower is better).
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

// Extract one case by session id (or short-id prefix) from the current trace.
function extractCaseById(rows, wanted) {
  const q = String(wanted || '');
  const tr = rows.filter((r) => r.kind === 'tool' && sessionId(r) && (sessionId(r) === q || sessionId(r).startsWith(q) || shortId(sessionId(r)).startsWith(q)));
  if (!tr.length) return null;
  const sid = sessionId(tr[0]);
  return buildCase(sid, tr.filter((r) => sessionId(r) === sid));
}

// tool-name -> count for a case (the tool mix).
function toolMix(cas) {
  const mix = {};
  for (const s of cas.sequence) mix[s.tool] = (mix[s.tool] || 0) + 1;
  return mix;
}

function renderVs(before, after) {
  const L = [];
  const fmtMix = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)';
  L.push(`routing A/B  before=${before.short_id} (${before.agent || '-'}/${shortModel(before.model)})  after=${after.short_id} (${after.agent || '-'}/${shortModel(after.model)})`);
  L.push('');
  const metric = (label, b, a, lowerBetter = true) => {
    const d = a - b; const arrow = d === 0 ? '=' : (lowerBetter ? (d < 0 ? 'v' : '^') : (d > 0 ? 'v' : '^'));
    L.push(`- ${label.padEnd(14)} ${String(b).padStart(5)} -> ${String(a).padStart(5)}  (${d > 0 ? '+' : ''}${d}) ${arrow}`);
  };
  metric('turns', before.turns, after.turns);
  metric('tools', before.tools, after.tools);
  metric('flags', before.flags.length, after.flags.length);
  L.push(`  before tool-mix: ${fmtMix(toolMix(before))}`);
  L.push(`  after  tool-mix: ${fmtMix(toolMix(after))}`);
  const gained = after.flags.filter((f) => !before.flags.includes(f));
  const cleared = before.flags.filter((f) => !after.flags.includes(f));
  if (cleared.length) L.push(`  cleared flags: ${cleared.join(', ')}`);
  if (gained.length) L.push(`  NEW flags: ${gained.join(', ')}`);
  if (!cleared.length && !gained.length) L.push(`  flags unchanged: [${before.flags.join(', ') || 'none'}]`);
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
const vsIdx = process.argv.indexOf('--vs');  // --vs <before-sid> <after-sid>: routing diff

if (vsIdx >= 0) {
  const beforeId = process.argv[vsIdx + 1];
  const afterId = process.argv[vsIdx + 2];
  if (!beforeId || !afterId) { console.error('usage: --vs <before-session> <after-session>'); process.exit(1); }
  const rows = readRows(tracePath);
  const before = extractCaseById(rows, beforeId);
  const after = extractCaseById(rows, afterId);
  if (!before) { console.error(`before session not found: ${beforeId}`); process.exit(1); }
  if (!after) { console.error(`after session not found: ${afterId}`); process.exit(1); }
  if (jsonMode) console.log(JSON.stringify({ before, after }, null, 2));
  else console.log(renderVs(before, after));
  process.exit(0);
}

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
