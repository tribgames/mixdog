// Text renderer for the session-bench report. Pure: the CLI options are passed in.
import { compactText, fmtKindCounts, fmtMs, fmtPct, fmtSec, fmtTok, padTable, shortId } from './session-bench-fmt.mjs';

function renderHeader(report, lines) {
  lines.push(`Session bench (${report.selected_sessions.map(shortId).join(', ')})`);
  lines.push(
    `range: ${report.time_range.start || '-'} → ${report.time_range.end || '-'} (${fmtSec(report.time_range.span_ms)})`
  );
  lines.push(
    `turns=${report.summary.turns} tools=${report.summary.tool_calls} llm_stream=${fmtMs(report.summary.llm_stream_ms)} tool_time=${fmtMs(report.summary.total_tool_ms)} cache=${fmtPct((report.summary.cache_ratio ?? 0) * 100)}`
  );
  lines.push('');
}

function renderExecutiveSummary(report, lines, opts) {
  lines.push('Executive summary');
  for (const line of report.executive_summary || []) lines.push(`- ${line}`);
  if (report.rankings?.length) {
    lines.push('why slow / risk ranking:');
    for (const r of report.rankings.slice(0, Math.min(opts.limit, 8))) lines.push(`- [${r.type}] ${r.message}`);
  }
  lines.push('');
}

function compactBreakLine(b) {
  return `- ${shortId(b.session_id)} it=${b.iteration ?? '-'} phase=${b.phase || '-'} reason=${b.reason || '-'} prompt=${fmtTok(b.prompt_tokens)} out=${fmtTok(b.output_tokens)}`;
}

function renderCompactMeta(report, lines, opts) {
  lines.push('compact meta:');
  for (const m of report.compact.recent_meta.slice(0, Math.min(opts.limit, 10))) {
    const pipe = m.handoff_pipeline;
    const fit = m.fit;
    const parts = [
      `- ${shortId(m.session_id)} it=${m.iteration ?? '-'} ${fmtMs(m.duration_ms)} ${fmtTok(m.before_tokens)}→${fmtTok(m.after_tokens)}`,
      `pressure=${fmtTok(m.pressure_tokens)}/${fmtTok(m.trigger_tokens)}/${fmtTok(m.boundary_tokens)}`,
      `target=${fmtTok(m.target_budget_tokens)} changed=${m.changed}`,
    ];
    if (m.error) parts.push(`error=${compactText(m.error, 120)}`);
    lines.push(parts.join(' '));
    if (pipe) {
      lines.push(
        `  handoff pipeline: ingest=${fmtMs(pipe.ingest_ms)} dump=${fmtMs(pipe.initial_dump_ms)} raw=${pipe.initial_raw_pending ?? '-'} cycle1=${fmtMs(pipe.cycle1_ms)} passes=${pipe.cycle1_passes ?? '-'} rawLeft=${pipe.cycle1_raw_remaining ?? '-'} handoff=${pipe.final_handoff_kb ?? '-'}KB`
      );
    }
    if (fit) {
      const handoffPart =
        fit.handoff_chars != null ? ` handoffChars=${fit.handoff_chars} tailTrunc=${fit.tail_truncated}` : '';
      lines.push(
        `  fit: head=${fit.head_messages ?? '-'} tail=${fit.tail_messages ?? '-'} mandatory=${fmtTok(fit.mandatory_cost)} remain=${fmtTok(fit.remaining_tokens)} final=${fmtTok(fit.final_tokens)} raised=${fit.budget_raised}${handoffPart}`
      );
    }
  }
}

