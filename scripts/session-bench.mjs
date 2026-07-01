#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { resolvePluginData } from '../src/runtime/shared/plugin-paths.mjs';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseDuration(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
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

const opts = {
  trace: argValue('--trace', null),
  session: argValue('--session', 'current'),
  since: parseDuration(argValue('--since', null)),
  agent: argValue('--agent', null),
  limit: Number.parseInt(argValue('--limit', '50'), 10) || 50,
  json: hasFlag('--json'),
  cacheOnly: hasFlag('--cache'),
  toolsOnly: hasFlag('--tools'),
  issuesOnly: hasFlag('--issues'),
  failuresOnly: hasFlag('--failures'),
  compactOnly: hasFlag('--compact'),
  tokensOnly: hasFlag('--tokens'),
  slowOnly: hasFlag('--slow'),
};

function defaultTracePath() {
  const data = process.env.MIXDOG_DATA_DIR || resolvePluginData() || resolve(homedir(), '.mixdog', 'data');
  return resolve(data, 'history', 'agent-trace.jsonl');
}

function defaultToolFailurePath(tracePath = null) {
  if (process.env.MIXDOG_TOOL_FAILURE_LOG_PATH) return process.env.MIXDOG_TOOL_FAILURE_LOG_PATH;
  const base = tracePath ? dirname(resolve(tracePath)) : resolve(process.env.MIXDOG_DATA_DIR || resolvePluginData() || resolve(homedir(), '.mixdog', 'data'), 'history');
  return resolve(base, 'tool-failures.jsonl');
}

function readRows(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      rows.push({ ...row, _line: i + 1 });
    } catch {
      // Keep JSONL parsing best-effort; a partially-written tail must not break diagnostics.
    }
  }
  return rows;
}

function payload(row) {
  return row?.payload && typeof row.payload === 'object' ? row.payload : {};
}

function field(row, name) {
  if (row && row[name] != null) return row[name];
  const p = payload(row);
  return p[name] != null ? p[name] : null;
}

function num(row, name) {
  const n = Number(field(row, name));
  return Number.isFinite(n) ? n : null;
}

function sessionId(row) {
  return String(row?.session_id || row?.sessionId || field(row, 'session_id') || '');
}

function baseSessionId(id) {
  return String(id || '').replace(/:compact$/, '');
}

function isCompactSessionId(id) {
  return String(id || '').endsWith(':compact');
}

function stableStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',') + '}';
}

function hashValue(value) {
  try { return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16); }
  catch { return null; }
}

function toolArgs(row) {
  return field(row, 'tool_args_summary') || field(row, 'tool_args') || null;
}

function toolArgsHash(row) {
  const args = toolArgs(row);
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return null;
  return field(row, 'tool_args_hash') || hashValue(args);
}

function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(n)}ms`;
}

function fmtSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
}

function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtPct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${Math.round(v)}%` : '-';
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function compactText(value, max = 140) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

function sum(values) {
  return values.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
}

function cacheDenom(row) {
  const prompt = num(row, 'prompt_tokens');
  const input = num(row, 'input_tokens');
  return prompt || input || 0;
}

function cacheRatioFromUsage(rows) {
  let cached = 0;
  let total = 0;
  for (const row of rows) {
    cached += num(row, 'cached_tokens') || 0;
    total += cacheDenom(row);
  }
  return total > 0 ? cached / total : null;
}

function cacheBreakExplanation(reason) {
  const r = String(reason || '');
  if (r === 'no_anchor') return 'delta 기준점/previous response 없음';
  if (r === 'input_prefix_mismatch') return '요청 prefix가 이전 turn과 달라짐';
  if (r.startsWith('response_output_mismatch')) return '이전 응답 output 체인이 기대값과 다름';
  if (r === 'cache_key_changed') return 'cache key 변경';
  return r ? '원인 미분류' : '원인 기록 없음';
}

function classifyCacheBreakPhase(row, usageRows, transportRows) {
  const reason = field(row, 'reason') || field(row, 'chain_delta_reason') || field(row, 'payload')?.reason || null;
  const sid = sessionId(row);
  if (isCompactSessionId(sid)) return 'intentional_compact';
  const ts = Number(row.ts || 0);
  const priorUsage = usageRows.filter((r) => sessionId(r) === sid && Number(r.ts || 0) < ts)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const priorTransport = transportRows.filter((r) => sessionId(r) === sid && Number(r.ts || 0) < ts)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const priorCalls = priorUsage.length + priorTransport.length;
  if (String(reason || '') === 'no_anchor') {
    if (priorCalls === 0) return 'cold_start';
    return 'mid_chain_reset';
  }
  if (priorCalls === 0) return 'first_call_mismatch';
  return 'mid_chain_break';
}

function shortId(id) {
  const s = String(id || '');
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function padTable(rows) {
  if (!rows.length) return [];
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, String(cell ?? '').length); });
  }
  return rows.map((row) => row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  '));
}

function inferSessionMeta(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const preset = sorted.find((r) => r.kind === 'preset_assign');
  const usage = [...sorted].reverse().find((r) => r.kind === 'usage_raw' || r.kind === 'usage');
  const tool = sorted.find((r) => r.kind === 'tool');
  const context = sorted.find((r) => r.kind === 'context');
  const last = sorted[sorted.length - 1] || {};
  const tsValues = sorted.map((r) => Number(r.ts || 0)).filter((n) => n > 0);
  return {
    session_id: sessionId(last),
    parent_session_id: field(preset, 'parent_session_id') || field(preset, 'parentSessionId') || null,
    agent: field(preset, 'agent') || field(tool, 'agent') || field(usage, 'sourceName') || field(last, 'sourceName') || null,
    preset: field(preset, 'preset_name') || field(last, 'preset') || null,
    provider: field(preset, 'provider') || field(usage, 'provider') || field(context, 'provider') || null,
    model: field(preset, 'model') || field(usage, 'model') || field(context, 'model') || null,
    min_ts: tsValues.length ? Math.min(...tsValues) : null,
    max_ts: tsValues.length ? Math.max(...tsValues) : null,
    rows: sorted.length,
  };
}

function chooseCurrentSession(sessionMetas) {
  const sorted = [...sessionMetas].sort((a, b) => Number(b.max_ts || 0) - Number(a.max_ts || 0));
  // "current" should mean the freshest active route, not necessarily the
  // oldest root workflow that still has background child events. Prefer recent
  // workflow-lead/main rows, then fall back to newest activity.
  const main = sorted.find((m) => {
    const agent = String(m.agent || '').toLowerCase();
    const preset = String(m.preset || '').toLowerCase();
    return agent === 'main' || agent === 'lead' || preset.includes('workflow lead');
  });
  return main || sorted.find((m) => !m.parent_session_id && m.model) || sorted[0] || null;
}

function sessionMatches(id, query) {
  const q = String(query || '').trim();
  if (!q || q === 'current') return false;
  return id === q || id.startsWith(q) || shortId(id).startsWith(q);
}

function selectSessionIds(sessionMetas, query) {
  let selected;
  if (!query || query === 'current') selected = chooseCurrentSession(sessionMetas);
  else selected = sessionMetas.find((m) => sessionMatches(m.session_id, query));
  if (!selected) return [];
  const root = selected.parent_session_id
    ? sessionMetas.find((m) => m.session_id === selected.parent_session_id) || selected
    : selected;
  const ids = new Set([root.session_id]);
  for (const meta of sessionMetas) {
    if (meta.parent_session_id === root.session_id) ids.add(meta.session_id);
  }
  if (selected.session_id) ids.add(selected.session_id);
  return [...ids];
}

function filterAgent(rows, agent) {
  if (!agent) return rows;
  const q = String(agent).toLowerCase();
  return rows.filter((r) => {
    const values = [
      field(r, 'agent'),
      field(r, 'agent'),
      field(r, 'sourceName'),
      field(r, 'preset'),
      field(r, 'preset_name'),
    ].filter(Boolean).map((v) => String(v).toLowerCase());
    return values.some((v) => v.includes(q));
  });
}

