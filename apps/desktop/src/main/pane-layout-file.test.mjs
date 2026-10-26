import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { registerPaneLayoutIpc } from './ipc-pane-layout.ts';
import { createPaneLayoutFile, flushPaneLayoutFiles, PANE_LAYOUT_FILE } from './pane-layout-file.ts';

const unexpectedFailure = (stage, error) => assert.fail(`unexpected ${stage} failure: ${error}`);

async function withProfile(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pane-layout-'));
  try {
    await run(join(dir, PANE_LAYOUT_FILE), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a layout written reads back; an absent file reads as none', () =>
  withProfile(async (path) => {
    const file = createPaneLayoutFile(path, unexpectedFailure);
    assert.equal(file.read(), null);
    file.write('{"layout":1}');
    await flushPaneLayoutFiles();
    assert.equal(await readFile(path, 'utf8'), '{"layout":1}');
    assert.equal(file.read(), '{"layout":1}');
  }));

test('a burst of writes lands the latest text, in order, without a torn file', () =>
  withProfile(async (path) => {
    const file = createPaneLayoutFile(path, unexpectedFailure);
    for (let version = 1; version <= 20; version += 1) file.write(`{"v":${version}}`);
    await flushPaneLayoutFiles();
    assert.equal(await readFile(path, 'utf8'), '{"v":20}');
    file.write('{"v":21}');
    await flushPaneLayoutFiles();
    assert.equal(await readFile(path, 'utf8'), '{"v":21}');
  }));

test('a read failure other than a missing file is reported, and reads as none', () =>
  withProfile(async (path) => {
    const failures = [];
    // A directory where the file belongs cannot be read as one.
    await mkdir(path);
    const file = createPaneLayoutFile(path, (stage, error) => failures.push([stage, error?.code]));
    assert.equal(file.read(), null);
    assert.deepEqual(failures, [['read', 'EISDIR']]);
  }));

test('a write failure is reported, not swallowed, and does not stop later writes', () =>
  withProfile(async (path, dir) => {
    const failures = [];
    // The profile directory's place is taken by a file: nothing can be created in it.
    await writeFile(join(dir, 'blocker'), 'x');
    const blocked = createPaneLayoutFile(join(dir, 'blocker', PANE_LAYOUT_FILE), (stage) => failures.push(stage));
    blocked.write('{"v":1}');
    await flushPaneLayoutFiles();
    assert.deepEqual(failures, ['write']);
    const other = createPaneLayoutFile(path, unexpectedFailure);
    other.write('{"v":2}');
    await flushPaneLayoutFiles();
    assert.equal(await readFile(path, 'utf8'), '{"v":2}');
  }));

function ipcHarness({ file } = {}) {
  const ipc = new EventEmitter();
  const mainFrame = { name: 'main' };
  const window = { webContents: { mainFrame } };
  const dispose = registerPaneLayoutIpc({ window, ipcMain: ipc, file });
  const own = () => ({ sender: window.webContents, senderFrame: mainFrame });
  const read = (event = own()) => {
    ipc.emit(DESKTOP_IPC.readPaneLayoutFile, event);
    return event.returnValue;
  };
  const write = (layout, event = own()) => ipc.emit(DESKTOP_IPC.writePaneLayoutFile, event, layout);
  return { ipc, window, dispose, own, read, write };
}

function recordingFile(initial = null) {
  const writes = [];
  return { writes, read: () => initial, write: (layout) => writes.push(layout) };
}

test('the window reads its file synchronously and its writes reach the file', () => {
  const file = recordingFile('{"layout":"stored"}');
  const { read, write } = ipcHarness({ file });
  assert.equal(read(), '{"layout":"stored"}');
  write('{"layout":"next"}');
  assert.deepEqual(file.writes, ['{"layout":"next"}']);
});

test('a sender that is not the window main frame gets no layout and writes nothing, but is answered', () => {
  const file = recordingFile('{"layout":"stored"}');
  const { window, read, write } = ipcHarness({ file });
  const subframe = { sender: window.webContents, senderFrame: { name: 'iframe' } };
  const stranger = { sender: { other: true }, senderFrame: window.webContents.mainFrame };
  assert.equal(read(subframe), null);
  assert.equal(read(stranger), null);
  write('{"x":1}', subframe);
  write('{"x":2}', stranger);
  for (const malformed of [null, undefined, 5, { layout: 1 }, ['x']]) write(malformed);
  assert.deepEqual(file.writes, []);
});

test('a window without a layout file (capture) is answered with none and drops writes', () => {
  const { read, write } = ipcHarness();
  assert.equal(read(), null);
  write('{"x":1}');
});

test('disposing removes both listeners', () => {
  const { ipc, dispose } = ipcHarness({ file: recordingFile() });
  assert.equal(ipc.listenerCount(DESKTOP_IPC.readPaneLayoutFile), 1);
  assert.equal(ipc.listenerCount(DESKTOP_IPC.writePaneLayoutFile), 1);
  dispose();
  assert.equal(ipc.listenerCount(DESKTOP_IPC.readPaneLayoutFile), 0);
  assert.equal(ipc.listenerCount(DESKTOP_IPC.writePaneLayoutFile), 0);
});
