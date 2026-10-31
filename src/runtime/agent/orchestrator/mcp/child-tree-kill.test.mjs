import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { spawnTreeKill, TREE_KILL_DEADLINE_MS, treeKillCommand } from './child-tree.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'requires Windows parent links' };

// The members one tree-kill pass would end, over a stand-in table.
function members(pids, { aliveAt, table }) {
  const { command, args } = treeKillCommand(pids, { aliveAt, table });
  const run = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return {
    status: run.status,
    pids: String(run.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b),
  };
}

// wininit.exe keeps the pid of its long-gone boot-time parent; here a newer
// process holds that pid (10) and is the kill target.
const table = [
  { pid: 10, ppid: 1, created: 1_000_000 },
  { pid: 20, ppid: 10, created: 500_000 }, // wininit.exe: older, names pid 10 as its dead parent
  { pid: 21, ppid: 20, created: 510_000 }, // services.exe under it
  { pid: 11, ppid: 10, created: 1_000_500 }, // the target's real child
  { pid: 12, ppid: 11, created: 1_000_600 }, // and grandchild
];

test('a tree kill never reaches an older process that names the killed pid as its dead parent', windowsOnly, () => {
  assert.deepEqual(members([10], { aliveAt: 2_000_000, table }), { status: 0, pids: [10, 11, 12] });
});

test('a tree kill refuses a pid whose holder was created after the caller last saw its process', windowsOnly, () => {
  assert.deepEqual(members([10], { aliveAt: 900_000, table }), { status: 128, pids: [] });
});

// A pass that never answers (its table read hung) and the owned root it targets.
function hungPass(t) {
  const pass = Object.assign(new EventEmitter(), { kills: 0, refs: true });
  pass.kill = () => {
    pass.kills += 1;
  };
  pass.unref = () => {
    pass.refs = false;
  };
  const spawnMock = t.mock.method(childProcess, 'spawn', () => pass);
  syncBuiltinESMExports();
  // Restored here: the test's own mock reset runs after its after-hooks.
  t.after(() => {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  });
  const root = { kills: 0, kill: () => (root.kills += 1) };
  return { pass, root };
}

test('a hung tree kill is ended at its deadline and the owned root is killed directly', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pass, root } = hungPass(t);
  assert.equal(spawnTreeKill([4242], { root }), pass);
  assert.equal(pass.refs, false, 'the pass never keeps the caller alive');
  t.mock.timers.tick(TREE_KILL_DEADLINE_MS - 1);
  assert.deepEqual([pass.kills, root.kills], [0, 0]);
  t.mock.timers.tick(1);
  assert.deepEqual([pass.kills, root.kills], [1, 1]);
});

test('a finished tree kill clears its deadline and then kills the owned root', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pass, root } = hungPass(t);
  spawnTreeKill([4242], { root });
  pass.emit('exit', 0);
  t.mock.timers.tick(TREE_KILL_DEADLINE_MS);
  assert.deepEqual([pass.kills, root.kills], [0, 1]);
});