function buildRouteGroups(rows) {
  const bySid = groupBy(rows, sessionId);
  const groups = [];
  for (const [sid, srows] of bySid.entries()) {
    const meta = inferSessionMeta(srows);
    const usageRows = srows.filter((r) => r.kind === 'usage_raw');
    const toolRows = srows.filter((r) => r.kind === 'tool');
    const sseRows = srows.filter((r) => r.kind === 'sse');
    const fetchRows = srows.filter((r) => r.kind === 'fetch');
    const transportRows = srows.filter((r) => r.kind === 'transport');
    const turns = usageRows.length || new Set(transportRows.map((r) => num(r, 'iteration')).filter((n) => n != null)).size;
    const promptTokens = sum(usageRows.map((r) => num(r, 'prompt_tokens')));
    const outputTokens = sum(usageRows.map((r) => num(r, 'output_tokens')));
    const cachedTokens = sum(usageRows.map((r) => num(r, 'cached_tokens')));
    const cacheRatio = cacheRatioFromUsage(usageRows);
    groups.push({
      ...meta,
      session_id: sid,
      turns,
      tool_calls: toolRows.length,
      tool_ms: sum(toolRows.map((r) => num(r, 'tool_ms'))),
      llm_stream_ms: sum(sseRows.map((r) => num(r, 'stream_total_ms') ?? num(r, 'sse_parse_ms'))),
      headers_ms: sum(fetchRows.map((r) => num(r, 'headers_ms'))),
      ttft_p50_ms: percentile(sseRows.map((r) => num(r, 'ttft_ms')).filter((n) => n != null), 50),
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cache_ratio: cacheRatio,
      ws_full: transportRows.filter((r) => field(r, 'ws_mode') === 'full').length,
      ws_delta: transportRows.filter((r) => field(r, 'ws_mode') === 'delta').length,
      reused_connection: transportRows.filter((r) => field(r, 'reused_connection') === true).length,
      transport_rows: transportRows.length,
    });
  }
  return groups.sort((a, b) => Number(a.min_ts || 0) - Number(b.min_ts || 0));
}

function buildCacheDiagnostics(rows) {
  const transport = rows.filter((r) => r.kind === 'transport');
  const usage = rows.filter((r) => r.kind === 'usage_raw');
  const breaks = rows.filter((r) => r.kind === 'cache_break');
  const keyCounts = new Map();
  for (const r of transport) {
    const key = field(r, 'cache_key_hash');
    if (key) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  }
  const downgrades = transport.filter((r) => {
    const requested = field(r, 'requested_service_tier');
    const response = field(r, 'response_service_tier');
    return requested && response && requested !== response;
  }).map((r) => ({
    session_id: sessionId(r),
    iteration: num(r, 'iteration'),
    requested: field(r, 'requested_service_tier'),
    response: field(r, 'response_service_tier'),
    model: field(r, 'model'),
    ts: r.ts,
  }));
  return {
    usage_cache_ratio: cacheRatioFromUsage(usage),
    cached_tokens: sum(usage.map((r) => num(r, 'cached_tokens'))),
    prompt_tokens: sum(usage.map((r) => num(r, 'prompt_tokens'))),
    transport_count: transport.length,
    ws_full: transport.filter((r) => field(r, 'ws_mode') === 'full').length,
    ws_delta: transport.filter((r) => field(r, 'ws_mode') === 'delta').length,
    reused_connection: transport.filter((r) => field(r, 'reused_connection') === true).length,
    previous_response_id: transport.filter((r) => field(r, 'request_has_previous_response_id') === true).length,
    cache_key_hashes: [...keyCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count),
    cache_breaks: breaks.map((r) => {
      const reason = field(r, 'reason') || field(r, 'chain_delta_reason') || field(r, 'payload')?.reason || null;
      const relatedUsage = nearestRowAround(
        usage,
        r.ts,
        5_000,
        (u) => sessionId(u) === sessionId(r) && num(u, 'iteration') === num(r, 'iteration'),
      ) || nearestRowBefore(
        usage.filter((u) => sessionId(u) === sessionId(r)),
        r.ts,
        30_000,
      );
      const promptTokens = relatedUsage ? cacheDenom(relatedUsage) : 0;
      const cachedTokens = relatedUsage ? (num(relatedUsage, 'cached_tokens') || 0) : 0;
      return {
        session_id: sessionId(r),
        iteration: num(r, 'iteration'),
        reason,
        phase: classifyCacheBreakPhase(r, usage, transport),
        explanation: cacheBreakExplanation(reason),
        ws_mode: field(r, 'ws_mode'),
        cache_key_hash: field(r, 'cache_key_hash'),
        request_has_previous_response_id: field(r, 'request_has_previous_response_id'),
        body_input_items: field(r, 'body_input_items'),
        frame_input_items: field(r, 'frame_input_items'),
        prompt_tokens: promptTokens,
        cached_tokens: cachedTokens,
        cache_ratio: promptTokens > 0 ? cachedTokens / promptTokens : null,
        output_tokens: relatedUsage ? (num(relatedUsage, 'output_tokens') || 0) : 0,
        ts: r.ts,
      };
    }),
    service_tier_downgrades: downgrades,
    low_cache_turns: usage.map((r) => {
      const denom = cacheDenom(r);
      const ratio = denom > 0 ? (num(r, 'cached_tokens') || 0) / denom : null;
      return { session_id: sessionId(r), iteration: num(r, 'iteration'), ratio, cached_tokens: num(r, 'cached_tokens') || 0, prompt_tokens: denom, ts: r.ts };
    }).filter((x) => x.prompt_tokens >= 1000 && (x.ratio == null || x.ratio < 0.25)),
  };
}

function summarizeToolTarget(row) {
  const args = toolArgs(row) || {};
  const name = String(field(row, 'tool_name') || '');
  if (name === 'read') return `${args.path || '?'}:${args.line || args.offset || ''}`;
  if (name === 'grep') return `${args.path || '?'} :: ${String(args.pattern || '').slice(0, 80)}`;
  if (name === 'code_graph') return `${args.mode || '?'} ${args.file || ''} ${args.symbol || ''}`.trim();
  if (name === 'find') return `${args.path || '?'} :: ${args.query || ''}`;
  if (name === 'glob') return `${args.path || '?'} :: ${args.pattern || ''}`;
  if (name === 'list') return String(args.path || '?');
  if (name === 'shell') return compactText(args.command || args.cmd || hashValue(args) || '-', 140);
  if (name === 'agent') return compactText(`${args.agent || args.type || 'agent'} ${args.tag || args.task_id || ''} ${args.prompt || args.message || ''}`, 140);
  if (name === 'apply_patch') return 'patch';
  return hashValue(args) || '-';
}

function toolResultKind(row) {
  return String(field(row, 'result_kind') || 'unknown').toLowerCase();
}

function toolFailureReason(row) {
  const candidates = [
    field(row, 'error'),
    field(row, 'message'),
    field(row, 'result_error'),
    field(row, 'result_preview'),
    field(row, 'result_excerpt'),
    field(row, 'error_first_line'),
    field(row, 'error_preview'),
    field(row, 'stderr'),
    field(row, 'stdout'),
  ];
  const hit = candidates.find((v) => v != null && String(v).trim());
  return hit ? compactText(hit, 180) : null;
}

function toolFailureCategory(row) {
  return field(row, 'category') || null;
}

function findFailureDetail(row, failureRows = []) {
  const sid = sessionId(row);
  const it = num(row, 'iteration');
  const tool = field(row, 'tool_name');
  const ts = Number(row.ts || 0);
  let best = null;
  let bestDelta = Infinity;
  for (const f of failureRows) {
    if (sessionId(f) !== sid) continue;
    if (tool && field(f, 'tool_name') !== tool) continue;
    if (it != null && num(f, 'iteration') !== it) continue;
    const fts = Number(f.ts || 0);
    const delta = Number.isFinite(ts) && Number.isFinite(fts) ? Math.abs(fts - ts) : 0;
    if (delta <= 120_000 && delta < bestDelta) {
      best = f;
      bestDelta = delta;
    }
  }
  return best;
}

function summarizeKindCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const kind = toolResultKind(row);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, count }));
}

function fmtKindCounts(counts, limit = 3) {
  const shown = (counts || []).slice(0, limit).map((x) => `${x.kind}×${x.count}`);
  const hidden = Math.max(0, (counts || []).length - shown.length);
  return `${shown.join(', ')}${hidden ? ` +${hidden}` : ''}` || '-';
}

