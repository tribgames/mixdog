#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function intArg(name, fallback) {
  const n = Number.parseInt(argValue(name, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const pathArg = argValue('--path', null);
const dataDir = argValue('--data-dir', null);
const sinceArg = argValue('--since', null);
const kindFilter = argValue('--kind', null);
const last = intArg('--last', 5000);
const limit = intArg('--limit', 20);
const slowMs = intArg('--slow-ms', 3000);
const jsonMode = process.argv.includes('--json');

const mixdogHome = process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog');
const mixdogDataDir = process.env.MIXDOG_DATA_DIR || resolve(mixdogHome, 'data');

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function defaultTraceFiles() {
  if (pathArg) return [resolve(pathArg)];
  const dirs = dataDir
    ? [resolve(dataDir)]
    : [resolve(process.cwd(), '.mixdog', 'data'), mixdogDataDir];
  return unique(dirs.flatMap((dir) => [
    resolve(dir, 'history', 'agent-trace.jsonl.1'),
    resolve(dir, 'history', 'agent-trace.jsonl'),
    resolve(dir, 'history', 'bridge-trace.jsonl.1'),
    resolve(dir, 'history', 'bridge-trace.jsonl'),
  ]));
}

function parseSince(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^now$/i.test(raw)) return Date.now();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 10_000_000_000 ? n : n * 1000;
  }
  const rel = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return { file, ...JSON.parse(line) };
      } catch {
        return { file, kind: 'parse_error', payload: { line: line.slice(0, 300) } };
      }
    });
}

function payload(row) {
  return row && row.payload && typeof row.payload === 'object' ? row.payload : {};
}

function field(row, name) {
  if (row && row[name] != null) return row[name];
  const p = payload(row);
  return p[name] != null ? p[name] : null;
}

function numberField(row, name) {
  const n = Number(field(row, name));
  return Number.isFinite(n) ? n : null;
}

