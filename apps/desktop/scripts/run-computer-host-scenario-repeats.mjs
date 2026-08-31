import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertRepeatedScenariosPassed,
  repeatRequiresPass,
} from './computer-host-repeat-policy.mjs';

const argument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const repeatCount = Math.max(1, Number(argument('repeat')) || 10);
const label = argument('label') || 'baseline';
const initialDirectory = process.env.INIT_CWD || process.cwd();
const output = resolve(
  argument('output')
    || join(initialDirectory, 'artifacts', 'computer-use', `scenario-repeat-${label}.json`),
);
const runDirectory = resolve(
  argument('run-dir')
    || join(initialDirectory, 'artifacts', 'computer-use', 'repeats', label),
);
const requirePass = repeatRequiresPass();
const only = argument('only');
const customTimeoutMs = Number(argument('timeout-ms')) || 300_000;
const scenarioRunner = fileURLToPath(new URL('./run-computer-host-scenarios.mjs', import.meta.url));
const mergeRunner = fileURLToPath(new URL('./merge-computer-host-scenarios.mjs', import.meta.url));
const coreShards = [
  {
    name: 'observation',
    only: 'S01,S02,S03,S04,S05,S24,S25,S27,S31,S40,S44',
    timeoutMs: 240_000,
  },
  {
    name: 'input',
    only: 'S06,S07,S08,S09,S10,S11,S12,S13,S14,S28,S32,S36,S37,S38,S39',
    timeoutMs: 360_000,
  },
  {
    name: 'recovery',
    only: 'S15,S16,S17,S18,S26,S35,S41,S42,S43',
    timeoutMs: 360_000,
  },
  {
    name: 'external',
    only: 'S19',
    timeoutMs: 240_000,
  },
  {
    name: 'real-apps',
    only: 'S20,S21,S22,S23,S29,S33,S34',
    timeoutMs: 300_000,
  },
  {
    name: 'performance',
    only: 'S30',
    timeoutMs: 300_000,
  },
];
const shards = only
  ? [{ name: 'custom', only, timeoutMs: customTimeoutMs }]
  : coreShards;

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function runNode(args) {
  const child = spawn(process.execPath, args, {
    cwd: initialDirectory,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${args[0]} was terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`${args[0]} exited ${exitCode}`);
}

await mkdir(runDirectory, { recursive: true });
const repeatReports = [];
for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
  const repeatLabel = `${label}-r${String(repeat).padStart(2, '0')}`;
  const shardOutputs = [];
  for (const shard of shards) {
    const shardOutput = join(runDirectory, `${repeatLabel}-${shard.name}.json`);
    shardOutputs.push(shardOutput);
    console.log(`[${repeat}/${repeatCount}] ${shard.name}`);
    await runNode([
      scenarioRunner,
      `--label=${repeatLabel}-${shard.name}`,
      `--output=${shardOutput}`,
      `--only=${shard.only}`,
      `--timeout-ms=${shard.timeoutMs}`,
    ]);
  }
  const repeatOutput = join(runDirectory, `${repeatLabel}.json`);
  await runNode([
    mergeRunner,
    `--label=${repeatLabel}`,
    `--output=${repeatOutput}`,
    ...shardOutputs,
  ]);
  repeatReports.push(JSON.parse(await readFile(repeatOutput, 'utf8')));
  console.log(
    `[${repeat}/${repeatCount}] ${repeatReports.at(-1).summary.passed}`
      + `/${repeatReports.at(-1).summary.total} passed`,
  );
}

const results = repeatReports.flatMap((report, repeatIndex) =>
  report.results.map((result) => ({ repeat: repeatIndex + 1, ...result })));
const grouped = new Map();
for (const result of results) {
  const group = grouped.get(result.id) || [];
  group.push(result);
  grouped.set(result.id, group);
}
const scenarioStats = [...grouped.entries()]
  .sort((left, right) => Number(left[0].slice(1)) - Number(right[0].slice(1)))
  .map(([id, group]) => {
    const passed = group.filter((result) => result.status === 'pass').length;
    return {
      id,
      name: group[0].name,
      runs: group.length,
      passed,
      failed: group.filter((result) => result.status === 'fail').length,
      skipped: group.filter((result) => result.status === 'skip').length,
      pass_rate: passed / group.length,
      false_positives: group.filter((result) => result.false_positive).length,
      duration_p50_ms: percentile(group.map((result) => result.duration_ms), 0.5),
      duration_p95_ms: percentile(group.map((result) => result.duration_ms), 0.95),
      commands_p50: percentile(group.map((result) => result.commands), 0.5),
      commands_p95: percentile(group.map((result) => result.commands), 0.95),
      commands_total: group.reduce((sum, result) => sum + result.commands, 0),
      observations_total: group.reduce((sum, result) => sum + result.observations, 0),
      mutations_total: group.reduce((sum, result) => sum + result.mutations, 0),
      post_action_recaptures: group.reduce(
        (sum, result) => sum + result.post_action_recaptures,
        0,
      ),
      retries: group.reduce((sum, result) => sum + result.retries, 0),
    };
  });
