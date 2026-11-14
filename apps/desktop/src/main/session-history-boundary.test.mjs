// `readSessionHistory` is an internal host read of a session's stored history, never a transcript read a window, a paired phone
// or a page can make. (Whether an attachment belongs to a session is the core's: desktop/attachment/resolve reads the stored
// history itself, thread/items/list.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
const hostFor = () => ({
  readSessionTranscript: async () => ({ items: [] }),
  readSessionHistory: async () => ({ items: [] }),
  readAttachmentImage: async () => null,
});
/** Source files of the app, tests excluded. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test('only the host and its client name the history read', () => {
  const root = join(import.meta.dirname, '..');
  const naming = sourceFiles(root)
    .filter((file) => readFileSync(file, 'utf8').includes('readSessionHistory'))
    .map((file) => relative(root, file).split(sep).join('/'))
    .sort();
  assert.deepEqual(naming, [
    // The service RPC list and its typed contract (main <-> service process only).
    'main/desktop-service-client.ts',
    'main/desktop-service-contract.ts',
    // The service RPC's route onto the core's `thread/items/list` op (main <-> core only; it lives with the core lanes).
    'shared/core-lanes/session-lane.ts',
  ]);
  // Not the window's preload / renderer / shared contract, nor any remote table.
  assert.equal(
    naming.some((file) => /^(preload|renderer)\//.test(file) || /^shared\/(?!core-lanes\/)/.test(file) || /remote/.test(file)),
    false
  );
});