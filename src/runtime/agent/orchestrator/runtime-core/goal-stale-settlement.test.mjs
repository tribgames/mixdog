import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';

const SESSION = 'sess_goal_stale_settlement';
const context = { callerSessionId: SESSION };

function open(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-stale-'));
  const runtime = createGoalRuntime({ dataDir, deadlineWarningMs: [], generateTitle: null });
  t.after(() => {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return runtime;
}

for (const action of ['complete', 'block']) {
  test(`a ${action} from a turn that predates an objective edit is refused with the current objective`, async (t) => {
    const runtime = open(t);
    await runtime.control(SESSION, { action: 'create', objective: 'Verify parser' });
    await runtime.startTurn(SESSION);
    await runtime.executeTool('goal', { action: 'status' }, context);
    await runtime.control(SESSION, { action: 'edit', objective: 'Verify parser and run the production migration' });

    const args = action === 'block' ? { action, blocker: 'waiting on credentials' } : { action };
    await assert.rejects(
      runtime.executeTool('goal', args, context),
      /objective changed[\s\S]*Verify parser and run the production migration/
    );
    assert.equal(runtime.snapshot(SESSION).status, 'active');

    // The refusal showed the current wording; the same call now settles.
    const settled = JSON.parse(await runtime.executeTool('goal', args, context)).goal;
    assert.equal(settled.status, action === 'block' ? 'blocked' : 'complete');
  });
}

test('a status read after the edit shows the new objective, so the completion that follows is accepted', async (t) => {
  const runtime = open(t);
  await runtime.control(SESSION, { action: 'create', objective: 'Verify parser' });
  await runtime.startTurn(SESSION);
  await runtime.control(SESSION, { action: 'edit', objective: 'Verify parser twice' });
  await runtime.executeTool('goal', { action: 'status' }, context);
  const settled = JSON.parse(await runtime.executeTool('goal', { action: 'complete' }, context)).goal;
  assert.equal(settled.status, 'complete');
});
