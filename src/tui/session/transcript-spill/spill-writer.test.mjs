import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { waitUntil } from '../../../runtime/shared/wait-until.test-support.mjs';
import { createSpillWriter } from './spill-writer.mjs';

// The writer retires its worker thread once every write has settled and it
// stayed idle, respawns transparently on the next write without losing or
// reordering pages, and dispose always ends the thread.

function fakeWorkers() {
  const workers = [];
  const posted = [];
  const factory = () => {
    const handlers = {};
    const worker = {
      terminated: false,
      on: (event, fn) => {
        handlers[event] = fn;
      },
      postMessage: ({ id, targetPath, tempPath, items }) => {
        posted.push({ worker: workers.indexOf(worker), id });
        setImmediate(() => {
          if (worker.terminated) return;
          writeFileSync(tempPath, JSON.stringify(items), 'utf8');
          renameSync(tempPath, targetPath);
          handlers.message?.({ id, ok: true });
        });
      },
      terminate: () => {
        worker.terminated = true;
        // A real worker reports its exit; the writer must ignore it for a
        // worker it retired itself.
        worker.exitReported = new Promise((resolve) =>
          setImmediate(() => {
            handlers.exit?.(1);
            resolve();
          })
        );
      },
      unref: () => {},
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers, posted };
}

function pageRecords(dir, from, to) {
  const records = [];
  for (let id = from; id <= to; id += 1) {
    records.push({
      id,
      path: join(dir, `${id}.json`),
      pendingItems: [{ id: `it_${id}`, n: id }],
      cancelled: false,
      attempts: 0,
      pinned: false,
    });
  }
  return records;
}

const drained = (writer) => waitUntil(() => writer.pendingCount === 0, { message: 'writes did not drain' });

const until = (predicate, label) => waitUntil(predicate, { message: label });

const tempDir = (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-spill-writer-test-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('an idle writer retires its worker and restarts on the next write without losing or reordering pages', async (context) => {
  const dir = tempDir(context);
  const { factory, workers, posted } = fakeWorkers();
  const pinned = [];
  const writer = createSpillWriter({ workerFactory: factory, idleMs: 30, onPinned: (e) => pinned.push(e) });
  context.after(() => writer.dispose());

  const first = pageRecords(dir, 1, 3);
  for (const record of first) writer.enqueue(record);
  await drained(writer);
  assert.equal(writer.workerAlive, true, 'the worker stays up right after a write');
  assert.equal(workers[0].terminated, false);

  await until(() => !writer.workerAlive, 'idle retirement');
  assert.equal(workers[0].terminated, true);
  await workers[0].exitReported; // the retired worker's exit event must not respawn or fail anything
  assert.equal(workers.length, 1);

  const second = pageRecords(dir, 4, 6);
  for (const record of second) writer.enqueue(record);
  await drained(writer);
  assert.equal(workers.length, 2, 'the next write spawned a fresh worker');
  assert.equal(writer.workerCount, 2);

  assert.deepEqual(
    posted.map((entry) => entry.id),
    [1, 2, 3, 4, 5, 6],
    'writes go out once each, in order'
  );
  assert.deepEqual(
    posted.map((entry) => entry.worker),
    [0, 0, 0, 1, 1, 1]
  );
  for (const record of [...first, ...second]) {
    assert.equal(record.pendingItems, null, `page ${record.id} committed`);
    assert.equal(record.pinned, false);
    assert.deepEqual(JSON.parse(readFileSync(record.path, 'utf8')), [{ id: `it_${record.id}`, n: record.id }]);
  }
  assert.deepEqual(pinned, []);
});

test('a write arriving before the idle deadline keeps the same worker', async (context) => {
  const dir = tempDir(context);
  const { factory, workers } = fakeWorkers();
  const writer = createSpillWriter({ workerFactory: factory, idleMs: 200, onPinned: () => {} });
  context.after(() => writer.dispose());
  const [a, b] = pageRecords(dir, 1, 2);
  writer.enqueue(a);
  await drained(writer);
  writer.enqueue(b);
  await drained(writer);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  assert.equal(b.pendingItems, null);
});

test('dispose ends the worker thread even while it is busy or idle-armed', async (context) => {
  const dir = tempDir(context);
  const { factory, workers } = fakeWorkers();
  const writer = createSpillWriter({ workerFactory: factory, idleMs: 60_000, onPinned: () => {} });
  const [a] = pageRecords(dir, 1, 1);
  writer.enqueue(a);
  await drained(writer);
  assert.equal(writer.workerAlive, true);
  writer.dispose();
  assert.equal(writer.workerAlive, false);
  assert.equal(workers[0].terminated, true);
  assert.equal(writer.pendingCount, 0);
  await workers[0].exitReported;
  assert.equal(workers.length, 1, 'dispose never respawns');
});

test('a real worker thread exits on idle, restarts for the next page and exits on dispose', async (context) => {
  const dir = tempDir(context);
  const exits = [];
  const factory = (source) => {
    const worker = new Worker(source, { eval: true, stdout: true, stderr: true });
    const index = exits.length;
    exits.push(false);
    worker.once('exit', () => {
      exits[index] = true;
    });
    return worker;
  };
  const writer = createSpillWriter({ workerFactory: factory, idleMs: 50, onPinned: () => {} });
  context.after(() => writer.dispose());

  const first = pageRecords(dir, 1, 2);
  for (const record of first) writer.enqueue(record);
  await drained(writer);
  await until(() => exits[0] === true, 'first thread exit');
  assert.equal(writer.workerAlive, false);

  const second = pageRecords(dir, 3, 4);
  for (const record of second) writer.enqueue(record);
  await drained(writer);
  assert.equal(exits.length, 2);
  assert.equal(exits[1], false);
  writer.dispose();
  await until(() => exits[1] === true, 'thread exit on dispose');

  for (const record of [...first, ...second]) {
    assert.equal(record.pinned, false);
    assert.deepEqual(JSON.parse(readFileSync(record.path, 'utf8')), [{ id: `it_${record.id}`, n: record.id }]);
  }
});

test('a reset during an in-flight write leaves no folder and no page behind', async (context) => {
  const dir = tempDir(context);
  const gone = join(dir, 'reset');
  mkdirSync(gone);
  class DelayedWorker extends Worker {
    postMessage(message) {
      setTimeout(() => super.postMessage(message), 150);
    }
  }
  const pinned = [];
  const writer = createSpillWriter({
    workerFactory: (source) => new DelayedWorker(source, { eval: true }),
    onPinned: (e) => pinned.push(e),
  });
  context.after(() => writer.dispose());
  const [record] = pageRecords(gone, 1, 1);
  writer.enqueue(record);
  // Reset/cleanup: cancel the record, then delete its folder, while the worker
  // has not yet run the write.
  record.cancelled = true;
  rmSync(gone, { recursive: true, force: true });
  await drained(writer);
  assert.equal(existsSync(gone), false, 'the folder must not be recreated');
  assert.equal(existsSync(record.path), false, 'the cancelled page must not be committed');
  assert.deepEqual(pinned, []);
});

test('a spill folder that vanished is recreated and the page still commits', async (context) => {
  const dir = tempDir(context);
  const gone = join(dir, 'vanished');
  const workerFactory = (source) => new Worker(source, { eval: true });
  const pinned = [];
  const writer = createSpillWriter({ workerFactory, onPinned: (e) => pinned.push(e) });
  context.after(() => writer.dispose());
  const [record] = pageRecords(gone, 1, 1);
  writer.enqueue(record);
  await until(() => record.pendingItems === null || record.pinned, 'page settled');
  assert.equal(record.pinned, false);
  assert.deepEqual(pinned, []);
  assert.deepEqual(JSON.parse(readFileSync(record.path, 'utf8')), [{ id: 'it_1', n: 1 }]);
});
