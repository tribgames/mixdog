import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeStoredGoal } from './goal-state.mjs';
import { adoptLegacyGoalTasks, todoSnapshot } from './todo-list.mjs';

test('a legacy criterion marked satisfied adopts as a completed todo item', () => {
  const goal = normalizeStoredGoal(
    {
      id: 'legacy-goal',
      objective: 'Migrate the Goal',
      status: 'active',
      criteria: [
        { id: 'criterion_1', text: 'Keep completed work', satisfied: true },
        { id: 'criterion_2', text: 'Keep pending work', satisfied: false },
      ],
    },
    'sess_goal_legacy_criteria'
  );
  assert.deepEqual(
    goal.legacyTasks.map((task) => task.status),
    ['completed', 'pending']
  );

  const session = { id: 'sess_goal_legacy_criteria', messages: [] };
  assert.equal(adoptLegacyGoalTasks(session, goal.legacyTasks), true);
  const items = todoSnapshot(session).phases.flatMap((phase) => phase.tasks);
  assert.deepEqual(
    items.map((item) => [item.content, item.status]),
    [
      ['Keep completed work', 'completed'],
      ['Keep pending work', 'in_progress'],
    ]
  );
});
