#!/usr/bin/env node
// Tool efficiency analysis over TB run artifacts (agent/mixdog.txt JSONL).
// Measures per-tool speed (timing), context cost (output chars), and stability
// (failure rates, error categories, recovery chains). Read-only over artifacts.
//
// Usage:
//   node tool-efficiency.mjs <runDir> [<runDir> ...] [--json out.json] [--md out.md]
// A runDir is a jobs-* directory containing one or more date dirs of trials.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const runDirs = [];
let jsonOut = null;
let mdOut = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') jsonOut = args[++i];
  else if (args[i] === '--md') mdOut = args[++i];
  else runDirs.push(args[i]);
}
if (runDirs.length === 0) {
  console.error('usage: node tool-efficiency.mjs <runDir> [...] [--json out] [--md out]');
  process.exit(2);
}

function listDirs(p) {
  return readdirSync(p).filter((n) => {
    try { return statSync(join(p, n)).isDirectory(); } catch { return false; }
  });
}

function findTrialDirs(runDir) {
  const trials = [];
  for (const dateDir of listDirs(runDir)) {
    for (const trial of listDirs(join(runDir, dateDir))) {
      trials.push(join(runDir, dateDir, trial));
    }
  }
  return trials;
}

function argKey(name, a) {
  if (!a || typeof a !== 'object') return '';
  switch (name) {
    case 'git': return String(a.command ?? '');
    case 'shell': return String(a.command ?? '');
    case 'read': return String(a.file_path ?? '');
    case 'grep': return JSON.stringify([a.pattern, a.glob ?? null, a.path ?? null]);
    case 'find': return JSON.stringify([a.query, a.path ?? null]);
    case 'glob': return JSON.stringify([a.pattern, a.path ?? null]);
    case 'list': return String(a.path ?? '.');
    case 'code_graph': return JSON.stringify([a.mode, a.symbols ?? null, a.files ?? null]);
    case 'edit': return String(a.file_path ?? '');
    default: return JSON.stringify(a);
  }
}

const ERROR_CATEGORIES = [
  ['non-repo', /not a git repository/i],
  ['not-found', /ENOENT|Not found at this path|no such file|does not exist|No files found|not an existing/i],
  ['timeout', /timed? ?out|deadline|TIMEOUT/i],
  ['invalid-args', /invalid|must be|expected|unsupported|not allowed|rejected|missing required/i],
];

function classifyError(output) {
  const s = String(output ?? '');
  for (const [cat, re] of ERROR_CATEGORIES) if (re.test(s)) return cat;
  return 'other';
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return {
    n: s.length,
    sum,
    mean: s.length ? Math.round((sum / s.length) * 10) / 10 : 0,
    p50: pct(s, 50),
    p95: pct(s, 95),
    max: s.length ? s[s.length - 1] : 0,
  };
}

// ---- collect ----

