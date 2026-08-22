import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateRunReport, pricedCost, rateFor, writeRunReport } from './run-report.mjs';

function measuredContract(overrides = {}) {
  return {
    rulesHash: 'sha256:rules',
    toolContractHash: 'sha256:tools',
    promptSurfaceHash: 'sha256:prompt',
    ...overrides,
  };
}

function fixture(root, name, fingerprint, start, agentSeconds, options = {}) {
  const jobsDir = join(root, name);
  const runDir = join(jobsDir, '2026-08-15__00-00-00');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(jobsDir, 'preset-run.json'), JSON.stringify({
    schemaVersion: 1,
    preset: 'sol-xhigh',
    fingerprint,
    startedAt: start,
    completedAt: new Date(new Date(start).getTime() + 60_000).toISOString(),
    exitCode: 0,
    definition: {
      suite: 'core',
      tasks: ['a', 'b'],
      routeProfile: 'sol-xhigh',
      routes: { lead: { provider: 'openai-oauth', model: 'gpt-5.6-sol', effort: 'xhigh' } },
      concurrent: 8,
      attempts: 1,
    },
    comparison: options.comparison ?? null,
    ...(options.contract === false ? {} : { contract: options.contract ?? measuredContract() }),
  }));
  const errorIndex = Number.isInteger(options.errorIndex) ? options.errorIndex : null;
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    started_at: start,
    finished_at: new Date(new Date(start).getTime() + 60_000).toISOString(),
    n_total_trials: 2,
    stats: {
      n_completed_trials: 2,
      n_errored_trials: errorIndex == null ? 0 : 1,
      n_running_trials: 0,
      n_pending_trials: 0,
      n_cancelled_trials: 0,
      n_retries: 0,
      n_input_tokens: 100,
      n_cache_tokens: 50,
      n_output_tokens: 20,
    },
  }));
  for (const [index, task] of ['a', 'b'].entries()) {
    const trialDir = join(runDir, `${task}__fixture`);
    mkdirSync(trialDir);
    const agentStart = new Date(new Date(start).getTime() + index * 1_000);
    const agentFinish = new Date(agentStart.getTime() + agentSeconds[index] * 1_000);
    const failed = index === errorIndex;
    const reward = options.rewards && Object.hasOwn(options.rewards, index)
      ? options.rewards[index]
      : 1;
    writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
      task_id: { name: task },
      ...(reward == null ? {} : { verifier_result: { rewards: { reward } } }),
      ...(failed ? {
        exception_info: {
          exception_type: 'AgentTimeoutError',
          exception_message: 'Agent execution timed out after 900.0 seconds',
        },
      } : {}),
      agent_execution: {
        started_at: agentStart.toISOString(),
        finished_at: agentFinish.toISOString(),
      },
      ...(!failed ? { agent_result: {
        n_input_tokens: 50,
        n_cache_tokens: 25,
        n_output_tokens: 10,
        cost_usd: options.costs?.[index] ?? 1,
      } } : {}),
    }));
    if (failed && Array.isArray(options.traceRows)) {
      const agentDir = join(trialDir, 'agent');
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, 'agent-trace.jsonl'),
        `${options.traceRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
    }
  }
  return jobsDir;
}

test('includes cached and cache-write input in final context tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-context-report-'));
  try {
    const jobsDir = fixture(root, 'jobs-current', 'sha256:context', '2026-08-15T00:00:00.000Z', [10, 20]);
    const agentDir = join(jobsDir, '2026-08-15__00-00-00', 'a__fixture', 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'mixdog.txt'), `${JSON.stringify({
      type: 'model.request.completed',
      usage: {
        input_tokens: 2,
        cached_input_tokens: 100,
        cache_write_input_tokens: 5,
      },
    })}\n`);
    const report = generateRunReport({ jobsDir, historyRoot: root });
    assert.equal(report.finalContext.medianTokens, 107);
    assert.equal(report.finalContext.trials, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ranks only clean equal-score runs with the same preset fingerprint', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-report-'));
  try {
    const fingerprint = 'sha256:same';
    const olderDir = fixture(root, 'jobs-old', fingerprint, '2026-08-15T00:00:00.000Z', [10, 20]);
    const older = generateRunReport({ jobsDir: olderDir, historyRoot: root });
    writeRunReport(older);

    const otherDir = fixture(root, 'jobs-other', 'sha256:other', '2026-08-15T00:02:00.000Z', [1, 1]);
    writeRunReport(generateRunReport({ jobsDir: otherDir, historyRoot: root }));

    const currentDir = fixture(root, 'jobs-current', fingerprint, '2026-08-15T00:04:00.000Z', [15, 25]);
    const current = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    writeRunReport(current);

    assert.equal(current.result.clean, true);
    assert.deepEqual(current.comparison.ranks.agentTotalSeconds, {
      rank: 2,
      count: 2,
      best: 30,
      median: 35,
    });
    assert.equal(current.comparison.previous.deltas.agentTotalSeconds, 10);
    assert.equal(current.bottlenecks.deltas.agentSeconds, 10);
    assert.equal(current.bottlenecks.slowestTask.agentSeconds, 5);
    assert.match(readFileSync(join(currentDir, 'report.md'), 'utf8'), /rank 2\/2/);
    assert.equal(JSON.parse(readFileSync(join(currentDir, 'report.json'), 'utf8')).preset.fingerprint, fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnoses dirty runs and compares them provisionally with the latest clean run', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-dirty-report-'));
  try {
    const fingerprint = 'sha256:dirty';
    const olderDir = fixture(root, 'jobs-old', fingerprint, '2026-08-15T00:00:00.000Z', [10, 20]);
    writeRunReport(generateRunReport({ jobsDir: olderDir, historyRoot: root }));
    const currentDir = fixture(root, 'jobs-current', fingerprint, '2026-08-15T00:04:00.000Z', [900, 25], {
      errorIndex: 0,
      rewards: [null, 1],
      traceRows: [
        {
          kind: 'usage_raw',
          input_tokens: 123,
          cached_tokens: 100,
          cache_write_tokens: 0,
          output_tokens: 5,
        },
        {
          kind: 'tool',
          iteration: 1,
          tool_name: 'shell',
          tool_args_summary: { command: 'inspect' },
          result_kind: 'normal',
        },
        {
          kind: 'tool',
          iteration: 2,
          tool_name: 'glob',
          tool_args_summary: { pattern: '**/*', path: '/' },
          result_kind: 'error',
          result_error_category: 'timeout/abort',
          result_error_first_line: 'timed out',
        },
      ],
    });
    const report = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    const failed = report.tasks.find((task) => task.task === 'a');

    assert.equal(report.result.clean, false);
    assert.equal(report.comparison.eligible, false);
    assert.equal(report.comparison.provisional, true);
    assert.equal(report.comparison.previous.provisional, true);
    assert.match(report.comparison.previous.jobsDir, /jobs-old/);
    assert.equal(report.bottlenecks.slowestTask.task, 'a');
    assert.deepEqual(report.activity, { providerRequests: 1, toolCalls: 2 });
    assert.deepEqual(report.tokens, { input: 173, cached: 125, cacheWrite: 0, output: 15 });
    assert.equal(failed.trace.providerRequests, 1);
    assert.deepEqual(failed.trace.toolCounts, { glob: 1, shell: 1 });
    assert.equal(failed.trace.failures[0].errorCategory, 'timeout/abort');
    assert.equal(failed.trace.lastCalls.at(-1).tool, 'glob');
    assert.match(formatReport(report), /## Diagnostics/);
    assert.match(formatReport(report), /AgentTimeoutError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loads explicitly registered legacy runs without mutating their artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-history-'));
  try {
    const fingerprint = 'sha256:registered';
    const legacyDir = fixture(root, 'jobs-legacy', fingerprint, '2026-08-15T00:00:00.000Z', [10, 20]);
    unlinkSync(join(legacyDir, 'preset-run.json'));
    writeFileSync(join(root, 'preset-history.json'), JSON.stringify({
      schemaVersion: 1,
      runs: [{
        preset: 'sol-xhigh',
        fingerprint,
        runDir: 'jobs-legacy/2026-08-15__00-00-00',
        verified: { concurrent: 8, attempts: 1, maxRetries: 2 },
      }],
    }));
    const currentDir = fixture(root, 'jobs-current', fingerprint, '2026-08-15T00:04:00.000Z', [15, 25]);
    const report = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    assert.equal(report.comparison.cohortSize, 1);
    assert.equal(report.comparison.previous, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical runs missing a prompt surface hash do not enter the cohort', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-contractless-'));
  try {
    const fingerprint = 'sha256:contract';
    const olderDir = fixture(root, 'jobs-old', fingerprint, '2026-08-15T00:00:00.000Z', [10, 20], {
      contract: measuredContract({ promptSurfaceHash: undefined }),
    });
    const olderManifest = JSON.parse(readFileSync(join(olderDir, 'preset-run.json'), 'utf8'));
    delete olderManifest.contract.promptSurfaceHash;
    writeFileSync(join(olderDir, 'preset-run.json'), JSON.stringify(olderManifest));
    writeRunReport(generateRunReport({ jobsDir: olderDir, historyRoot: root }));
    const currentDir = fixture(root, 'jobs-current', fingerprint, '2026-08-15T00:04:00.000Z', [15, 25]);
    const current = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    assert.equal(current.comparison.cohortSize, 1);
    assert.equal(current.comparison.previous, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('historical runs with a different prompt surface hash do not enter the cohort', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-prompt-hash-'));
  try {
    const fingerprint = 'sha256:prompt-surface';
    const olderDir = fixture(root, 'jobs-old', fingerprint, '2026-08-15T00:00:00.000Z', [10, 20], {
      contract: measuredContract({ promptSurfaceHash: 'sha256:other-prompt' }),
    });
    writeRunReport(generateRunReport({ jobsDir: olderDir, historyRoot: root }));
    const currentDir = fixture(root, 'jobs-current', fingerprint, '2026-08-15T00:04:00.000Z', [15, 25]);
    const current = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    assert.equal(current.comparison.cohortSize, 1);
    assert.equal(current.comparison.previous, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown claude identifiers report unsupported cost instead of Opus rates', () => {
  assert.equal(rateFor('claude-sonnet-4-5'), null);
  assert.equal(rateFor('claude-unknown'), null);
  assert.equal(rateFor('grok-4'), null);
  assert.equal(rateFor('gpt-unknown'), null);
  assert.equal(rateFor('constructor'), null);
  assert.equal(rateFor('__proto__'), null);
  assert.equal(pricedCost({ model: 'claude-sonnet-4-5', input: 1e6, output: 1e6 }), null);
  assert.equal(pricedCost({ model: 'gpt-unknown', input: 1e6, output: 1e6 }), null);
  assert.equal(pricedCost({ model: 'constructor', input: 1e6, output: 1e6 }), null);
  assert.equal(pricedCost({ model: '__proto__', input: 1e6, output: 1e6 }), null);
  assert.ok(rateFor('claude-opus-5'));
  assert.ok(rateFor('claude-fable-5'));
  assert.ok(rateFor('claude-haiku-4-5'));
  assert.ok(rateFor('claude-sonnet-5'));
  assert.ok(rateFor('gpt-5.6-sol'));
  assert.equal(pricedCost({ model: 'claude-opus-5', input: 1e6, cached: 0, cacheWrite: 0, output: 0 }), 5);
  assert.equal(pricedCost({ model: 'claude-sonnet-5', input: 1e6, cached: 0, cacheWrite: 0, output: 0 }), 2);
});

test('pairs a full preset with its pinned baseline on settled shared tasks', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-pair-'));
  try {
    fixture(root, 'jobs-baseline', 'sha256:baseline', '2026-08-15T00:00:00.000Z', [20, 40], {
      rewards: [1, 0],
      costs: [2, 2],
    });
    const currentDir = fixture(root, 'jobs-current', 'sha256:current', '2026-08-15T00:04:00.000Z', [15, 25], {
      costs: [1, 1],
      comparison: {
        name: 'fixture-baseline',
        baseline: {
          label: 'Fixture baseline',
          jobsDir: 'jobs-baseline',
          finalContextMedianTokens: 100,
        },
      },
    });
    const report = generateRunReport({ jobsDir: currentDir, historyRoot: root });
    assert.equal(report.pair.sharedTasks, 2);
    assert.deepEqual(report.pair.outcomes, {
      oursOnly: 1,
      baselineOnly: 0,
      bothPass: 1,
      bothFail: 0,
    });
    assert.equal(report.pair.ratios.speedup, 1.5);
    assert.equal(report.pair.ratios.cost, 0.5);
    assert.match(formatReport(report), /Pair: Fixture baseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function formatReport(report) {
  writeRunReport(report);
  return readFileSync(join(report.paths.jobsDir, 'report.md'), 'utf8');
}
