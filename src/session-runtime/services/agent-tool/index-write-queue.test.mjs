import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withFileLock } from '../../../runtime/shared/file-lock.mjs';
import { flushAllIndexWrites, flushAllIndexWritesSync } from './index-write-queue.mjs';
import { createLeadIndexFile } from './lead-worker-index/index-file.mjs';
import { createWorkerRowStore } from './worker-index/row-store.mjs';

// The worker / Lead pool indexes are written by one in-process async queue:
// write() applies the mutator synchronously (read-your-writes, "did it apply"
// results), and a single FIFO job persists the effects under the file lock
// without ever blocking the event loop on it.

const workerRow = (sessionId, extra = {}) => ({
  tag: `tag-${sessionId}`,
  sessionId,
  agent: 'worker',
  clientHostPid: 1,
  status: 'idle',
  ...extra,
});
const keyOf = (row) => row.sessionId;

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'mixdog-index-queue-'));
}

const storedSessionIds = (file) =>
  Object.values(JSON.parse(readFileSync(file, 'utf8')).workers)
    .map(keyOf)
    .sort();

test('a write is visible to reads immediately, runs once, and reaches the file asynchronously', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    let runs = 0;
    store.write((byKey) => {
      runs += 1;
      byKey.set('sess-a', workerRow('sess-a'));
    });
    assert.equal(runs, 1);
    assert.deepEqual(store.readAll().map(keyOf), ['sess-a'], 'read-your-writes before any I/O');
    assert.equal(existsSync(file), false, 'nothing was written synchronously');

    await store.flush();
    assert.equal(runs, 1, 'persisting replays the effect, not the mutator');
    assert.deepEqual(storedSessionIds(file), ['sess-a']);
    assert.deepEqual(store.readAll().map(keyOf), ['sess-a']);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('writes persist in call order, and a foreign writer of another key is merged, not overwritten', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    store.write((byKey) => byKey.set('sess-a', workerRow('sess-a', { status: 'running' })));
    store.write((byKey) => byKey.set('sess-b', workerRow('sess-b')));
    store.write((byKey) => byKey.set('sess-a', { ...byKey.get('sess-a'), status: 'idle' }));
    store.write((byKey) => byKey.delete('sess-b'));
    // Another process publishes its own row before our queue drains.
    writeFileSync(file, JSON.stringify({ version: 2, workers: { 'sess-x': workerRow('sess-x') } }));

    await store.flush();
    const stored = JSON.parse(readFileSync(file, 'utf8')).workers;
    assert.deepEqual(Object.keys(stored).sort(), ['sess-a', 'sess-x']);
    assert.equal(stored['sess-a'].status, 'idle');
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a held file lock never blocks the caller; the queue waits it out asynchronously', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, `${process.pid} ${Date.now()} foreign-token\n`); // live foreign owner
    const started = performance.now();
    store.write((byKey) => byKey.set('sess-a', workerRow('sess-a')));
    store.write((byKey) => byKey.set('sess-b', workerRow('sess-b')));
    assert.ok(performance.now() - started < 100, 'write() returns without waiting on the lock');
    assert.deepEqual(store.readAll().map(keyOf).sort(), ['sess-a', 'sess-b']);

    // The event loop keeps turning while the lock is contended.
    let ticks = 0;
    const interval = setInterval(() => (ticks += 1), 5);
    await new Promise((resolve) => setTimeout(resolve, 150));
    clearInterval(interval);
    assert.ok(ticks >= 5, `loop stayed responsive (${ticks} ticks)`);
    assert.equal(existsSync(file), false, 'still waiting for the lock');

    unlinkSync(lockPath);
    await store.flush();
    assert.deepEqual(storedSessionIds(file), ['sess-a', 'sess-b']);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('flushSync (exit path) persists what is still queued', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    store.write((byKey) => byKey.set('sess-a', workerRow('sess-a')));
    flushAllIndexWritesSync();
    assert.deepEqual(storedSessionIds(file), ['sess-a']);
    await store.flush();
    assert.deepEqual(storedSessionIds(file), ['sess-a']);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the exit flush never replays a running persist: a conditional update applies once', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    store.write((byKey) => byKey.set('sess-a', workerRow('sess-a', { clientHostPid: 1 })));
    await store.flush();

    // This process's own async holder keeps the lock, so the persist job of
    // the update below is running (blocked on it) when the exit flush fires.
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

    // A non-idempotent conditional update: +1 on whatever row it is applied to.
    store.update((byKey) => {
      const row = byKey.get('sess-a');
      if (row) byKey.set('sess-a', { ...row, clientHostPid: row.clientHostPid + 1 });
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // the job is running
    assert.equal(store.flushSync(), false, 'a running persist is left alone');
    flushAllIndexWritesSync();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).workers['sess-a'].clientHostPid, 1, 'nothing written yet');

    release();
    await holder;
    await store.flush();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).workers['sess-a'].clientHostPid, 2, 'applied exactly once');
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a mutator that throws applies nothing and queues nothing', async () => {
  const root = tempRoot();
  try {
    const file = join(root, 'agent-workers.json');
    const store = createWorkerRowStore(file);
    const result = store.write((byKey) => {
      byKey.set('sess-a', workerRow('sess-a'));
      throw new Error('boom');
    });
    assert.equal(result, null);
    assert.deepEqual(store.readAll(), []);
    await store.flush();
    assert.equal(existsSync(file), false);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Capture what is written to stderr (the daemon log in the daemon) while `fn` runs. */
async function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    const done = rest.find((arg) => typeof arg === 'function');
    if (done) done();
    return true;
  };
  try {
    return { result: await fn(), lines };
  } finally {
    process.stderr.write = original;
  }
}

