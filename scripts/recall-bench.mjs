#!/usr/bin/env node
// recall-bench.mjs — case-based recall quality bench against the LIVE memory
// DB. READ-ONLY: every case goes through handleToolCall('search_memories')
// which only performs SELECTs (handleSearch path). No mutation actions
// ('memory' tool / cycle1 / cycle2 / prune / purge / etc.) are ever invoked
// here — do not add any.
//
//   node scripts/recall-bench.mjs [--cases scripts/recall-bench-cases.json] [--json]
//
// Loads src/runtime/memory/index.mjs in-process (same module the daemon
// uses), calls init() once, runs each bench case through handleToolCall,
// prints params/result-count/top-3/latency/PASS-WARN per case, then a
// summary table, then calls stop().
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const DEFAULT_CASES_PATH = resolve(__dir, 'recall-bench-cases.json');

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }

const WARN_LATENCY_MS = 3000;

const DEFAULT_CASES = [
  { id: 'kw-ko', label: 'keyword query (ko)', args: { query: '메모리 재현' }, expect: 'results' },
  { id: 'kw-en', label: 'keyword query (en)', args: { query: 'memory recall pipeline' }, expect: 'results' },
  { id: 'short-1tok', label: 'short 1-token query', args: { query: 'recall' }, expect: 'results' },
  { id: 'short-2tok', label: 'short 2-token query', args: { query: 'cycle1 drain' }, expect: 'results' },
  { id: 'browse-last', label: 'query-less recent browse (period=last)', args: { period: 'last', limit: 10 }, expect: 'browse' },
  { id: 'period-24h', label: 'period window 24h', args: { period: '24h', limit: 10 }, expect: 'browse' },
  { id: 'period-7d', label: 'period window 7d', args: { period: '7d', limit: 10 }, expect: 'browse' },
  { id: 'category-filter', label: 'category filter (decision)', args: { period: '30d', category: 'decision', limit: 10 }, expect: 'browse' },
  { id: 'id-lookup', label: 'id lookup', args: { id: 1 }, expect: 'idlookup' },
  { id: 'scope-project', label: 'project-scoped query', args: { query: 'recall', cwd: ROOT, limit: 10 }, expect: 'results' },
  { id: 'scope-all', label: 'all-scope query', args: { query: 'recall', projectScope: 'all', limit: 10 }, expect: 'results' },
  { id: 'raw-on', label: 'includeRaw on', args: { query: 'recall', includeRaw: true, limit: 10 }, expect: 'results' },
  { id: 'raw-off', label: 'includeRaw off', args: { query: 'recall', includeRaw: false, limit: 10 }, expect: 'results' },
];

function loadCases(path) {
  if (path && existsSync(resolve(path))) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      process.stderr.write(`[recall-bench] failed to parse cases file ${path}: ${e.message}; using built-in cases\n`);
    }
  }
  return DEFAULT_CASES;
}

function textOfResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content.map((p) => (p?.type === 'text' ? p.text || '' : JSON.stringify(p))).join('\n');
  }
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text;
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '');
}

function countEntryLines(text) {
  const t = String(text || '').trim();
  if (!t || t === '(no results)' || t === '(no valid ids)') return 0;
  return t.split('\n').filter((line) => line.trim() && !line.startsWith('[recall truncated') && !line.startsWith('note:')).length;
}

function topN(text, n = 3, maxLen = 140) {
  const t = String(text || '').trim();
  if (!t || t === '(no results)') return [];
  return t.split('\n')
    .filter((line) => line.trim() && !line.startsWith('[recall truncated') && !line.startsWith('note:'))
    .slice(0, n)
    .map((line) => (line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line));
}

function evaluateCase(kase, { count, ms, isError }) {
  const warnings = [];
  if (isError) warnings.push('error result');
  if (ms > WARN_LATENCY_MS) warnings.push(`latency ${ms}ms > ${WARN_LATENCY_MS}ms`);
  if ((kase.expect === 'browse' || kase.expect === 'idlookup') && count === 0) {
    warnings.push('0 results for a browse/id-lookup case (expected data present)');
  }
  const status = warnings.length ? 'WARN' : 'PASS';
  return { status, warnings };
}

