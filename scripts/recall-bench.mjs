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
import { parsePeriod } from '../src/runtime/memory/lib/recall-format.mjs';
import {
  evaluateCase,
  parseRecallOutput,
  scoreAllContain,
  scoreRecencyOrdered,
  scorePageAfter,
  scoreTopNContains,
  scoreWithinPeriod,
  textOfResult,
  topItems,
} from './lib/recall-bench-eval.mjs';

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

const DEFAULT_CASES = [
  { id: 'kw-ko', label: 'keyword query (ko)', args: { query: '\uBA54\uBAA8\uB9AC \uC7AC\uD604' }, expect: 'results' },
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

async function runCase(memoryModule, kase, priorRows = new Map()) {
  const expectObj = kase.expect && typeof kase.expect === 'object' ? kase.expect : null;
  const cursorPrior = expectObj?.cursorFrom ? priorRows.get(expectObj.cursorFrom) : null;
  const callArgs = {
    ...(kase.args || {}),
    ...(expectObj?.cursorFrom ? { cursor: cursorPrior?.nextCursor } : {}),
  };
  const started = Date.now();
  let result;
  let isError = false;
  let errMsg = null;
  try {
    if (expectObj?.cursorFrom && !callArgs.cursor) throw new Error(`missing cursor from ${expectObj.cursorFrom}`);
    result = await memoryModule.handleToolCall('search_memories', callArgs);
    isError = Boolean(result?.isError);
  } catch (e) {
    isError = true;
    errMsg = e?.message || String(e);
    result = { text: `(error: ${errMsg})` };
  }
  const ms = Date.now() - started;
  const text = textOfResult(result);
  const parsed = parseRecallOutput(text);
  const count = parsed.items.length;
  // expect stays a plain string for legacy cases ('results'/'browse'/'idlookup').
  // New quality cases use an object: { kind?, topNContains: [...], topN? }.
  const expectKind = expectObj ? expectObj.kind : kase.expect;
  const topNContains = expectObj && Array.isArray(expectObj.topNContains) ? expectObj.topNContains : null;
  const cutoffN = expectObj && Number.isInteger(expectObj.topN) ? expectObj.topN : 5;
  const quality = topNContains ? scoreTopNContains(parsed.items, topNContains, cutoffN) : null;
  const recency = expectObj && expectObj.recencyOrdered ? scoreRecencyOrdered(parsed.items) : null;
  const allContainNeedles = expectObj && Array.isArray(expectObj.allContain) ? expectObj.allContain : null;
  const allContain = allContainNeedles ? scoreAllContain(parsed.items, allContainNeedles) : null;
  const temporal = expectObj?.withinPeriod ? parsePeriod(String(kase.args?.period || ''), Boolean(kase.args?.query)) : null;
  const withinPeriod = temporal?.startMs != null ? scoreWithinPeriod(parsed.items, temporal) : null;
  const prior = expectObj?.pageAfter ? priorRows.get(expectObj.pageAfter) : null;
  const pageOrder = prior ? scorePageAfter(prior.parsed, parsed) : null;
  const evalResult = evaluateCase(
    { ...kase, expect: expectObj ? { ...expectObj, kind: expectKind } : expectKind },
    { count, ms, isError },
    quality,
    recency,
    allContain,
    withinPeriod,
    pageOrder,
  );
  return {
    id: kase.id,
    label: kase.label,
    args: kase.args,
    count,
    ms,
    isError,
    errMsg,
    top3: topItems(parsed.items, 3),
    quality,
    recency,
    allContain,
    withinPeriod,
    pageOrder,
    parsed,
    nextCursor: result?.nextCursor || null,
    status: evalResult.status,
    warnings: evalResult.warnings,
  };
}

function printCase(row) {
  process.stdout.write(`\n[${row.status}] ${row.id} — ${row.label}\n`);
  process.stdout.write(`  params: ${JSON.stringify(row.args)}\n`);
  process.stdout.write(`  results: ${row.count}  latency: ${row.ms}ms${row.isError ? `  ERROR: ${row.errMsg}` : ''}\n`);
  if (row.quality) {
    process.stdout.write(`  hit@${row.quality.n}: ${row.quality.hitAtN.toFixed(2)}  MRR: ${row.quality.mrr.toFixed(2)}\n`);
    for (const p of row.quality.perSubstring) {
      process.stdout.write(`    substr "${p.needle}" -> rank ${p.rank ?? 'none'}${p.hit ? '' : '  (miss)'}\n`);
    }
  }
  if (row.recency) {
    process.stdout.write(`  recency: ${row.recency.ordered ? 'ordered' : 'OUT-OF-ORDER'} (${row.recency.parsed} timestamped lines)\n`);
  }
  if (row.withinPeriod) {
    process.stdout.write(`  period: ${row.withinPeriod.ok ? 'in-range' : 'OUT-OF-RANGE'} (${row.withinPeriod.checked} timestamped items)\n`);
  }
  if (row.pageOrder) {
    process.stdout.write(`  page order: ${row.pageOrder.ok ? 'ordered, distinct' : 'INVALID'}\n`);
  }
  if (row.top3.length) {
    for (const line of row.top3) process.stdout.write(`    - ${line}\n`);
  } else {
    process.stdout.write('    (no results)\n');
  }
  for (const w of row.warnings) process.stdout.write(`  WARN: ${w}\n`);
}

function printSummary(rows) {
  process.stdout.write('\n=== recall-bench summary ===\n');
  const widths = { id: 18, results: 8, ms: 8, status: 6, hit: 9, mrr: 7 };
  process.stdout.write(
    `${'case'.padEnd(widths.id)}${'results'.padEnd(widths.results)}${'ms'.padEnd(widths.ms)}${'status'.padEnd(widths.status)}${'hit@N'.padEnd(widths.hit)}${'MRR'.padEnd(widths.mrr)}notes\n`,
  );
  for (const r of rows) {
    const hitStr = r.quality ? r.quality.hitAtN.toFixed(2) : '-';
    const mrrStr = r.quality ? r.quality.mrr.toFixed(2) : '-';
    process.stdout.write(
      `${String(r.id).padEnd(widths.id)}${String(r.count).padEnd(widths.results)}${String(r.ms).padEnd(widths.ms)}${String(r.status).padEnd(widths.status)}${hitStr.padEnd(widths.hit)}${mrrStr.padEnd(widths.mrr)}${r.warnings.join('; ')}\n`,
    );
  }
  const warnCount = rows.filter((r) => r.status === 'WARN').length;
  const totalMs = rows.reduce((s, r) => s + r.ms, 0);
  const qualityRows = rows.filter((r) => r.quality);
  let aggLine = '';
  if (qualityRows.length) {
    const aggHit = qualityRows.reduce((s, r) => s + r.quality.hitAtN, 0) / qualityRows.length;
    const aggMrr = qualityRows.reduce((s, r) => s + r.quality.mrr, 0) / qualityRows.length;
    aggLine = `  agg_hit@N=${aggHit.toFixed(3)} agg_MRR=${aggMrr.toFixed(3)} (${qualityRows.length} scored cases)`;
  }
  process.stdout.write(`\ncases=${rows.length} pass=${rows.length - warnCount} warn=${warnCount} total_latency=${totalMs}ms${aggLine}\n`);
}

async function main() {
  const casesPath = argValue('cases', DEFAULT_CASES_PATH);
  const jsonMode = hasFlag('json');
  const strict = hasFlag('strict');
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
  const rowsById = new Map();
  try {
    for (const kase of cases) {
      const row = await runCase(memoryModule, kase, rowsById);
      rows.push(row);
      rowsById.set(row.id, row);
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
    process.stdout.write(JSON.stringify({ cases: rows.map(({ parsed, ...row }) => row) }, null, 2) + '\n');
  } else {
    printSummary(rows);
  }

  const hardErrors = rows.filter((r) => r.isError);
  if (hardErrors.length) process.exitCode = 1;
  // --strict: any WARN row fails the run. Default behavior (errors-only) unchanged.
  if (strict && rows.some((r) => r.status === 'WARN')) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || e}\n`);
  process.exitCode = 1;
});
