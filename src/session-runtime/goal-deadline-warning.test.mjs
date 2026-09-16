import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createGoalRuntime } from './goal-runtime.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// Delivery joins the runtime's mutation queue and writes the record, so the
// durable warning lands a turn later than the read that crossed it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const warningRevisions = (events) =>
  events.map((event) => Number(event?.goal?.warningRevision) || 0).filter((revision) => revision > 0);

// The default writer pays for a file lock and Windows ACL work on every write;
// these tests need the same write ordering, not the same syscalls.
const writeGoalRecord = async (path, record) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
};

test('a requested duration warns once at each threshold before the budget stop', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-warning-'));
  let clock = 1_950_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, writeGoalRecord });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  try {
    await runtime.control('sess_goal_warning', {
      action: 'create',
      objective: 'Finish the objective',
      timeLimitMs: HOUR_MS,
    });
    assert.equal(runtime.snapshot('sess_goal_warning').warningRevision, 0);

    // Inside the ten-minute window: one warning, carrying the live remaining
    // time the session needs to phrase its reminder.
    clock += HOUR_MS - 9 * MINUTE_MS;
    runtime.snapshot('sess_goal_warning');
    await settle();
    const tenMinute = runtime.snapshot('sess_goal_warning');
    assert.equal(tenMinute.warningRevision, 1);
    assert.equal(tenMinute.status, 'active');
    assert.ok(tenMinute.remainingMs > 0 && tenMinute.remainingMs <= 10 * MINUTE_MS);

    // Crossing the five-minute threshold warns exactly once more.
    clock += 5 * MINUTE_MS;
    runtime.snapshot('sess_goal_warning');
    await settle();
    assert.equal(runtime.snapshot('sess_goal_warning').warningRevision, 2);

    // Repeated reads inside the same window never re-warn.
    for (let index = 0; index < 3; index += 1) {
      clock += MINUTE_MS;
      runtime.snapshot('sess_goal_warning');
      await settle();
    }
    assert.equal(runtime.snapshot('sess_goal_warning').warningRevision, 2);
    assert.deepEqual(warningRevisions(events), [1, 2]);

    // The hard stop still lands on the requested boundary.
    clock += 5 * MINUTE_MS;
    assert.equal(runtime.snapshot('sess_goal_warning').status, 'duration_reached');
    await settle();
    const stored = JSON.parse(readFileSync(join(dataDir, 'goals', 'sess_goal_warning.json'), 'utf8')).goal;
    assert.equal(stored.status, 'duration_reached');
    assert.equal(stored.warningRevision, 2);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Goal already inside a window at resume warns once at the most urgent threshold', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-warning-late-'));
  let clock = 1_951_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, writeGoalRecord });
  try {
    await runtime.control('sess_goal_late', {
      action: 'create',
      objective: 'Finish the objective',
      timeLimitMs: HOUR_MS,
    });
    // Four minutes left with no warning ever delivered: one reminder, not two.
    clock += HOUR_MS - 4 * MINUTE_MS;
    runtime.snapshot('sess_goal_late');
    await settle();
    assert.equal(runtime.snapshot('sess_goal_late').warningRevision, 1);
    clock += MINUTE_MS;
    runtime.snapshot('sess_goal_late');
    await settle();
    assert.equal(runtime.snapshot('sess_goal_late').warningRevision, 1);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const action of ['time', 'edit']) {
  test(`a new duration commitment via ${action} re-earns its warnings`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-warning-extend-'));
    let clock = 1_952_000_000_000;
    const runtime = createGoalRuntime({ dataDir, now: () => clock, writeGoalRecord });
    try {
      await runtime.control('sess_goal_extend', {
        action: 'create',
        objective: 'Finish the objective',
        timeLimitMs: HOUR_MS,
      });
      clock += HOUR_MS - 9 * MINUTE_MS;
      runtime.snapshot('sess_goal_extend');
      await settle();
      assert.equal(runtime.snapshot('sess_goal_extend').warningRevision, 1);

      const extended = await runtime.control('sess_goal_extend', {
        action,
        objective: 'Finish the objective',
        duration: '3h',
      });
      assert.equal(extended.goal.timeLimitMs, 3 * HOUR_MS);
      assert.equal(extended.goal.status, 'active');
      clock += 3 * HOUR_MS - extended.goal.timeUsedMs - 9 * MINUTE_MS;
      runtime.snapshot('sess_goal_extend');
      await settle();
      assert.equal(runtime.snapshot('sess_goal_extend').warningRevision, 2);
    } finally {
      runtime.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test('objective-only edits do not repeat an already delivered deadline warning', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-warning-edit-'));
  let clock = 1_952_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, writeGoalRecord });
  try {
    await runtime.control('sess_goal_edit', {
      action: 'create',
      objective: 'Finish the objective',
      timeLimitMs: HOUR_MS,
    });
    clock += HOUR_MS - 9 * MINUTE_MS;
    runtime.snapshot('sess_goal_edit');
    await settle();
    await runtime.control('sess_goal_edit', {
      action: 'edit',
      objective: 'Clarify the objective',
      timeLimitMs: HOUR_MS,
    });
    await settle();
    assert.equal(runtime.snapshot('sess_goal_edit').warningRevision, 1);
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a paused or completed Goal never warns about a budget it is not spending', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-goal-warning-paused-'));
  let clock = 1_953_000_000_000;
  const runtime = createGoalRuntime({ dataDir, now: () => clock, writeGoalRecord });
  try {
    await runtime.control('sess_goal_paused', {
      action: 'create',
      objective: 'Finish the objective',
      timeLimitMs: HOUR_MS,
    });
    clock += HOUR_MS - 9 * MINUTE_MS;
    await runtime.control('sess_goal_paused', { action: 'pause' });
    runtime.snapshot('sess_goal_paused');
    await settle();
    assert.equal(runtime.snapshot('sess_goal_paused').warningRevision, 0);
    assert.equal(runtime.snapshot('sess_goal_paused').status, 'paused');
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