function buildToolDiagnostics(rows, failureRows = []) {
  const tools = rows.filter((r) => r.kind === 'tool');
  const byName = [];
  for (const [name, trows] of groupBy(tools, (r) => String(field(r, 'tool_name') || '(unknown)')).entries()) {
    const kindCounts = summarizeKindCounts(trows);
    const errors = trows.filter((r) => toolResultKind(r) === 'error').length;
    byName.push({
      tool: name,
      count: trows.length,
      ok: trows.length - errors,
      errors,
      result_kinds: kindCounts,
      total_ms: sum(trows.map((r) => num(r, 'tool_ms'))),
      p50_ms: percentile(trows.map((r) => num(r, 'tool_ms')).filter((n) => n != null), 50),
      p95_ms: percentile(trows.map((r) => num(r, 'tool_ms')).filter((n) => n != null), 95),
      bytes: sum(trows.map((r) => num(r, 'result_bytes_est'))),
      lines: sum(trows.map((r) => num(r, 'result_lines_est'))),
    });
  }
  byName.sort((a, b) => b.total_ms - a.total_ms || b.count - a.count);

  const duplicates = [];
  for (const [key, trows] of groupBy(tools, (r) => `${field(r, 'tool_name') || ''}:${toolArgsHash(r) || ''}`).entries()) {
    if (!key.endsWith(':') && trows.length >= 2) {
      const sorted = [...trows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
      for (let i = 1; i < sorted.length; i += 1) {
        if (Number(sorted[i].ts || 0) - Number(sorted[i - 1].ts || 0) <= 120_000) {
          duplicates.push({
            tool: field(sorted[i], 'tool_name'),
            count: trows.length,
            result_kinds: summarizeKindCounts(trows),
            first_ts: sorted[0].ts,
            last_ts: sorted[sorted.length - 1].ts,
            target: summarizeToolTarget(sorted[i]),
            args_hash: toolArgsHash(sorted[i]),
          });
          break;
        }
      }
    }
  }
  duplicates.sort((a, b) => b.count - a.count);

  const failedRepeats = [];
  for (const dup of duplicates) {
    const matches = tools.filter((r) => field(r, 'tool_name') === dup.tool && toolArgsHash(r) === dup.args_hash);
    const errors = matches.filter((r) => toolResultKind(r) === 'error');
    if (errors.length >= 2) failedRepeats.push({ ...dup, error_count: errors.length });
  }

  const failures = tools
    .filter((r) => toolResultKind(r) === 'error')
    .map((r) => {
      const detail = findFailureDetail(r, failureRows);
      return {
        tool: field(r, 'tool_name'),
        session_id: sessionId(r),
        agent: field(r, 'agent') || field(r, 'sourceName') || field(detail, 'agent') || null,
        iteration: num(r, 'iteration'),
        tool_ms: num(r, 'tool_ms') || num(detail, 'tool_ms') || 0,
        bytes: num(r, 'result_bytes_est') || num(detail, 'result_bytes_est') || 0,
        lines: num(r, 'result_lines_est') || num(detail, 'result_lines_est') || 0,
        category: toolFailureCategory(detail) || toolFailureCategory(r),
        reason: toolFailureReason(detail) || toolFailureReason(r),
        preview: field(detail, 'error_preview') || null,
        target: summarizeToolTarget(detail || r),
        ts: r.ts,
      };
    })
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const successes = tools
    .filter((r) => toolResultKind(r) !== 'error')
    .map((r) => ({
      tool: field(r, 'tool_name'),
      session_id: sessionId(r),
      agent: field(r, 'agent') || field(r, 'sourceName') || null,
      iteration: num(r, 'iteration'),
      tool_ms: num(r, 'tool_ms') || 0,
      bytes: num(r, 'result_bytes_est') || 0,
      lines: num(r, 'result_lines_est') || 0,
      result_kind: toolResultKind(r),
      target: summarizeToolTarget(r),
      ts: r.ts,
    }))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const broadResults = tools.filter((r) => {
    const bytes = num(r, 'result_bytes_est') || 0;
    const lines = num(r, 'result_lines_est') || 0;
    return bytes >= 64 * 1024 || lines >= 1000 || String(field(r, 'result_kind') || '').includes('offload');
  }).map((r) => ({
    tool: field(r, 'tool_name'),
    session_id: sessionId(r),
    iteration: num(r, 'iteration'),
    bytes: num(r, 'result_bytes_est') || 0,
    lines: num(r, 'result_lines_est') || 0,
    target: summarizeToolTarget(r),
    ts: r.ts,
  })).sort((a, b) => b.bytes - a.bytes);

  const readRows = tools.filter((r) => field(r, 'tool_name') === 'read');
  const readFragmentation = [];
  for (const [path, rrows] of groupBy(readRows, (r) => String((toolArgs(r) || {}).path || '')).entries()) {
    if (!path || path.includes(',')) continue;
    const lineReads = rrows.map((r) => ({ row: r, line: Number((toolArgs(r) || {}).line || (toolArgs(r) || {}).offset || 0), ts: Number(r.ts || 0) }))
      .filter((x) => Number.isFinite(x.line) && x.line > 0)
      .sort((a, b) => a.line - b.line);
    if (lineReads.length >= 3) {
      const span = lineReads[lineReads.length - 1].line - lineReads[0].line;
      const timeSpan = Math.max(...lineReads.map((x) => x.ts)) - Math.min(...lineReads.map((x) => x.ts));
      if (span <= 800 && timeSpan <= 10 * 60_000) {
        readFragmentation.push({ path, count: lineReads.length, line_span: span, time_span_ms: timeSpan });
      }
    }
  }
  readFragmentation.sort((a, b) => b.count - a.count);

  const singleToolBatches = rows.filter((r) => r.kind === 'batch' && Number(field(r, 'tool_call_count')) === 1)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  let missedParallelism = 0;
  const singleToolBatchDetails = singleToolBatches.map((batch) => {
    const bts = Number(batch.ts || 0);
    const sid = sessionId(batch);
    const tool = tools
      .filter((r) => sessionId(r) === sid && Number(r.ts || 0) >= bts - 100 && Number(r.ts || 0) <= bts + 15_000)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))[0] || null;
    return {
      batch,
      ts: bts,
      session_id: sid,
      agent: field(batch, 'agent') || field(tool, 'agent') || null,
      iteration: num(tool || batch, 'iteration'),
      tool: field(tool, 'tool_name') || '(unknown)',
      tool_ms: num(tool, 'tool_ms') || 0,
      result_kind: tool ? toolResultKind(tool) : 'unknown',
      target: tool ? summarizeToolTarget(tool) : '-',
    };
  });
  const sequentialClusters = [];
  let cluster = [];
  for (let i = 1; i < singleToolBatches.length; i += 1) {
    if (Number(singleToolBatches[i].ts || 0) - Number(singleToolBatches[i - 1].ts || 0) <= 15_000) missedParallelism += 1;
  }
  for (const detail of singleToolBatchDetails) {
    const prev = cluster[cluster.length - 1];
    if (prev && detail.session_id === prev.session_id && detail.ts - prev.ts <= 15_000) {
      cluster.push(detail);
    } else {
      if (cluster.length >= 3) sequentialClusters.push(cluster);
      cluster = [detail];
    }
  }
  if (cluster.length >= 3) sequentialClusters.push(cluster);
  const sequentialToolClusters = sequentialClusters.map((items) => {
    const toolCounts = countBy(items, (x) => x.tool).slice(0, 5).map(([tool, count]) => ({ tool, count }));
    const errorCount = items.filter((x) => x.result_kind === 'error').length;
    return {
      session_id: items[0].session_id,
      agent: items[0].agent || null,
      count: items.length,
      span_ms: items[items.length - 1].ts - items[0].ts,
      tool_ms: sum(items.map((x) => x.tool_ms)),
      errors: errorCount,
      tools: toolCounts,
      start_it: items[0].iteration,
      end_it: items[items.length - 1].iteration,
      examples: items.slice(0, 3).map((x) => `${x.tool}:${compactText(x.target, 80)}`),
    };
  }).sort((a, b) => b.count - a.count || b.tool_ms - a.tool_ms).slice(0, 20);

  return {
    total_tool_calls: tools.length,
    total_tool_ms: sum(tools.map((r) => num(r, 'tool_ms'))),
    result_kinds: summarizeKindCounts(tools),
    by_name: byName,
    failures: failures.slice(0, 20),
    recent_successes: successes.slice(0, 20),
    duplicates: duplicates.slice(0, 20),
    failed_repeats: failedRepeats.slice(0, 20),
    broad_results: broadResults.slice(0, 20),
    read_fragmentation: readFragmentation.slice(0, 20),
    missed_parallelism_heuristic: {
      consecutive_single_tool_batches: missedParallelism,
      single_tool_batches: singleToolBatches.length,
    },
    sequential_tool_clusters: sequentialToolClusters,
  };
}

