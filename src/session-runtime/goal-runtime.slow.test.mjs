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
    assert.deepEqual(created.goal.tasks, []);
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Persist Goal state', status: 'completed', kind: 'work' },
        { text: 'Verify Goal continuation', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_main' });
    await runtime.startTurn('sess_goal_main');

    clock += 12 * 60 * 1000;
    const completedText = await runtime.executeTool('goal', {
      action: 'complete',
    }, { callerSessionId: 'sess_goal_main' });
    const completed = JSON.parse(completedText).goal;
    assert.equal(completed.status, 'complete');
    assert.equal(completed.tasksCompleted, 2);
    assert.equal(completed.timeUsedMs, 12 * 60 * 1000);

    const goalPath = join(dataDir, 'goals', 'sess_goal_main.json');
    assert.equal(runtime.snapshot('sess_goal_main').status, 'complete');
    assert.equal(runtime.storedSnapshot('sess_goal_main').status, 'complete');
    assert.equal(existsSync(goalPath), true);
    runtime.close();

    const reloaded = createGoalRuntime({ dataDir, now: () => clock });
    try {
      assert.equal(reloaded.snapshot('sess_goal_main').status, 'complete');
      assert.equal(reloaded.storedSnapshot('sess_goal_main').tasksTotal, 2);
      await reloaded.archiveCompletedOnUserInput('sess_goal_main');
      assert.equal(reloaded.snapshot('sess_goal_main'), null);
      assert.equal(reloaded.storedSnapshot('sess_goal_main').status, 'complete');
      assert.equal(reloaded.storedSnapshot('sess_goal_main').archivedAt, clock);
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
  const generated = new Promise((resolve) => { releaseTitle = resolve; });
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
    releaseTitle('Durable Goal Tasks');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
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
    let goal = (await runtime.control('sess_goal_unlimited', {
      action: 'create',
      objective: 'Track elapsed work without a deadline',
    })).goal;
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

test('legacy Goal criteria migrate into durable task statuses', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-migrate-'));
  const goalsDir = join(dataDir, 'goals');
  mkdirSync(goalsDir, { recursive: true });
  writeFileSync(join(goalsDir, 'sess_goal_legacy.json'), JSON.stringify({
    version: 1,
    goal: {
      id: 'legacy-goal',
      sessionId: 'sess_goal_legacy',
      objective: 'Migrate the Goal',
      status: 'active',
      criteria: [
        { id: 'criterion_1', text: 'Keep completed work', satisfied: true },
        { id: 'criterion_2', text: 'Keep pending work', satisfied: false },
      ],
      timeLimitMs: DEFAULT_GOAL_TIME_LIMIT_MS,
      createdAt: 1,
      updatedAt: 1,
    },
  }));
  const runtime = createGoalRuntime({ dataDir });
  try {
    const goal = runtime.snapshot('sess_goal_legacy');
    assert.deepEqual(goal.tasks.map((task) => task.status), ['completed', 'pending']);
    assert.equal(goal.tasksTotal, 2);
    assert.equal(goal.tasks[0].id, 'criterion_1');
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
    assert.equal(parked.reason, 'agent-running');

    const shellIgnored = runtime.continuation('sess_goal_limit', {
      agentStatus: { agentJobs: [], shellJobs: [{ status: 'running' }] },
    });
    assert.equal(shellIgnored.run, true);
    assert.match(shellIgnored.prompt, /Active Goal/);
    assert.match(shellIgnored.prompt, /goal action "set_tasks"/);
    assert.match(shellIgnored.prompt, /mark current work in_progress before starting/);
    assert.match(shellIgnored.prompt, /requested duration is a full-period work commitment/);
    assert.match(shellIgnored.prompt, /keep implementing, verifying, reviewing, and polishing/);
    assert.match(shellIgnored.prompt, /do not complete early unless the user allows it/);
    assert.match(shellIgnored.prompt, /audit each user condition on its own/);
    assert.match(shellIgnored.prompt, /every user condition is proven met/);
    assert.match(shellIgnored.prompt, /Finish every approved task without stepwise approval/);
    assert.match(shellIgnored.prompt, /Paused is the only Goal waiting state/);
    // Deferred pause in short form: the full standing contract is owned by the
    // tool-description test, so the per-turn prompt only points at it.
    assert.match(shellIgnored.prompt, /park work that needs a user response as awaiting_approval/);
    assert.match(shellIgnored.prompt, /same external impasse prevents meaningful progress for 3 consecutive Goal turns/);
    assert.match(shellIgnored.prompt, /never for user input, approval, direction choice, difficulty, uncertainty, or incomplete work/);
    assert.doesNotMatch(shellIgnored.prompt, /success criteria|criteria_revision_summary/i);
    // Injected once per continuation, so it stays lean while retaining the
    // deferred-pause and full-duration commitments long-running Goals depend on.
    assert.ok(shellIgnored.prompt.length < 2_300);

    clock += limitMs + 1;
    const limited = runtime.snapshot('sess_goal_limit');
    assert.equal(limited.status, 'duration_reached');
    assert.equal(runtime.continuation('sess_goal_limit').run, false);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal completion requires all durable tasks and a completed verification task', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-status-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_status', { action: 'create', objective: 'Ship a verified result' });
    await assert.rejects(
      runtime.executeTool('goal', {}, { callerSessionId: 'sess_goal_status' }),
      /action is required/,
    );
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: 'sess_goal_status' }),
      /at least one durable task/,
    );
    let goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Implement result', status: 'completed', kind: 'work' },
        { text: 'Verify result', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_status' })).goal;
    assert.equal(goal.tasksCompleted, 1);
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'set_tasks',
        tasks: [goal.tasks[0]],
      }, { callerSessionId: 'sess_goal_status' }),
      /cannot remove unfinished Goal tasks: task_2 \(Verify result\)/,
    );
    assert.equal(runtime.snapshot('sess_goal_status').tasksTotal, 2);
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: 'sess_goal_status' }),
      /durable tasks remain incomplete/,
    );
    goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: goal.tasks.map((task) => ({ ...task, status: 'completed' })),
    }, { callerSessionId: 'sess_goal_status' })).goal;
    const completed = JSON.parse(await runtime.executeTool('goal', {
      action: 'complete',
    }, { callerSessionId: 'sess_goal_status' })).goal;
    assert.equal(completed.status, 'complete');
    assert.equal(completed.tasksCompleted, 2);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal tool schemas expose lifecycle and durable task contracts', () => {
  assert.equal(GOAL_TOOL_DEFS.length, 1);
  const goalTool = GOAL_TOOL_DEFS[0];
  assert.equal(goalTool.name, 'goal');
  assert.deepEqual(goalTool.inputSchema.required, ['action']);
  assert.deepEqual(Object.keys(goalTool.inputSchema.properties), [
    'action', 'objective', 'time_limit_minutes', 'tasks', 'blocker',
  ]);
  assert.deepEqual(goalTool.inputSchema.properties.action.enum, [
    'status', 'create', 'pause', 'resume', 'set_tasks', 'complete', 'block', 'abandon',
  ]);
  assert.deepEqual(goalTool.inputSchema.properties.tasks.items.required, ['text', 'status', 'kind']);
  assert.equal(goalTool.inputSchema.properties.blocker.minLength, 1);
  assert.match(goalTool.description, /If a mutation needs approval, create the Goal only after it/i);
  assert.match(goalTool.description, /3\+ steps or careful planning/i);
  assert.match(goalTool.description, /skip trivial or conversational work/i);
  assert.match(goalTool.description, /idle reminder for unfinished work/i);
  assert.match(goalTool.description, /never spend an iteration on Goal alone: batch create\/resume\/set_tasks with the next work tool/i);
  assert.match(goalTool.description, /finish every approved step without stepwise approval/i);
  assert.match(goalTool.inputSchema.properties.time_limit_minutes.description, /full-period active work commitment/i);
  assert.match(goalTool.inputSchema.properties.time_limit_minutes.description, /do not complete early unless user allows it/i);
  assert.match(goalTool.description, /paused is the only user-wait state/i);
  // Deferred pause: a long-running Goal must not idle for hours on one
  // approval while approval-free work is still available.
  assert.match(goalTool.description, /mark work needing a user answer awaiting_approval \(work that answer could invalidate counts too\), keep doing the rest/i);
  assert.match(goalTool.description, /pause once nothing can proceed and ask every parked question at once/i);
  assert.match(goalTool.description, /never pause for routine errors, retries, or a user addition/i);
  assert.match(goalTool.description, /resume right after the answer/i);
  assert.match(goalTool.description, /Block only when the same external impasse stops progress for 3 turns/i);
  // A stopped Goal must stay retirable, or it blocks every later Goal.
  assert.match(goalTool.description, /Abandon only when the user redirects away from the objective/i);
  assert.doesNotMatch(goalTool.description, /opt-in|explicit user request/i);
  assert.match(goalTool.inputSchema.properties.action.description, /pause is the single user-wait state; resume continues it/i);
  assert.match(goalTool.inputSchema.properties.action.description, /abandon discards a superseded Goal/i);
  assert.match(goalTool.inputSchema.properties.blocker.description, /external impasse.*3 consecutive turns/i);
  // Retiring scoped-out work must not require falsely marking it completed.
  assert.deepEqual(goalTool.inputSchema.properties.tasks.items.properties.status.enum, [
    'pending', 'in_progress', 'completed', 'dropped', 'awaiting_approval',
  ]);
  // Schema bytes ride on every request, so this ceiling tracks the intended
  // surface rather than drifting: it covers abandon, the dropped and
  // awaiting_approval task states, and the deferred-pause contract, with the
  // prose already consolidated once to pay for them.
  assert.ok(JSON.stringify(goalTool).length < 3_000);
});

