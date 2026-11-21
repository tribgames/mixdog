import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./session-bench.mjs', import.meta.url));

const ROWS = [
  {
    kind: 'preset_assign',
    ts: 1000,
    session_id: 's1',
    agent: 'lead',
    model: 'm',
    provider: 'p',
  },
  {
    kind: 'sse',
    ts: 1900,
    session_id: 's1',
    iteration: 1,
    stream_total_ms: 16000,
  },
  {
    kind: 'transport',
    ts: 2000,
    session_id: 's1',
    iteration: 1,
    ws_mode: 'full',
    headers_ms: 6000,
    requested_service_tier: 'a',
    response_service_tier: 'b',
  },
  {
    kind: 'fetch',
    ts: 1800,
    session_id: 's1',
    iteration: 1,
    headers_ms: 6000,
  },
  {
    kind: 'tool',
    ts: 2100,
    session_id: 's1',
    iteration: 1,
    tool_name: 'read',
    tool_ms: 6000,
    result_kind: 'ok',
    agent: 'lead',
  },
  {
    kind: 'tool',
    ts: 2200,
    session_id: 's1',
    iteration: 1,
    tool_name: 'grep',
    tool_ms: 10,
    result_kind: 'error',
    agent: 'lead',
  },
  {
    kind: 'cache_break',
    ts: 2050,
    session_id: 's1',
    iteration: 1,
    reason: 'no_anchor',
  },
  {
    kind: 'usage_raw',
    ts: 2060,
    session_id: 's1',
    iteration: 1,
    prompt_tokens: 60000,
    cached_tokens: 1000,
    output_tokens: 1500,
    thinking_tokens: 5,
  },
  {
    kind: 'usage_raw',
    ts: 3060,
    session_id: 's1',
    iteration: 2,
    prompt_tokens: 70000,
    cached_tokens: 65000,
    output_tokens: 20,
  },
  {
    kind: 'usage_raw',
    ts: 2500,
    session_id: 's1:compact',
    iteration: 1,
    prompt_tokens: 100,
    cached_tokens: 0,
    output_tokens: 5,
  },
  {
    kind: 'sse',
    ts: 2490,
    session_id: 's1:compact',
    stream_total_ms: 300,
  },
  {
    kind: 'transport',
    ts: 2495,
    session_id: 's1:compact',
    ws_mode: 'delta',
  },
  {
    kind: 'cache_break',
    ts: 2400,
    session_id: 's1:compact',
    reason: 'no_anchor',
  },
  {
    kind: 'compact_meta',
    ts: 2600,
    session_id: 's1:compact',
    stage: 'x',
    trigger: 'auto',
    message_tokens_est: 900,
    details: {
      freshContext: {
        finalTokens: 100,
        headMessages: 2,
        budgetRaised: true,
        pipeline: {
          finalHandoffBytes: 2048,
          ingestMs: 3,
        },
      },
    },
  },
];

