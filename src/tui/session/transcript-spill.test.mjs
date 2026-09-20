import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { createTranscriptSpillBuffer } from './transcript-spill.mjs';

// The spill buffer with an in-process fake worker: whole chunks leave the live
// array as pages, paging restores them with overlap, a failing writer pins
// history in memory after two retries, a hung write times out onto a fresh
// worker, and snapshots keep a reset history restorable.

function fakeWorkers(behaviorFor = () => 'ok') {
  const workers = [];
  const factory = () => {
    const handlers = {};
    const behavior = behaviorFor(workers.length);
    const worker = {
      terminated: false,
      on: (event, fn) => {
        handlers[event] = fn;
      },
      postMessage: ({ id, targetPath, tempPath, items }) => {
        if (behavior === 'hang') return;
        setImmediate(() => {
          if (behavior === 'fail') {
            handlers.message?.({ id, ok: false, error: 'disk full' });
            return;
          }
          writeFileSync(tempPath, JSON.stringify(items), 'utf8');
          renameSync(tempPath, targetPath);
          handlers.message?.({ id, ok: true });
        });
      },
      terminate: () => {
        worker.terminated = true;
      },
      unref: () => {},
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
}

const items = (count) => Array.from({ length: count }, (_, i) => ({ id: `it_${i}`, n: i }));
const ids = (list) => list.map((item) => item.id);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function drained(buffer) {
  const deadline = Date.now() + 3000;
  while (buffer.pendingWriteCount > 0) {
    if (Date.now() > deadline) throw new Error('writes did not drain');
    await settle(5);
  }
}

test('capLive spills whole chunks into pages and paging restores them with overlap', async (context) => {
  const { factory, workers } = fakeWorkers();
  const warnings = [];
  const buffer = createTranscriptSpillBuffer({
    cap: 8,
    chunkSize: 4,
    workerFactory: factory,
    onWarning: (m) => warnings.push(m),
  });
  context.after(() => buffer.dispose());
  const all = items(20);
  const live = buffer.capLive(all);
  assert.deepEqual(ids(live), ids(all.slice(12)));
  assert.equal(buffer.hasOlder, true);
  assert.equal(buffer.hasNewer, false);
  await drained(buffer);
  assert.equal(workers.length, 1);
  assert.equal(buffer.workerCount, 1);

  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(all.slice(8, 20)));
  assert.equal(buffer.hasNewer, true);
  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(all.slice(4, 12)));
  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(all.slice(0, 8)));
  assert.equal(buffer.hasOlder, false);
  assert.equal(buffer.restoreOlder(live), null);
  assert.deepEqual(ids(buffer.restoreNewer(live)), ids(all.slice(4, 12)));
  assert.deepEqual(ids(buffer.restoreNewer(live)), ids(all.slice(8, 20)));
  assert.deepEqual(buffer.restoreNewer(live), { items: null, atLive: true });
  assert.equal(buffer.hasNewer, false);
  assert.equal(buffer.restoreNewer(live), null);
  assert.equal(buffer.capLive(live), live, 'under the cap nothing spills');
  assert.deepEqual(warnings, []);
  assert.equal(buffer.pinnedPageCount, 0);
});

test('a failing writer retries twice, then pins history in memory and disables spilling with one warning', async (context) => {
  const { factory } = fakeWorkers(() => 'fail');
  const warnings = [];
  const buffer = createTranscriptSpillBuffer({
    cap: 4,
    chunkSize: 4,
    workerFactory: factory,
    onWarning: (m) => warnings.push(m),
  });
  context.after(() => buffer.dispose());
  const all = items(8);
  const live = buffer.capLive(all);
  assert.deepEqual(ids(live), ids(all.slice(4)));
  await drained(buffer);
  assert.equal(buffer.disabled, true);
  assert.equal(buffer.pinnedPageCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /history pinned in memory \(disk full\)/);
  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(all), 'a pinned page still restores from memory');
  const more = buffer.capLive(items(12));
  assert.equal(more.length, 12, 'spilling stays disabled');
  buffer.reset();
  assert.equal(buffer.disabled, false);
  assert.equal(buffer.hasOlder, false);
});

test('a write that never completes times out onto a fresh worker and the retry lands', async (context) => {
  const { factory, workers } = fakeWorkers((index) => (index === 0 ? 'hang' : 'ok'));
  const buffer = createTranscriptSpillBuffer({ cap: 2, chunkSize: 2, workerFactory: factory, writeTimeoutMs: 20 });
  context.after(() => buffer.dispose());
  const live = buffer.capLive(items(4));
  assert.equal(live.length, 2);
  await drained(buffer);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.equal(buffer.workerCount, 2);
  assert.equal(buffer.pinnedPageCount, 0);
  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(items(4)));
});

test('a snapshot keeps a reset history on disk and restores it; dispose removes the spill directory', async (context) => {
  const { factory } = fakeWorkers();
  const buffer = createTranscriptSpillBuffer({ cap: 4, chunkSize: 4, workerFactory: factory });
  context.after(() => buffer.dispose());
  const all = items(8);
  const live = buffer.capLive(all);
  await drained(buffer);
  const snapshot = buffer.snapshot();
  const restored = buffer.restoreOlder(live);
  buffer.reset();
  assert.equal(buffer.hasOlder, false);
  assert.equal(buffer.restoreSnapshot(snapshot), true);
  assert.equal(buffer.hasOlder, true);
  assert.deepEqual(ids(buffer.restoreOlder(live)), ids(restored));
  assert.equal(buffer.restoreSnapshot(snapshot), false, 'a restored snapshot is consumed');

  const second = buffer.snapshot();
  assert.equal(buffer.releaseSnapshot(second), true);
  assert.equal(buffer.releaseSnapshot(second), false);
  buffer.dispose();
  assert.equal(buffer.hasOlder, false);
  assert.equal(buffer.pendingWriteCount, 0);
});

test('spilled pages are written under the process-owned spill directory and read back from disk', async (context) => {
  const paths = [];
  const { factory } = fakeWorkers();
  const original = factory;
  const recording = () => {
    const worker = original();
    const post = worker.postMessage;
    worker.postMessage = (message) => {
      paths.push(message.targetPath);
      post(message);
    };
    return worker;
  };
  const buffer = createTranscriptSpillBuffer({ cap: 2, chunkSize: 2, workerFactory: recording });
  context.after(() => buffer.dispose());
  buffer.capLive(items(4));
  await drained(buffer);
  assert.equal(paths.length, 1);
  assert.match(paths[0], new RegExp(`mixdog-transcript-${process.pid}-`));
  assert.deepEqual(ids(JSON.parse(readFileSync(paths[0], 'utf8'))), ids(items(2)));
  assert.equal(existsSync(`${dirname(paths[0])}/heartbeat`), true);
  buffer.dispose();
  assert.equal(existsSync(dirname(paths[0])), false);
});
