import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport } from './computer-task-cost-report.mjs';

const paths = { model: 'm.json', host: 'h.json', sequence: 's.json' };
const model = {
  summary: { first_call_success_rate: 1 },
  rows: [
    { usage: { inputTokens: 1000, cachedTokens: 400, outputTokens: 20 }, duration_ms: 1000 },
    { usage: { inputTokens: 2000, cachedTokens: 500, outputTokens: 40 }, duration_ms: 3000 },
  ],
};
const host = {
  total_runs: 4,
  summary: {
    success_rate: 0.75,
    tool_calls: 10,
    observations: 6,
    mutations: 2,
    scenario_duration_p50_ms: 800,
    scenario_duration_p95_ms: 1600,
    request_bytes: 400,
    response_text_bytes: 800,
    image_bytes: 4000,
  },
};
const sequence = {
  separate: { post_action_captures: 2, p50_ms: 900, p95_ms: 1200 },
  sequence: { post_action_captures: 1, p50_ms: 500, p95_ms: 700 },
  reduction: { latency: 0.4 },
};

test('the report summarises model calls, host runs and the sequence comparison', () => {
  const report = buildReport(model, host, sequence, paths);
  assert.equal(report.model_call.samples, 2);
  assert.equal(report.model_call.first_call_success_rate, 1);
  assert.equal(report.windows_host_scenario.samples, 4);
  assert.equal(report.windows_host_scenario.pass_rate, 0.75);
  assert.equal(report.windows_host_scenario.model_facing_tool_calls_per_run, 2.5);
  assert.equal(report.windows_host_scenario.payload_bytes_per_run.images, 1000);
  assert.equal(report.task_profiles.safe_two_action_chain.separate.model_calls_after_observation, 2);
  assert.equal(report.task_profiles.safe_two_action_chain.sequence.model_calls_after_observation, 1);
  assert.deepEqual(report.task_profiles.safe_two_action_chain.reduction, { latency: 0.4 });
});

test('a task profile multiplies one call by the number of model calls', () => {
  const report = buildReport(model, host, sequence, paths);
  const one = report.task_profiles.fresh_observation_action;
  const three = report.task_profiles.discover_observe_then_action;
  assert.equal(three.model_calls, 3);
  assert.equal(
    three.call_equivalent_input_tokens_p50,
    Math.round(one.call_equivalent_input_tokens_p50 * 3 * 100) / 100
  );
});

test('empty inputs give zero rates and null fields rather than a failure', () => {
  const report = buildReport({}, {}, {}, paths);
  assert.equal(report.model_call.samples, 0);
  assert.equal(report.model_call.first_call_success_rate, null);
  assert.equal(report.windows_host_scenario.samples, 0);
  assert.equal(report.windows_host_scenario.pass_rate, null);
});
