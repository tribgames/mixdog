import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createGoalRuntime,
  DEFAULT_GOAL_TIME_LIMIT_MS,
  parseGoalDuration,
} from './goal-runtime.mjs';

test('Goal runtime persists criteria, enforces completion evidence, and archives after user input', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-'));
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    const created = await runtime.control('sess_goal_main', {
      command: 'Ship Goal mode --time 2h',
    });
    assert.equal(created.goal.status, 'active');
    assert.equal(created.goal.timeLimitMs, 2 * 60 * 60 * 1000);
    assert.equal(created.goal.criteriaTotal, 0);

    const criteria = [
      { text: 'State is durable', satisfied: true, evidence: 'persistence test passed' },
      { text: 'Idle continuation works', satisfied: false, evidence: '' },
    ];
    await runtime.executeTool('update_goal', {
      success_criteria: criteria,
      progress_summary: 'State complete; continuation remains.',
    }, { callerSessionId: 'sess_goal_main' });

    await assert.rejects(
      runtime.executeTool('update_goal', {
        status: 'complete',
        completion_evidence: 'partial evidence',
      }, { callerSessionId: 'sess_goal_main' }),
      /success criteria remain unsatisfied/,
    );

    clock += 12 * 60 * 1000;
    const completedCriteria = criteria.map((criterion) => ({
      ...criterion,
      satisfied: true,
      evidence: criterion.evidence || 'continuation test passed',
    }));
    const completedText = await runtime.executeTool('update_goal', {
      success_criteria: completedCriteria,
      status: 'complete',
      completion_evidence: 'All required checks passed.',
    }, { callerSessionId: 'sess_goal_main' });
    const completed = JSON.parse(completedText).goal;
    assert.equal(completed.status, 'complete');
    assert.equal(completed.criteriaCompleted, 2);
    assert.equal(completed.timeUsedMs, 12 * 60 * 1000);

    await runtime.archiveCompletedOnUserInput('sess_goal_main');
    assert.equal(runtime.snapshot('sess_goal_main'), null);
    assert.equal(runtime.storedSnapshot('sess_goal_main').status, 'complete');

    const reloaded = createGoalRuntime({ dataDir, now: () => clock });
    try {
      assert.equal(reloaded.snapshot('sess_goal_main'), null);
      assert.equal(reloaded.storedSnapshot('sess_goal_main').completionEvidence, 'All required checks passed.');
    } finally {
      reloaded.close();
    }
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal continuation parks only for active agent work and the deadline limits new turns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-limit-'));
  let clock = 1_900_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    await runtime.control('sess_goal_limit', { action: 'create', objective: 'Finish the objective' });
    const parked = runtime.continuation('sess_goal_limit', {
      agentStatus: { agentJobs: [{ status: 'running' }] },
    });
    assert.equal(parked.run, false);
    assert.equal(parked.reason, 'agent-running');

    const shellIgnored = runtime.continuation('sess_goal_limit', {
      agentStatus: { agentJobs: [], shellJobs: [{ status: 'running' }] },
    });
    assert.equal(shellIgnored.run, true);
    assert.match(shellIgnored.prompt, /Active Goal/);

    clock += DEFAULT_GOAL_TIME_LIMIT_MS + 1;
    const limited = runtime.snapshot('sess_goal_limit');
    assert.equal(limited.status, 'budget_limited');
    assert.equal(runtime.continuation('sess_goal_limit').run, false);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal duration parser accepts compound limits and rejects unsafe values', () => {
  assert.equal(parseGoalDuration('1h30m'), 90 * 60 * 1000);
  assert.equal(parseGoalDuration('2d 4h'), (2 * 24 + 4) * 60 * 60 * 1000);
  assert.throws(() => parseGoalDuration('30s'), /at least 1 minute/);
  assert.throws(() => parseGoalDuration('8d'), /exceeds 7 days/);
});