const EXPECTED = {
  summary: {
    row_count: 9,
    sessions: 1,
    turns: 2,
    tool_calls: 2,
    total_tool_ms: 6010,
    llm_stream_ms: 16000,
    headers_ms: 6000,
    cache_ratio: 0.5076923076923077,
    issues: 5,
  },
  time_range: {
    start_ts: 1000,
    end_ts: 3060,
    start: '1970-01-01 00:00:01Z',
    end: '1970-01-01 00:00:03Z',
    span_ms: 2060,
  },
  executive_summary: [
    '주 병목=stream 16s/28s; cache=51%; turns=2; tools=2',
    '캐시 깨짐=2 (no_anchor/mid_chain_reset×1, no_anchor/cold_start×1)',
    '컴팩트 호출=1 session, cache reset=1 (no_anchor/cold_start×1)',
    '툴 실패=1 (grep×1)',
    '토큰 증폭=lead it=2 promptΔ=10.0k out=20',
  ],
  rankings: [
    {
      score: 59,
      type: 'uncached_prompt',
      message: 'lead it=1 uncached=59.0k prompt=60.0k cache=2%',
    },
    {
      score: 51,
      type: 'tool_failures',
      message: '1 failed tool call(s): grep×1',
    },
    {
      score: 42,
      type: 'cache_breaks',
      message: '2 actionable cache break(s): no_anchor/mid_chain_reset×1, no_anchor/cold_start×1',
    },
    {
      score: 16,
      type: 'slow_stream',
      message: 'lead it=1 stream=16s prompt=60.0k out=1.5k',
    },
    {
      score: 10,
      type: 'prompt_growth',
      message: 'lead it=2 prompt Δ=10.0k out=20 cache=93%',
    },
    {
      score: 6.01,
      type: 'slow_tools',
      message: 'lead it=1 tools=6.0s read×1/6.0s, grep×1/10ms',
    },
  ],
  issues: [
    {
      severity: 'high',
      type: 'cache',
      message: 'lead stayed full WS (1 full, 0 delta)',
      session_id: 's1',
    },
    {
      severity: 'medium',
      type: 'cache_break',
      message: 'cache_break no_anchor at it=1',
      session_id: 's1',
    },
    {
      severity: 'medium',
      type: 'cache_break',
      message: 'cache_break no_anchor at it=0',
      session_id: 's1:compact',
    },
    {
      severity: 'medium',
      type: 'service_tier',
      message: '1 service tier downgrade(s), e.g. a->b',
      session_id: 's1',
    },
    {
      severity: 'medium',
      type: 'tool_error',
      message: '1 failed tool call(s): grep×1',
    },
  ],
  turns: [
    {
      session_id: 's1',
      agent: 'lead',
      model: 'm',
      provider: 'p',
      iteration: 1,
      occurrence: 1,
      turn_label: '1',
      ts: 2060,
      headers_ms: 6000,
      stream_ms: 16000,
      tool_ms: 6010,
      approx_active_ms: 28010,
      tool_calls: 2,
      prompt_tokens: 60000,
      output_tokens: 1500,
      thinking_tokens: 5,
      cached_tokens: 1000,
      cache_ratio: 0.016666666666666666,
      ws_mode: 'full',
      reused_connection: null,
      has_previous_response_id: null,
      service_requested: 'a',
      service_response: 'b',
      cache_breaks: ['no_anchor'],
      top_tools: [
        {
          tool: 'read',
          count: 1,
          ms: 6000,
        },
        {
          tool: 'grep',
          count: 1,
          ms: 10,
        },
      ],
      flags: [
        'full_ws',
        'cache_break:no_anchor',
        'tier:a->b',
        'slow_stream',
        'slow_headers',
        'slow_tools',
        'low_cache_large_prompt',
      ],
    },
    {
      session_id: 's1',
      agent: 'lead',
      model: 'm',
      provider: 'p',
      iteration: 2,
      occurrence: 1,
      turn_label: '2',
      ts: 3060,
      headers_ms: 6000,
      stream_ms: 16000,
      tool_ms: 0,
      approx_active_ms: 22000,
      tool_calls: 0,
      prompt_tokens: 70000,
      output_tokens: 20,
      thinking_tokens: 0,
      cached_tokens: 65000,
      cache_ratio: 0.9285714285714286,
      ws_mode: null,
      reused_connection: null,
      has_previous_response_id: null,
      service_requested: null,
      service_response: null,
      cache_breaks: [],
      top_tools: [],
      flags: ['slow_stream', 'slow_headers'],
    },
  ],
  tokens: {
    sessions: [
      {
        session_id: 's1',
        agent: 'lead',
        turns: 2,
        first_prompt: 60000,
        last_prompt: 70000,
        max_prompt: 70000,
        max_prompt_it: '2',
        prompt_growth: 10000,
        total_output: 1520,
        total_thinking: 5,
        uncached_tokens: 64000,
        cache_ratio: 0.5076923076923077,
      },
    ],
    growth_turns: [
      {
        session_id: 's1',
        agent: 'lead',
        iteration: 2,
        turn_label: '2',
        prompt_tokens: 70000,
        prompt_delta: 10000,
        output_tokens: 20,
        thinking_tokens: 0,
        cached_tokens: 65000,
        cache_ratio: 0.9285714285714286,
        uncached_tokens: 5000,
        growth_per_output: 500,
        ts: 3060,
      },
    ],
    output_heavy_turns: [
      {
        session_id: 's1',
        agent: 'lead',
        iteration: 1,
        turn_label: '1',
        prompt_tokens: 60000,
        prompt_delta: 0,
        output_tokens: 1500,
        thinking_tokens: 5,
        cached_tokens: 1000,
        cache_ratio: 0.016666666666666666,
        uncached_tokens: 59000,
        growth_per_output: 0,
        ts: 2060,
      },
    ],
    cache_miss_cost_turns: [
      {
        session_id: 's1',
        agent: 'lead',
        iteration: 1,
        turn_label: '1',
        prompt_tokens: 60000,
        prompt_delta: 0,
        output_tokens: 1500,
        thinking_tokens: 5,
        cached_tokens: 1000,
        cache_ratio: 0.016666666666666666,
        uncached_tokens: 59000,
        growth_per_output: 0,
        ts: 2060,
      },
    ],
  },
  compactSessions: [
    {
      session_id: 's1:compact',
      base_session_id: 's1',
      turns: 1,
      prompt_tokens: 100,
      cached_tokens: 0,
      output_tokens: 5,
      thinking_tokens: 0,
      stream_ms: 300,
      cache_ratio: 0,
      breaks: 1,
      no_anchor: 1,
      full_ws: 0,
      delta_ws: 1,
    },
  ],
  compactMeta: [
    {
      session_id: 's1:compact',
      ts: 2600,
      iteration: 0,
      stage: 'x',
      trigger: 'auto',
      changed: false,
      before_tokens: 900,
      pressure_tokens: 0,
      trigger_tokens: 0,
      boundary_tokens: 0,
      target_budget_tokens: 0,
      after_tokens: 100,
      before_messages: 0,
      after_messages: 0,
      duration_ms: 0,
      error: null,
      handoff_pipeline: {
        ingest_ms: 3,
        initial_dump_ms: null,
        initial_raw_pending: null,
        cycle1_ms: null,
        cycle1_passes: null,
        cycle1_raw_remaining: null,
        final_handoff_kb: 2,
      },
      fit: {
        head_messages: 2,
        tail_messages: null,
        mandatory_cost: null,
        remaining_tokens: null,
        budget_raised: true,
        final_tokens: 100,
        handoff_chars: null,
        tail_truncated: null,
      },
    },
  ],
  cacheBreaks: [
    {
      session_id: 's1',
      iteration: 1,
      reason: 'no_anchor',
      phase: 'mid_chain_reset',
      intentional_transition: null,
      actionable: true,
      explanation: 'delta 기준점/previous response 없음',
      ws_mode: null,
      cache_key_hash: null,
      request_tool_choice: null,
      request_has_previous_response_id: null,
      body_input_items: null,
      frame_input_items: null,
      prompt_tokens: 60000,
      cached_tokens: 1000,
      cache_ratio: 0.016666666666666666,
      output_tokens: 1500,
      ts: 2050,
    },
    {
      session_id: 's1:compact',
      iteration: 0,
      reason: 'no_anchor',
      phase: 'cold_start',
      intentional_transition: null,
      actionable: true,
      explanation: 'delta 기준점/previous response 없음',
      ws_mode: null,
      cache_key_hash: null,
      request_tool_choice: null,
      request_has_previous_response_id: null,
      body_input_items: null,
      frame_input_items: null,
      prompt_tokens: 0,
      cached_tokens: 0,
      cache_ratio: null,
      output_tokens: 0,
      ts: 2400,
    },
  ],
};

