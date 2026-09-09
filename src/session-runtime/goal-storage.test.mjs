import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGoalStorage } from './goal-storage.mjs';

const normalize = (goal) => goal;

function fixture(t, writeRecord) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-goal-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'session.json');
  const storage = createGoalStorage({
    pathFor: () => path,
    normalizeGoal: normalize,
    now: () => 1_000,
    writeRecord,
  });
  return { dir, path, storage };
}

test('a read inside our own in-flight write answers from the committed cache', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { path, storage } = fixture(t, async (target, value) => {
    await gate;
    writeFileSync(target, JSON.stringify(value));
  });
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
  assert.equal(storage.read('s').goal.id, 'g1');

  const pending = storage.write('s', { version: 1, goal: { id: 'g1', status: 'complete' } });
  // The file is mid-replace: on disk it can be momentarily absent or refused.
  unlinkSync(path);
  assert.equal(storage.read('s').goal.status, 'active', 'the last durable record, never "no Goal"');

  release();
  await pending;
  assert.equal(storage.read('s').goal.status, 'complete');
});

test('a missing record still reads as no Goal when nothing is being written', (t) => {
  const { path, storage } = fixture(t, async () => {});
  writeFileSync(path, JSON.stringify({ version: 1, goal: { id: 'g1', status: 'active' } }));
  assert.equal(storage.read('s').goal.id, 'g1');
  unlinkSync(path);
  assert.equal(storage.read('s').goal, null);
});