const sum = (field) => results.reduce((total, result) => total + (Number(result[field]) || 0), 0);
const passed = results.filter((result) => result.status === 'pass').length;
const phaseMs = {};
const actionGroups = new Map();
for (const result of results) {
  for (const [name, timing] of Object.entries(result.phase_ms || {})) {
    phaseMs[name] = Number(((phaseMs[name] || 0) + Number(timing || 0)).toFixed(2));
  }
  for (const [action, metrics] of Object.entries(result.actions || {})) {
    const group = actionGroups.get(action) || {
      commands: 0,
      failures: 0,
      durations_ms: [],
      request_bytes: 0,
      response_text_bytes: 0,
      image_bytes: 0,
    };
    group.commands += Number(metrics.commands) || 0;
    group.failures += Number(metrics.failures) || 0;
    group.durations_ms.push(...(Array.isArray(metrics.durations_ms) ? metrics.durations_ms : []));
    group.request_bytes += Number(metrics.request_bytes) || 0;
    group.response_text_bytes += Number(metrics.response_text_bytes) || 0;
    group.image_bytes += Number(metrics.image_bytes) || 0;
    actionGroups.set(action, group);
  }
}
const actionStats = [...actionGroups.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([action, metrics]) => ({
    action,
    commands: metrics.commands,
    failures: metrics.failures,
    duration_p50_ms: percentile(metrics.durations_ms, 0.5),
    duration_p95_ms: percentile(metrics.durations_ms, 0.95),
    request_bytes: metrics.request_bytes,
    response_text_bytes: metrics.response_text_bytes,
    image_bytes: metrics.image_bytes,
  }));
const report = {
  schema_version: 1,
  label,
  generated_at: new Date().toISOString(),
  repeats: repeatCount,
  require_pass: requirePass,
  scenario_count: scenarioStats.length,
  total_runs: results.length,
  summary: {
    passed,
    failed: results.filter((result) => result.status === 'fail').length,
    skipped: results.filter((result) => result.status === 'skip').length,
    success_rate: results.length ? passed / results.length : 0,
    false_positives: results.filter((result) => result.false_positive).length,
    flaky_scenarios: scenarioStats.filter(
      (scenario) => scenario.failed > 0 || (scenario.passed > 0 && scenario.skipped > 0),
    ).map((scenario) => scenario.id),
    scenario_duration_p50_ms: percentile(results.map((result) => result.duration_ms), 0.5),
    scenario_duration_p95_ms: percentile(results.map((result) => result.duration_ms), 0.95),
    matrix_duration_p50_ms: percentile(
      repeatReports.map((reportItem) => reportItem.summary.duration_ms),
      0.5,
    ),
    matrix_duration_p95_ms: percentile(
      repeatReports.map((reportItem) => reportItem.summary.duration_ms),
      0.95,
    ),
    commands: sum('commands'),
    tool_calls: sum('commands') - sum('cleanup_commands'),
    cleanup_commands: sum('cleanup_commands'),
    commands_per_task: results.length ? sum('commands') / results.length : 0,
    observations: sum('observations'),
    mutations: sum('mutations'),
    accepted_mutations: sum('accepted_mutations'),
    post_action_recaptures: sum('post_action_recaptures'),
    retries: sum('retries'),
    request_bytes: sum('request_bytes'),
    response_text_bytes: sum('response_text_bytes'),
    image_bytes: sum('image_bytes'),
    phase_ms: phaseMs,
  },
  scenarios: scenarioStats,
  actions: actionStats,
  repeat_reports: repeatReports.map((reportItem) => ({
    label: reportItem.label,
    summary: reportItem.summary,
  })),
  results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `Computer Use repeat matrix ${passed}/${results.length} passed;`
    + ` p50=${report.summary.scenario_duration_p50_ms}ms`
    + ` p95=${report.summary.scenario_duration_p95_ms}ms; ${output}`,
);
assertRepeatedScenariosPassed(report.summary, requirePass);
