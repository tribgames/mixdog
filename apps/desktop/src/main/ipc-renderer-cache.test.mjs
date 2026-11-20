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

test('the latest text is held and given to the page, and reaches the file once, when saved', (t) => {
  const path = join(profile(t), 'cache.json');
  const cache = createRendererCache(path, unexpectedFailure);
  assert.equal(cache.read(), null);
  cache.save();
  assert.equal(existsSync(path), false, 'nothing held is nothing to write');
  for (let version = 1; version <= 20; version += 1) cache.write(`v${version}`);
  assert.equal(cache.read(), 'v20', 'a page loaded meanwhile is given what is held');
  assert.equal(existsSync(path), false, 'a change is not a write to disk');
  cache.save();
  assert.equal(readFileSync(path, 'utf8'), 'v20');
  // The next window's cache starts from the file.
  assert.equal(createRendererCache(path, unexpectedFailure).read(), 'v20');
});

test('a file that cannot be read or written is reported, and what is held stays readable', (t) => {
  const dir = profile(t);
  const failures = [];
  // A directory where the file belongs cannot be read as one.
  const unreadable = createRendererCache(dir, (stage) => failures.push(stage));
  assert.equal(unreadable.read(), null);
  // A file where the profile directory belongs: nothing can be created in it.
  writeFileSync(join(dir, 'blocker'), 'x');
  const unwritable = createRendererCache(join(dir, 'blocker', 'cache.json'), (stage) => failures.push(stage));
  unwritable.write('held');
  unwritable.save();
  assert.deepEqual(failures, ['read', 'write']);
  assert.equal(unwritable.read(), 'held');
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
