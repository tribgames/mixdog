#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function parseNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDuration(value, fallback = null) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`invalid duration: ${raw}`);
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.max(1, Math.floor(n * mult));
}

function argValues(name) {
  const values = [];
  const prefix = `${name}=`;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name && i + 1 < process.argv.length) values.push(process.argv[i + 1]);
    else if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
  }
  return values;
}

function parseStepCaps(values) {
  const caps = new Map();
  for (const value of values) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    const idx = raw.lastIndexOf('=');
    if (idx <= 0) throw new Error(`invalid --max-step-ms value: ${raw}`);
    const name = raw.slice(0, idx).trim().replace(/^scripts\//, '');
    const cap = Number(raw.slice(idx + 1).trim());
    if (!name || !Number.isFinite(cap) || cap < 0) throw new Error(`invalid --max-step-ms value: ${raw}`);
    caps.set(name, cap);
  }
  return caps;
}

function summarize(values) {
  if (!values.length) return { min: 0, max: 0, avg: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    avg: Math.round(avg * 10) / 10,
  };
}

function readRows(path) {
  if (!existsSync(path)) throw new Error(`smoke loop log not found: ${path}`);
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: 'parse_error', line: index + 1, error: error?.message || String(error), raw: line };
      }
    });
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function summarizeSteps(iterations) {
  const byScript = new Map();
  for (const row of iterations) {
    if (!Array.isArray(row.steps)) continue;
    for (const step of row.steps) {
      const script = String(step?.script || '').replace(/^scripts\//, '');
      const ms = Number(step?.ms);
      if (!script || !Number.isFinite(ms)) continue;
      const values = byScript.get(script) || [];
      values.push(ms);
      byScript.set(script, values);
    }
  }
  return Object.fromEntries([...byScript.entries()].map(([script, values]) => [script, summarize(values)]));
}

const logPath = resolve(argValue('--log', '.mixdog/data/history/smoke-loop.jsonl'));
const pidArg = parseNumber(argValue('--pid', null), null);
const minIterations = parseNumber(argValue('--min-iterations', null), null);
const minElapsedMs = parseDuration(argValue('--min-elapsed', null), null);
const maxGapMs = parseDuration(argValue('--max-gap', null), null);
const maxStaleMs = parseDuration(argValue('--max-stale', null), null);
const maxSmokeMs = parseNumber(argValue('--max-smoke-ms', null), null);
const maxAvgSmokeMs = parseNumber(argValue('--max-avg-smoke-ms', null), null);
const maxStepMs = parseStepCaps(argValues('--max-step-ms'));
const maxRssMb = parseNumber(argValue('--max-rss-mb', null), null);
const maxRssGrowthMb = parseNumber(argValue('--max-rss-growth-mb', null), null);
const jsonMode = process.argv.includes('--json');
const requireComplete = process.argv.includes('--require-complete');

const rows = readRows(logPath);
const startRows = rows.filter((row) => row?.type === 'start' && (pidArg == null || Number(row.pid) === pidArg));
const start = startRows.at(-1);
if (!start) throw new Error(pidArg == null ? 'no smoke loop start row found' : `no smoke loop start row found for pid ${pidArg}`);

const startIndex = rows.lastIndexOf(start);
const runRows = rows.slice(startIndex).filter((row) => Number(row.pid) === Number(start.pid));
const iterations = runRows.filter((row) => row?.type === 'iteration');
const errors = runRows.filter((row) => row?.type === 'error' || row?.type === 'parse_error');
const summaryRows = runRows.filter((row) => row?.type === 'summary');
const last = iterations.at(-1) || null;
const smoke = summarize(iterations.map((row) => Number(row.smoke_ms)).filter(Number.isFinite));
const stepMs = summarizeSteps(iterations);
const rss = summarize(iterations.map((row) => Number(row.rss_mb)).filter(Number.isFinite));
const startRss = Number(start.rss_mb);
const lastRss = Number(last?.rss_mb);
const rssGrowth = Number.isFinite(startRss) && Number.isFinite(lastRss)
  ? Math.round((lastRss - startRss) * 10) / 10
  : 0;
const elapsedMs = Number(last?.elapsed_ms || summaryRows.at(-1)?.elapsed_ms || 0);
const durationMs = Number(start.duration_ms || 0);
const remainingMs = durationMs > 0 ? Math.max(0, durationMs - elapsedMs) : null;
const startTs = Date.parse(start.ts);
const finishAt = durationMs > 0 && Number.isFinite(startTs)
  ? new Date(startTs + durationMs).toISOString()
  : null;
const iterationsPerHour = elapsedMs > 0
  ? Math.round((iterations.length / (elapsedMs / 3_600_000)) * 10) / 10
  : 0;
const gaps = [];
for (let i = 1; i < iterations.length; i += 1) {
  const prev = Date.parse(iterations[i - 1].ts);
  const cur = Date.parse(iterations[i].ts);
  if (Number.isFinite(prev) && Number.isFinite(cur)) gaps.push(cur - prev);
}
const gapSummary = summarize(gaps);
const lastTs = Date.parse(last?.ts || '');
const staleMs = Number.isFinite(lastTs) ? Date.now() - lastTs : null;

const failures = [];
if (errors.length > 0) failures.push(`errors=${errors.length}`);
if (requireComplete && summaryRows.length === 0) failures.push('loop has no completed summary row');
if (minIterations != null && iterations.length < minIterations) failures.push(`iterations ${iterations.length} < ${minIterations}`);
if (minElapsedMs != null && elapsedMs < minElapsedMs) failures.push(`elapsed ${formatDuration(elapsedMs)} < ${formatDuration(minElapsedMs)}`);
if (maxGapMs != null && gapSummary.max > maxGapMs) failures.push(`max gap ${formatDuration(gapSummary.max)} > ${formatDuration(maxGapMs)}`);
if (maxStaleMs != null && staleMs != null && staleMs > maxStaleMs) failures.push(`latest iteration stale ${formatDuration(staleMs)} > ${formatDuration(maxStaleMs)}`);
if (maxSmokeMs != null && smoke.max > maxSmokeMs) failures.push(`smoke max ${smoke.max}ms > ${maxSmokeMs}ms`);
if (maxAvgSmokeMs != null && smoke.avg > maxAvgSmokeMs) failures.push(`smoke avg ${smoke.avg}ms > ${maxAvgSmokeMs}ms`);
for (const [script, cap] of maxStepMs.entries()) {
  const stats = stepMs[script];
  if (stats && stats.max > cap) failures.push(`${script} max ${stats.max}ms > ${cap}ms`);
}
if (maxRssMb != null && rss.max > maxRssMb) failures.push(`rss max ${rss.max}MB > ${maxRssMb}MB`);
if (maxRssGrowthMb != null && rssGrowth > maxRssGrowthMb) failures.push(`rss growth ${rssGrowth}MB > ${maxRssGrowthMb}MB`);

const report = {
  ok: failures.length === 0,
  pid: start.pid,
  started_at: start.ts,
  finish_at: finishAt,
  elapsed_ms: elapsedMs,
  elapsed: formatDuration(elapsedMs),
  remaining_ms: remainingMs,
  remaining: remainingMs == null ? null : formatDuration(remainingMs),
  min_elapsed_ms: minElapsedMs,
  iterations: iterations.length,
  iterations_per_hour: iterationsPerHour,
  duration_ms: start.duration_ms,
  interval_ms: start.interval_ms,
  smoke_ms: smoke,
  step_ms: stepMs,
  max_step_ms: Object.fromEntries(maxStepMs.entries()),
  rss_mb: rss,
  rss_growth_mb: rssGrowth,
  gap_ms: gapSummary,
  stale_ms: staleMs,
  errors: errors.length,
  completed: summaryRows.length > 0,
  require_complete: requireComplete,
  latest_iteration: last?.iteration || 0,
  failures,
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`smoke loop report pid=${report.pid} ok=${report.ok}`);
  console.log(`started=${report.started_at} finish=${report.finish_at || '-'} elapsed=${report.elapsed} remaining=${report.remaining || '-'} iterations=${report.iterations} rate=${iterationsPerHour}/h completed=${report.completed}`);
  console.log(`smoke_ms min=${smoke.min} avg=${smoke.avg} max=${smoke.max}`);
  for (const [script, stats] of Object.entries(stepMs)) {
    console.log(`${script} min=${stats.min} avg=${stats.avg} max=${stats.max}`);
  }
  console.log(`rss_mb min=${rss.min} avg=${rss.avg} max=${rss.max} growth=${rssGrowth}`);
  console.log(`gap_ms min=${gapSummary.min} avg=${gapSummary.avg} max=${gapSummary.max} stale=${staleMs == null ? '-' : staleMs}`);
  console.log(`errors=${errors.length}`);
  if (failures.length) console.log(`failures: ${failures.join('; ')}`);
}

if (failures.length) process.exit(1);