function renderCompactDiagnostics(report, lines, opts) {
  if (
    !(report.compact?.sessions?.length || report.compact?.recent_meta?.length || report.compact?.cache_breaks?.length)
  ) {
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
  if (report.compact.recent_meta?.length) renderCompactMeta(report, lines, opts);
  const intentionalCompactBreaks = report.compact.cache_breaks.filter((b) => !b.actionable);
  const actionableCompactBreaks = report.compact.cache_breaks.filter((b) => b.actionable);
  if (intentionalCompactBreaks.length) {
    lines.push('compact cache resets (intentional):');
    for (const b of intentionalCompactBreaks.slice(0, 5)) lines.push(compactBreakLine(b));
  }
  if (actionableCompactBreaks.length) {
    lines.push('compact cache breaks (actionable):');
    for (const b of actionableCompactBreaks.slice(0, 5)) lines.push(compactBreakLine(b));
  }
}

function renderRouteTimeline(report, lines) {
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

function renderCacheTransport(report, lines, opts) {
  lines.push('Cache / transport');
  lines.push(
    `cache: ${fmtTok(report.cache.cached_tokens)} / ${fmtTok(report.cache.prompt_tokens)} (${fmtPct((report.cache.usage_cache_ratio ?? 0) * 100)})`
  );
  lines.push(
    `ws: delta=${report.cache.ws_delta}, full=${report.cache.ws_full}, previous_response_id=${report.cache.previous_response_id}, reused=${report.cache.reused_connection}/${report.cache.transport_count}`
  );
  if (report.cache.cache_key_hashes.length)
    lines.push(
      `cache keys: ${report.cache.cache_key_hashes
        .slice(0, 5)
        .map((k) => `${k.key}×${k.count}`)
        .join(', ')}`
    );
  if (report.cache.cache_breaks.length) {
    lines.push(
      `cache breaks (raw=${report.cache.cache_breaks.length}, actionable=${report.cache.actionable_cache_breaks.length}):`
    );
    for (const b of report.cache.cache_breaks.slice(0, 10)) {
      lines.push(
        `- ${shortId(b.session_id)} it=${b.iteration ?? '-'} ${b.actionable ? 'actionable' : `intentional:${b.intentional_transition}`} phase=${b.phase || '-'} reason=${b.reason || '-'} (${b.explanation || '-'}) ws=${b.ws_mode || '-'} tool_choice=${b.request_tool_choice ?? '-'} prev=${b.request_has_previous_response_id} cache=${fmtPct((b.cache_ratio ?? 0) * 100)} prompt=${fmtTok(b.prompt_tokens)} out=${fmtTok(b.output_tokens)} body/frame=${b.body_input_items ?? '-'}/${b.frame_input_items ?? '-'}`
      );
    }
  }
  if (report.cache.actual_cache_misses?.length) {
    lines.push('actual cache misses:');
    for (const m of report.cache.actual_cache_misses.slice(0, 10)) {
      lines.push(
        `- ${shortId(m.session_id)} it=${m.iteration ?? '-'} reason=${m.reason || '-'} ws=${m.ws_mode || '-'} prev=${m.request_has_previous_response_id} cache=${fmtPct((m.cache_ratio ?? 0) * 100)} prompt=${fmtTok(m.prompt_tokens)} uncached=${fmtTok(m.uncached_tokens)} prevMax=${fmtTok(m.previous_max_cached_tokens)}`
      );
    }
  }
  if (report.cache.service_tier_downgrades.length) {
    lines.push('service tier downgrades:');
    for (const d of report.cache.service_tier_downgrades.slice(0, 10))
      lines.push(`- ${shortId(d.session_id)} it=${d.iteration ?? '-'} ${d.requested}->${d.response}`);
  }
  if (report.compact?.sessions?.length || report.compact?.recent_meta?.length) {
    renderCompactDiagnostics(report, lines, opts);
  }
  lines.push('');
}

function renderPreflight(report, lines) {
  const p = report.preflight;
  const row = (label, s) => `${label}: p50=${fmtMs(s.p50)} p90=${fmtMs(s.p90)} max=${fmtMs(s.max)} (n=${s.n})`;
  lines.push('Turn preflight (harness-owned, submit → provider request)');
  lines.push(row('runtime ttft', p.runtime_ttft_ms));
  lines.push(row('end-to-end ttft', p.end_to_end_ttft_ms));
  lines.push(`${row('queue', p.queue_ms)}`);
  lines.push(`${row('route', p.route_ms)}`);
  lines.push(`${row('preflight', p.preflight_ms)}`);
  lines.push(`${row('mcp grace', p.mcp_ms)}`);
  lines.push(`status: ${p.statuses.map(([k, v]) => `${k}×${v}`).join(', ') || '-'}`);
  lines.push('');
}

function renderSlowTurns(report, lines, opts) {
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
      lines.push(
        `- ${t.agent || '-'} it=${t.turn_label || (t.iteration ?? '-')} tools=${fmtMs(t.tool_ms)} calls=${t.tool_calls}: ${toolLabel}`
      );
    }
  }
  lines.push('');
}

