import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { deleteHeartbeat, getStoreDir, publishHeartbeat, sessionPath } = await import('./paths-heartbeat.mjs');

test('memoized session paths equal fresh joins and follow a data-dir switch', () => {
  const other = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-switch-'));
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

test('deleteHeartbeat removes the marker off the event loop, after a pending write', async (t) => {
  const id = 'sess_heartbeat_order';
  const path = join(getStoreDir(), `${id}.hb`);
  // Write still in flight when the turn settles: it must not resurrect.
  const pendingWrite = publishHeartbeat(id, Date.now());
  const syncCalls = [];
  for (const name of ['unlinkSync', 'existsSync', 'mkdirSync', 'statSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (target, ...args) => {
      syncCalls.push(`${name} ${target}`);
      return original(target, ...args);
    });
  }
  syncBuiltinESMExports();
  let deleted;
  try {
    deleted = deleteHeartbeat(id);
    assert.deepEqual(syncCalls, [], 'heartbeat deletion ran synchronous file calls');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await Promise.all([pendingWrite, deleted]);
  assert.equal(existsSync(path), false);

  // A marker left by another (e.g. killed) process is removed as well.
  writeFileSync(path, `${Date.now()}\n999999\n`);
  await deleteHeartbeat(id);
  assert.equal(existsSync(path), false);
});
