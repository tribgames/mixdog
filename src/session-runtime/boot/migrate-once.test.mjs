import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateOncePerProcess } from './migrate-once.mjs';

test('a profile migration runs at the first runtime start per data dir; a failed one stays due', () => {
  const runs = [];
  const migrate = (dataDir, result) =>
    migrateOncePerProcess(dataDir, 'example', () => {
      runs.push(dataDir);
      return result;
    });
  // Twenty session runtimes of one daemon over one profile.
  assert.equal(migrate('data-a', true), true);
  for (let i = 0; i < 19; i += 1) assert.equal(migrate('data-a', true), undefined);
  assert.deepEqual(runs, ['data-a']);
  // Another data dir is another profile.
  migrate('data-b', { failed: true });
  migrate('data-b', { skipped: true });
  migrate('data-b', { skipped: true });
  assert.throws(() =>
    migrateOncePerProcess('data-c', 'example', () => {
      throw new Error('locked');
    })
  );
  migrate('data-c', false);
  assert.deepEqual(runs, ['data-a', 'data-b', 'data-b', 'data-c']);
});

test('a start back in an earlier data dir migrates it again (the folder may be a new one)', () => {
  const runs = [];
  const migrate = (dataDir) =>
    migrateOncePerProcess(dataDir, 'example', () => {
      runs.push(dataDir);
      return true;
    });
  migrate('retarget-a');
  migrate('retarget-b');
  migrate('retarget-a');
  migrate('retarget-a');
  assert.deepEqual(runs, ['retarget-a', 'retarget-b', 'retarget-a']);
});
