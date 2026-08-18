import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateRunReport, writeRunReport } from './run-report.mjs';

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
    assert.equal(report.comparison.cohortSize, 2);
    assert.equal(report.comparison.ranks.agentTotalSeconds.rank, 2);
    assert.match(report.comparison.previous.jobsDir, /jobs-legacy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