function nearestRowBefore(rows, ts, maxBeforeMs = 120_000) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const row of rows) {
    const rts = Number(row.ts || 0);
    if (!Number.isFinite(rts) || rts > t) continue;
    const delta = t - rts;
    if (delta <= maxBeforeMs && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

function nearestRowAround(rows, ts, maxDeltaMs = 1_000, predicate = null) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const row of rows) {
    if (predicate && !predicate(row)) continue;
    const rts = Number(row.ts || 0);
    if (!Number.isFinite(rts)) continue;
    const delta = Math.abs(rts - t);
    if (delta <= maxDeltaMs && delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

function buildTurnDiagnostics(rows, routeGroups) {
  const sessionMeta = new Map(routeGroups.map((g) => [g.session_id, g]));
  const bySid = groupBy(rows, sessionId);
  const turns = [];
  for (const [sid, srows] of bySid.entries()) {
    const meta = sessionMeta.get(sid) || inferSessionMeta(srows);
    const usageRows = srows.filter((r) => r.kind === 'usage_raw');
    const fetchRows = srows.filter((r) => r.kind === 'fetch');
    const sseRows = srows.filter((r) => r.kind === 'sse');
    const transportRows = srows.filter((r) => r.kind === 'transport');
    const cacheBreakRows = srows.filter((r) => r.kind === 'cache_break');
    const toolRows = srows.filter((r) => r.kind === 'tool');
    const usageSorted = [...usageRows].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const seenByIteration = new Map();

    const pushTurn = ({ usage = null, transport = null, tools = [], cacheBreaks = [], nextTs = Infinity }) => {
      const iteration = num(usage || transport || tools[0] || cacheBreaks[0], 'iteration');
      const occurrence = (seenByIteration.get(iteration) || 0) + 1;
      seenByIteration.set(iteration, occurrence);
      const tRef = Number(usage?.ts || transport?.ts || tools.at(-1)?.ts || 0);
      const sse = usage ? nearestRowBefore(sseRows, usage.ts, 10_000) : nearestRowBefore(sseRows, tRef, 10_000);
      const streamMs = sse ? (num(sse, 'stream_total_ms') ?? num(sse, 'sse_parse_ms') ?? 0) : 0;
      const fetchWindowMs = Math.max(30_000, streamMs + 10_000);
      const fetch = transport ? nearestRowBefore(fetchRows, transport.ts, fetchWindowMs) : nearestRowBefore(fetchRows, tRef, fetchWindowMs);
      const promptTokens = usage ? cacheDenom(usage) : 0;
      const cachedTokens = usage ? (num(usage, 'cached_tokens') || 0) : 0;
      const cacheRatio = promptTokens > 0 ? cachedTokens / promptTokens : null;
      const headersMs = fetch ? (num(fetch, 'headers_ms') || 0) : 0;
      const toolMs = sum(tools.map((r) => num(r, 'tool_ms')));
      const outputTokens = usage ? (num(usage, 'output_tokens') || 0) : 0;
      const thinkingTokens = usage ? (num(usage, 'thinking_tokens') || 0) : 0;
      const serviceRequested = transport ? field(transport, 'requested_service_tier') : null;
      const serviceResponse = transport ? field(transport, 'response_service_tier') : field(usage, 'service_tier');
      const flags = [];
      if (field(transport, 'ws_mode') === 'full') flags.push('full_ws');
      if (cacheBreaks.length) flags.push(`cache_break:${cacheBreaks.map((r) => field(r, 'reason') || field(r, 'chain_delta_reason') || field(r, 'payload')?.reason || 'unknown').join('|')}`);
      if (serviceRequested && serviceResponse && serviceRequested !== serviceResponse) flags.push(`tier:${serviceRequested}->${serviceResponse}`);
      if (streamMs >= 15_000) flags.push('slow_stream');
      if (headersMs >= 5_000) flags.push('slow_headers');
      if (toolMs >= 5_000) flags.push('slow_tools');
      if (promptTokens >= 50_000 && cacheRatio != null && cacheRatio < 0.8) flags.push('low_cache_large_prompt');
      turns.push({
        session_id: sid,
        agent: meta.agent || null,
        model: meta.model || null,
        provider: meta.provider || null,
        iteration,
        occurrence,
        turn_label: occurrence > 1 ? `${iteration ?? '-'}#${occurrence}` : String(iteration ?? '-'),
        ts: tRef || null,
        headers_ms: headersMs,
        stream_ms: streamMs,
        tool_ms: toolMs,
        approx_active_ms: headersMs + streamMs + toolMs,
        tool_calls: tools.length,
        prompt_tokens: promptTokens,
        output_tokens: outputTokens,
        thinking_tokens: thinkingTokens,
        cached_tokens: cachedTokens,
        cache_ratio: cacheRatio,
        ws_mode: transport ? field(transport, 'ws_mode') : null,
        reused_connection: transport ? field(transport, 'reused_connection') : null,
        has_previous_response_id: transport ? field(transport, 'request_has_previous_response_id') : null,
        service_requested: serviceRequested,
        service_response: serviceResponse,
        cache_breaks: cacheBreaks.map((r) => field(r, 'reason') || field(r, 'chain_delta_reason') || field(r, 'payload')?.reason || 'unknown'),
        top_tools: Object.values(tools.reduce((acc, r) => {
          const name = String(field(r, 'tool_name') || '(unknown)');
          if (!acc[name]) acc[name] = { tool: name, count: 0, ms: 0 };
          acc[name].count += 1;
          acc[name].ms += num(r, 'tool_ms') || 0;
          return acc;
        }, {})).sort((a, b) => b.ms - a.ms || b.count - a.count).slice(0, 3),
        flags,
      });
    };

    for (let idx = 0; idx < usageSorted.length; idx += 1) {
      const usage = usageSorted[idx];
      const iteration = num(usage, 'iteration');
      const ts = Number(usage.ts || 0);
      const nextTs = Number(usageSorted[idx + 1]?.ts || Infinity);
      const inWindow = (r) => {
        const rts = Number(r.ts || 0);
        return Number.isFinite(rts) && rts >= ts - 100 && rts < nextTs;
      };
      const sameIteration = (r) => num(r, 'iteration') === iteration;
      const transport = nearestRowAround(transportRows, ts, 1_000, sameIteration);
      const tools = toolRows.filter((r) => sameIteration(r) && inWindow(r));
      const cacheBreaks = cacheBreakRows.filter((r) => sameIteration(r) && inWindow(r));
      pushTurn({ usage, transport, tools, cacheBreaks, nextTs });
    }

    const usageMatchedTransports = new Set(usageSorted
      .map((usage) => nearestRowAround(transportRows, usage.ts, 1_000, (r) => num(r, 'iteration') === num(usage, 'iteration')))
      .filter(Boolean));
    for (const transport of transportRows.filter((r) => !usageMatchedTransports.has(r)).sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))) {
      const iteration = num(transport, 'iteration');
      const ts = Number(transport.ts || 0);
      const nextUsage = usageSorted.find((r) => Number(r.ts || 0) > ts);
      const nextTs = Number(nextUsage?.ts || Infinity);
      const tools = toolRows.filter((r) => num(r, 'iteration') === iteration && Number(r.ts || 0) >= ts - 100 && Number(r.ts || 0) < nextTs);
      const cacheBreaks = cacheBreakRows.filter((r) => num(r, 'iteration') === iteration && Number(r.ts || 0) >= ts - 100 && Number(r.ts || 0) < nextTs);
      pushTurn({ transport, tools, cacheBreaks, nextTs });
    }
  }
  const slowestActive = [...turns].sort((a, b) => b.approx_active_ms - a.approx_active_ms).slice(0, 20);
  const slowestStream = [...turns].sort((a, b) => b.stream_ms - a.stream_ms).slice(0, 20);
  const slowestTools = [...turns].sort((a, b) => b.tool_ms - a.tool_ms).slice(0, 20);
  const cacheBreakTurns = turns.filter((t) => t.cache_breaks.length > 0);
  return { turns, slowest_active: slowestActive, slowest_stream: slowestStream, slowest_tools: slowestTools, cache_break_turns: cacheBreakTurns };
}

function buildTokenDiagnostics(turns) {
  const bySession = groupBy([...turns].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)), (t) => t.session_id);
  const sessions = [];
  const growthTurns = [];
  const outputHeavy = [];
  const cacheMissCost = [];

  for (const [sid, trows] of bySession.entries()) {
    const useful = trows.filter((t) => Number(t.prompt_tokens || 0) > 0);
    if (!useful.length) continue;
    const first = useful[0];
    const last = useful[useful.length - 1];
    const maxPromptTurn = useful.reduce((best, t) => (Number(t.prompt_tokens || 0) > Number(best.prompt_tokens || 0) ? t : best), useful[0]);
    const totalOutput = sum(useful.map((t) => t.output_tokens));
    const totalThinking = sum(useful.map((t) => t.thinking_tokens));
    const uncachedTokens = sum(useful.map((t) => Math.max(0, (t.prompt_tokens || 0) - (t.cached_tokens || 0))));
    sessions.push({
      session_id: sid,
      agent: last.agent || first.agent || null,
      turns: useful.length,
      first_prompt: first.prompt_tokens || 0,
      last_prompt: last.prompt_tokens || 0,
      max_prompt: maxPromptTurn.prompt_tokens || 0,
      max_prompt_it: maxPromptTurn.turn_label || maxPromptTurn.iteration,
      prompt_growth: Math.max(0, (last.prompt_tokens || 0) - (first.prompt_tokens || 0)),
      total_output: totalOutput,
      total_thinking: totalThinking,
      uncached_tokens: uncachedTokens,
      cache_ratio: cacheRatioFromUsage(useful.map((t) => ({
        prompt_tokens: t.prompt_tokens,
        cached_tokens: t.cached_tokens,
      }))),
    });

    for (let i = 0; i < useful.length; i += 1) {
      const t = useful[i];
      const prev = useful[i - 1] || null;
      const promptDelta = prev ? (t.prompt_tokens || 0) - (prev.prompt_tokens || 0) : 0;
      const out = t.output_tokens || 0;
      const uncached = Math.max(0, (t.prompt_tokens || 0) - (t.cached_tokens || 0));
      const growthPerOutput = out > 0 ? promptDelta / out : null;
      const tokenRow = {
        session_id: sid,
        agent: t.agent || null,
        iteration: t.iteration,
        turn_label: t.turn_label || (t.iteration ?? '-'),
        prompt_tokens: t.prompt_tokens || 0,
        prompt_delta: promptDelta,
        output_tokens: out,
        thinking_tokens: t.thinking_tokens || 0,
        cached_tokens: t.cached_tokens || 0,
        cache_ratio: t.cache_ratio,
        uncached_tokens: uncached,
        growth_per_output: growthPerOutput,
        ts: t.ts,
      };
      if (promptDelta >= 5_000 || (growthPerOutput != null && growthPerOutput >= 10)) growthTurns.push(tokenRow);
      if (out >= 1_000 || (t.thinking_tokens || 0) >= 1_000) outputHeavy.push(tokenRow);
      if (uncached >= 10_000 || ((t.cache_ratio ?? 1) < 0.8 && (t.prompt_tokens || 0) >= 20_000)) cacheMissCost.push(tokenRow);
    }
  }

  sessions.sort((a, b) => b.prompt_growth - a.prompt_growth || b.total_output - a.total_output);
  growthTurns.sort((a, b) => b.prompt_delta - a.prompt_delta);
  outputHeavy.sort((a, b) => (b.output_tokens + b.thinking_tokens) - (a.output_tokens + a.thinking_tokens));
  cacheMissCost.sort((a, b) => b.uncached_tokens - a.uncached_tokens);
  return {
    sessions,
    growth_turns: growthTurns.slice(0, 20),
    output_heavy_turns: outputHeavy.slice(0, 20),
    cache_miss_cost_turns: cacheMissCost.slice(0, 20),
  };
}

