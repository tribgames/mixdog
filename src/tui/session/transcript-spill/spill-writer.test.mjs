import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createSpillWriter } from './spill-writer.mjs';

// The writer retires its worker thread once every write has settled and it
// stayed idle, respawns transparently on the next write without losing or
// reordering pages, and dispose always ends the thread.

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        setImmediate(() => handlers.exit?.(1));
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

async function drained(writer) {
  const deadline = Date.now() + 3000;
  while (writer.pendingCount > 0) {
    if (Date.now() > deadline) throw new Error('writes did not drain');
    await settle(5);
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await settle(5);
  }
}

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
  await settle(10); // the retired worker's exit event must not respawn or fail anything
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
  await settle(20);
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
  await settle(10);
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
