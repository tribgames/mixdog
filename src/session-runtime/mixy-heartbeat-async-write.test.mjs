// The heartbeat state file is written off the event loop: a turn submit
// (noteUserTurn) runs no synchronous fs write or fsync, writes that arrive
// during one in flight collapse into the last state, and an exit still
// persists what has not landed.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import * as heartbeat from './mixy-heartbeat.mjs';

const SYNC_WRITES = ['writeFileSync', 'writeSync', 'fsyncSync', 'renameSync', 'mkdirSync', 'appendFileSync', 'linkSync'];

/** Every synchronous fs write call (and a non-read openSync) made until `t` ends. */
function spySyncFsWrites(t) {
  const calls = [];
  const originals = new Map();
  for (const name of [...SYNC_WRITES, 'openSync']) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function (...args) {
      if (name !== 'openSync' || (typeof args[1] === 'string' && args[1] !== 'r') || typeof args[1] === 'number') {
        calls.push(name);
      }
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  t.after(() => {
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
  });
  return calls;
}

function statePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-heartbeat-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'heartbeat.json');
}
const onDisk = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('noteUserTurn runs no synchronous fs write or fsync, and the state still lands', async (t) => {
  const path = statePath(t);
  const calls = spySyncFsWrites(t);
  heartbeat.noteUserTurn(1_700_000_000_000, { path });
  assert.deepEqual(calls, [], 'sync fs write on the submit path');
  await heartbeat.heartbeatStateSettled(path);
  assert.equal(onDisk(path).lastUserInputAt, 1_700_000_000_000);
});

test('writes during one in flight collapse into the last state, which lands', async (t) => {
  const path = statePath(t);
  const calls = spySyncFsWrites(t);
  heartbeat.noteUserTurn(1_700_000_000_001, { path });
  heartbeat.noteUserTurn(1_700_000_000_002, { path });
  const first = heartbeat.recordSuggestion({ key: 'pause-routine:daily-news', text: 'Pause it' }, { path });
  heartbeat.noteUserTurn(1_700_000_000_009, { path });
  // Each update builds on the newest state, landed or not.
  const second = heartbeat.recordSuggestion({ key: 'pause-routine:old-news', dismissed: true }, { path });
  assert.deepEqual(calls, []);
  await heartbeat.heartbeatStateSettled(path);
  assert.equal((await first).recorded, true);
  assert.equal((await second).dismissed, true);
  const state = onDisk(path);
  assert.equal(state.lastUserInputAt, 1_700_000_000_009);
  assert.deepEqual(
    state.pending.map((entry) => entry.key),
    ['pause-routine:daily-news']
  );
  assert.deepEqual(state.dismissed, ['pause-routine:old-news']);
});

// A child that makes two updates `rounds` event-loop turns apart and exits at
// once: the exit lands at a different point of the first write each time
// (before it starts, mid-stage, at the rename, after it).
function exitAfter(path, rounds) {
  const script = `
    import { noteUserTurn } from ${JSON.stringify(new URL('./mixy-heartbeat.mjs', import.meta.url).href)};
    const path = ${JSON.stringify(path)};
    noteUserTurn(100, { path });
    for (let round = 0; round < ${rounds}; round += 1) await new Promise((resolve) => setImmediate(resolve));
    noteUserTurn(200, { path });
    process.exit(0);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('a forced exit at any point of a write in flight leaves the newest accepted state', (t) => {
  for (const rounds of [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 20, 40]) {
    const path = statePath(t);
    const run = exitAfter(path, rounds);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', `rounds=${rounds}`);
    assert.equal(onDisk(path).lastUserInputAt, 200, `exit after ${rounds} rounds`);
  }
});

test('a state not yet written when the process exits is persisted by the exit hook', (t) => {
  const path = statePath(t);
  const script = `
    import { noteUserTurn } from ${JSON.stringify(new URL('./mixy-heartbeat.mjs', import.meta.url).href)};
    noteUserTurn(1700000000042, { path: ${JSON.stringify(path)} });
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(onDisk(path).lastUserInputAt, 1_700_000_000_042);
});

const settlesWithin = (promise, ms) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected'
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);

/** A state path whose directory cannot be created: every write fails. */
function blockedPath(t) {
  const path = statePath(t);
  const blocker = join(path, '..');
  mkdirSync(join(blocker, '..'), { recursive: true });
  writeFileSync(blocker, 'not a directory');
  return { path, blocker };
}

test('a write that fails is reported, stays queued and lands on a later attempt', async (t) => {
  const { path, blocker } = blockedPath(t);
  await assert.rejects(heartbeat.recordSuggestion({ key: 'pause-routine:news', text: 'Pause it' }, { path }));
  await assert.rejects(heartbeat.heartbeatStateSettled(path), 'settlement reports the failure');
  rmSync(blocker);
  await heartbeat.heartbeatStateSettled(path);
  assert.deepEqual(
    onDisk(path).pending.map((entry) => entry.key),
    ['pause-routine:news']
  );
});

test('after a failed write every caller still waiting settles: none is left pending', async (t) => {
  const { path } = blockedPath(t);
  const suggest = (name) => heartbeat.recordSuggestion({ key: `pause-routine:${name}` }, { path });
  const outcomes = [settlesWithin(suggest('a'), 3000)];
  // Queued while the first write is being tried, and after it failed.
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    outcomes.push(settlesWithin(suggest(`b${round}`), 3000));
  }
  assert.deepEqual(await Promise.all(outcomes), Array(7).fill('rejected'));
  assert.equal(await settlesWithin(heartbeat.heartbeatStateSettled(path), 3000), 'rejected');
});

test('shutdown: stop ends scheduling, waits for the running check, and the flush lands what producers made meanwhile', async (t) => {
  const path = statePath(t);
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const cleared = [];
  const callbacks = [];
  const timers = {
    setTimeout: (fn) => (callbacks.push(fn), { unref() {} }),
    setInterval: (fn) => (callbacks.push(fn), { unref() {} }),
    clearTimeout: (timer) => cleared.push(timer),
    clearInterval: (timer) => cleared.push(timer),
  };
  const stop = heartbeat.startMixyHeartbeat({
    timers,
    path,
    now: () => 1_800_000_000_000,
    isEnabled: async () => {
      await gate;
      return true;
    },
    mixyExists: async () => true,
    userTurnAt: () => 0,
    appInputAt: () => 0,
    log: () => {},
  });
  callbacks[0]();
  const stopped = stop();
  let ended = false;
  stopped.then(() => {
    ended = true;
  });
  assert.equal(cleared.length, 2, 'both timers are cleared at once');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, 'stop waits for the check in progress');
  // A producer still running while the check is.
  heartbeat.noteUserTurn(555, { path });
  open();
  await stopped;
  await heartbeat.flushHeartbeatState();
  const state = onDisk(path);
  assert.equal(state.lastBeatAt, 1_800_000_000_000, 'the check that was running armed the clock');
  assert.equal(state.lastUserInputAt, 555);
});