function buildCompactDiagnostics(rows, selectedIds) {
  const selectedBase = new Set(selectedIds.map(baseSessionId));
  const compactRows = rows.filter((r) => {
    const sid = sessionId(r);
    return isCompactSessionId(sid) && selectedBase.has(baseSessionId(sid));
  });
  const metaRows = rows.filter((r) => {
    if (r.kind !== 'compact_meta') return false;
    return selectedBase.has(baseSessionId(sessionId(r)));
  }).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const cache = buildCacheDiagnostics(compactRows);
  const usageRows = compactRows.filter((r) => r.kind === 'usage_raw');
  const transportRows = compactRows.filter((r) => r.kind === 'transport');
  const sessions = [];
  for (const [sid, srows] of groupBy(compactRows, sessionId).entries()) {
    const usage = srows.filter((r) => r.kind === 'usage_raw');
    const transports = srows.filter((r) => r.kind === 'transport');
    const breaks = srows.filter((r) => r.kind === 'cache_break');
    const sseRows = srows.filter((r) => r.kind === 'sse');
    sessions.push({
      session_id: sid,
      base_session_id: baseSessionId(sid),
      turns: usage.length,
      prompt_tokens: sum(usage.map((r) => cacheDenom(r))),
      cached_tokens: sum(usage.map((r) => num(r, 'cached_tokens'))),
      output_tokens: sum(usage.map((r) => num(r, 'output_tokens'))),
      thinking_tokens: sum(usage.map((r) => num(r, 'thinking_tokens'))),
      stream_ms: sum(sseRows.map((r) => num(r, 'stream_total_ms') ?? num(r, 'sse_parse_ms'))),
      cache_ratio: cacheRatioFromUsage(usage),
      breaks: breaks.length,
      no_anchor: breaks.filter((r) => String(field(r, 'reason') || field(r, 'chain_delta_reason') || '').includes('no_anchor')).length,
      full_ws: transports.filter((r) => field(r, 'ws_mode') === 'full').length,
      delta_ws: transports.filter((r) => field(r, 'ws_mode') === 'delta').length,
    });
  }
  sessions.sort((a, b) => b.stream_ms - a.stream_ms || b.prompt_tokens - a.prompt_tokens);
  return {
    rows: compactRows.length,
    sessions,
    meta_rows: metaRows.length,
    recent_meta: metaRows.slice(0, 10).map((r) => {
      const details = field(r, 'details') || {};
      const semantic = details?.semantic || null;
      const recall = details?.recallFastTrack || null;
      const pipe = recall?.pipeline || null;
      return {
        session_id: sessionId(r),
        ts: r.ts || null,
        iteration: num(r, 'iteration'),
        stage: field(r, 'stage'),
        trigger: field(r, 'trigger'),
        compact_type: field(r, 'compact_type'),
        changed: field(r, 'compact_changed') === true,
        before_tokens: num(r, 'message_tokens_est'),
        pressure_tokens: num(r, 'pressure_tokens'),
        trigger_tokens: num(r, 'trigger_tokens'),
        boundary_tokens: num(r, 'boundary_tokens') ?? num(r, 'budget_tokens'),
        target_budget_tokens: num(r, 'target_budget_tokens'),
        after_tokens: recall?.finalTokens ?? semantic?.finalTokens ?? null,
        before_messages: num(r, 'before_count'),
        after_messages: num(r, 'after_count'),
        duration_ms: num(r, 'duration_ms'),
        error: field(r, 'error'),
        recall_pipeline: pipe ? {
          ingest_ms: pipe.ingestMs ?? null,
          initial_dump_ms: pipe.initialDumpMs ?? null,
          initial_raw_pending: pipe.initialRawPending ?? null,
          cycle1_ms: pipe.cycle1Ms ?? null,
          cycle1_passes: pipe.cycle1Passes ?? null,
          cycle1_raw_remaining: pipe.cycle1RawRemaining ?? null,
          final_recall_kb: pipe.finalRecallBytes != null ? Math.round(pipe.finalRecallBytes / 1024) : null,
        } : null,
        fit: recall || semantic ? {
          head_messages: (recall || semantic).headMessages ?? null,
          tail_messages: (recall || semantic).tailMessages ?? null,
          mandatory_cost: (recall || semantic).mandatoryCost ?? null,
          remaining_tokens: (recall || semantic).remainingTokens ?? null,
          budget_raised: (recall || semantic).budgetRaised === true,
          final_tokens: (recall || semantic).finalTokens ?? null,
          recall_chars: recall?.recallChars ?? null,
          prior_chars: recall?.priorChars ?? null,
          tail_truncated: recall?.tailTruncated ?? null,
          summary_repaired: semantic?.summaryRepaired ?? null,
        } : null,
      };
    }),
    cache_breaks: cache.cache_breaks,
    usage_rows: usageRows.length,
    transport_rows: transportRows.length,
  };
}