function renderTokenAmplification(report, lines, opts) {
  lines.push('Token amplification');
  const sessionTable = [
    ['agent', 'turns', 'prompt first→last', 'max', 'Δprompt', 'out', 'uncached', 'cache', 'session'],
  ];
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
      const growth = t.growth_per_output;
      let ratio = '-';
      if (growth != null) ratio = `${growth.toFixed(growth >= 10 ? 0 : 1)}x/out`;
      lines.push(
        `- ${t.agent || '-'} it=${t.turn_label} prompt=${fmtTok(t.prompt_tokens)} Δ=${fmtTok(t.prompt_delta)} out=${fmtTok(t.output_tokens + t.thinking_tokens)} ${ratio} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`
      );
    }
  }
  if (report.tokens.output_heavy_turns.length) {
    lines.push('large output turns:');
    for (const t of report.tokens.output_heavy_turns.slice(0, 5)) {
      lines.push(
        `- ${t.agent || '-'} it=${t.turn_label} out=${fmtTok(t.output_tokens)} think=${fmtTok(t.thinking_tokens)} prompt=${fmtTok(t.prompt_tokens)} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`
      );
    }
  }
  if (report.tokens.cache_miss_cost_turns.length) {
    lines.push('uncached prompt cost:');
    for (const t of report.tokens.cache_miss_cost_turns.slice(0, 5)) {
      lines.push(
        `- ${t.agent || '-'} it=${t.turn_label} uncached=${fmtTok(t.uncached_tokens)} prompt=${fmtTok(t.prompt_tokens)} cache=${fmtPct((t.cache_ratio ?? 0) * 100)}`
      );
    }
  }
  lines.push('');
}

function renderToolDiagnostics(report, lines, opts) {
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
  renderToolOutcomes(report, lines, opts);
  renderToolPatterns(report, lines);
  lines.push(
    `missed parallelism heuristic: ${report.tools.missed_parallelism_heuristic.consecutive_single_tool_batches} close single-tool batches`
  );
  lines.push(
    `ordered patch→shell follow-ups: ${report.tools.ordered_followup_candidates?.patch_then_shell || 0} separate-turn pair(s)`
  );
  lines.push('');
}

function renderToolOutcomes(report, lines, opts) {
  if (report.tools.failures.length) {
    lines.push('tool failures:');
    for (const f of report.tools.failures.slice(0, 10)) {
      lines.push(
        `- ${f.agent || '-'} it=${f.iteration ?? '-'} ${f.tool || '-'} ${fmtMs(f.tool_ms)} category=${f.category || '-'} reason=${f.reason || 'trace\uC5D0 \uC0C1\uC138 stderr/\uC608\uC678 \uBBF8\uC800\uC7A5'} result=${Math.round(f.bytes / 1024)}KB/${f.lines}l: ${f.target}`
      );
      if (opts.failuresOnly && f.preview) {
        const preview = compactText(f.preview, 700);
        lines.push(`  preview: ${preview}`);
      }
    }
  }
  if (report.tools.recent_successes.length) {
    lines.push('recent successful tools:');
    for (const s of report.tools.recent_successes.slice(0, 5)) {
      lines.push(
        `- ${s.agent || '-'} it=${s.iteration ?? '-'} ${s.tool || '-'} ${fmtMs(s.tool_ms)} kind=${s.result_kind}: ${s.target}`
      );
    }
  }
}

