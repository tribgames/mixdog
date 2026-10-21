import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withFileLock } from '../../../runtime/shared/file-lock.mjs';
import { exitFlushCount } from './helpers.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';
import { createWorkerIndex } from './worker-index.mjs';

function pair(root) {
  const worker = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: { getSessionRuntime: () => null },
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  const lead = createLeadWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    workerRowFromSession: worker.workerRowFromSession,
  });
  return { worker, lead };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-dispose-'));
  mkdirSync(join(root, 'sessions'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('constructing and disposing index pairs leaves exitFlushes at its prior size', (t) => {
  const root = tempRoot(t);
  const before = exitFlushCount();
  const pairs = Array.from({ length: 5 }, () => pair(root));
  assert.equal(exitFlushCount(), before + 10);
  for (const { worker, lead } of pairs) {
    worker.dispose();
    lead.dispose();
    worker.dispose();
    lead.dispose();
  }
  assert.equal(exitFlushCount(), before);
});

test('dispose persists pending worker rows before unregistering', (t) => {
  const root = tempRoot(t);
  const { worker, lead } = pair(root);
  const now = new Date().toISOString();
  worker.queueWorkerIndexMutation((byKey) => {
    byKey.set('pending', {
      tag: 'pending',
      sessionId: 'pending',
      ownerSessionId: 'lead-a',
      agent: 'worker',
      status: 'idle',
      stage: 'idle',
      updatedAt: now,
    });
  });
  worker.dispose();
  lead.dispose();
  const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
  assert.equal(stored.workers.pending?.sessionId, 'pending');
});

test("dispose under this process's own async lock holder drains before teardown", async (t) => {
  const root = tempRoot(t);
  const file = join(root, 'agent-workers.json');
  const before = exitFlushCount();
  const { worker, lead } = pair(root);
  assert.equal(exitFlushCount(), before + 2);
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
  const now = new Date().toISOString();
  worker.queueWorkerIndexMutation((byKey) => {
    byKey.set('gated', {
      tag: 'gated',
      sessionId: 'gated',
      ownerSessionId: 'lead-a',
      agent: 'worker',
      status: 'idle',
      stage: 'idle',
      updatedAt: now,
    });
  });
  worker.flushWorkerIndexMutations();
  // Let the async persist start and block on the held lock.
  await new Promise((resolve) => setTimeout(resolve, 20));
  worker.dispose();
  worker.dispose();
  assert.equal(exitFlushCount(), before + 2, 'exit hook stays registered until drained');
  release();
  await holder;
  await worker.flushWorkerIndexWrites();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.workers.gated?.sessionId, 'gated');
  assert.equal(exitFlushCount(), before + 1, 'worker hook released after drain');
  worker.dispose();
  assert.equal(exitFlushCount(), before + 1);
  lead.dispose();
});

// A child that queues index writes and then exits for real. `graceful` queues
// the second write while a persist is running (blocked behind this process's
// own async lock holder) and drains before process.exit. `last-resort` has no
// persist running and relies on the synchronous 'exit' hook alone.
function exitChildSource(mode) {
  const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  return `
    import { join } from 'node:path';
    import { withFileLock } from ${url('../../../runtime/shared/file-lock.mjs')};
    import { flushAllIndexWrites } from ${url('./index-write-queue.mjs')};
    import { createWorkerIndex } from ${url('./worker-index.mjs')};
    const root = process.argv[1];
    const worker = createWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: { getSessionRuntime: () => null },
      tags: new Map(),
      tagAgents: new Map(),
      tagCwds: new Map(),
    });
    const row = (id) => ({
      tag: id, sessionId: id, ownerSessionId: 'lead-a', agent: 'worker',
      status: 'idle', stage: 'idle', updatedAt: new Date().toISOString(),
    });
    ${
      mode === 'graceful'
        ? `let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let locked;
    const lockTaken = new Promise((resolve) => { locked = resolve; });
    withFileLock(join(root, 'agent-workers.json.lock'), async () => { locked(); await gate; });
    await lockTaken;
    worker.queueWorkerIndexMutation((byKey) => byKey.set('first', row('first')));
    worker.flushWorkerIndexMutations();
    await new Promise((resolve) => setTimeout(resolve, 30)); // persist is now running
    worker.queueWorkerIndexMutation((byKey) => byKey.set('second', row('second')));
    worker.flushWorkerIndexMutations();
    setTimeout(release, 30);
    await flushAllIndexWrites();`
        : `worker.queueWorkerIndexMutation((byKey) => byKey.set('first', row('first')));
    worker.queueWorkerIndexMutation((byKey) => byKey.set('second', row('second')));`
    }
    process.exit(0);
  `;
}

for (const mode of ['graceful', 'last-resort']) {
  test(`${mode} process exit leaves every queued row on disk`, (t) => {
    const root = tempRoot(t);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', exitChildSource(mode), root], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, MIXDOG_DATA_DIR: root },
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
    assert.equal(stored.workers.first?.sessionId, 'first');
    assert.equal(stored.workers.second?.sessionId, 'second');
  });
}

// A live foreign process holds the index lock past every persist retry, then
// releases it. The failed drain must keep the rows queued and the
// registrations in place, and a later drain after the unlock must land them.
function foreignLockChildSource() {
  const url = (name) => JSON.stringify(new URL(name, import.meta.url).href);
  return `
    import { unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { exitFlushCount } from ${url('./helpers.mjs')};
    import { createWorkerIndex } from ${url('./worker-index.mjs')};
    const root = process.argv[1];
    const worker = createWorkerIndex({
      dataDir: root,
      cfgMod: { loadConfig: () => ({}) },
      mgr: { getSessionRuntime: () => null },
      tags: new Map(),
      tagAgents: new Map(),
      tagCwds: new Map(),
    });
    const lock = join(root, 'agent-workers.json.lock');
    const registered = exitFlushCount();
    // The parent test process is a live pid that is not this one.
    writeFileSync(lock, process.ppid + ' ' + Date.now() + ' foreign-token\\n');
    worker.queueWorkerIndexMutation((byKey) => byKey.set('held', {
      tag: 'held', sessionId: 'held', ownerSessionId: 'lead-a', agent: 'worker',
      status: 'idle', stage: 'idle', updatedAt: new Date().toISOString(),
    }));
    let failed = false;
    try { await worker.disposeAsync(); } catch { failed = true; }
    const keptAfterFailure = exitFlushCount() === registered;
    unlinkSync(lock);
    await worker.disposeAsync();
    console.log(JSON.stringify({ failed, keptAfterFailure, released: exitFlushCount() === registered - 1 }));
  `;
}

test('a drain that fails against a live foreign lock keeps the rows and registrations for a later drain', (t) => {
  const root = tempRoot(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', foreignLockChildSource(), root], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, MIXDOG_DATA_DIR: root, MIXDOG_LOCK_TIMEOUT_MS: '30' },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.equal(result.failed, true, 'the drain reported its failure');
  assert.equal(result.keptAfterFailure, true, 'registrations were not removed by the failed drain');
  assert.equal(result.released, true, 'the later successful drain released them');
  const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
  assert.equal(stored.workers.held?.sessionId, 'held', 'the row landed after the unlock');
});
test('disposing one runtime leaves workers another runtime in the same process still runs', (t) => {
  const root = tempRoot(t);
  const evicted = pair(root);
  const live = pair(root);
  const now = new Date().toISOString();
  live.worker.queueWorkerIndexMutation((byKey) => {
    byKey.set('busy', {
      tag: 'busy',
      sessionId: 'busy',
      ownerSessionId: 'lead-b',
      agent: 'worker',
      status: 'running',
      stage: 'running',
      runtimePid: process.pid,
      updatedAt: now,
    });
  });
  live.worker.dispose();
  live.lead.dispose();
  evicted.worker.invalidateWorkerRowsCache();
  evicted.worker.dispose();
  evicted.lead.dispose();
  const stored = JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8'));
  assert.equal(stored.workers.busy?.status, 'running');
});
