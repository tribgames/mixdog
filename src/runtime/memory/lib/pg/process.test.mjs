import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyOrphanTempPostmaster } from './process.mjs';

const tempRoot = process.platform === 'win32'
  ? 'C:/Users/test/AppData/Local/Temp'
  : '/tmp';
const args = `"${tempRoot}/mixdog-headless-pristine-test/data/runtime/bin/postgres" `
  + `-D "${tempRoot}/mixdog-headless-pristine-test/data/pgdata"`;

test('old unowned temp postmasters are sweep candidates', () => {
  assert.equal(classifyOrphanTempPostmaster({
    args,
    uptimeSec: 3600,
    tempRoot,
    ownerAlive: false,
  }), true);
});

test('a live owner protects a long-running temp postmaster', () => {
  assert.equal(classifyOrphanTempPostmaster({
    args,
    uptimeSec: 3600,
    tempRoot,
    ownerAlive: true,
  }), false);
});

test('the official data directory is never a sweep candidate', () => {
  assert.equal(classifyOrphanTempPostmaster({
    args: 'postgres -D "/home/test/.mixdog/data/pgdata"',
    uptimeSec: 3600,
    tempRoot,
  }), false);
});
