#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { isInclusiveProvider } from '../src/runtime/shared/llm/cost.mjs';

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
const agentFilter = argValue('--agent', null);
const sessionArg = argValue('--session', null);
const limit = intArg('--limit', 30);
const jsonMode = process.argv.includes('--json');
const treeMode = process.argv.includes('--tree');

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
    .flatMap((line) => {
      try {
        return [{ file, ...JSON.parse(line) }];
      } catch {
        return [];
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

function values(nums) {
  return nums.filter((n) => Number.isFinite(n));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(nums) {
  const arr = values(nums).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    sum,
    avg: Math.round(sum / arr.length),
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    p99: percentile(arr, 99),
    max: arr[arr.length - 1],
  };
}

function mean(nums) {
  const arr = values(nums);
  if (arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function timeHms(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const d = new Date(n);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function shortModel(model) {
  const text = String(model || '-');
  if (text.length <= 18) return text;
  const slash = text.lastIndexOf('/');
  if (slash >= 0 && text.length - slash - 1 <= 18) return text.slice(slash + 1);
  return `${text.slice(0, 15)}…`;
}

function shortSessionId(sessionId) {
  const raw = String(sessionId || '');
  const core = raw.startsWith('sess_') ? raw.slice(5) : raw;
  if (core.length <= 12) return core;
  return core.slice(0, 10);
}

function inferProviderFromModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  if (m.includes('gpt') || m.includes('codex')) return 'openai';
  if (m.includes('grok') || m.includes('xai')) return 'xai';
  if (m.includes('deepseek')) return 'deepseek';
  return null;
}

function sessionInclusive(provider) {
  if (provider) return isInclusiveProvider(provider);
  return true;
}

function usageDenom(row, provider) {
  const prompt = numberField(row, 'prompt_tokens');
  const input = numberField(row, 'input_tokens');
  if (isInclusiveProvider(provider)) return prompt;
  const p = String(provider || '').toLowerCase();
  if (p.includes('anthropic')) return prompt || input;
  return input ?? prompt;
}

function cacheHitPctRow(row, provider) {
  const cached = numberField(row, 'cached_tokens') || 0;
  const denom = usageDenom(row, provider);
  if (!denom || denom <= 0) return null;
  return (cached / denom) * 100;
}

function aggregateCacheHit(usageRows, provider) {
  let sumCached = 0;
  let sumDenom = 0;
  for (const row of usageRows) {
    sumCached += numberField(row, 'cached_tokens') || 0;
    const denom = usageDenom(row, provider);
    if (denom && denom > 0) sumDenom += denom;
  }
  if (sumDenom <= 0) return null;
  return (sumCached / sumDenom) * 100;
}

function nearestPreceding(rows, ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const row of rows) {
    const rts = Number(row.ts || 0);
    if (rts <= t && rts > bestTs) {
      bestTs = rts;
      best = row;
    }
  }
  return best;
}

function formatKb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n / 1024)}KB`;
}

function formatTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}ktok`;
  return `${Math.round(v)}tok`;
}

function formatPct(p) {
  if (p == null || !Number.isFinite(p)) return '-';
  return `${Math.round(p)}%`;
}

function padColumns(tableRows) {
  if (tableRows.length === 0) return [];
  const colCount = tableRows[0].length;
  const widths = Array.from({ length: colCount }, (_, i) =>
    Math.max(...tableRows.map((r) => String(r[i] ?? '').length)));
  return tableRows.map((r) => r.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  '));
}

function groupToolsByIteration(toolRows) {
  const map = new Map();
  for (const row of toolRows) {
    const it = numberField(row, 'iteration');
    if (it == null) continue;
    const name = String(field(row, 'tool_name') || '(unknown)');
    if (!map.has(it)) map.set(it, new Map());
    const inner = map.get(it);
    inner.set(name, (inner.get(name) || 0) + 1);
  }
  return map;
}

function toolsLabel(toolMap) {
  if (!toolMap || toolMap.size === 0) return '-';
  return [...toolMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

function deriveSessionMeta(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  let agent = null;
  for (const row of sorted) {
    const kind = String(row.kind || '');
    if (kind !== 'preset_assign' && kind !== 'tool') continue;
    const r = field(row, 'agent');
    if (r) {
      agent = String(r);
      break;
    }
  }
  const preset = sorted.find((r) => r.kind === 'preset_assign');
  let provider = preset ? field(preset, 'provider') : null;
  let model = preset ? field(preset, 'model') : null;
  if (!model) {
    const usage = sorted.find((r) => r.kind === 'usage_raw' && field(r, 'model'));
    model = usage ? field(usage, 'model') : null;
  }
  if (!provider) provider = inferProviderFromModel(model);
  const inclusive = sessionInclusive(provider);
  const tsList = sorted.map((r) => Number(r.ts || 0)).filter((n) => n > 0);
  const minTs = tsList.length ? Math.min(...tsList) : 0;
  const maxTs = tsList.length ? Math.max(...tsList) : 0;
  const batchRows = sorted.filter((r) => r.kind === 'batch');
  const toolRows = sorted.filter((r) => r.kind === 'tool');
  const usageRows = sorted.filter((r) => r.kind === 'usage_raw');
  const sseRows = sorted.filter((r) => r.kind === 'sse');
  const contextRows = sorted.filter((r) => r.kind === 'context');
  let turns = batchRows.length;
  if (turns === 0) {
    const iters = usageRows.map((r) => numberField(r, 'iteration')).filter((n) => n != null);
    turns = iters.length ? Math.max(...iters) : 0;
  }
  const tools = toolRows.length;
  const toolsPerTurn = turns > 0 ? (tools / turns).toFixed(1) : '-';
  const avgPromptTok = mean(usageRows.map((r) => numberField(r, 'prompt_tokens')));
  const cacheHit = aggregateCacheHit(usageRows, provider);
  const avgTtft = mean(sseRows.map((r) => numberField(r, 'ttft_ms')));
  const spanSec = maxTs >= minTs ? Math.round((maxTs - minTs) / 1000) : 0;
  const totalPrompt = usageRows.reduce((s, r) => s + (numberField(r, 'prompt_tokens') || 0), 0);
  const totalOutput = usageRows.reduce((s, r) => s + (numberField(r, 'output_tokens') || 0), 0);
  const parentSessionId = preset ? field(preset, 'parent_session_id') : null;
  return {
    agent,
    provider,
    model,
    inclusive,
    minTs,
    maxTs,
    turns,
    tools,
    toolsPerTurn,
    avgPromptTok,
    cacheHit,
    avgTtft,
    spanSec,
    totalPrompt,
    totalOutput,
    usageRows,
    toolRows,
    sseRows,
    contextRows,
    batchRows,
    parentSessionId,
    sorted,
  };
}

function collectIterations(meta) {
  const iters = new Set();
  for (const row of meta.usageRows) {
    const it = numberField(row, 'iteration');
    if (it != null) iters.add(it);
  }
  for (const row of meta.toolRows) {
    const it = numberField(row, 'iteration');
    if (it != null) iters.add(it);
  }
  return [...iters].sort((a, b) => a - b);
}

function usageForIteration(usageRows, it) {
  const hits = usageRows.filter((r) => numberField(r, 'iteration') === it);
  if (hits.length === 0) return null;
  return hits.reduce((a, b) => (Number(a.ts || 0) >= Number(b.ts || 0) ? a : b));
}

function buildTimeline(meta) {
  const toolByIt = groupToolsByIteration(meta.toolRows);
  const iterations = collectIterations(meta);
  const sessionAvgCache = meta.cacheHit;
  const lines = [];
  let prevPrompt = null;
  const issues = [];

  for (const it of iterations) {
    const usage = usageForIteration(meta.usageRows, it);
    const ts = Number(usage?.ts || 0);
    const ctx = nearestPreceding(meta.contextRows, ts);
    const sse = nearestPreceding(meta.sseRows, ts);
    const prompt = usage ? numberField(usage, 'prompt_tokens') : null;
    const cachedPct = usage ? cacheHitPctRow(usage, meta.provider) : null;
    const ttft = sse ? numberField(sse, 'ttft_ms') : null;
    const ctxBytes = ctx ? numberField(ctx, 'totalBytes') : null;
    const flags = [];
    if (sessionAvgCache != null && cachedPct != null && cachedPct < sessionAvgCache - 20) {
      flags.push('cache');
    }
    if (prevPrompt != null && prompt != null && prompt > prevPrompt * 1.5) {
      flags.push('prompt');
    }
    if (ttft != null && ttft > 5000) flags.push('ttft');
    const warn = flags.length ? ' ⚠' : '';
    if (flags.length) {
      issues.push({ it, flags, prompt, cachedPct, ttft, ctxBytes, tools: toolByIt.get(it) });
    }
    lines.push({
      it,
      tools: toolsLabel(toolByIt.get(it)),
      ctx: formatKb(ctxBytes),
      prompt: formatTok(prompt),
      cached: formatPct(cachedPct),
      ttft: ttft != null ? `${Math.round(ttft)}ms` : '-',
      warn,
      promptRaw: prompt,
      cachedPct,
      ttftRaw: ttft,
      ctxBytes,
      flags,
    });
    if (prompt != null) prevPrompt = prompt;
  }
  return { lines, issues };
}

function autoDiagnosis(meta, timeline) {
  const { issues, lines } = timeline;
  if (lines.length === 0) {
    return 'No iterations with usage or tool rows; cannot infer per-turn behavior.';
  }
  const ranked = [...issues].sort((a, b) => {
    const score = (x) => (x.flags.includes('prompt') ? 3 : 0)
      + (x.flags.includes('cache') ? 2 : 0)
      + (x.flags.includes('ttft') ? 1 : 0)
      + ((x.ttft || 0) / 1000);
    return score(b) - score(a) || (b.prompt || 0) - (a.prompt || 0);
  });
  const worst = ranked.slice(0, 2);
  if (worst.length === 0) {
    return `Session span ${meta.spanSec}s across ${meta.turns} turns looks stable: cache ~${formatPct(meta.cacheHit)}, mean prompt ~${formatTok(meta.avgPromptTok)}tok; no iteration tripped cache, prompt-jump, or TTFT thresholds.`;
  }
  const parts = worst.map((w) => {
    const causes = [];
    if (w.flags.includes('prompt') || (w.ctxBytes && w.ctxBytes > 500_000)) causes.push('context spike');
    if (w.flags.includes('cache')) causes.push('cache break');
    if (w.flags.includes('ttft')) causes.push('slow TTFT');
    if (w.tools && w.tools.size >= 4) causes.push('tool overuse');
    if (causes.length === 0) causes.push('mixed pressure');
    return `it=${w.it} (${causes.join(', ')})`;
  });
  return `Worst iterations: ${parts.join('; ')}. Classification follows fired thresholds: prompt jump → context spike; cache drop → cache break; many tools → tool overuse; high TTFT → latency.`;
}

function sessionMatchesQuery(id, query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (id === q) return true;
  if (id.startsWith(q)) return true;
  const short = shortSessionId(id);
  if (short === q || short.startsWith(q)) return true;
  const core = id.startsWith('sess_') ? id.slice(5) : id;
  return core.startsWith(q);
}

function findSessionsByQuery(summaries, query) {
  return summaries.filter((s) => sessionMatchesQuery(s.id, query));
}

const files = defaultTraceFiles();
const sinceTs = parseSince(sinceArg);
const allRows = files.flatMap(readRows)
  .filter((row) => sinceTs == null || Number(row.ts || 0) >= sinceTs)
  .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

const bySession = new Map();
for (const row of allRows) {
  const sid = row.session_id || field(row, 'session_id');
  if (!sid) continue;
  if (!bySession.has(sid)) bySession.set(sid, []);
  bySession.get(sid).push(row);
}

const sessionSummaries = [];
for (const [id, rows] of bySession.entries()) {
  const meta = deriveSessionMeta(rows);
  if (agentFilter && String(meta.agent || '') !== agentFilter) continue;
  sessionSummaries.push({ id, meta });
}

function buildListJson(limited) {
  return limited.map(({ id, meta }) => ({
    session_id: id,
    last_activity: timeHms(meta.maxTs),
    last_ts: meta.maxTs,
    agent: meta.agent,
    model: meta.model,
    provider: meta.provider,
    short_id: shortSessionId(id),
    turns: meta.turns,
    tools: meta.tools,
    tools_per_turn: meta.toolsPerTurn,
    avg_prompt_tokens: meta.avgPromptTok,
    cache_hit_pct: meta.cacheHit,
    avg_ttft_ms: meta.avgTtft,
    span_sec: meta.spanSec,
  }));
}

function renderListView() {
  const sorted = [...sessionSummaries].sort((a, b) => Number(b.meta.maxTs || 0) - Number(a.meta.maxTs || 0));
  const limited = sorted.slice(0, limit);
  if (jsonMode) {
    console.log(JSON.stringify(buildListJson(limited), null, 2));
    return;
  }
  const header = [
    'lastActivity',
    'agent',
    'model',
    'sess',
    'turns',
    'tools',
    'tools/turn',
    'avgPromptTok',
    'cacheHit%',
    'avgTTFTms',
    'spanSec',
  ];
  const dataRows = limited.map(({ id, meta }) => [
    timeHms(meta.maxTs),
    meta.agent || '-',
    shortModel(meta.model),
    shortSessionId(id),
    String(meta.turns),
    String(meta.tools),
    String(meta.toolsPerTurn),
    formatTok(meta.avgPromptTok),
    formatPct(meta.cacheHit),
    meta.avgTtft != null ? String(meta.avgTtft) : '-',
    String(meta.spanSec),
  ]);
  for (const line of padColumns([header, ...dataRows])) console.log(line);
}

function buildDetailObject(full) {
  const meta = full.meta;
  const ttftStats = stats(meta.sseRows.map((r) => numberField(r, 'ttft_ms')));
  const timeline = buildTimeline(meta);
  const children = sessionSummaries
    .filter((s) => s.meta.parentSessionId && String(s.meta.parentSessionId) === String(full.id))
    .map((s) => ({
      session_id: s.id,
      agent: s.meta.agent,
      short_id: shortSessionId(s.id),
      turns: s.meta.turns,
      total_prompt_tokens: s.meta.totalPrompt,
      cache_hit_pct: s.meta.cacheHit,
    }));
  return {
    session_id: full.id,
    short_id: shortSessionId(full.id),
    agent: meta.agent,
    model: meta.model,
    provider: meta.provider,
    turns: meta.turns,
    span_sec: meta.spanSec,
    total_prompt_tokens: meta.totalPrompt,
    total_output_tokens: meta.totalOutput,
    cache_hit_pct: meta.cacheHit,
    ttft_p50_ms: ttftStats?.p50 ?? null,
    ttft_p90_ms: ttftStats?.p90 ?? null,
    timeline: timeline.lines,
    diagnosis: autoDiagnosis(meta, timeline),
    children,
  };
}

function renderDetailView(query) {
  const matches = findSessionsByQuery(sessionSummaries, query);
  if (matches.length === 0) {
    console.log(`no session matched: ${query}`);
    return;
  }
  if (matches.length > 1) {
    console.log(`multiple sessions matched "${query}":`);
    for (const s of matches) {
      console.log(`  ${shortSessionId(s.id)}  ${s.id}  agent=${s.meta.agent || '-'}`);
    }
    return;
  }
  const full = matches[0];
  const detail = buildDetailObject(full);
  if (jsonMode) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  const meta = full.meta;
  const ttftStats = stats(meta.sseRows.map((r) => numberField(r, 'ttft_ms')));
  console.log(`session ${detail.short_id}  agent=${meta.agent || '-'}  model=${meta.model || '-'}  provider=${meta.provider || '-'}`);
  console.log(`turns=${meta.turns}  span=${meta.spanSec}s  prompt=${meta.totalPrompt}tok  output=${meta.totalOutput}tok  cacheHit=${formatPct(meta.cacheHit)}  ttft p50/p90=${ttftStats?.p50 ?? '-'} / ${ttftStats?.p90 ?? '-'}ms`);
  console.log('');
  for (const l of detail.timeline) {
    console.log(`it=${l.it}  tools: ${l.tools}   ctx: ${l.ctx}   prompt: ${l.prompt}  cached: ${l.cached}  ttft: ${l.ttft}${l.warn}`);
  }
  if (treeMode && detail.children.length > 0) {
    console.log('');
    console.log('child sessions:');
    for (const c of detail.children) {
      console.log(`  ↳ ${c.agent || '-'}  ${c.short_id}  turns=${c.turns}  prompt=${c.total_prompt_tokens}tok  cacheHit=${formatPct(c.cache_hit_pct)}`);
    }
  }
  console.log('');
  console.log(detail.diagnosis);
}

if (sessionArg) {
  renderDetailView(sessionArg);
} else {
  renderListView();
}
