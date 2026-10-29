import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createGoalRuntime,
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  DEFAULT_GOAL_TIME_LIMIT_MS,
  GOAL_TOOL_DEFS,
  parseGoalDuration,
} from './goal-runtime.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../../../shared/background-tasks.mjs';
import { beginUserCycle, stampShellJobCycle } from '../../../shared/background-wait.mjs';

test('Goal runtime keeps completion visible across restart, then archives it on user input until TTL deletion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-'));
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    const created = await runtime.control('sess_goal_main', {
      command: 'Ship Goal mode --time 2h',
    });
    assert.equal(created.goal.status, 'active');
    assert.equal(created.goal.timeLimitMs, 2 * 60 * 60 * 1000);
    assert.equal(created.goal.title, 'Ship Goal mode');
    await runtime.startTurn('sess_goal_main');

    clock += 2 * 60 * 60 * 1000;
    const completedText = await runtime.executeTool(
      'goal',
      {
        action: 'complete',
      },
      { callerSessionId: 'sess_goal_main' }
    );
    const completed = JSON.parse(completedText).goal;
    assert.equal(completed.status, 'complete');
    assert.equal(completed.timeUsedMs, 2 * 60 * 60 * 1000);

    const goalPath = join(dataDir, 'goals', 'sess_goal_main.json');
    assert.equal(runtime.snapshot('sess_goal_main').status, 'complete');
    assert.equal(runtime.storedSnapshot('sess_goal_main').status, 'complete');
    assert.equal(existsSync(goalPath), true);
    runtime.close();

    const reloaded = createGoalRuntime({ dataDir, now: () => clock });
    try {
      assert.equal(reloaded.snapshot('sess_goal_main').status, 'complete');
      await reloaded.archiveCompletedOnUserInput('sess_goal_main');
      assert.equal(reloaded.snapshot('sess_goal_main'), null);
      assert.equal(reloaded.storedSnapshot('sess_goal_main').status, 'complete');
      assert.equal(reloaded.storedSnapshot('sess_goal_main').archivedAt, clock);
      // Retired work owns no turn chrome: neither boundary may hand the
      // archived record back to the session lane, or the capsule the user's
      // prompt dismissed pops back for a frame (user: 사라질 때 한 번 더 생성).
      assert.equal(await reloaded.startTurn('sess_goal_main'), null);
      assert.equal(await reloaded.settleTurn('sess_goal_main', { status: 'done' }), null);
    } finally {
      reloaded.close();
    }

    const hiddenReload = createGoalRuntime({ dataDir, now: () => clock });
    try {
      assert.equal(hiddenReload.snapshot('sess_goal_main'), null);
      clock += DEFAULT_COMPLETED_GOAL_TTL_MS - 1;
      assert.equal(hiddenReload.snapshot('sess_goal_main'), null);
      assert.equal(existsSync(goalPath), true);
      clock += 1;
      assert.equal(hiddenReload.snapshot('sess_goal_main'), null);
      assert.equal(hiddenReload.storedSnapshot('sess_goal_main'), null);
      assert.equal(existsSync(goalPath), false);
    } finally {
      hiddenReload.close();
    }
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal titles use the compact fallback and promote an async generated title', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-title-'));
  let releaseTitle;
  const generated = new Promise((resolve) => {
    releaseTitle = resolve;
  });
  const runtime = createGoalRuntime({
    dataDir,
    generateTitle: async () => generated,
  });
  try {
    const created = await runtime.control('sess_goal_title', {
      action: 'create',
      objective: 'Implement a durable Goal task system with mobile layout verification',
    });
    assert.ok(created.goal.title.length <= 32);
    const titleSaved = new Promise((resolve) => {
      const unsubscribe = runtime.subscribe(({ goal }) => {
        if (goal?.title !== 'Durable Goal Tasks') return;
        unsubscribe();
        resolve();
      });
    });
    releaseTitle('Durable Goal Tasks');
    await titleSaved;
    assert.equal(runtime.snapshot('sess_goal_title').title, 'Durable Goal Tasks');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goals default to no deadline and active elapsed time stays synchronized across resume and settled turns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-unlimited-'));
  let clock = 1_850_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    let goal = (
      await runtime.control('sess_goal_unlimited', {
        action: 'create',
        objective: 'Track elapsed work without a deadline',
      })
    ).goal;
    assert.equal(goal.timeLimitMs, 0);
    assert.equal(goal.remainingMs, null);
    assert.equal(goal.deadlineAt, null);

    clock += 5_000;
    goal = runtime.snapshot('sess_goal_unlimited');
    assert.equal(goal.timeUsedMs, 5_000);
    await runtime.control('sess_goal_unlimited', { action: 'pause' });
    clock += 5_000;
    assert.equal(runtime.snapshot('sess_goal_unlimited').timeUsedMs, 5_000);

    await runtime.startTurn('sess_goal_unlimited');
    goal = (await runtime.control('sess_goal_unlimited', { action: 'resume' })).goal;
    assert.equal(goal.lastStartedAt, clock);
    clock += 5_000;
    goal = await runtime.settleTurn('sess_goal_unlimited', { status: 'done' });
    assert.equal(goal.timeUsedMs, 10_000);
    clock += 5_000;
    assert.equal(runtime.snapshot('sess_goal_unlimited').timeUsedMs, 15_000);
    assert.match(runtime.continuation('sess_goal_unlimited').prompt, /Time elapsed:/);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal continuation waits on running agents and background shells of this cycle, not earlier servers, and the deadline limits turns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-limit-'));
  let clock = 1_900_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  const shellTasks = [];
  try {
    const limitMs = 60 * 60 * 1000;
    await runtime.control('sess_goal_limit', {
      action: 'create',
      objective: 'Finish the objective',
      timeLimitMs: limitMs,
    });
    const parked = runtime.continuation('sess_goal_limit', {
      agentStatus: { agentJobs: [{ status: 'running' }] },
    });
    assert.equal(parked.run, false);
    assert.equal(parked.reason, 'awaiting-work');

    // A server started in an earlier user cycle never counts as a wait.
    const context = { callerSessionId: 'sess_goal_limit' };
    const server = stampShellJobCycle(registerBackgroundTask({ surface: 'shell', context }));
    shellTasks.push(server);
    beginUserCycle('sess_goal_limit');
    assert.equal(runtime.continuation('sess_goal_limit').run, true);

    // A background build started this cycle does, until it finishes.
    const build = stampShellJobCycle(registerBackgroundTask({ surface: 'shell', context }));
    shellTasks.push(build);
    assert.equal(runtime.continuation('sess_goal_limit').reason, 'awaiting-work');
    completeBackgroundTask(build.taskId, { status: 'completed', notify: false });
    assert.equal(runtime.continuation('sess_goal_limit').run, true);

    clock += limitMs + 1;
    const limited = runtime.snapshot('sess_goal_limit');
    assert.equal(limited.status, 'duration_reached');
    assert.equal(runtime.continuation('sess_goal_limit').run, false);
  } finally {
    for (const task of shellTasks) completeBackgroundTask(task.taskId, { status: 'completed', notify: false });
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the runtime never completes a Goal by itself; model and user completions both settle it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-user-complete-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_user_complete', { action: 'create', objective: 'Half-finished work' });
    await runtime.startTurn('sess_goal_user_complete');
    await runtime.settleTurn('sess_goal_user_complete', { status: 'done' });
    assert.equal(runtime.snapshot('sess_goal_user_complete').status, 'active');
    const completed = (await runtime.control('sess_goal_user_complete', { action: 'complete' })).goal;
    assert.equal(completed.status, 'complete');
    await runtime.control('sess_goal_model_complete', { action: 'create', objective: 'Verified work' });
    const model = JSON.parse(
      await runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: 'sess_goal_model_complete' })
    ).goal;
    assert.equal(model.status, 'complete');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a legacy time-capped Goal loads as a finished duration, never as active work', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-legacy-'));
  try {
    mkdirSync(join(dataDir, 'goals'), { recursive: true });
    writeFileSync(
      join(dataDir, 'goals', 'sess_goal_legacy.json'),
      JSON.stringify({
        version: 1,
        goal: {
          id: 'goal_legacy',
          sessionId: 'sess_goal_legacy',
          objective: 'Legacy capped Goal',
          status: 'budget_limited',
          tasks: [{ id: 'task_1', text: 'Legacy work', status: 'pending' }],
          timeLimitMs: 60_000,
          timeUsedMs: 60_000,
          createdAt: 1_800_000_000_000,
          updatedAt: 1_800_000_000_000,
        },
      })
    );
    const runtime = createGoalRuntime({ dataDir });
    try {
      // Falling through to the default would silently restart a Goal whose
      // requested duration had already elapsed.
      assert.equal(runtime.snapshot('sess_goal_legacy').status, 'duration_reached');
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal observations count turns without judging them', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-observe-'));
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    await runtime.control('sess_goal_observe', { action: 'create', objective: 'Observed work' });
    assert.equal(runtime.snapshot('sess_goal_observe').turnCount, 0);

    await runtime.startTurn('sess_goal_observe');
    await runtime.settleTurn('sess_goal_observe', { status: 'done' });
    await runtime.startTurn('sess_goal_observe');
    assert.equal(runtime.snapshot('sess_goal_observe').turnCount, 2);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal status shows the model exactly what the user still sees', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-visible-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_visible', { action: 'create', objective: 'Archived work' });
    await runtime.executeTool(
      'goal',
      { action: 'complete' },
      {
        callerSessionId: 'sess_goal_visible',
      }
    );
    await runtime.archiveCompletedOnUserInput('sess_goal_visible');

    const status = JSON.parse(
      await runtime.executeTool(
        'goal',
        {
          action: 'status',
        },
        { callerSessionId: 'sess_goal_visible' }
      )
    );
    assert.equal(status.goal, null);
    assert.equal(runtime.snapshot('sess_goal_visible'), null);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal turn lifecycle stops terminal failures, preserves blockers, and supports resume', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-lifecycle-'));
  let clock = 2_000_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    await runtime.control('sess_goal_lifecycle', { action: 'create', objective: 'Finish lifecycle work' });
    await runtime.startTurn('sess_goal_lifecycle');
    clock += 30_000;
    let goal = await runtime.settleTurn('sess_goal_lifecycle', { status: 'cancelled' });
    assert.equal(goal.status, 'paused');
    assert.equal(goal.timeUsedMs, 30_000);

    goal = (await runtime.control('sess_goal_lifecycle', { action: 'resume' })).goal;
    assert.equal(goal.status, 'active');

    await runtime.startTurn('sess_goal_lifecycle');
    clock += 10_000;
    goal = await runtime.settleTurn('sess_goal_lifecycle', {
      status: 'failed',
      error: 'provider request failed',
    });
    assert.equal(goal.status, 'blocked');
    assert.equal(goal.blocker, 'provider request failed');
    assert.equal(runtime.continuation('sess_goal_lifecycle').run, false);

    await runtime.control('sess_goal_lifecycle', { action: 'resume' });
    await runtime.startTurn('sess_goal_lifecycle');
    clock += 10_000;
    goal = await runtime.settleTurn('sess_goal_lifecycle', {
      status: 'failed',
      error: 'network unavailable',
    });
    assert.equal(goal.status, 'blocked');
    assert.equal(goal.blocker, 'network unavailable');

    await runtime.executeTool('goal', { action: 'status' }, { callerSessionId: 'sess_goal_lifecycle' });
    await assert.rejects(
      runtime.executeTool(
        'goal',
        {
          action: 'block',
        },
        { callerSessionId: 'sess_goal_lifecycle' }
      ),
      /blocker is required/
    );
    await runtime.control('sess_goal_lifecycle', { action: 'resume' });
    await runtime.executeTool('goal', { action: 'status' }, { callerSessionId: 'sess_goal_lifecycle' });
    goal = JSON.parse(
      await runtime.executeTool(
        'goal',
        {
          action: 'block',
          blocker: 'Waiting for deployment credentials',
        },
        { callerSessionId: 'sess_goal_lifecycle' }
      )
    ).goal;
    assert.equal(goal.status, 'blocked');
    assert.equal(goal.blocker, 'Waiting for deployment credentials');

    await runtime.control('sess_goal_lifecycle', { action: 'resume' });
    await runtime.startTurn('sess_goal_lifecycle');
    goal = await runtime.settleTurn('sess_goal_lifecycle', {
      status: 'failed',
      error: 'quota exhausted',
      usageLimited: true,
    });
    assert.equal(goal.status, 'usage_limited');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal tool rejects a stale turn update after the Goal is replaced', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-stale-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_stale', { action: 'create', objective: 'Original Goal' });
    await runtime.startTurn('sess_goal_stale');
    await runtime.control('sess_goal_stale', { action: 'complete' });
    await runtime.control('sess_goal_stale', { action: 'clear' });
    await runtime.control('sess_goal_stale', { action: 'create', objective: 'Replacement Goal' });
    for (const args of [{ action: 'block', blocker: 'stale turn result' }, { action: 'complete' }]) {
      await assert.rejects(
        runtime.executeTool('goal', args, { callerSessionId: 'sess_goal_stale' }),
        /stale Goal update rejected/
      );
    }
    assert.equal(runtime.snapshot('sess_goal_stale').objective, 'Replacement Goal');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('daemon restart preserves active, paused, blocked, and complete Goal snapshots exactly', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-restart-'));
  let clock = 2_100_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock });
  try {
    const active = (
      await runtime.control('sess_goal_restart_active', {
        action: 'create',
        objective: 'Resume active work',
      })
    ).goal;
    await runtime.startTurn('sess_goal_restart_active');
    clock += 2_000;
    const preservedActive = await runtime.settleTurn('sess_goal_restart_active', {
      status: 'cancelled',
      preserveGoalState: true,
    });
    assert.equal(preservedActive.status, 'active');

    const paused = (
      await runtime.control('sess_goal_restart_paused', {
        action: 'create',
        objective: 'Keep paused work',
      })
    ).goal;
    await runtime.control('sess_goal_restart_paused', { action: 'pause' });

    const blocked = (
      await runtime.control('sess_goal_restart_blocked', {
        action: 'create',
        objective: 'Keep blocked work',
      })
    ).goal;
    await runtime.startTurn('sess_goal_restart_blocked');
    await runtime.executeTool(
      'goal',
      {
        action: 'block',
        blocker: 'External service unavailable',
      },
      { callerSessionId: 'sess_goal_restart_blocked' }
    );
    await runtime.settleTurn('sess_goal_restart_blocked', { status: 'done' });

    const complete = (
      await runtime.control('sess_goal_restart_complete', {
        action: 'create',
        objective: 'Keep completed work visible',
      })
    ).goal;
    await runtime.executeTool(
      'goal',
      {
        action: 'complete',
      },
      { callerSessionId: 'sess_goal_restart_complete' }
    );
    const completed = runtime.snapshot('sess_goal_restart_complete');
    runtime.close();

    clock += 5_000;
    const reloaded = createGoalRuntime({ dataDir, now: () => clock });
    try {
      const events = [];
      const unsubscribe = reloaded.subscribe((event) => events.push(event));
      const restoredActive = reloaded.watchSession('sess_goal_restart_active');
      unsubscribe();
      assert.equal(restoredActive.id, active.id);
      assert.equal(restoredActive.status, 'active');
      assert.equal(restoredActive.lastStartedAt, preservedActive.lastStartedAt);
      assert.equal(restoredActive.timeUsedMs, preservedActive.timeUsedMs + 5_000);
      assert.equal(reloaded.continuation('sess_goal_restart_active').run, true);
      assert.equal(events.at(-1)?.goal?.id, active.id);

      const restoredPaused = reloaded.snapshot('sess_goal_restart_paused');
      assert.equal(restoredPaused.id, paused.id);
      assert.equal(restoredPaused.status, 'paused');
      assert.equal(reloaded.continuation('sess_goal_restart_paused').run, false);

      const restoredBlocked = reloaded.snapshot('sess_goal_restart_blocked');
      assert.equal(restoredBlocked.id, blocked.id);
      assert.equal(restoredBlocked.status, 'blocked');
      assert.equal(restoredBlocked.blocker, 'External service unavailable');

      const restoredComplete = reloaded.snapshot('sess_goal_restart_complete');
      assert.equal(restoredComplete.id, complete.id);
      assert.equal(restoredComplete.status, 'complete');
      assert.equal(restoredComplete.completedAt, completed.completedAt);
    } finally {
      reloaded.close();
    }
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

test('Goal tool schema is the minimal lifecycle surface within its size budget', () => {
  assert.equal(GOAL_TOOL_DEFS.length, 1);
  const goalTool = GOAL_TOOL_DEFS[0];
  assert.deepEqual(goalTool.inputSchema.required, ['action']);
  assert.deepEqual(Object.keys(goalTool.inputSchema.properties), ['action', 'objective', 'time_limit_minutes', 'blocker']);
  assert.deepEqual(goalTool.inputSchema.properties.action.enum, ['status', 'create', 'complete', 'block']);
  assert.match(goalTool.description, /todo/);
  assert.doesNotMatch(goalTool.description, /goal-management/);
  const size = JSON.stringify(goalTool).length;
  assert.ok(size < 1_900, `goal tool schema is ${size} chars; budget 1900`);
});