async function runCase(memoryModule, kase) {
  const started = Date.now();
  let result;
  let isError = false;
  let errMsg = null;
  try {
    result = await memoryModule.handleToolCall('search_memories', kase.args || {});
    isError = Boolean(result?.isError);
  } catch (e) {
    isError = true;
    errMsg = e?.message || String(e);
    result = { text: `(error: ${errMsg})` };
  }
  const ms = Date.now() - started;
  const text = textOfResult(result);
  const count = countEntryLines(text);
  const evalResult = evaluateCase(kase, { count, ms, isError });
  return {
    id: kase.id,
    label: kase.label,
    args: kase.args,
    count,
    ms,
    isError,
    errMsg,
    top3: topN(text, 3),
    status: evalResult.status,
    warnings: evalResult.warnings,
  };
}

function printCase(row) {
  process.stdout.write(`\n[${row.status}] ${row.id} — ${row.label}\n`);
  process.stdout.write(`  params: ${JSON.stringify(row.args)}\n`);
  process.stdout.write(`  results: ${row.count}  latency: ${row.ms}ms${row.isError ? `  ERROR: ${row.errMsg}` : ''}\n`);
  if (row.top3.length) {
    for (const line of row.top3) process.stdout.write(`    - ${line}\n`);
  } else {
    process.stdout.write('    (no results)\n');
  }
  for (const w of row.warnings) process.stdout.write(`  WARN: ${w}\n`);
}

function printSummary(rows) {
  process.stdout.write('\n=== recall-bench summary ===\n');
  const widths = { id: 18, results: 8, ms: 8, status: 6 };
  process.stdout.write(
    `${'case'.padEnd(widths.id)}${'results'.padEnd(widths.results)}${'ms'.padEnd(widths.ms)}${'status'.padEnd(widths.status)}notes\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${String(r.id).padEnd(widths.id)}${String(r.count).padEnd(widths.results)}${String(r.ms).padEnd(widths.ms)}${String(r.status).padEnd(widths.status)}${r.warnings.join('; ')}\n`,
    );
  }
  const warnCount = rows.filter((r) => r.status === 'WARN').length;
  const totalMs = rows.reduce((s, r) => s + r.ms, 0);
  process.stdout.write(`\ncases=${rows.length} pass=${rows.length - warnCount} warn=${warnCount} total_latency=${totalMs}ms\n`);
}

async function main() {
  const casesPath = argValue('cases', DEFAULT_CASES_PATH);
  const jsonMode = hasFlag('json');
  const cases = loadCases(casesPath);

  let memoryModule;
  try {
    memoryModule = await import(pathToFileURL(resolve(ROOT, 'src/runtime/memory/index.mjs')).href);
  } catch (e) {
    process.stderr.write(`[recall-bench] failed to load memory module: ${e?.stack || e?.message || e}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await memoryModule.init();
  } catch (e) {
    process.stdout.write(`recall-bench: DB unreachable / init failed — reporting clearly, no fabricated results.\n`);
    process.stdout.write(`error: ${e?.stack || e?.message || e}\n`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  try {
    for (const kase of cases) {
      const row = await runCase(memoryModule, kase);
      rows.push(row);
      if (!jsonMode) printCase(row);
    }
  } finally {
    try { await memoryModule.stop?.(); } catch {}
  }

  const allZero = rows.length > 0 && rows.every((r) => r.count === 0 && !r.isError);
  if (allZero) {
    process.stdout.write('\nNOTE: every case returned 0 results — DB is likely empty (or unreachable pool). Treat WARNs below as expected-empty, not a recall bug, until data is present.\n');
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ cases: rows }, null, 2) + '\n');
  } else {
    printSummary(rows);
  }

  const hardErrors = rows.filter((r) => r.isError);
  if (hardErrors.length) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || e}\n`);
  process.exitCode = 1;
});