test('a write that cannot reach disk is logged, rejects the flush, and is retried once the cause is gone', async () => {
  const root = tempRoot();
  try {
    // The data dir is occupied by a regular file, so the index can never be written.
    const dataDir = join(root, 'blocked');
    writeFileSync(dataDir, 'not a directory');
    const index = createLeadIndexFile({ dataDir });
    const leadRow = { sessionId: 'lead-1', tag: 'lead-1', agent: 'lead', clientHostPid: 1, status: 'idle' };
    index.write((byKey) => byKey.set('lead-1', leadRow));

    const { result, lines } = await captureStderr(() => index.flush().then(() => null, (error) => error));
    assert.ok(result instanceof Error, 'flush rejects instead of reporting success');
    assert.ok(
      lines.some((line) => line.includes('[index-write]') && line.includes('kept queued')),
      `the failure reached the log: ${lines.join('|')}`
    );
    assert.equal(index.read().length, 1, 'the unpersisted write stays visible and queued');

    rmSync(dataDir);
    mkdirSync(dataDir);
    await index.flush();
    assert.equal(Object.keys(JSON.parse(readFileSync(index.path(), 'utf8')).workers).length, 1);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a write whose mutator throws is logged rather than silently dropped', async () => {
  const root = tempRoot();
  try {
    const index = createLeadIndexFile({ dataDir: root });
    const { result, lines } = await captureStderr(() =>
      index.write(() => {
        throw new Error('mutator exploded');
      })
    );
    assert.equal(result, null);
    assert.ok(lines.some((line) => line.includes('[index-write]') && line.includes('mutator exploded')));
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the Lead index has the same read-your-writes and ordered async persistence', async () => {
  const root = tempRoot();
  try {
    const index = createLeadIndexFile({ dataDir: root });
    const leadRow = (id, status) => ({ sessionId: id, tag: `lead-${id}`, agent: 'lead', clientHostPid: 1, status });
    index.write((byKey) => byKey.set('lead-1', leadRow('lead-1', 'running')));
    index.write((byKey) => byKey.set('lead-1', { ...byKey.get('lead-1'), status: 'idle' }));
    assert.equal(index.read().find((row) => row.sessionId === 'lead-1')?.status, 'idle');
    assert.equal(existsSync(index.path()), false);

    await index.flush();
    const stored = JSON.parse(readFileSync(index.path(), 'utf8'));
    assert.equal(Object.values(stored.workers).find((row) => row.sessionId === 'lead-1').status, 'idle');
    assert.equal(index.read().length, 1);
  } finally {
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true });
  }
});
