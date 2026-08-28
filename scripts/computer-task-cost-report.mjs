#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function load(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function percentile(values, fraction) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function fixed(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

const modelPath = arg(
  'model',
  'artifacts/computer-use/computer-schema-sequence-guided-full.json',
);
const hostPath = arg(
  'host',
  'apps/desktop/artifacts/computer-use/scenario-repeat-further-optimized-v5.json',
);
const sequencePath = arg(
  'sequence',
  'artifacts/computer-use/sequence-performance-final.json',
);
const outputPath = resolve(arg(
  'output',
  'artifacts/computer-use/computer-task-cost-final.json',
));

const model = load(modelPath);
const host = load(hostPath);
const sequence = load(sequencePath);
const rows = Array.isArray(model.rows) ? model.rows : [];
const totalInputTokens = rows.map((row) => row.usage?.inputTokens);
const mainInputTokens = rows.map((row) => row.usage?.mainInputTokens);
const warmupInputTokens = rows.map((row) => row.usage?.warmupInputTokens);
const cachedTokens = rows.map((row) => row.usage?.cachedTokens);
const uncachedTokens = rows.map((row) => (
  Number(row.usage?.inputTokens || 0) - Number(row.usage?.cachedTokens || 0)
));
const outputTokens = rows.map((row) => row.usage?.outputTokens);
const modelLatency = rows.map((row) => row.duration_ms);
const totalRuns = Number(host.total_runs || 0);
const hostSummary = host.summary || {};
const perToolCallInput = distribution(totalInputTokens);
const perToolCallLatency = distribution(modelLatency);

const taskProfile = (modelCalls) => ({
  model_calls: modelCalls,
  call_equivalent_input_tokens_p50: fixed(perToolCallInput.p50 * modelCalls),
  call_equivalent_input_tokens_p95: fixed(perToolCallInput.p95 * modelCalls),
  model_latency_p50_ms: fixed(perToolCallLatency.p50 * modelCalls),
  note: 'Call-equivalent only; later turns can include fresh-state text or images and prompt-cache behavior.',
});

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  inputs: {
    model: resolve(modelPath),
    host: resolve(hostPath),
    sequence: resolve(sequencePath),
  },
  model_call: {
    samples: rows.length,
    first_call_success_rate: model.summary?.first_call_success_rate ?? null,
    total_input_tokens: perToolCallInput,
    main_input_tokens: distribution(mainInputTokens),
    warmup_input_tokens: distribution(warmupInputTokens),
    cached_tokens: distribution(cachedTokens),
    uncached_tokens: distribution(uncachedTokens),
    output_tokens: distribution(outputTokens),
    latency_ms: perToolCallLatency,
  },
  windows_host_scenario: {
    samples: totalRuns,
    pass_rate: hostSummary.success_rate ?? null,
    model_facing_tool_calls_per_run: fixed(hostSummary.tool_calls / totalRuns, 3),
    observations_per_run: fixed(hostSummary.observations / totalRuns, 3),
    mutations_per_run: fixed(hostSummary.mutations / totalRuns, 3),
    latency_ms: {
      p50: hostSummary.scenario_duration_p50_ms,
      p95: hostSummary.scenario_duration_p95_ms,
    },
    payload_bytes_per_run: {
      request: fixed(hostSummary.request_bytes / totalRuns),
      response_text: fixed(hostSummary.response_text_bytes / totalRuns),
      images: fixed(hostSummary.image_bytes / totalRuns),
    },
  },
  task_profiles: {
    fresh_observation_action: taskProfile(1),
    observe_then_action: taskProfile(2),
    discover_observe_then_action: taskProfile(3),
    safe_two_action_chain: {
      separate: {
        model_calls_after_observation: 2,
        post_action_captures: sequence.separate?.post_action_captures,
        host_latency_p50_ms: sequence.separate?.p50_ms,
        host_latency_p95_ms: sequence.separate?.p95_ms,
      },
      sequence: {
        model_calls_after_observation: 1,
        post_action_captures: sequence.sequence?.post_action_captures,
        host_latency_p50_ms: sequence.sequence?.p50_ms,
        host_latency_p95_ms: sequence.sequence?.p95_ms,
      },
      reduction: sequence.reduction,
    },
  },
  caveats: [
    'Model token samples are provider-reported single-call usage from 36 representative first-call tasks.',
    'Windows host samples are 230 real native, Electron, Chrome, Korean OCR, stale-state, and recovery runs.',
    'Task profiles are call-equivalent projections, not billing claims; screenshots and growing conversation history can increase later-turn input.',
  ],
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n${outputPath}\n`);
