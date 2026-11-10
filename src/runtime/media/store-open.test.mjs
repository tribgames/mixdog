import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const spawned = [];
mock.module('node:child_process', {
  namedExports: {
    ...childProcess,
    spawn: (command, args) => {
      const child = new EventEmitter();
      child.unref = () => {};
      spawned.push([command, args]);
      // What a missing opener (e.g. no xdg-open) looks like: an async error event.
      setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' })));
      return child;
    },
  },
});

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-media-open-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const store = await import('./store.mjs');
after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('a missing OS opener reports through the child error event without crashing the process', async () => {
  const result = store.openMediaFolder();
  assert.equal(result.opened, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 1);
});

test('Windows opens a path with explorer.exe, never through cmd.exe parsing', () => {
  const path = 'C:\\Media\\a&calc^b.png';
  assert.deepEqual(store.mediaOpenCommand(path, { platform: 'win32' }), ['explorer.exe', [path]]);
});
