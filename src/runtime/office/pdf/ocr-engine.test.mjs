// The OCR engine's lifecycle: a stalled start or a cancelled call ends the
// engine thread at once (with any download it started), and concurrent first
// calls share one start.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { acquireOcrEngine, liveOcrEngines } from './ocr-engine.mjs';

// A stand-in engine thread: `ready` after `readyMs` (never when null), and a
// recognize that never answers. It also starts a nested thread, as the real
// engine does, holding an interval of its own.
const STUB = `
const { parentPort, workerData, Worker } = require('node:worker_threads');
new Worker('setInterval(() => {}, 1000)', { eval: true });
if (workerData.readyMs != null) setTimeout(() => parentPort.postMessage({ ready: true }), workerData.readyMs);
parentPort.on('message', () => {});
`;

function stubSpawner({ readyMs }) {
  const threads = [];
  const spawn = (_url, options) => {
    const thread = new Worker(STUB, { eval: true, workerData: { ...options.workerData, readyMs } });
    const exited = new Promise((resolve) => thread.once('exit', resolve));
    threads.push({ thread, exited });
    return thread;
  };
  return { spawn, threads };
}

function cacheDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-ocr-engine-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const activeResources = () => process.getActiveResourcesInfo().slice().sort();

test('a start that never finishes times out and its thread is ended, leaving nothing running', async (t) => {
  const before = activeResources();
  const { spawn, threads } = stubSpawner({ readyMs: null });
  await assert.rejects(
    acquireOcrEngine({ languages: 'eng', cachePath: cacheDir(t), timeoutMs: 200, spawn }),
    (error) => error.code === 'OCR_UNAVAILABLE' && /did not load in time/.test(error.message)
  );
  assert.equal(threads.length, 1);
  await threads[0].exited;
  assert.equal(liveOcrEngines(), 0);
  assert.deepEqual(activeResources(), before);
});

test('cancelling while the engine starts ends its thread at once', async (t) => {
  const { spawn, threads } = stubSpawner({ readyMs: null });
  const controller = new AbortController();
  const pending = acquireOcrEngine({ languages: 'eng', cachePath: cacheDir(t), signal: controller.signal, spawn });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /PDF OCR was cancelled/);
  await threads[0].exited;
  assert.equal(liveOcrEngines(), 0);
});

test('cancelling a page in recognition ends the engine thread', async (t) => {
  const { spawn, threads } = stubSpawner({ readyMs: 10 });
  const engine = await acquireOcrEngine({ languages: 'eng', cachePath: cacheDir(t), spawn });
  const controller = new AbortController();
  const recognizing = engine.recognize(Buffer.from('png'), { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(recognizing, /PDF OCR was cancelled/);
  await threads[0].exited;
  assert.equal(liveOcrEngines(), 0);
  engine.release();
});

test('two first calls at once share one engine start', async (t) => {
  const { spawn, threads } = stubSpawner({ readyMs: 100 });
  const cachePath = cacheDir(t);
  const [first, second] = await Promise.all([
    acquireOcrEngine({ languages: 'eng+kor', cachePath, spawn }),
    acquireOcrEngine({ languages: 'eng+kor', cachePath, spawn }),
  ]);
  assert.equal(threads.length, 1, 'one engine thread for both callers');
  assert.equal(liveOcrEngines(), 1);
  first.release();
  assert.equal(liveOcrEngines(), 1, 'kept while the other caller holds it');
  second.release();
  await threads[0].exited;
  assert.equal(liveOcrEngines(), 0);
});

test('the real engine: cancelling a stalled first-use download closes the download', async (t) => {
  let arrived;
  const requested = new Promise((resolve) => {
    arrived = resolve;
  });
  let closed;
  const socketClosed = new Promise((resolve) => {
    closed = resolve;
  });
  // A language server that accepts the download and never answers.
  const server = createServer((request) => {
    request.socket.once('close', closed);
    arrived(request.url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const controller = new AbortController();
  const pending = acquireOcrEngine({
    languages: 'eng',
    cachePath: cacheDir(t),
    langPath: `http://127.0.0.1:${server.address().port}/lang`,
    signal: controller.signal,
  });
  assert.match(await requested, /eng\.traineddata/);
  controller.abort();
  await assert.rejects(pending, /PDF OCR was cancelled/);
  await socketClosed;
  assert.equal(liveOcrEngines(), 0);
});
