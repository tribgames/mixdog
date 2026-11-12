import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const root = makeTempDirSync('session-hidden');
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

// The file as each write published it; the first write is held until released.
const published = [];
let releaseFirst;
const firstHeld = new Promise((resolve) => {
  releaseFirst = resolve;
});
let writes = 0;
const atomicFile = await import('./atomic-file.mjs');
mock.module('./atomic-file.mjs', {
  namedExports: {
    ...atomicFile,
    writeJsonAtomicAsync: async (_file, value) => {
      const text = JSON.stringify(value.hidden);
      writes += 1;
      if (writes === 1) await firstHeld;
      published.push(text);
    },
  },
});
const { hideInDaemon, unhideInDaemon } = await import('./session-hidden.mjs');

test('a slow earlier write never lands after a later one: the file ends on the newest set', async () => {
  const first = hideInDaemon(['sess_a']);
  const second = hideInDaemon(['sess_b']);
  const third = unhideInDaemon('sess_a');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(Object.keys(JSON.parse(published.at(-1))), ['sess_b']);
});
