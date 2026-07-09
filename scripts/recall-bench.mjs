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

function textOfResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return result.content.map((p) => (p?.type === 'text' ? p.text || '' : JSON.stringify(p))).join('\n');
  }
  if (result && typeof result === 'object' && typeof result.text === 'string') return result.text;
  if (typeof result === 'string') return result;
  return JSON.stringify(result ?? '');
}

function countEntryLines(text) {
  return resultLines(text).length;
}

function topN(text, n = 3, maxLen = 140) {
  return resultLines(text)
    .slice(0, n)
    .map((line) => (line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line));
}

// Full ordered list of result lines (no slice), used for topNContains rank
// scoring. Same filtering rule as countEntryLines/topN.
function resultLines(text) {
  const t = String(text || '').trim();
  if (!t || t === '(no results)' || t === '(no valid ids)') return [];
  return t.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed
      && !trimmed.startsWith('[recall truncated')
      && !trimmed.startsWith('note:')
      && !/^\[[^\]]+\]$/.test(trimmed);
  });
}

// Score expect.topNContains: for each expected substring, find the 1-indexed
// rank of the first result line containing it (case-insensitive), over the
// FULL result list (not just the topN cutoff) so we can tell "missed
// entirely" from "present but ranked below cutoff". hit@N/MRR are then
// computed against the topN cutoff.
function scoreTopNContains(lines, substrings, n) {
  const lower = lines.map((l) => l.toLowerCase());
  const perSubstring = substrings.map((needle) => {
    const hay = String(needle || '').toLowerCase();
    let rank = null;
    for (let i = 0; i < lower.length; i++) {
      if (hay && lower[i].includes(hay)) { rank = i + 1; break; }
    }
    const hit = rank !== null && rank <= n;
    return { needle, rank, hit, rr: hit ? 1 / rank : 0 };
  });
  const total = perSubstring.length || 1;
  const hitAtN = perSubstring.reduce((s, p) => s + (p.hit ? 1 : 0), 0) / total;
  const mrr = perSubstring.reduce((s, p) => s + p.rr, 0) / total;
  return { perSubstring, hitAtN, mrr, n };
}

// Parse leading "[YYYY-MM-DD HH:MM]" timestamps from result lines and check
// they are non-increasing (newest-first). Returns null when fewer than 2
// lines carry a parseable timestamp (nothing to order).
function scoreRecencyOrdered(lines) {
  const tsRe = /^\s*\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/;
  const headerRe = /^\s*##\s/;
  const parse = (raw) => Date.parse(raw.replace(' ', 'T'));
  // Non-increasing check within a single ordered list of {raw,ts}. Returns
  // the first {prev,cur} pair where cur is newer than prev, else null.
  const firstBreak = (stamps) => {
    for (let i = 1; i < stamps.length; i++) {
      if (Number.isFinite(stamps[i].ts) && Number.isFinite(stamps[i - 1].ts) && stamps[i].ts > stamps[i - 1].ts) {
        return { prev: stamps[i - 1].raw, cur: stamps[i].raw };
      }
    }
    return null;
  };
  const hasSessions = lines.some((l) => headerRe.test(l));
  if (!hasSessions) {
    // Ungrouped: single global non-increasing check over all timestamped lines.
    const stamps = [];
    for (const line of lines) {
      const m = tsRe.exec(line);
      if (m) stamps.push({ raw: m[1], ts: parse(m[1]) });
    }
    if (stamps.length < 2) return { parsed: stamps.length, groups: 0, ordered: true, firstViolation: null };
    const b = firstBreak(stamps);
    return { parsed: stamps.length, groups: 0, ordered: b === null, firstViolation: b };
  }
  // Session-grouped: partition timestamped lines by their "## session" header.
  // Timestamps only compared WITHIN a group; groups themselves must descend by
  // their first line's timestamp.
  const groups = [];
  let cur = null;
  for (const line of lines) {
    if (headerRe.test(line)) { cur = { stamps: [] }; groups.push(cur); continue; }
    const m = tsRe.exec(line);
    if (m && cur) cur.stamps.push({ raw: m[1], ts: parse(m[1]) });
  }
  const nonEmpty = groups.filter((g) => g.stamps.length);
  const parsed = nonEmpty.reduce((s, g) => s + g.stamps.length, 0);
  let firstViolation = null;
  for (const g of nonEmpty) {
    const b = firstBreak(g.stamps);
    if (b) { firstViolation = { ...b, scope: 'within-session' }; break; }
  }
  if (!firstViolation) {
    const heads = nonEmpty.map((g) => g.stamps[0]);
    const b = firstBreak(heads);
    if (b) firstViolation = { ...b, scope: 'across-sessions' };
  }
  return { parsed, groups: nonEmpty.length, ordered: firstViolation === null, firstViolation };
}

