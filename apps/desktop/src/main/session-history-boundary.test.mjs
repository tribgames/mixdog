// `readSessionHistory` lets the host decide whether an attachment id belongs to a session whose chip the pane still shows
// after a compaction. It is an internal host read, never a transcript read a window, a paired phone or a page can make:
// only readSessionAttachment calls it. (The reads of the stored history itself are the core's: thread/items/list.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';

const hostFor = () => ({
  readSessionTranscript: async () => ({ items: [] }),
  readSessionHistory: async () => ({ items: [] }),
  readAttachmentImage: async () => null,
});
test('no channel of the renderer, the paired phone or the service reaches the history as a transcript read', async () => {
  const host = hostFor();
  // A paired phone calls only the methods its table holds, by own name.
  const remote = createRemoteMethods({ host });
  for (const name of ['readSessionHistory', 'readSessionTranscript']) {
    assert.equal(Object.hasOwn(remote, name), false, `${name} is not a remote method`);
  }
  // The window's IPC is a fixed channel list: none is a history read.
  const handlers = new Map();
  registerSessionIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    host,
    invokeDesktopOperation: async () => null,
  });
  assert.equal(
    [...Object.keys(DESKTOP_IPC), ...Object.values(DESKTOP_IPC)].some((name) =>
      /SessionHistory|session-history/i.test(name)
    ),
    false
  );
  assert.equal(
    [...handlers.keys()].some((channel) => /history/i.test(String(channel))),
    false
  );
});

/** Source files of the app, tests excluded. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test('only the host, its client and readSessionAttachment name the history read', () => {
  const root = join(import.meta.dirname, '..');
  const naming = sourceFiles(root)
    .filter((file) => readFileSync(file, 'utf8').includes('readSessionHistory'))
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
  assert.deepEqual(naming, [
    // The service RPC list and its typed contract (main <-> service process only).
    'main/desktop-service-client.ts',
    'main/desktop-service-contract.ts',
    // The download host's type Pick, handed on to readSessionAttachment.
    'main/file-downloads.ts',
    // The service RPC's route onto the core's `thread/items/list` op (main <-> core only).
    'main/protocol/service-route.ts',
    // The one caller.
    'main/session-attachments.ts',
  ]);
  // Not the window's preload / renderer / shared contract, nor any remote table.
  assert.equal(
    naming.some((file) => /^(preload|renderer|shared)\//.test(file) || /remote/.test(file)),
    false
  );
});