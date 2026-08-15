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
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    started_at: start,
    finished_at: new Date(new Date(start).getTime() + 60_000).toISOString(),
    n_total_trials: 2,
    stats: {
      n_completed_trials: 2,
      n_errored_trials: 0,
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
    writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
      task_id: { name: task },
      verifier_result: { rewards: { reward: options.rewards?.[index] ?? 1 } },
      agent_execution: {
        started_at: agentStart.toISOString(),
        finished_at: agentFinish.toISOString(),
      },
      agent_result: {
        n_input_tokens: 50,
        n_cache_tokens: 25,
        n_output_tokens: 10,
        cost_usd: options.costs?.[index] ?? 1,
      },
    }));
  }
  return jobsDir;
}

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