// Score expect.allContain: every result line must contain at least one of the
// given substrings (case-insensitive). Returns offending lines (matching none).
// Use for negative cases where rows legitimately mention the term.
function scoreAllContain(lines, substrings) {
  const needles = substrings.map((s) => String(s || '').toLowerCase()).filter(Boolean);
  const offenders = lines.filter((line) => {
    const l = line.toLowerCase();
    return !needles.some((n) => l.includes(n));
  });
  return { needles: substrings, offenders, ok: offenders.length === 0 };
}

function evaluateCase(kase, { count, ms, isError }, quality, recency, allContain) {
  const warnings = [];
  if (isError) warnings.push('error result');
  if (ms > WARN_LATENCY_MS) warnings.push(`latency ${ms}ms > ${WARN_LATENCY_MS}ms`);
  if ((kase.expect === 'browse' || kase.expect === 'idlookup') && count === 0) {
    warnings.push('0 results for a browse/id-lookup case (expected data present)');
  }
  if (kase.expect === 'empty' && count > 0) {
    warnings.push(`expected empty but got ${count} result(s) — possible filler/unrelated match`);
  }
  if (allContain) {
    for (const line of allContain.offenders) {
      warnings.push(`allContain miss: result line contains none of [${allContain.needles.join(', ')}]: "${line}"`);
    }
  }
  if (quality) {
    for (const p of quality.perSubstring) {
      if (!p.hit) {
        warnings.push(p.rank === null
          ? `topNContains miss: "${p.needle}" not found in results`
          : `topNContains miss: "${p.needle}" found at rank ${p.rank} > topN ${quality.n}`);
      }
    }
  }
  if (recency && !recency.ordered && recency.firstViolation) {
    const v = recency.firstViolation;
    warnings.push(`recencyOrdered violation (${v.scope || 'global'}): ${v.cur} newer than prior ${v.prev}`);
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
  // expect stays a plain string for legacy cases ('results'/'browse'/'idlookup').
  // New quality cases use an object: { kind?, topNContains: [...], topN? }.
  const expectObj = kase.expect && typeof kase.expect === 'object' ? kase.expect : null;
  const expectKind = expectObj ? expectObj.kind : kase.expect;
  const topNContains = expectObj && Array.isArray(expectObj.topNContains) ? expectObj.topNContains : null;
  const cutoffN = expectObj && Number.isInteger(expectObj.topN) ? expectObj.topN : 5;
  const quality = topNContains ? scoreTopNContains(resultLines(text), topNContains, cutoffN) : null;
  const recency = expectObj && expectObj.recencyOrdered ? scoreRecencyOrdered(resultLines(text)) : null;
  const allContainNeedles = expectObj && Array.isArray(expectObj.allContain) ? expectObj.allContain : null;
  const allContain = allContainNeedles ? scoreAllContain(resultLines(text), allContainNeedles) : null;
  const evalResult = evaluateCase({ ...kase, expect: expectKind }, { count, ms, isError }, quality, recency, allContain);
  return {
    id: kase.id,
    label: kase.label,
    args: kase.args,
    count,
    ms,
    isError,
    errMsg,
    top3: topN(text, 3),
    quality,
    recency,
    allContain,
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
  // --strict: any WARN row fails the run. Default behavior (errors-only) unchanged.
  if (strict && rows.some((r) => r.status === 'WARN')) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e?.message || e}\n`);
  process.exitCode = 1;
});
