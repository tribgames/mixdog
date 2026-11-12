import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';
import { GOAL_TOOL_DEFS } from './goal-tool-defs.mjs';
import { NO_DEADLINE_WARNING_MS } from './goal-state.mjs';

const SESSION = 'sess_goal_extend';
const context = { callerSessionId: SESSION };
const MINUTE = 60_000;

function open(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-extend-'));
  let clock = 1_800_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, deadlineWarningMs: [], generateTitle: null });
  t.after(() => {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const recordPath = join(dataDir, 'goals', `${SESSION}.json`);
  return {
    runtime,
    advance: (ms) => {
      clock += ms;
    },
    stored: () => JSON.parse(readFileSync(recordPath, 'utf8')).goal,
    markWarned: (warnedMs) => {
      const file = JSON.parse(readFileSync(recordPath, 'utf8'));
      file.goal.deadlineWarnedMs = warnedMs;
      writeFileSync(recordPath, JSON.stringify(file));
    },
  };
}

const extend = (runtime, minutes) => runtime.executeTool('goal', { action: 'extend', extend_minutes: minutes }, context);

test('extend adds the asked minutes to an active Goal cap, keeps the time already used and re-earns warnings', async (t) => {
  const { runtime, advance, stored, markWarned } = open(t);
  await runtime.control(SESSION, { action: 'create', objective: 'Port the parser', duration: '1h' });
  advance(20 * MINUTE);
  markWarned(5 * MINUTE);

  const reply = JSON.parse(await extend(runtime, 600));
  assert.equal(reply.goal.status, 'active');
  assert.equal(reply.goal.timeLimitMs, 660 * MINUTE);
  assert.equal(reply.goal.timeUsedMs, 20 * MINUTE);
  assert.equal(reply.remaining_ms, 640 * MINUTE);

  assert.equal(stored().timeLimitMs, 660 * MINUTE);
  assert.equal(stored().deadlineWarnedMs, NO_DEADLINE_WARNING_MS);
  advance(10 * MINUTE);
  assert.equal(runtime.snapshot(SESSION).remainingMs, 630 * MINUTE);
});

test('extend works on a paused Goal without starting its clock', async (t) => {
  const { runtime, advance } = open(t);
  await runtime.control(SESSION, { action: 'create', objective: 'Port the parser', duration: '30m' });
  advance(10 * MINUTE);
  await runtime.control(SESSION, { action: 'pause' });

  const reply = JSON.parse(await extend(runtime, 30));
  assert.equal(reply.goal.status, 'paused');
  assert.equal(reply.goal.timeLimitMs, 60 * MINUTE);
  assert.equal(reply.remaining_ms, 50 * MINUTE);
  advance(MINUTE);
  assert.equal(runtime.snapshot(SESSION).timeUsedMs, 10 * MINUTE);
});

test('extend refuses an uncapped Goal, a settled Goal, a missing Goal and an invalid or over-cap amount', async (t) => {
  const { runtime, stored } = open(t);
  await assert.rejects(extend(runtime, 10), /no Goal/);

  await runtime.control(SESSION, { action: 'create', objective: 'Open ended' });
  await assert.rejects(extend(runtime, 10), /needs a Goal with a time cap/);
  await runtime.control(SESSION, { action: 'stop' });

  await runtime.control(SESSION, { action: 'create', objective: 'Capped', duration: '1h' });
  for (const bad of [0, -5, 'soon', 10_080]) {
    await assert.rejects(extend(runtime, bad), /from 1 to 10080 minutes|exceeds 7 days/, String(bad));
  }
  assert.equal(stored().timeLimitMs, 60 * MINUTE);

  await runtime.executeTool('goal', { action: 'complete' }, context);
  await assert.rejects(extend(runtime, 10), /only on an active or paused Goal \(status complete\)/);
  assert.equal(stored().timeLimitMs, 60 * MINUTE);
});

// Shared with the Rust port's twin test: only a JSON number from 1 to 10080 is a minutes value.
const REJECTED_MINUTES = [0.5, 0, 10_081, true, [2], '5'];
const ACCEPTED_MINUTES = [1, 2.5, 10_080];

test('create time_limit_minutes and extend_minutes accept and reject the same values, with nothing coerced', async (t) => {
  const { runtime } = open(t);
  for (const bad of REJECTED_MINUTES) {
    await assert.rejects(
      runtime.executeTool('goal', { action: 'create', objective: 'Capped', time_limit_minutes: bad }, context),
      /from 1 to 10080 minutes/,
      `create ${JSON.stringify(bad)}`
    );
  }
  for (const ok of ACCEPTED_MINUTES) {
    const session = `${SESSION}_${String(ok).replace('.', '_')}`;
    const created = JSON.parse(
      await runtime.executeTool('goal', { action: 'create', objective: 'Capped', time_limit_minutes: ok }, { callerSessionId: session })
    );
    assert.equal(created.goal.status, 'active', `create ${ok}`);
    await runtime.control(session, { action: 'stop' });
  }

  await runtime.control(SESSION, { action: 'create', objective: 'Capped', duration: '1m' });
  for (const bad of REJECTED_MINUTES) {
    await assert.rejects(extend(runtime, bad), /from 1 to 10080 minutes/, `extend ${JSON.stringify(bad)}`);
  }
  for (const ok of [1, 2.5]) {
    assert.equal(JSON.parse(await extend(runtime, ok)).goal.status, 'active', `extend ${ok}`);
  }
  await runtime.control(SESSION, { action: 'stop' });
  await runtime.control(SESSION, { action: 'create', objective: 'Capped', duration: '1m' });
  // 10080 alone is a valid amount; the Goal's total must still stay within the 7-day cap.
  await assert.rejects(extend(runtime, 10_080), /exceeds 7 days/);
});

test('the goal tool definition offers extend only on the user’s explicit request', () => {
  const [def] = GOAL_TOOL_DEFS;
  assert.ok(def.inputSchema.properties.action.enum.includes('extend'));
  assert.match(def.description, /only when the user explicitly asks in this conversation/);
  assert.match(def.description, /never on your own initiative/);
  assert.deepEqual(
    [def.inputSchema.properties.extend_minutes.minimum, def.inputSchema.properties.extend_minutes.maximum],
    [1, 10_080]
  );
});