function renderToolPatterns(report, lines) {
  if (report.tools.duplicates.length) {
    lines.push('tool churn / duplicates:');
    for (const d of report.tools.duplicates.slice(0, 10))
      lines.push(`- ${d.tool} x${d.count} kinds=${fmtKindCounts(d.result_kinds)}: ${d.target}`);
  }
  if (report.tools.broad_results.length) {
    lines.push('broad/offloaded results:');
    for (const b of report.tools.broad_results.slice(0, 10))
      lines.push(`- ${b.tool} ${Math.round(b.bytes / 1024)}KB/${b.lines}l: ${b.target}`);
  }
  if (report.tools.read_fragmentation.length) {
    lines.push('read fragmentation:');
    for (const f of report.tools.read_fragmentation.slice(0, 10))
      lines.push(`- x${f.count} span=${f.line_span} lines: ${f.path}`);
  }
  if (report.tools.sequential_tool_clusters?.length) {
    lines.push('sequential single-tool clusters:');
    for (const c of report.tools.sequential_tool_clusters.slice(0, 8)) {
      const toolSummary = c.tools.map((x) => `${x.tool}×${x.count}`).join(', ');
      lines.push(
        `- ${c.agent || '-'} it=${c.start_it ?? '-'}→${c.end_it ?? '-'} x${c.count} span=${fmtMs(c.span_ms)} tool_ms=${fmtMs(c.tool_ms)} errors=${c.errors}: ${toolSummary}`
      );
      if (c.examples?.length) lines.push(`  e.g. ${c.examples.join(' | ')}`);
    }
  }
  if (report.tools.edit_fragmentation?.length) {
    lines.push('edit fragmentation:');
    for (const e of report.tools.edit_fragmentation.slice(0, 8)) {
      lines.push(
        `- ${e.agent || '-'} it=${e.start_it}→${e.end_it} score=${e.frag_score} multi=${e.multi_patch_turns} cross=${e.cross_turn_patch}`
      );
    }
  }
}

function renderIssues(report, lines, opts) {
  lines.push('Issues');
  if (!report.issues.length) lines.push('- none detected by current heuristics');
  for (const issue of report.issues.slice(0, opts.limit))
    lines.push(`- [${issue.severity}] ${issue.type}: ${issue.message}`);
}

// Section gating follows the --*-only flags: a focused view renders its own
// section (plus the header and issues), the default view renders everything.
export function renderText(report, opts) {
  const lines = [];
  const flagged = (...names) => names.some((name) => opts[name]);
  const focused = flagged('failuresOnly', 'compactOnly', 'tokensOnly', 'slowOnly');
  renderHeader(report, lines);
  if (!flagged('issuesOnly', 'cacheOnly', 'toolsOnly', 'compactOnly', 'tokensOnly', 'failuresOnly')) {
    renderExecutiveSummary(report, lines, opts);
  }
  if (opts.compactOnly) {
    renderCompactDiagnostics(report, lines, opts);
    return lines.join('\n');
  }
  const wide = !focused && !opts.toolsOnly && !opts.issuesOnly;
  if (wide) renderRouteTimeline(report, lines);
  if (wide) renderCacheTransport(report, lines, opts);
  if (wide && report.preflight?.turns) renderPreflight(report, lines);
  if ((opts.slowOnly || !focused) && !flagged('cacheOnly', 'toolsOnly', 'issuesOnly', 'failuresOnly', 'tokensOnly')) {
    renderSlowTurns(report, lines, opts);
  }
  if ((opts.tokensOnly || !focused) && !flagged('cacheOnly', 'toolsOnly', 'issuesOnly', 'failuresOnly', 'slowOnly')) {
    renderTokenAmplification(report, lines, opts);
  }
  if (
    (flagged('toolsOnly', 'failuresOnly') || !focused) &&
    !flagged('cacheOnly', 'issuesOnly', 'tokensOnly', 'slowOnly')
  ) {
    renderToolDiagnostics(report, lines, opts);
  }
  if (!opts.cacheOnly && !opts.toolsOnly) renderIssues(report, lines, opts);
  return lines.join('\n');
}