const runs = [];
for (const runDir of runDirs) {
  const label = basename(runDir.replace(/[\\/]+$/, ''));
  const calls = []; // flat call records for this run
  let trials = 0;
  for (const trialDir of findTrialDirs(runDir)) {
    const txt = join(trialDir, 'agent', 'mixdog.txt');
    let raw;
    try { raw = readFileSync(txt, 'utf8'); } catch { continue; }
    trials++;
    const task = basename(trialDir).replace(/__[^_]+$/, '');
    for (const line of raw.split('\n')) {
      if (!line.includes('"tool_call"') || !line.includes('"item.completed"')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const it = ev.item;
      if (!it || it.type !== 'tool_call') continue;
      const output = String(it.output ?? '');
      const status = it.status ?? 'completed';
      const softFail = status === 'completed' && /^Error\b/.test(output);
      calls.push({
        task,
        trial: basename(trialDir),
        name: it.name,
        key: argKey(it.name, it.arguments),
        status,
        softFail,
        outChars: output.length,
        errCat: status === 'failed' || softFail ? classifyError(output) : null,
        exec: it.timing?.execution_ms ?? null,
        total: it.timing?.total_ms ?? it.duration_ms ?? null,
        batchWait: it.timing?.batch_wait_ms ?? null,
        ts: it.completed_at ?? ev.timestamp,
      });
    }
  }
  runs.push({ label, dir: runDir, trials, calls });
}

// ---- aggregate ----

function aggregate(calls) {
  const byTool = new Map();
  for (const c of calls) {
    if (!byTool.has(c.name)) byTool.set(c.name, []);
    byTool.get(c.name).push(c);
  }

  // recovery chains: same (trial, tool, key) — failure followed later by success
  const chains = new Map(); // chainKey -> { fails: n, wastedChars, recovered }
  for (const c of calls) {
    const isFail = c.status === 'failed' || c.softFail;
    const isOk = !isFail && c.status !== 'skipped';
    const k = `${c.trial}\u0000${c.name}\u0000${c.key}`;
    let ch = chains.get(k);
    if (isFail) {
      if (!ch) chains.set(k, (ch = { fails: 0, wastedChars: 0, recovered: false }));
      ch.fails++;
      ch.wastedChars += c.outChars;
    } else if (isOk && ch && !ch.recovered) {
      ch.recovered = true;
    }
  }

  const tools = {};
  for (const [name, list] of [...byTool.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const ok = list.filter((c) => c.status === 'completed' && !c.softFail);
    const hardFail = list.filter((c) => c.status === 'failed');
    const softFail = list.filter((c) => c.softFail);
    const skipped = list.filter((c) => c.status === 'skipped');
    const fails = hardFail.length + softFail.length;
    const errCats = {};
    for (const c of [...hardFail, ...softFail]) errCats[c.errCat] = (errCats[c.errCat] ?? 0) + 1;
    tools[name] = {
      calls: list.length,
      ok: ok.length,
      failed: fails,
      skipped: skipped.length,
      failRatePct: list.length ? Math.round((fails / list.length) * 1000) / 10 : 0,
      execMs: stats(list.filter((c) => c.exec != null).map((c) => c.exec)),
      totalMs: stats(list.filter((c) => c.total != null).map((c) => c.total)),
      batchWaitMs: stats(list.filter((c) => c.batchWait != null).map((c) => c.batchWait)),
      outChars: stats(list.map((c) => c.outChars)),
      okOutChars: stats(ok.map((c) => c.outChars)),
      wastedChars: [...hardFail, ...softFail, ...skipped].reduce((s, c) => s + c.outChars, 0),
      errCats,
    };
  }

  let recovered = 0, abandoned = 0, chainWaste = 0;
  for (const ch of chains.values()) {
    if (ch.recovered) recovered++; else abandoned++;
    chainWaste += ch.wastedChars;
  }
  const totalOut = calls.reduce((s, c) => s + c.outChars, 0);
  const wasted = calls
    .filter((c) => c.status === 'failed' || c.softFail || c.status === 'skipped')
    .reduce((s, c) => s + c.outChars, 0);
  return {
    totalCalls: calls.length,
    totalOutChars: totalOut,
    wastedChars: wasted,
    wastedPct: totalOut ? Math.round((wasted / totalOut) * 1000) / 10 : 0,
    failChains: { recovered, abandoned, chainWasteChars: chainWaste },
    tools,
  };
}

const result = runs.map((r) => ({
  label: r.label,
  trials: r.trials,
  ...aggregate(r.calls),
}));

// ---- render ----

function fmtMs(s) { return `${s.p50}/${s.p95}`; }
function fmtK(n) { return n >= 10000 ? `${Math.round(n / 100) / 10}k` : String(n); }

const lines = [];
lines.push('# Tool efficiency report');
lines.push('');
for (const run of result) {
  lines.push(`## ${run.label}`);
  lines.push('');
  lines.push(`- trials: ${run.trials}, tool calls: ${run.totalCalls}, total output: ${fmtK(run.totalOutChars)} chars`);
  lines.push(`- wasted output (failed+skipped): ${fmtK(run.wastedChars)} chars (${run.wastedPct}%)`);
  lines.push(`- failure chains: recovered ${run.failChains.recovered}, abandoned ${run.failChains.abandoned}, chain waste ${fmtK(run.failChains.chainWasteChars)} chars`);
  lines.push('');
  lines.push('| tool | calls | ok | fail | skip | fail% | exec p50/p95 ms | total p50/p95 ms | out p50/p95 ch | ok-out p50 | wasted ch | errors |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, t] of Object.entries(run.tools)) {
    const errs = Object.entries(t.errCats).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
    lines.push(`| ${name} | ${t.calls} | ${t.ok} | ${t.failed} | ${t.skipped} | ${t.failRatePct} | ${fmtMs(t.execMs)} | ${fmtMs(t.totalMs)} | ${t.outChars.p50}/${t.outChars.p95} | ${t.okOutChars.p50} | ${fmtK(t.wastedChars)} | ${errs} |`);
  }
  lines.push('');
}

const md = lines.join('\n');
console.log(md);
if (mdOut) writeFileSync(mdOut, md + '\n');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n');