function buildIssues(routeGroups, cache, tools) {
  const issues = [];
  for (const g of routeGroups) {
    if (g.ws_full > 0 && g.ws_delta === 0 && g.transport_rows > 0) {
      issues.push({ severity: 'high', type: 'cache', message: `${g.agent || shortId(g.session_id)} stayed full WS (${g.ws_full} full, 0 delta)`, session_id: g.session_id });
    } else if (g.ws_full > 0) {
      issues.push({ severity: 'medium', type: 'cache', message: `${g.agent || shortId(g.session_id)} had ${g.ws_full} full WS turn(s) before delta`, session_id: g.session_id });
    }
    if (g.cache_ratio != null && g.prompt_tokens > 5000 && g.cache_ratio < 0.25) {
      issues.push({ severity: 'high', type: 'cache', message: `${g.agent || shortId(g.session_id)} low cache ratio ${fmtPct(g.cache_ratio * 100)}`, session_id: g.session_id });
    }
  }
  for (const b of cache.cache_breaks.slice(0, 10)) {
    issues.push({ severity: b.reason === 'no_anchor' ? 'medium' : 'high', type: 'cache_break', message: `cache_break ${b.reason || 'unknown'} at it=${b.iteration ?? '-'}`, session_id: b.session_id });
  }
  if (cache.service_tier_downgrades.length) {
    const first = cache.service_tier_downgrades[0];
    issues.push({ severity: 'medium', type: 'service_tier', message: `${cache.service_tier_downgrades.length} service tier downgrade(s), e.g. ${first.requested}->${first.response}`, session_id: first.session_id });
  }
  if (tools.failures.length) {
    const byTool = new Map();
    for (const f of tools.failures) byTool.set(f.tool || '(unknown)', (byTool.get(f.tool || '(unknown)') || 0) + 1);
    const summary = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tool, count]) => `${tool}×${count}`).join(', ');
    issues.push({ severity: 'medium', type: 'tool_error', message: `${tools.failures.length} failed tool call(s): ${summary}` });
  }
  for (const dup of tools.duplicates.slice(0, 5)) {
    issues.push({ severity: 'low', type: 'duplicate_tool', message: `duplicate ${dup.tool} x${dup.count}: ${dup.target}`, args_hash: dup.args_hash });
  }
  for (const fail of tools.failed_repeats.slice(0, 5)) {
    issues.push({ severity: 'medium', type: 'failed_tool_repeat', message: `repeated failing ${fail.tool} x${fail.error_count}: ${fail.target}`, args_hash: fail.args_hash });
  }
  for (const broad of tools.broad_results.slice(0, 5)) {
    issues.push({ severity: 'medium', type: 'broad_tool_result', message: `${broad.tool} returned ${Math.round(broad.bytes / 1024)}KB/${broad.lines} lines: ${broad.target}`, session_id: broad.session_id });
  }
  for (const frag of tools.read_fragmentation.slice(0, 5)) {
    issues.push({ severity: 'low', type: 'read_fragmentation', message: `read fragmentation x${frag.count} within ${frag.line_span} lines: ${frag.path}` });
  }
  if (tools.missed_parallelism_heuristic.consecutive_single_tool_batches >= 3) {
    issues.push({ severity: 'low', type: 'missed_parallelism', message: `${tools.missed_parallelism_heuristic.consecutive_single_tool_batches} close consecutive single-tool batches` });
  }
  if (tools.sequential_tool_clusters?.length) {
    const c = tools.sequential_tool_clusters[0];
    const toolSummary = c.tools.map((x) => `${x.tool}×${x.count}`).join(', ');
    issues.push({ severity: 'low', type: 'tool_churn_cluster', message: `sequential single-tool cluster x${c.count} over ${fmtMs(c.span_ms)}: ${toolSummary}` });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return issues.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function buildWhySlowRankings(report) {
  const ranks = [];
  const topStream = report.stages.slowest_stream[0];
  if (topStream && topStream.stream_ms > 0) {
    ranks.push({ score: topStream.stream_ms / 1000, type: 'slow_stream', message: `${topStream.agent || '-'} it=${topStream.turn_label || topStream.iteration} stream=${fmtMs(topStream.stream_ms)} prompt=${fmtTok(topStream.prompt_tokens)} out=${fmtTok(topStream.output_tokens + topStream.thinking_tokens)}` });
  }
  const topTool = report.stages.slowest_tools[0];
  if (topTool && topTool.tool_ms > 0) {
    const label = topTool.top_tools.map((x) => `${x.tool}×${x.count}/${fmtMs(x.ms)}`).join(', ');
    ranks.push({ score: topTool.tool_ms / 1000, type: 'slow_tools', message: `${topTool.agent || '-'} it=${topTool.turn_label || topTool.iteration} tools=${fmtMs(topTool.tool_ms)} ${label}` });
  }
  if (report.tools.failures.length) {
    const summary = countBy(report.tools.failures, (f) => f.category || f.tool || 'unknown').slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    ranks.push({ score: 50 + report.tools.failures.length, type: 'tool_failures', message: `${report.tools.failures.length} failed tool call(s): ${summary}` });
  }
  if (report.cache.cache_breaks.length) {
    const summary = countBy(report.cache.cache_breaks, (b) => `${b.reason || 'unknown'}/${b.phase || 'unknown'}`).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    ranks.push({ score: 40 + report.cache.cache_breaks.length, type: 'cache_breaks', message: `${report.cache.cache_breaks.length} cache break(s): ${summary}` });
  }
  const topGrowth = report.tokens.growth_turns[0];
  if (topGrowth) {
    ranks.push({ score: Math.max(0, topGrowth.prompt_delta) / 1000, type: 'prompt_growth', message: `${topGrowth.agent || '-'} it=${topGrowth.turn_label} prompt Δ=${fmtTok(topGrowth.prompt_delta)} out=${fmtTok(topGrowth.output_tokens + topGrowth.thinking_tokens)} cache=${fmtPct((topGrowth.cache_ratio ?? 0) * 100)}` });
  }
  const topUncached = report.tokens.cache_miss_cost_turns[0];
  if (topUncached) {
    ranks.push({ score: topUncached.uncached_tokens / 1000, type: 'uncached_prompt', message: `${topUncached.agent || '-'} it=${topUncached.turn_label} uncached=${fmtTok(topUncached.uncached_tokens)} prompt=${fmtTok(topUncached.prompt_tokens)} cache=${fmtPct((topUncached.cache_ratio ?? 0) * 100)}` });
  }
  if (report.tools.duplicates.length) {
    const d = report.tools.duplicates[0];
    ranks.push({ score: 10 + d.count, type: 'tool_churn', message: `${d.tool} repeated x${d.count} kinds=${fmtKindCounts(d.result_kinds)}: ${d.target}` });
  }
  return ranks.sort((a, b) => b.score - a.score).slice(0, 10);
}

function buildExecutiveSummary(report) {
  const lines = [];
  const headers = report.summary.headers_ms || 0;
  const stream = report.summary.llm_stream_ms || 0;
  const tools = report.summary.total_tool_ms || 0;
  const total = headers + stream + tools;
  const dominant = [['stream', stream], ['tools', tools], ['headers', headers]].sort((a, b) => b[1] - a[1])[0];
  lines.push(`주 병목=${dominant[0]} ${fmtMs(dominant[1])}/${fmtMs(total)}; cache=${fmtPct((report.summary.cache_ratio ?? 0) * 100)}; turns=${report.summary.turns}; tools=${report.summary.tool_calls}`);
  if (report.cache.cache_breaks.length) {
    const summary = countBy(report.cache.cache_breaks, (b) => `${b.reason || 'unknown'}/${b.phase || 'unknown'}`).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(`캐시 깨짐=${report.cache.cache_breaks.length} (${summary})`);
  }
  if (report.compact?.cache_breaks?.length) {
    const summary = countBy(report.compact.cache_breaks, (b) => `${b.reason || 'unknown'}/${b.phase || 'unknown'}`).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(`컴팩트 호출=${report.compact.sessions.length} session, cache reset=${report.compact.cache_breaks.length} (${summary})`);
  }
  if (report.tools.failures.length) {
    const summary = countBy(report.tools.failures, (f) => f.category || f.tool || 'unknown').slice(0, 3).map(([k, v]) => `${k}×${v}`).join(', ');
    lines.push(`툴 실패=${report.tools.failures.length} (${summary})`);
  }
  const topGrowth = report.tokens.growth_turns[0];
  if (topGrowth) lines.push(`토큰 증폭=${topGrowth.agent || '-'} it=${topGrowth.turn_label} promptΔ=${fmtTok(topGrowth.prompt_delta)} out=${fmtTok(topGrowth.output_tokens + topGrowth.thinking_tokens)}`);
  const topChurn = report.tools.duplicates[0];
  if (topChurn) lines.push(`툴 헛돎=${topChurn.tool}×${topChurn.count} ${compactText(topChurn.target, 90)}`);
  return lines;
}

function buildReport(rows, selectedIds, failureRows = []) {
  const selected = rows.filter((r) => selectedIds.includes(sessionId(r)));
  const selectedFailures = failureRows.filter((r) => selectedIds.includes(sessionId(r)));
  const routeGroups = buildRouteGroups(selected);
  const cache = buildCacheDiagnostics(selected);
  const tools = buildToolDiagnostics(selected, selectedFailures);
  const stages = buildTurnDiagnostics(selected, routeGroups);
  const tokens = buildTokenDiagnostics(stages.turns);
  const compact = buildCompactDiagnostics(rows, selectedIds);
  const issues = buildIssues(routeGroups, cache, tools);
  const tsValues = selected.map((r) => Number(r.ts || 0)).filter((n) => n > 0);
  const report = {
    trace: opts.trace || defaultTracePath(),
    selected_sessions: selectedIds,
    time_range: {
      start_ts: tsValues.length ? Math.min(...tsValues) : null,
      end_ts: tsValues.length ? Math.max(...tsValues) : null,
      start: tsValues.length ? fmtTime(Math.min(...tsValues)) : null,
      end: tsValues.length ? fmtTime(Math.max(...tsValues)) : null,
      span_ms: tsValues.length ? Math.max(...tsValues) - Math.min(...tsValues) : 0,
    },
    summary: {
      row_count: selected.length,
      sessions: selectedIds.length,
      turns: sum(routeGroups.map((g) => g.turns)),
      tool_calls: tools.total_tool_calls,
      total_tool_ms: tools.total_tool_ms,
      llm_stream_ms: sum(routeGroups.map((g) => g.llm_stream_ms)),
      headers_ms: sum(routeGroups.map((g) => g.headers_ms)),
      cache_ratio: cache.usage_cache_ratio,
      issues: issues.length,
    },
    routeGroups,
    cache,
    tools,
    stages,
    tokens,
    compact,
    issues,
    selected_tool_failures: selectedFailures.length,
  };
  report.rankings = buildWhySlowRankings(report);
  report.executive_summary = buildExecutiveSummary(report);
  return report;
}

function renderText(report) {
  const lines = [];
  const focused = opts.failuresOnly || opts.compactOnly || opts.tokensOnly || opts.slowOnly;
  lines.push(`Session bench (${report.selected_sessions.map(shortId).join(', ')})`);
  lines.push(`range: ${report.time_range.start || '-'} → ${report.time_range.end || '-'} (${fmtSec(report.time_range.span_ms)})`);
  lines.push(`turns=${report.summary.turns} tools=${report.summary.tool_calls} llm_stream=${fmtMs(report.summary.llm_stream_ms)} tool_time=${fmtMs(report.summary.total_tool_ms)} cache=${fmtPct((report.summary.cache_ratio ?? 0) * 100)}`);
  lines.push('');

  if (!opts.issuesOnly && !opts.cacheOnly && !opts.toolsOnly && !opts.compactOnly && !opts.tokensOnly && !opts.failuresOnly) {
    lines.push('Executive summary');
    for (const line of report.executive_summary || []) lines.push(`- ${line}`);
    if (report.rankings?.length) {
      lines.push('why slow / risk ranking:');
      for (const r of report.rankings.slice(0, Math.min(opts.limit, 8))) lines.push(`- [${r.type}] ${r.message}`);
    }
    lines.push('');
  }

  const pushCompactDiagnostics = () => {
    if (!(report.compact?.sessions?.length || report.compact?.recent_meta?.length || report.compact?.cache_breaks?.length)) {
      lines.push('compact diagnostics: none');
      return;
    }
    lines.push('compact diagnostics:');
    if (report.compact.sessions.length) {
      const ctable = [['session', 'turns', 'stream', 'prompt', 'out', 'cache', 'breaks', 'WS']];
      for (const c of report.compact.sessions.slice(0, 5)) {
        ctable.push([
          shortId(c.session_id),
          c.turns,
          fmtMs(c.stream_ms),
          fmtTok(c.prompt_tokens),
          fmtTok(c.output_tokens + c.thinking_tokens),
          fmtPct((c.cache_ratio ?? 0) * 100),
          `${c.breaks}${c.no_anchor ? `/no_anchor×${c.no_anchor}` : ''}`,
          `${c.delta_ws}Δ/${c.full_ws}F`,
        ]);
      }
      lines.push(...padTable(ctable));
    }
    if (report.compact.recent_meta?.length) {
      lines.push('compact meta:');
      for (const m of report.compact.recent_meta.slice(0, Math.min(opts.limit, 10))) {
        const pipe = m.recall_pipeline;
        const fit = m.fit;
        const parts = [
          `- ${shortId(m.session_id)} it=${m.iteration ?? '-'} ${m.compact_type || '-'} ${fmtMs(m.duration_ms)} ${fmtTok(m.before_tokens)}→${fmtTok(m.after_tokens)}`,
          `pressure=${fmtTok(m.pressure_tokens)}/${fmtTok(m.trigger_tokens)}/${fmtTok(m.boundary_tokens)}`,
          `target=${fmtTok(m.target_budget_tokens)} changed=${m.changed}`,
        ];
        if (m.error) parts.push(`error=${compactText(m.error, 120)}`);
        lines.push(parts.join(' '));
        if (pipe) {
          lines.push(`  recall pipeline: ingest=${fmtMs(pipe.ingest_ms)} dump=${fmtMs(pipe.initial_dump_ms)} raw=${pipe.initial_raw_pending ?? '-'} cycle1=${fmtMs(pipe.cycle1_ms)} passes=${pipe.cycle1_passes ?? '-'} rawLeft=${pipe.cycle1_raw_remaining ?? '-'} recall=${pipe.final_recall_kb ?? '-'}KB`);
        }
        if (fit) {
          const recallPart = fit.recall_chars != null
            ? ` recallChars=${fit.recall_chars} priorChars=${fit.prior_chars ?? 0} tailTrunc=${fit.tail_truncated}`
            : '';
          const semanticPart = fit.summary_repaired != null ? ` repaired=${fit.summary_repaired}` : '';
          lines.push(`  fit: head=${fit.head_messages ?? '-'} tail=${fit.tail_messages ?? '-'} mandatory=${fmtTok(fit.mandatory_cost)} remain=${fmtTok(fit.remaining_tokens)} final=${fmtTok(fit.final_tokens)} raised=${fit.budget_raised}${recallPart}${semanticPart}`);
        }
      }
    }
    if (report.compact.cache_breaks.length) {
      lines.push('compact cache resets (intentional):');
      for (const b of report.compact.cache_breaks.slice(0, 5)) {
        lines.push(`- ${shortId(b.session_id)} it=${b.iteration ?? '-'} phase=${b.phase || '-'} reason=${b.reason || '-'} prompt=${fmtTok(b.prompt_tokens)} out=${fmtTok(b.output_tokens)}`);
      }
    }
  };

  if (opts.compactOnly) {
    pushCompactDiagnostics();
    return lines.join('\n');
  }

  if (!focused && !opts.toolsOnly && !opts.issuesOnly) {
    lines.push('Route timeline');
    const table = [['agent', 'model', 'turns', 'wall', 'LLM', 'tools', 'tool_ms', 'cache', 'WS', 'reused', 'session']];
    for (const g of report.routeGroups) {
      table.push([
        g.agent || '-',
        `${g.provider || '?'}:${g.model || '?'}`,
        g.turns,
        fmtSec((g.max_ts || 0) - (g.min_ts || 0)),
        fmtMs(g.llm_stream_ms),
        g.tool_calls,
        fmtMs(g.tool_ms),
        fmtPct((g.cache_ratio ?? 0) * 100),
        `${g.ws_delta}Δ/${g.ws_full}F`,
        `${g.reused_connection}/${g.transport_rows}`,
        shortId(g.session_id),
      ]);
    }
    lines.push(...padTable(table));
    lines.push('');
  }

  if (!focused && !opts.toolsOnly && !opts.issuesOnly) {
    lines.push('Cache / transport');
    lines.push(`cache: ${fmtTok(report.cache.cached_tokens)} / ${fmtTok(report.cache.prompt_tokens)} (${fmtPct((report.cache.usage_cache_ratio ?? 0) * 100)})`);
    lines.push(`ws: delta=${report.cache.ws_delta}, full=${report.cache.ws_full}, previous_response_id=${report.cache.previous_response_id}, reused=${report.cache.reused_connection}/${report.cache.transport_count}`);
    if (report.cache.cache_key_hashes.length) lines.push(`cache keys: ${report.cache.cache_key_hashes.slice(0, 5).map((k) => `${k.key}×${k.count}`).join(', ')}`);
    if (report.cache.cache_breaks.length) {
      lines.push('cache breaks:');
      for (const b of report.cache.cache_breaks.slice(0, 10)) {
        lines.push(`- ${shortId(b.session_id)} it=${b.iteration ?? '-'} phase=${b.phase || '-'} reason=${b.reason || '-'} (${b.explanation || '-'}) ws=${b.ws_mode || '-'} prev=${b.request_has_previous_response_id} cache=${fmtPct((b.cache_ratio ?? 0) * 100)} prompt=${fmtTok(b.prompt_tokens)} out=${fmtTok(b.output_tokens)} body/frame=${b.body_input_items ?? '-'}/${b.frame_input_items ?? '-'}`);
      }
    }
    if (report.cache.service_tier_downgrades.length) {
      lines.push('service tier downgrades:');
      for (const d of report.cache.service_tier_downgrades.slice(0, 10)) lines.push(`- ${shortId(d.session_id)} it=${d.iteration ?? '-'} ${d.requested}->${d.response}`);
    }
    if (report.compact?.sessions?.length || report.compact?.recent_meta?.length) {
      pushCompactDiagnostics();
    }
    lines.push('');
  }

  if ((opts.slowOnly || !focused) && !opts.cacheOnly && !opts.toolsOnly && !opts.issuesOnly && !opts.failuresOnly && !opts.tokensOnly) {
    lines.push('Slow turns / stage breakdown');
    const table = [['agent', 'it', 'active', 'headers', 'stream', 'tools', 'cache', 'ws', 'prompt', 'out', 'flags']];
    for (const t of report.stages.slowest_active.slice(0, Math.min(opts.limit, 12))) {
      table.push([
        t.agent || '-',
        t.turn_label || (t.iteration ?? '-'),
        fmtMs(t.approx_active_ms),
        fmtMs(t.headers_ms),
        fmtMs(t.stream_ms),
        `${fmtMs(t.tool_ms)}/${t.tool_calls}`,
        fmtPct((t.cache_ratio ?? 0) * 100),
        `${t.ws_mode || '-'}${t.reused_connection === true ? '+reuse' : ''}`,
        fmtTok(t.prompt_tokens),
        fmtTok(t.output_tokens),
        t.flags.join(',') || '-',
      ]);
    }
    lines.push(...padTable(table));
    if (report.stages.slowest_tools.some((t) => t.tool_ms > 0)) {
      lines.push('slow tool turns:');
      for (const t of report.stages.slowest_tools.slice(0, 5)) {
        const toolLabel = t.top_tools.map((x) => `${x.tool}×${x.count}/${fmtMs(x.ms)}`).join(', ') || '-';
        lines.push(`- ${t.agent || '-'} it=${t.turn_label || (t.iteration ?? '-')} tools=${fmtMs(t.tool_ms)} calls=${t.tool_calls}: ${toolLabel}`);
      }
    }
    lines.push('');
  }

  if ((opts.tokensOnly || !focused) && !opts.cacheOnly && !opts.toolsOnly && !opts.issuesOnly && !opts.failuresOnly && !opts.slowOnly) {
    lines.push('Token amplification');
    const sessionTable = [['agent', 'turns', 'prompt first→last', 'max', 'Δprompt', 'out', 'uncached', 'cache', 'session']];
    for (const s of report.tokens.sessions.slice(0, Math.min(opts.limit, 8))) {
      sessionTable.push([
        s.agent || '-',
        s.turns,
        `${fmtTok(s.first_prompt)}→${fmtTok(s.last_prompt)}`,
        `${fmtTok(s.max_prompt)}@${s.max_prompt_it}`,
        fmtTok(s.prompt_growth),
        fmtTok(s.total_output + s.total_thinking),
        fmtTok(s.uncached_tokens),
        fmtPct((s.cache_ratio ?? 0) * 100),
        shortId(s.session_id),
      ]);
    }
    lines.push(...padTable(sessionTable));
    if (report.tokens.growth_turns.length) {
      lines.push('prompt growth spikes:');
      for (const t of report.tokens.growth_turns.slice(0, 8)) {
        const ratio = t.growth_per_output == null ? '-' : `${t.growth_per_output.toFixed(t.growth_per_output >= 10 ? 0 : 1)}x/out`;
        lines.push(`- ${t.agent || '-'} it=${t.turn_label} prompt=${fmtTok(t.prompt_tokens)} Δ=${fmtTok(t.prompt_delta)} out=${fmtTok(t.output_tokens + t.thinking_tokens)} ${ratio} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`);
      }
    }
    if (report.tokens.output_heavy_turns.length) {
      lines.push('large output turns:');
      for (const t of report.tokens.output_heavy_turns.slice(0, 5)) {
        lines.push(`- ${t.agent || '-'} it=${t.turn_label} out=${fmtTok(t.output_tokens)} think=${fmtTok(t.thinking_tokens)} prompt=${fmtTok(t.prompt_tokens)} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`);
      }
    }
    if (report.tokens.cache_miss_cost_turns.length) {
      lines.push('uncached prompt cost:');
      for (const t of report.tokens.cache_miss_cost_turns.slice(0, 5)) {
        lines.push(`- ${t.agent || '-'} it=${t.turn_label} uncached=${fmtTok(t.uncached_tokens)} prompt=${fmtTok(t.prompt_tokens)} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`);
      }
    }
    lines.push('');
  }

  if ((opts.toolsOnly || opts.failuresOnly || !focused) && !opts.cacheOnly && !opts.issuesOnly && !opts.tokensOnly && !opts.slowOnly) {
    lines.push('Tool diagnostics');
    lines.push(`tool result kinds: ${fmtKindCounts(report.tools.result_kinds, 6)}`);
    const table = [['tool', 'count', 'ok/err', 'total', 'p50', 'p95', 'kinds', 'result']];
    for (const t of report.tools.by_name.slice(0, opts.limit)) {
      table.push([
        t.tool,
        t.count,
        `${t.ok}/${t.errors}`,
        fmtMs(t.total_ms),
        fmtMs(t.p50_ms),
        fmtMs(t.p95_ms),
        fmtKindCounts(t.result_kinds),
        `${Math.round(t.bytes / 1024)}KB/${t.lines}l`,
      ]);
    }
    lines.push(...padTable(table));
    if (report.tools.failures.length) {
      lines.push('tool failures:');
      for (const f of report.tools.failures.slice(0, 10)) {
        lines.push(`- ${f.agent || '-'} it=${f.iteration ?? '-'} ${f.tool || '-'} ${fmtMs(f.tool_ms)} category=${f.category || '-'} reason=${f.reason || 'trace에 상세 stderr/예외 미저장'} result=${Math.round(f.bytes / 1024)}KB/${f.lines}l: ${f.target}`);
        if (opts.failuresOnly && f.preview) {
          const preview = compactText(f.preview, 700);
          lines.push(`  preview: ${preview}`);
        }
      }
    }
    if (report.tools.recent_successes.length) {
      lines.push('recent successful tools:');
      for (const s of report.tools.recent_successes.slice(0, 5)) {
        lines.push(`- ${s.agent || '-'} it=${s.iteration ?? '-'} ${s.tool || '-'} ${fmtMs(s.tool_ms)} kind=${s.result_kind}: ${s.target}`);
      }
    }
    if (report.tools.duplicates.length) {
      lines.push('tool churn / duplicates:');
      for (const d of report.tools.duplicates.slice(0, 10)) lines.push(`- ${d.tool} x${d.count} kinds=${fmtKindCounts(d.result_kinds)}: ${d.target}`);
    }
    if (report.tools.broad_results.length) {
      lines.push('broad/offloaded results:');
      for (const b of report.tools.broad_results.slice(0, 10)) lines.push(`- ${b.tool} ${Math.round(b.bytes / 1024)}KB/${b.lines}l: ${b.target}`);
    }
    if (report.tools.read_fragmentation.length) {
      lines.push('read fragmentation:');
      for (const f of report.tools.read_fragmentation.slice(0, 10)) lines.push(`- x${f.count} span=${f.line_span} lines: ${f.path}`);
    }
    if (report.tools.sequential_tool_clusters?.length) {
      lines.push('sequential single-tool clusters:');
      for (const c of report.tools.sequential_tool_clusters.slice(0, 8)) {
        const toolSummary = c.tools.map((x) => `${x.tool}×${x.count}`).join(', ');
        lines.push(`- ${c.agent || '-'} it=${c.start_it ?? '-'}→${c.end_it ?? '-'} x${c.count} span=${fmtMs(c.span_ms)} tool_ms=${fmtMs(c.tool_ms)} errors=${c.errors}: ${toolSummary}`);
        if (c.examples?.length) lines.push(`  e.g. ${c.examples.join(' | ')}`);
      }
    }
    lines.push(`missed parallelism heuristic: ${report.tools.missed_parallelism_heuristic.consecutive_single_tool_batches} close single-tool batches`);
    lines.push('');
  }

  if (!opts.cacheOnly && !opts.toolsOnly) {
    lines.push('Issues');
    if (!report.issues.length) lines.push('- none detected by current heuristics');
    for (const issue of report.issues.slice(0, opts.limit)) lines.push(`- [${issue.severity}] ${issue.type}: ${issue.message}`);
  }
  return lines.join('\n');
}

const tracePath = opts.trace ? resolve(opts.trace) : defaultTracePath();
const failurePath = defaultToolFailurePath(tracePath);
let rows = readRows(tracePath);
if (opts.since != null) rows = rows.filter((r) => Number(r.ts || 0) >= opts.since);
rows = filterAgent(rows, opts.agent);

let failureRows = readRows(failurePath);
if (opts.since != null) failureRows = failureRows.filter((r) => Number(r.ts || 0) >= opts.since);
failureRows = filterAgent(failureRows, opts.agent);

const bySession = groupBy(rows.filter((r) => sessionId(r)), sessionId);
const metas = [...bySession.entries()].map(([sid, srows]) => ({ ...inferSessionMeta(srows), session_id: sid }))
  .filter((m) => m.max_ts != null)
  .sort((a, b) => Number(b.max_ts || 0) - Number(a.max_ts || 0));

const selectedIds = selectSessionIds(metas, opts.session);
if (!selectedIds.length) {
  const fallback = { error: `No session matched ${opts.session}`, trace: tracePath, sessions_seen: metas.slice(0, 10).map((m) => ({ session_id: m.session_id, agent: m.agent, model: m.model, last: fmtTime(m.max_ts) })) };
  if (opts.json) console.log(JSON.stringify(fallback, null, 2));
  else {
    console.error(fallback.error);
    for (const s of fallback.sessions_seen) console.error(`- ${shortId(s.session_id)} ${s.agent || '-'} ${s.model || '-'} ${s.last}`);
  }
  process.exitCode = 1;
} else {
  const report = buildReport(rows, selectedIds, failureRows);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}
