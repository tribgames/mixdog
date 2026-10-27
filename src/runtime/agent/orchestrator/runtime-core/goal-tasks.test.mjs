import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGoalTaskChanges } from './goal-tasks.mjs';
import { MAX_GOAL_TASKS } from './goal-tool-defs.mjs';

const fullGoal = () => ({
  status: 'active',
  objectiveRevision: 1,
  tasksObjectiveRevision: 1,
  tasks: Array.from({ length: MAX_GOAL_TASKS }, (_, index) => ({
    id: `task_${index + 1}`,
    text: `round ${index + 1}`,
    status: index === MAX_GOAL_TASKS - 1 ? 'in_progress' : 'completed',
  })),
});

test('a full Goal names the set_tasks route when settled tasks fill the cap, and that route works', () => {
  assert.throws(
    () => applyGoalTaskChanges(fullGoal(), { tasks: [{ text: 'next round', status: 'pending' }] }, { partial: true }),
    /at most 20 entries; completed and dropped tasks count, so to add more send set_tasks with only the unfinished tasks plus the new ones$/
  );
  const goal = applyGoalTaskChanges(fullGoal(), {
    tasks: [
      { id: `task_${MAX_GOAL_TASKS}`, text: `round ${MAX_GOAL_TASKS}`, status: 'in_progress' },
      { text: 'next round', status: 'pending' },
    ],
  });
  assert.deepEqual(
    goal.tasks.map((task) => task.text),
    [`round ${MAX_GOAL_TASKS}`, 'next round']
  );
});

test('a new-task entry that names an existing task id updates that task; unknown ids stay refused', () => {
  const goal = () => ({
    status: 'active',
    objectiveRevision: 1,
    tasksObjectiveRevision: 1,
    tasks: [
      { id: 'task_1', text: 'inspect', status: 'in_progress' },
      { id: 'task_2', text: 'fix', status: 'pending' },
    ],
  });
  const updated = applyGoalTaskChanges(
    goal(),
    {
      tasks: [
        { id: 'task_1', status: 'completed' },
        { text: 'verify', status: 'pending' },
      ],
    },
    { partial: true }
  );
  assert.deepEqual(updated.tasks, [
    { id: 'task_1', text: 'inspect', status: 'completed' },
    { id: 'task_2', text: 'fix', status: 'pending' },
    { id: 'task_3', text: 'verify', status: 'pending' },
  ]);
  assert.throws(
    () =>
      applyGoalTaskChanges(goal(), { tasks: [{ id: 'verify', text: 'verify', status: 'pending' }] }, { partial: true }),
    /new Goal tasks must omit ids/
  );
  assert.throws(
    () =>
      applyGoalTaskChanges(
        goal(),
        { updates: [{ id: 'task_2', status: 'completed' }], tasks: [{ id: 'task_2', status: 'dropped' }] },
        { partial: true }
      ),
    /duplicate Goal task update: task_2/
  );
});

test('an oversized new task list without settled tasks keeps the plain cap message', () => {
  const tasks = Array.from({ length: MAX_GOAL_TASKS + 1 }, (_, index) => ({ text: `t${index}`, status: 'pending' }));
  assert.throws(
    () => applyGoalTaskChanges({ status: 'active', objectiveRevision: 1, tasks: [] }, { tasks }),
    /^Error: goal tasks support at most 20 entries$/
  );
});