function countBy(rows, fn) {
  const map = new Map();
  for (const row of rows) {
    const key = String(fn(row) ?? '(none)');
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function values(rows, name) {
  return rows.map((row) => numberField(row, name)).filter((n) => n != null);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    avg: Math.round(sum / arr.length),
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    p99: percentile(arr, 99),
    max: arr[arr.length - 1],
  };
}

function formatStats(s) {
  if (!s) return 'n=0';
  return `n=${s.n} avg=${s.avg}ms p50=${s.p50}ms p90=${s.p90}ms p99=${s.p99}ms max=${s.max}ms`;
}

function short(value, max = 140) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function timeLabel(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try {
    return new Date(n).toISOString();
  } catch {
    return String(ts);
  }
}

function topStatsBy(rows, groupName, valueName, minValue = null) {
  const groups = new Map();
  for (const row of rows) {
    const value = numberField(row, valueName);
    if (value == null) continue;
    if (minValue != null && value < minValue) continue;
    const key = String(field(row, groupName) || '(none)');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return [...groups.entries()]
    .map(([key, nums]) => ({ key, ...stats(nums) }))
    .sort((a, b) => b.max - a.max || b.p90 - a.p90 || b.n - a.n);
}

function printCounts(label, obj, max = 12) {
  const parts = Object.entries(obj).slice(0, max).map(([k, v]) => `${k}:${v}`);
  console.log(`${label}: ${parts.join(', ') || '(none)'}`);
}

const files = defaultTraceFiles();
const sinceTs = parseSince(sinceArg);
const allRows = files.flatMap(readRows)
  .filter((row) => sinceTs == null || Number(row.ts || 0) >= sinceTs)
  .filter((row) => !kindFilter || String(row.kind || '') === kindFilter)
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
const rows = allRows.slice(-last);

const kindCounts = countBy(rows, (row) => row.kind || 'unknown');
const transportRows = rows.filter((row) => row.kind === 'transport');
const sseRows = rows.filter((row) => row.kind === 'sse');
const fetchRows = rows.filter((row) => row.kind === 'fetch');
const toolRows = rows.filter((row) => row.kind === 'tool');
const toolSlowRows = rows.filter((row) => row.kind === 'tool_slow' || (row.kind === 'tool' && (numberField(row, 'tool_ms') || 0) >= slowMs));
const cacheSlowRows = rows.filter((row) => row.kind === 'cache_lane_slow');
const explicitCacheBreakRows = rows.filter((row) => row.kind === 'cache_break');
const explicitCacheBreakKeys = new Set(explicitCacheBreakRows.map((row) => `${row.session_id || ''}:${row.iteration ?? ''}`));
const cacheBreakRows = explicitCacheBreakRows
  .concat(transportRows.filter((row) => field(row, 'chain_delta_reason') && !explicitCacheBreakKeys.has(`${row.session_id || ''}:${row.iteration ?? ''}`)));
const fallbackRows = rows.filter((row) => row.kind === 'transport_fallback');

const report = {
  analyzed: rows.length,
  matched: allRows.length,
  since: sinceTs ? new Date(sinceTs).toISOString() : null,
  filters: {
    kind: kindFilter,
    last,
    slow_ms: slowMs,
  },
  sources: files.filter(existsSync),
  kinds: kindCounts,
  transport: {
    modes: countBy(transportRows, (row) => field(row, 'ws_mode') || field(row, 'transport') || '(unknown)'),
    delta_reasons: countBy(transportRows.filter((row) => field(row, 'chain_delta_reason')), (row) => field(row, 'chain_delta_reason')),
    cache_lane_rate_wait_ms: stats(values(transportRows, 'cache_lane_rate_wait_ms')),
    cache_lane_wait_ms: stats(values(transportRows, 'cache_lane_wait_ms')),
    cache_lane_slow: cacheSlowRows.length,
    fallback: countBy(fallbackRows, (row) => field(row, 'reason') || field(row, 'fallback_reason') || '(unknown)'),
  },
  sse: {
    ttft_ms: stats(values(sseRows, 'ttft_ms')),
    sse_parse_ms: stats(values(sseRows, 'sse_parse_ms')),
  },
  fetch: {
    headers_ms: stats(values(fetchRows, 'headers_ms')),
  },
  tools: {
    slow_ms: slowMs,
    by_tool: topStatsBy(toolRows, 'tool_name', 'tool_ms'),
    slow_by_tool: topStatsBy(toolRows, 'tool_name', 'tool_ms', slowMs),
  },
  cache_breaks: {
    count: cacheBreakRows.length,
    reasons: countBy(cacheBreakRows, (row) => field(row, 'reason') || field(row, 'chain_delta_reason') || '(unknown)'),
  },
  samples: {
    slow_tools: toolSlowRows
      .slice()
      .sort((a, b) => Number(numberField(b, 'tool_ms') || 0) - Number(numberField(a, 'tool_ms') || 0))
      .slice(0, limit)
      .map((row) => ({
        ts: timeLabel(row.ts),
        session_id: row.session_id || null,
        iteration: row.iteration ?? null,
        tool_name: field(row, 'tool_name'),
        tool_ms: numberField(row, 'tool_ms'),
        role: field(row, 'role'),
        model: field(row, 'model'),
        args: payload(row).tool_args || row.tool_args || null,
      })),
    cache_lane_slow: cacheSlowRows.slice(-limit).map((row) => ({
      ts: timeLabel(row.ts),
      session_id: row.session_id || null,
      iteration: row.iteration ?? null,
      event: field(row, 'event'),
      provider: field(row, 'provider'),
      model: field(row, 'model'),
      payload: payload(row),
    })),
    cache_breaks: cacheBreakRows.slice(-limit).map((row) => ({
      ts: timeLabel(row.ts),
      session_id: row.session_id || null,
      iteration: row.iteration ?? null,
      reason: field(row, 'reason') || field(row, 'chain_delta_reason'),
      provider: field(row, 'provider'),
      model: field(row, 'model'),
      payload: payload(row),
    })),
  },
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`llm trace: ${rows.length}/${allRows.length} rows analyzed`);
if (sinceTs) console.log(`since: ${new Date(sinceTs).toISOString()}`);
if (kindFilter) console.log(`filter: kind=${kindFilter}`);
console.log(`sources: ${report.sources.join(', ') || '(none)'}`);
printCounts('kinds', report.kinds);
printCounts('transport modes', report.transport.modes);
printCounts('delta/full reasons', report.transport.delta_reasons);
printCounts('transport fallback', report.transport.fallback);
console.log(`cache lane rate wait: ${formatStats(report.transport.cache_lane_rate_wait_ms)}`);
console.log(`cache lane queue wait: ${formatStats(report.transport.cache_lane_wait_ms)}`);
console.log(`cache lane slow rows: ${report.transport.cache_lane_slow}`);
console.log(`ttft: ${formatStats(report.sse.ttft_ms)}`);
console.log(`sse parse: ${formatStats(report.sse.sse_parse_ms)}`);
console.log(`fetch headers: ${formatStats(report.fetch.headers_ms)}`);
console.log(`cache breaks: ${report.cache_breaks.count}`);
printCounts('cache break reasons', report.cache_breaks.reasons);
console.log('slow tools:');
for (const row of report.tools.slow_by_tool.slice(0, 12)) {
  console.log(`- ${row.key}: n=${row.n} avg=${row.avg}ms p90=${row.p90}ms max=${row.max}ms`);
}
if (report.tools.slow_by_tool.length === 0) console.log('- (none)');
console.log('slow tool samples:');
for (const row of report.samples.slow_tools) {
  console.log(`- ${row.ts} ${row.tool_name} ${row.tool_ms}ms role=${row.role || '-'} args=${short(JSON.stringify(row.args || {}), 180)}`);
}
if (report.samples.slow_tools.length === 0) console.log('- (none)');
