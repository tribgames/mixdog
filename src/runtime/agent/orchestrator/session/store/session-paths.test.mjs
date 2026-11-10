import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-paths-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { sessionPath } = await import('./session-paths.mjs');

test('memoized session paths equal fresh joins and follow a data-dir switch', () => {
  const other = mkdtempSync(join(tmpdir(), 'mixdog-session-paths-switch-'));
  try {
    const ids = ['sess_1_abc', 'sess_2_def', 'x-y_z'];
    for (let round = 0; round < 2; round += 1) {
      for (const id of ids) assert.equal(sessionPath(id), join(root, 'sessions', `${id}.json`));
    }
    process.env.MIXDOG_DATA_DIR = other;
    for (const id of ids) assert.equal(sessionPath(id), join(other, 'sessions', `${id}.json`));
    assert.equal(existsSync(join(other, 'sessions')), true, 'the switched store dir is still created');
    // Default data dir under a switched MIXDOG_HOME.
    const priorHome = process.env.MIXDOG_HOME;
    delete process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_HOME = other;
    try {
      assert.equal(sessionPath(ids[0]), join(other, 'data', 'sessions', `${ids[0]}.json`));
    } finally {
      if (priorHome === undefined) delete process.env.MIXDOG_HOME;
      else process.env.MIXDOG_HOME = priorHome;
    }
    process.env.MIXDOG_DATA_DIR = root;
    for (const id of ids) assert.equal(sessionPath(id), join(root, 'sessions', `${id}.json`));
    for (const bad of ['', '../escape', 'a/b', null]) assert.throws(() => sessionPath(bad), /invalid session id/);
  } finally {
    process.env.MIXDOG_DATA_DIR = root;
    rmSync(other, { recursive: true, force: true });
  }
});
