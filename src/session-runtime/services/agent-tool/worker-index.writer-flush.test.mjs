import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withFileLock } from '../../../runtime/shared/file-lock.mjs';
import { flushAllIndexWrites } from './index-write-queue.mjs';
import { createWorkerIndex } from './worker-index.mjs';

// Several runtimes of one process write one agent-workers.json through one
// queue. A runtime's flush and dispose wait for the writes it made, not for
// what its neighbours queued; the process-wide drain still waits for all.

const row = (id, owner) => ({
  tag: `tag-${id}`,
  sessionId: id,
  ownerSessionId: owner,
  agent: 'worker',
  status: 'idle',
  stage: 'idle',
  updatedAt: new Date().toISOString(),
});

function runtime(root) {
  return createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
}

const readStored = (file) => JSON.parse(readFileSync(file, 'utf8'));
const withinMs = (promise, ms) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("a runtime's flush and dispose do not wait for another runtime's held index write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-writer-flush-'));
  const file = join(root, 'agent-workers.json');
  const mine = runtime(root);
  const other = runtime(root);
  let unlock = async () => {};
  t.after(async () => {
    await unlock();
    await flushAllIndexWrites();
    other.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  mine.writeWorkerRows((byKey) => byKey.set('mine-1', row('mine-1', 'lead-a')));
  await mine.flushWorkerIndexWrites();
  assert.ok(readStored(file).workers['mine-1'], 'its own write landed');

  // The index lock is held (another process, a slow disk): the other
  // runtime's write cannot persist.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let locked;
  const lockTaken = new Promise((resolve) => {
    locked = resolve;
  });
  const holder = withFileLock(`${file}.lock`, async () => {
    locked();
    await gate;
  });
  await lockTaken;
  unlock = async () => {
    release();
    await holder;
  };
  other.writeWorkerRows((byKey) => byKey.set('held', row('held', 'lead-b')));

  assert.equal(await withinMs(mine.flushWorkerIndexWrites(), 1000), true, 'its flush resolved with the lock held');
  assert.equal(await withinMs(mine.disposeAsync(), 1000), true, 'and so did its dispose');
  assert.equal(readStored(file).workers.held, undefined, "the other runtime's write is still waiting");

  // Shutdown drains every runtime's writes.
  await unlock();
  unlock = async () => {};
  await flushAllIndexWrites();
  assert.equal(readStored(file).workers.held?.sessionId, 'held');
});

test("a runtime's flush still waits for its own writes queued behind a neighbour's", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-writer-flush-'));
  const file = join(root, 'agent-workers.json');
  const mine = runtime(root);
  const other = runtime(root);
  t.after(async () => {
    await flushAllIndexWrites();
    mine.dispose();
    other.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  other.writeWorkerRows((byKey) => byKey.set('first', row('first', 'lead-b')));
  mine.writeWorkerRows((byKey) => byKey.set('second', row('second', 'lead-a')));
  other.writeWorkerRows((byKey) => byKey.set('third', row('third', 'lead-b')));
  await mine.flushWorkerIndexWrites();

  const stored = readStored(file).workers;
  assert.ok(stored.second, 'its own write is on disk');
  assert.ok(stored.first, 'the write ahead of it went out in the same order');
});
