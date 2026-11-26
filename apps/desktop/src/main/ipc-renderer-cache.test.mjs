import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { createRendererCache, registerRendererCacheIpc } from './ipc-renderer-cache.ts';

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-renderer-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const unexpectedFailure = (stage, error) => assert.fail(`unexpected ${stage} failure: ${error}`);

test('writes coalesce asynchronously and nothing is held in memory once persisted', async (t) => {
  const path = join(profile(t), 'cache.json');
  const cache = createRendererCache(path, unexpectedFailure);
  assert.equal(cache.read(), null);
  cache.save();
  assert.equal(existsSync(path), false, 'nothing written is nothing on disk');
  cache.write('v1');
  cache.write('v2');
  assert.equal(existsSync(path), false, 'write does not block synchronously on the main thread');
  assert.equal(cache.read(), 'v2', 'read returns latest pending text before async flush');
  await cache.flush();
  assert.equal(readFileSync(path, 'utf8'), 'v2', 'coalesced async write persists latest value');
  assert.equal(cache.read(), 'v2');
  // Removing the file on disk leaves nothing cached in main.
  rmSync(path);
  assert.equal(cache.read(), null, 'main holds no copy after the async write completes');
  cache.save();
  assert.equal(existsSync(path), false, 'save does not rewrite already-persisted data');
});

test('save synchronously flushes dirty pending writes on shutdown', async (t) => {
  const path = join(profile(t), 'shutdown.json');
  const cache = createRendererCache(path, unexpectedFailure);
  cache.write('final');
  cache.save();
  assert.equal(readFileSync(path, 'utf8'), 'final', 'save flushes pending dirty text synchronously');
  await cache.flush();
  rmSync(path);
  assert.equal(cache.read(), null, 'nothing remains held after synchronous shutdown flush');
});

test('a file that cannot be read or written is reported, and failed writes hold nothing', async (t) => {
  const dir = profile(t);
  const failures = [];
  // A directory where the file belongs cannot be read as one.
  const unreadable = createRendererCache(dir, (stage) => failures.push(stage));
  assert.equal(unreadable.read(), null);
  // A file where the profile directory belongs: nothing can be created in it.
  writeFileSync(join(dir, 'blocker'), 'x');
  const unwritable = createRendererCache(join(dir, 'blocker', 'cache.json'), (stage) => failures.push(stage));
  unwritable.write('held');
  await unwritable.flush();
  unwritable.save();
  assert.deepEqual(failures, ['read', 'write']);
  assert.equal(unwritable.read(), null);
});

/** A window's page and other senders over the caches' IPC. */
function harness(caches) {
  const ipc = new EventEmitter();
  const mainFrame = { name: 'main' };
  const window = { webContents: { mainFrame } };
  const dispose = registerRendererCacheIpc({ window, ipcMain: ipc, caches });
  const own = () => ({ sender: window.webContents, senderFrame: mainFrame });
  const read = (name, event = own()) => {
    ipc.emit(DESKTOP_IPC.readRendererCache, event, name);
    return event.returnValue;
  };
  const write = (name, text, event = own()) => ipc.emit(DESKTOP_IPC.writeRendererCache, event, name, text);
  return { ipc, window, dispose, read, write };
}

test('the page reads and writes each cache by name, and the window closing saves them', (t) => {
  const dir = profile(t);
  const paths = {
    'session-catalog': join(dir, 'catalog.json'),
    'transcript-row-heights-v2': join(dir, 'heights.json'),
  };
  writeFileSync(paths['session-catalog'], 'catalog');
  const caches = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, createRendererCache(path, unexpectedFailure)])
  );
  const { ipc, window, dispose, read, write } = harness(caches);
  assert.equal(read('session-catalog'), 'catalog');
  assert.equal(read('transcript-row-heights-v2'), null);
  write('transcript-row-heights-v2', 'heights');
  assert.equal(read('transcript-row-heights-v2'), 'heights');
  // A name that is not a cache, a prototype key included, names none; the blocked caller is answered all the same.
  for (const name of ['pane-layout', '../x', 'constructor', undefined, 5]) {
    assert.equal(read(name), null);
    write(name, 'x');
  }
  const stranger = { sender: { other: true }, senderFrame: window.webContents.mainFrame };
  assert.equal(read('session-catalog', stranger), null);
  write('session-catalog', 'x', stranger);
  write('session-catalog', { not: 'text' });
  assert.equal(read('session-catalog'), 'catalog');
  dispose();
  assert.equal(ipc.listenerCount(DESKTOP_IPC.readRendererCache), 0);
  assert.equal(ipc.listenerCount(DESKTOP_IPC.writeRendererCache), 0);
  assert.equal(readFileSync(paths['transcript-row-heights-v2'], 'utf8'), 'heights');
  assert.equal(readFileSync(paths['session-catalog'], 'utf8'), 'catalog');
});

test('a window without caches (capture) is answered with none and drops writes', () => {
  const { read, write, dispose } = harness();
  assert.equal(read('session-catalog'), null);
  write('session-catalog', 'x');
  dispose();
});

test('late in-flight async write cannot leave stale data over a newer sync save', async (t) => {
  const path = join(profile(t), 'race.json');
  const syncOpts = [];
  let releaseFirstAsync;
  let firstAsyncStarted;
  const firstStarted = new Promise((resolve) => (firstAsyncStarted = resolve));
  let asyncCalls = 0;

  const cache = createRendererCache(path, unexpectedFailure, {
    async writeAsync(filePath, text) {
      asyncCalls += 1;
      if (asyncCalls === 1) {
        firstAsyncStarted();
        await new Promise((resolve) => (releaseFirstAsync = resolve));
      }
      writeFileSync(filePath, text, 'utf8');
      return true;
    },
    writeSync(filePath, text, opts) {
      syncOpts.push(opts);
      writeFileSync(filePath, text, 'utf8');
      return true;
    },
  });

  // Start async write for T1 and hold it in flight.
  cache.write('T1');
  await firstStarted;

  // Queue newer T2 and flush synchronously on shutdown/close.
  cache.write('T2');
  cache.save();
  assert.equal(readFileSync(path, 'utf8'), 'T2', 'sync save immediately persists T2');
  assert.equal(cache.read(), 'T2', 'read returns T2 while stale T1 is still in flight');
  assert.ok(Array.isArray(syncOpts[0]?.backoffs) && syncOpts[0].backoffs.length > 0, 'sync save uses retry backoffs');

  // Stale T1 finishes late and renames over the file; drain must reconcile back to T2.
  releaseFirstAsync();
  await cache.flush();
  assert.equal(readFileSync(path, 'utf8'), 'T2', 'disk ends with T2 after stale T1 finishes');
  rmSync(path);
  assert.equal(cache.read(), null, 'nothing remains retained in memory after reconciliation');
});