function runBench(rows, flags) {
  const dir = mkdtempSync(join(tmpdir(), 'session-bench-'));
  try {
    const trace = join(dir, 'agent-trace.jsonl');
    writeFileSync(trace, rows.map((r) => JSON.stringify(r)).join('\n'));
    const run = spawnSync(process.execPath, [SCRIPT, '--trace', trace, '--session', 's1', ...flags], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function reportOf(rows) {
  return JSON.parse(runBench(rows, ['--json']));
}

function sectionsOf(flags) {
  return runBench(ROWS, flags)
    .split('\n')
    .filter((line) => /^[A-Z][A-Za-z ]+$/.test(line));
}

const report = reportOf(ROWS);

test('a turn record carries its stream, headers, tools, cache and flags', () => {
  assert.deepEqual(report.stages.turns, EXPECTED.turns);
});

test('token diagnostics rank prompt growth, output-heavy and cache-miss turns', () => {
  assert.deepEqual(report.tokens, EXPECTED.tokens);
});

test('compact diagnostics summarise the compact sessions and their meta rows', () => {
  assert.deepEqual(report.compact.sessions, EXPECTED.compactSessions);
  assert.deepEqual(report.compact.recent_meta, EXPECTED.compactMeta);
});

test('the report summary, time range, cache breaks and issues describe the selected session', () => {
  assert.deepEqual(report.summary, EXPECTED.summary);
  assert.deepEqual(report.time_range, EXPECTED.time_range);
  assert.deepEqual(report.cache.cache_breaks, EXPECTED.cacheBreaks);
  assert.deepEqual(report.issues, EXPECTED.issues);
});

test('rankings and the executive summary name the dominant causes', () => {
  assert.deepEqual(report.rankings, EXPECTED.rankings);
  assert.deepEqual(report.executive_summary, EXPECTED.executive_summary);
});

const SECTIONS_BY_FLAGS = [
  [[], ['Executive summary', 'Route timeline', 'Token amplification', 'Tool diagnostics', 'Issues']],
  [['--cache'], ['Route timeline']],
  [['--tools'], ['Tool diagnostics']],
  [['--issues'], ['Issues']],
  [['--failures'], ['Tool diagnostics', 'Issues']],
  [['--compact'], []],
  [['--tokens'], ['Token amplification', 'Issues']],
  [['--slow'], ['Executive summary', 'Issues']],
  [['--tools', '--failures'], ['Tool diagnostics']],
  [['--slow', '--tokens'], ['Issues']],
  [['--cache', '--tokens'], []],
];

for (const [flags, sections] of SECTIONS_BY_FLAGS) {
  test(`text report sections for ${flags.join(' ') || 'no flags'}`, () => {
    assert.deepEqual(sectionsOf(flags), sections);
  });
}