test('a user completes their own Goal without the model evidence gate', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-user-complete-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_user_complete', {
      action: 'create',
      objective: 'Half-finished work',
    });
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Unfinished work', status: 'in_progress', kind: 'work' },
        { text: 'Unrun verification', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_user_complete' });
    // The model's completion claim stays gated on evidence.
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, {
        callerSessionId: 'sess_goal_user_complete',
      }),
      /durable tasks remain incomplete/,
    );
    // The user's is not. Before this, the only user-side exit was deleting the
    // Goal, which threw the whole record away.
    const completed = (await runtime.control('sess_goal_user_complete', {
      action: 'complete',
    })).goal;
    assert.equal(completed.status, 'complete');
    assert.equal(completed.tasksCompleted, 0);
    assert.equal(completed.tasksTotal, 2);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('editing the objective keeps durable task progress', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-edit-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_edit', { action: 'create', objective: 'Original wording' });
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Finished step', status: 'completed', kind: 'work' },
        { text: 'Remaining step', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_edit' });
    // The desktop edit button drafts the CURRENT objective, so refining one
    // word must not discard finished rows.
    const edited = (await runtime.control('sess_goal_edit', {
      action: 'edit',
      objective: 'Original wording, clarified',
    })).goal;
    assert.equal(edited.objective, 'Original wording, clarified');
    assert.equal(edited.tasksTotal, 2);
    assert.equal(edited.tasksCompleted, 1);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dropped tasks retire scoped-out work without a false completion', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-dropped-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_dropped', { action: 'create', objective: 'Ship the feature' });
    let goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Build the feature', status: 'completed', kind: 'work' },
        { text: 'Port the legacy path', status: 'pending', kind: 'work' },
        { text: 'Verify the feature', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_dropped' })).goal;
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, { callerSessionId: 'sess_goal_dropped' }),
      /durable tasks remain incomplete/,
    );

    // Scope changed: the row is retired, not falsely completed.
    goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: goal.tasks.map((task) =>
        (task.id === 'task_2' ? { ...task, status: 'dropped' } : task)),
    }, { callerSessionId: 'sess_goal_dropped' })).goal;
    assert.equal(goal.tasks.length, 3);
    assert.equal(goal.tasks[1].status, 'dropped');
    // Retired work leaves the denominator so progress moves instead of freezing.
    assert.equal(goal.tasksTotal, 2);
    assert.equal(goal.tasksCompleted, 2);

    // Settled rows may be omitted from a later snapshot; unfinished ones may not.
    const trimmed = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: goal.tasks.filter((task) => task.status !== 'dropped'),
    }, { callerSessionId: 'sess_goal_dropped' })).goal;
    assert.equal(trimmed.tasks.length, 2);

    const completed = JSON.parse(await runtime.executeTool('goal', {
      action: 'complete',
    }, { callerSessionId: 'sess_goal_dropped' })).goal;
    assert.equal(completed.status, 'complete');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('work dropped this turn cannot also close the Goal in the same turn', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-drop-turn-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_drop_turn', { action: 'create', objective: 'Ship both paths' });
    await runtime.startTurn('sess_goal_drop_turn');
    let goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Ship the main path', status: 'completed', kind: 'work' },
        { text: 'Ship the legacy path', status: 'pending', kind: 'work' },
        { text: 'Verify both paths', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_drop_turn' })).goal;
    goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: goal.tasks.map((task) =>
        (task.id === 'task_2' ? { ...task, status: 'dropped' } : task)),
    }, { callerSessionId: 'sess_goal_drop_turn' })).goal;
    // Writing requested work off and closing the Goal in one breath is how a
    // user condition disappears unnoticed, so the drop has to outlive the turn.
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, {
        callerSessionId: 'sess_goal_drop_turn',
      }),
      /dropped this turn/,
    );
    // Omitting the retired row does not launder the same turn either.
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: goal.tasks.filter((task) => task.status !== 'dropped'),
    }, { callerSessionId: 'sess_goal_drop_turn' });
    await assert.rejects(
      runtime.executeTool('goal', { action: 'complete' }, {
        callerSessionId: 'sess_goal_drop_turn',
      }),
      /dropped this turn/,
    );
    // A later turn, where the user has seen the retired row, completes normally.
    await runtime.startTurn('sess_goal_drop_turn');
    const completed = JSON.parse(await runtime.executeTool('goal', {
      action: 'complete',
    }, { callerSessionId: 'sess_goal_drop_turn' })).goal;
    assert.equal(completed.status, 'complete');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('abandoning a superseded Goal releases the create guard', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-abandon-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_abandon', { action: 'create', objective: 'Superseded work' });
    await runtime.control('sess_goal_abandon', { action: 'pause' });
    // A stopped Goal used to block every later Goal in the session for good.
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'create',
        objective: 'Replacement work',
      }, { callerSessionId: 'sess_goal_abandon' }),
      /abandon it if the user redirected away/,
    );

    const abandoned = JSON.parse(await runtime.executeTool('goal', {
      action: 'abandon',
    }, { callerSessionId: 'sess_goal_abandon' }));
    assert.equal(abandoned.goal, null);
    assert.equal(runtime.snapshot('sess_goal_abandon'), null);

    const created = JSON.parse(await runtime.executeTool('goal', {
      action: 'create',
      objective: 'Replacement work',
    }, { callerSessionId: 'sess_goal_abandon' })).goal;
    assert.equal(created.objective, 'Replacement work');
    assert.equal(created.status, 'active');

    await assert.rejects(
      runtime.executeTool('goal', { action: 'abandon' }, { callerSessionId: 'sess_goal_no_goal' }),
      /no Goal exists/,
    );
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a legacy time-capped Goal loads as a finished duration, never as active work', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-legacy-'));
  try {
    mkdirSync(join(dataDir, 'goals'), { recursive: true });
    writeFileSync(join(dataDir, 'goals', 'sess_goal_legacy.json'), JSON.stringify({
      version: 1,
      goal: {
        id: 'goal_legacy',
        sessionId: 'sess_goal_legacy',
        objective: 'Legacy capped Goal',
        status: 'budget_limited',
        tasks: [{ id: 'task_1', text: 'Legacy work', status: 'pending', kind: 'work' }],
        timeLimitMs: 60_000,
        timeUsedMs: 60_000,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000,
      },
    }));
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

test('Goal observations report turns and real task movement without judging them', async () => {
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

    clock += 60_000;
    const moved = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Observed step', status: 'in_progress', kind: 'work' },
        { text: 'Observed check', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_observe' })).goal;
    assert.equal(moved.tasksUpdatedAt, clock);

    // Re-sending an identical snapshot is not movement, so a stalled Goal
    // cannot look busy on the observation line.
    clock += 60_000;
    const unchanged = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: moved.tasks,
    }, { callerSessionId: 'sess_goal_observe' })).goal;
    assert.equal(unchanged.tasksUpdatedAt, moved.tasksUpdatedAt);
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
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Archived step', status: 'completed', kind: 'work' },
        { text: 'Archived check', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_visible' });
    await runtime.executeTool('goal', { action: 'complete' }, {
      callerSessionId: 'sess_goal_visible',
    });
    await runtime.archiveCompletedOnUserInput('sess_goal_visible');

    const status = JSON.parse(await runtime.executeTool('goal', {
      action: 'status',
    }, { callerSessionId: 'sess_goal_visible' }));
    assert.equal(status.goal, null);
    assert.equal(runtime.snapshot('sess_goal_visible'), null);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unified Goal tool accepts model-shaped fields, consumes only the action payload, and keeps legacy compatibility', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-unified-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    const filler = {
      objective: '',
      time_limit_minutes: 60,
      tasks: [{ id: '', text: '', status: 'pending', kind: 'work' }],
      blocker: '/',
    };
    const empty = JSON.parse(await runtime.executeTool('goal', {
      action: 'status',
      ...filler,
    }, { callerSessionId: 'sess_goal_unified' }));
    assert.equal(empty.goal, null);
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'status',
        ...filler,
        unexpected: true,
      }, { callerSessionId: 'sess_goal_unified' }),
      /unknown fields: unexpected/,
    );
    const created = JSON.parse(await runtime.executeTool('goal', {
      action: 'create',
      objective: 'Use one Goal tool',
      time_limit_minutes: 60,
      tasks: [
        { id: '', text: 'Use the unified Goal tool', status: 'in_progress', kind: 'work' },
        { id: '', text: 'Verify the unified Goal tool', status: 'pending', kind: 'verification' },
      ],
      blocker: 'ignored for create',
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(created.objective, 'Use one Goal tool');
    assert.equal(created.tasksTotal, 2);
    assert.equal(created.tasks[0].id, 'task_1');

    const paused = JSON.parse(await runtime.executeTool('goal', {
      action: 'pause',
      ...filler,
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(paused.status, 'paused');
    const pausedContinuation = runtime.continuation('sess_goal_unified');
    assert.equal(pausedContinuation.run, false);
    assert.equal(pausedContinuation.reason, 'paused');
    assert.equal(pausedContinuation.goal.id, paused.id);
    assert.equal(pausedContinuation.goal.status, paused.status);
    const resumed = JSON.parse(await runtime.executeTool('goal', {
      action: 'resume',
      ...filler,
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(resumed.status, 'active');
    assert.equal(runtime.continuation('sess_goal_unified').run, true);

    const completedTasks = created.tasks.map((task) => ({ ...task, status: 'completed' }));
    const updated = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      objective: 'ignored for set_tasks',
      time_limit_minutes: 60,
      tasks: completedTasks,
      blocker: 'ignored for set_tasks',
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(updated.tasksCompleted, 2);

    const completed = JSON.parse(await runtime.executeTool('goal', {
      action: 'complete',
      ...filler,
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(completed.status, 'complete');

    const status = JSON.parse(await runtime.executeTool('goal', {
      action: 'status',
      ...filler,
    }, { callerSessionId: 'sess_goal_unified' })).goal;
    assert.equal(status.status, 'complete');

    const legacyStatus = JSON.parse(await runtime.executeTool('get_goal', {}, {
      callerSessionId: 'sess_goal_unified',
    })).goal;
    assert.equal(legacyStatus.id, created.id);

    await runtime.executeTool('goal', {
      action: 'create',
      objective: 'Block another Goal',
      time_limit_minutes: 60,
      tasks: [{ id: '', text: 'Wait for external state', status: 'in_progress', kind: 'work' }],
      blocker: 'ignored for create',
    }, { callerSessionId: 'sess_goal_block_shape' });
    const blocked = JSON.parse(await runtime.executeTool('goal', {
      action: 'block',
      ...filler,
      blocker: 'External state unavailable',
    }, { callerSessionId: 'sess_goal_block_shape' })).goal;
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blocker, 'External state unavailable');
    const resumedFromBlock = JSON.parse(await runtime.executeTool('goal', {
      action: 'resume',
      ...filler,
    }, { callerSessionId: 'sess_goal_block_shape' })).goal;
    assert.equal(resumedFromBlock.status, 'active');
    assert.equal(resumedFromBlock.blocker, '');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Goal turn lifecycle requires three identical failures, preserves blockers, and supports resume', async () => {
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
    assert.equal(goal.status, 'active');
    assert.equal(goal.blocker, '');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runtime.startTurn('sess_goal_lifecycle');
      clock += 10_000;
      goal = await runtime.settleTurn('sess_goal_lifecycle', {
        status: 'failed',
        error: 'network unavailable',
      });
      assert.equal(goal.status, attempt < 3 ? 'active' : 'blocked');
    }
    assert.equal(goal.blocker, 'network unavailable');

    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'block',
      }, { callerSessionId: 'sess_goal_lifecycle' }),
      /blocker is required/,
    );
    await runtime.control('sess_goal_lifecycle', { action: 'resume' });
    goal = JSON.parse(await runtime.executeTool('goal', {
      action: 'block',
      blocker: 'Waiting for deployment credentials',
    }, { callerSessionId: 'sess_goal_lifecycle' })).goal;
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
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Finish original Goal', status: 'completed', kind: 'work' },
        { text: 'Verify original Goal', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_stale' });
    await runtime.startTurn('sess_goal_stale');
    await runtime.control('sess_goal_stale', { action: 'complete' });
    await runtime.control('sess_goal_stale', { action: 'clear' });
    await runtime.control('sess_goal_stale', { action: 'create', objective: 'Replacement Goal' });
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'pause',
      }, { callerSessionId: 'sess_goal_stale' }),
      /stale Goal update rejected/,
    );
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'resume',
      }, { callerSessionId: 'sess_goal_stale' }),
      /stale Goal update rejected/,
    );
    await assert.rejects(
      runtime.executeTool('goal', {
        action: 'block',
        blocker: 'stale turn result',
      }, { callerSessionId: 'sess_goal_stale' }),
      /stale Goal update rejected/,
    );
    assert.equal(runtime.snapshot('sess_goal_stale').objective, 'Replacement Goal');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('model Goal creation rebinds the current turn and accepts immediate work updates', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-create-turn-'));
  const runtime = createGoalRuntime({ dataDir });
  try {
    await runtime.control('sess_goal_create_turn', { action: 'create', objective: 'Previous Goal' });
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Finish previous Goal', status: 'completed', kind: 'work' },
        { text: 'Verify previous Goal', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_create_turn' });
    await runtime.control('sess_goal_create_turn', { action: 'complete' });
    await runtime.startTurn('sess_goal_create_turn');

    const created = JSON.parse(await runtime.executeTool('goal', {
      action: 'create',
      objective: 'Approved replacement Goal',
      tasks: [
        { text: 'Start approved work', status: 'in_progress', kind: 'work' },
        { text: 'Verify approved work', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_create_turn' })).goal;
    const updated = JSON.parse(await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: created.tasks.map((task) => ({ ...task, status: 'completed' })),
    }, { callerSessionId: 'sess_goal_create_turn' })).goal;

    assert.equal(updated.id, created.id);
    assert.equal(updated.tasksCompleted, 2);
    assert.equal((await runtime.settleTurn('sess_goal_create_turn', { status: 'done' })).id, created.id);
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
    const active = (await runtime.control('sess_goal_restart_active', {
      action: 'create',
      objective: 'Resume active work',
    })).goal;
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Keep active progress', status: 'in_progress', kind: 'work' },
        { text: 'Verify active recovery', status: 'pending', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_restart_active' });
    await runtime.startTurn('sess_goal_restart_active');
    clock += 2_000;
    const preservedActive = await runtime.settleTurn('sess_goal_restart_active', {
      status: 'cancelled',
      preserveGoalState: true,
    });
    assert.equal(preservedActive.status, 'active');

    const paused = (await runtime.control('sess_goal_restart_paused', {
      action: 'create',
      objective: 'Keep paused work',
    })).goal;
    await runtime.control('sess_goal_restart_paused', { action: 'pause' });

    const blocked = (await runtime.control('sess_goal_restart_blocked', {
      action: 'create',
      objective: 'Keep blocked work',
    })).goal;
    await runtime.executeTool('goal', {
      action: 'block',
      blocker: 'External service unavailable',
    }, { callerSessionId: 'sess_goal_restart_blocked' });

    const complete = (await runtime.control('sess_goal_restart_complete', {
      action: 'create',
      objective: 'Keep completed work visible',
    })).goal;
    await runtime.executeTool('goal', {
      action: 'set_tasks',
      tasks: [
        { text: 'Finish recovery work', status: 'completed', kind: 'work' },
        { text: 'Verify recovery work', status: 'completed', kind: 'verification' },
      ],
    }, { callerSessionId: 'sess_goal_restart_complete' });
    const completed = JSON.parse(await runtime.executeTool('goal', {
      action: 'complete',
    }, { callerSessionId: 'sess_goal_restart_complete' })).goal;
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
      assert.deepEqual(restoredActive.tasks.map((task) => task.status), ['in_progress', 'pending']);
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
      assert.equal(restoredComplete.tasksCompleted, 2);
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
