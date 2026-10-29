import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';

import { processTable, scriptedChildTree } from './process-table-fixture.mjs';

// The operating system is the only thing replaced: every process-table read
// answers from a scripted table, and the live record is observed via spies.
const tree = scriptedChildTree();
mock.module('../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const records = { published: [], retired: [] };
mock.module('../builtin/shell-jobs.mjs', {
  namedExports: {
    publishForegroundShellRecord: (input) => records.published.push(input),
    retireForegroundShellRecord: (jobId) => records.retired.push(jobId),
  },
});
const { createSettle } = await import('./shell-run-settle.mjs');
const { TaskOutput } = await import('../shell-exec-output.mjs');
const { createProcessTreeTracker, PROCESS_TABLE_READ_BOUND_MS } = await import('./shell-descendants.mjs');
const { forceReleaseTerminationHold } = await import('../builtin/lib/shell-job-records.mjs');
const { registerForegroundOwnedTree, treeKillForceSettle } = await import('./shell-run-state.mjs');
const { cancelOwnedShellTrees } = await import('./owned-shell-trees.mjs');
const { noteShellOwnerSessionClosed } = await import('../builtin/lib/shell-job-records.mjs');

after(cleanupTempDirs);

const flush = () => new Promise((resolve) => setImmediate(resolve));
const isHeld = (repo) => {
  try {
    holdWorkspaceActivity([repo])();
    return false;
  } catch (error) {
    assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
    return true;
  }
};

// A foreground run whose kill was never confirmed: it holds the command
// reservation exactly as spawnShellChild leaves it (a lease under this live
// runtime's pid), and its child has not exited yet.
function unconfirmedRun(repo, child, { killUnconfirmed = true } = {}) {
  const counters = { resourceLeases: 0 };
  const run = {
    child,
    killed: true,
    killUnconfirmed,
    settled: false,
    autoBackgrounded: false,
    foregroundRecordId: 'job_unconfirmed_kill',
    foregroundRecordPublished: true,
    foregroundRecordInput: { command: 'node server.js', cwd: repo, ownerSessionId: 'session', clientHostPid: null },
    commandStartedAtMs: 1,
    workspaceAdmission: tryAdmitWorkspaceActivity('session', repo, { kind: 'command' }),
    resourceLease: {
      release: async () => {
        counters.resourceLeases += 1;
      },
    },
    stdoutDecoder: { end: () => '' },
    stderrDecoder: { end: () => '' },
    taskOutput: {
      spilled: false,
      getStdout: async () => '',
      getStderr: async () => '',
      closeFds() {},
      writeStdout() {},
      writeStderr() {},
    },
    resolveResult() {},
  };
  return { run, counters };
}

const ROOT = 4242;
const runningChild = () =>
  Object.assign(new EventEmitter(), {
    pid: ROOT,
    exitCode: null,
    signalCode: null,
    __nativeSpawn: true,
    kill: () => true,
  });
const exitChild = (child, code = 1) => {
  child.exitCode = code;
  child.emit('exit', code, null);
};
const settleAndFlush = async (run) => {
  await createSettle(run, () => {})(1, 'SIGKILL');
  await flush();
};
// The identities a kill path records while the root is still alive.
async function capturedBeforeKill(run, rows) {
  tree.state.next = () => processTable(rows);
  run.terminationTracker = createProcessTreeTracker({ pid: ROOT });
  assert.equal(await run.terminationTracker.capture(), true);
}
async function tick(ms) {
  mock.timers.tick(ms);
  await flush();
}
function withTimers(body) {
  return async () => {
    records.published.length = 0;
    records.retired.length = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await body();
    } finally {
      mock.timers.reset();
    }
  };
}

test(
  'an unconfirmed kill keeps the workspace reservation, even after the cleanup ceiling',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run, counters } = unconfirmedRun(repo, child);
    await capturedBeforeKill(run, [{ pid: ROOT }]);
    await settleAndFlush(run);
    assert.equal(isHeld(repo), true);
    await tick(60_000);
    assert.equal(counters.resourceLeases, 1, 'the bounded capture/resource cleanup still runs');
    assert.equal(isHeld(repo), true, 'a cleanup timer is not a confirmation');
    assert.equal(typeof run.workspaceAdmission, 'function');
    exitChild(child);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(run.workspaceAdmission, null);
    assert.equal(isHeld(repo), false);
  })
);

// Finding 1: the kill orphans the worker (its parent died first), so a tree
// walked from the root after exit no longer reaches it.
test(
  'a descendant orphaned by the kill stays tracked: the reservation waits for it',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    tree.state.next = () =>
      processTable([{ pid: ROOT }, { pid: 4300, ppid: ROOT }, { pid: 4301, ppid: 4300, token: 'worker' }]);
    child.kill = () => {
      tree.state.next = () => processTable([{ pid: 4301, ppid: 4300, token: 'worker' }]);
      return true;
    };
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'timeout');
    await flush();
    for (let attempt = 0; attempt < 3; attempt += 1) await tick(5_000);
    assert.equal(run.killUnconfirmed, true);
    exitChild(child, 137);
    await flush();
    assert.equal(isHeld(repo), true, 'the orphaned worker still runs');
    await tick(5_000);
    assert.equal(isHeld(repo), true);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(isHeld(repo), false);
  })
);

test(
  'a timeout kill whose captured descendant survives the root keeps the reservation until it is gone',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.timedOut = true;
    const survivor = { pid: 4400, ppid: ROOT, token: 'worker' };
    await capturedBeforeKill(run, [{ pid: ROOT }, survivor]);
    exitChild(child, 137);
    tree.state.next = () => processTable([{ ...survivor, ppid: 1 }]);
    await settleAndFlush(run);
    assert.equal(isHeld(repo), true, 'the root exit alone does not release the folder');
    assert.equal(typeof run.workspaceAdmission, 'function');
    assert.equal(records.published.at(-1)?.terminationUnconfirmed, true, 'shown as termination unconfirmed');
    assert.deepEqual(records.retired, []);
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'other' })).released,
      false,
      'the hold is owned'
    );
    await tick(5_000);
    assert.equal(isHeld(repo), true);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(isHeld(repo), false);
    assert.equal(run.workspaceAdmission, null);
    assert.deepEqual(records.retired, ['job_unconfirmed_kill']);
  })
);

test(
  'a kill whose captured descendant survives keeps its capture until the tree is gone',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run, counters } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.foregroundRecordId = 'job_killed_tree_capture';
    run.taskOutput = new TaskOutput('killed_tree_capture');
    run.taskOutput.forceSpill();
    run.taskOutput.writeStdout('before the kill\n');
    const capture = run.taskOutput.stdoutPath;
    let result;
    run.resolveResult = (value) => {
      result = value;
    };
    const survivor = { pid: 4410, ppid: ROOT, token: 'worker' };
    await capturedBeforeKill(run, [{ pid: ROOT }, survivor]);
    exitChild(child, 137);
    tree.state.next = () => processTable([{ ...survivor, ppid: 1 }]);
    try {
      await settleAndFlush(run);
      assert.equal(counters.resourceLeases, 1, 'the foreground slot is returned with the result');
      assert.equal(result.stdoutPath, null, 'an inline-sized capture is not reported as a file');
      assert.equal(existsSync(capture), true, 'the surviving worker may still write it');
      run.taskOutput.writeStdout('from the survivor\n');
      assert.equal(run.taskOutput.writeError, null);
      let ended = false;
      void result.settled.then(() => {
        ended = true;
      });
      await tick(5_000);
      assert.equal(ended, false);
      tree.state.next = () => processTable([]);
      await tick(5_000);
      assert.equal(ended, true, 'the result reports when its tree is gone');
      assert.equal(existsSync(capture), false, 'and the capture goes with it');
    } finally {
      run.stopTerminationWatch?.();
      run.taskOutput.deleteFiles();
    }
  })
);

test(
  'an abort kill whose captured tree is gone releases the reservation on the first observation',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    await capturedBeforeKill(run, [{ pid: ROOT }, { pid: 4400, ppid: ROOT, token: 'worker' }]);
    exitChild(child, 137);
    tree.state.next = () => processTable([]);
    await settleAndFlush(run);
    await flush();
    assert.equal(isHeld(repo), false);
    assert.equal(records.published.length, 0, 'never marked unconfirmed');
  })
);

// Finding 2: the root's pid now names an unrelated process, whose child must
// not be mistaken for a survivor of this command.
test(
  'a reused root pid is not the command: its children do not hold the reservation',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    await capturedBeforeKill(run, [{ pid: ROOT, token: 'root' }]);
    exitChild(child, 137);
    tree.state.next = () =>
      processTable([
        { pid: ROOT, token: 'reused' },
        { pid: process.pid, ppid: ROOT, token: 'unrelated' },
      ]);
    await settleAndFlush(run);
    assert.equal(run.workspaceAdmission, null);
    assert.equal(isHeld(repo), false);
  })
);

test(
  'a captured descendant whose pid was recycled no longer counts as a survivor',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    await capturedBeforeKill(run, [{ pid: ROOT }, { pid: process.pid, ppid: ROOT, token: 'worker' }]);
    exitChild(child, 137);
    tree.state.next = () => processTable([{ pid: process.pid, ppid: 1, token: 'recycled' }]);
    await settleAndFlush(run);
    assert.equal(isHeld(repo), false);
  })
);

// Finding 3: no exit event ever arrives and the table is unreadable for a
// while; the one loop re-checks every 5 s and recovers.
test(
  'repeated uncertainty is re-checked every 5 s until termination is confirmed',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    await capturedBeforeKill(run, [{ pid: ROOT }]);
    let failures = 3;
    tree.state.next = () => {
      if (failures-- > 0) throw new Error('process enumeration denied');
      return processTable([]);
    };
    const start = tree.state.reads;
    await settleAndFlush(run);
    assert.equal(tree.state.reads - start, 1);
    assert.equal(isHeld(repo), true);
    await tick(4_999);
    assert.equal(tree.state.reads - start, 1, 'nothing re-checks before the cadence');
    await tick(1);
    assert.equal(tree.state.reads - start, 2);
    await tick(5_000);
    assert.equal(tree.state.reads - start, 3);
    assert.equal(isHeld(repo), true, 'unknown is never empty');
    await tick(5_000);
    assert.equal(tree.state.reads - start, 4);
    assert.equal(isHeld(repo), false);
  })
);

test(
  'the observation loop stops for good once the reservation is released',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    const survivor = { pid: process.pid, ppid: ROOT, token: 'service' };
    await capturedBeforeKill(run, [{ pid: ROOT }, survivor]);
    exitChild(child, 137);
    tree.state.next = () => processTable([survivor]);
    await settleAndFlush(run);
    await tick(5_000);
    assert.equal(isHeld(repo), true);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(isHeld(repo), false);
    const reads = tree.state.reads;
    await tick(60_000);
    assert.equal(tree.state.reads, reads, 'no observation after release');
  })
);

// Finding 4: the result is reported, but the command stays on the readouts.
test(
  'an unconfirmed kill keeps a visible record until termination is confirmed',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    let result = null;
    run.resolveResult = (value) => {
      result = value;
    };
    await capturedBeforeKill(run, [{ pid: ROOT }]);
    await settleAndFlush(run);
    assert.ok(result, 'the result completes now');
    assert.deepEqual(records.retired, []);
    assert.equal(records.published.length, 1);
    assert.equal(records.published[0].terminationUnconfirmed, true);
    assert.equal(records.published[0].jobId, 'job_unconfirmed_kill');
    assert.equal(records.published[0].pid, ROOT);
    exitChild(child, 137);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.deepEqual(records.retired, ['job_unconfirmed_kill']);
  })
);

test(
  'a pre-kill snapshot slower than the read bound is still taken before the kill, so the cancelled tree is confirmed gone',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    // A table read answers with the processes alive when it is taken: a
    // loaded host's enumerator takes it long after it was asked for.
    let alive = [{ pid: ROOT }];
    let takeTable;
    tree.state.next = () => new Promise((resolve) => (takeTable = () => resolve(processTable(alive))));
    let kills = 0;
    child.kill = () => {
      kills += 1;
      alive = [];
      return true;
    };
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'cancellation');
    await flush();
    await tick(PROCESS_TABLE_READ_BOUND_MS);
    assert.equal(kills, 0, 'no kill before the snapshot it relies on');
    takeTable();
    await flush();
    assert.equal(kills, 1);
    assert.equal(run.terminationTracker.complete, true, 'the identities were taken while the root ran');
    tree.state.next = () => processTable(alive);
    exitChild(child, 137);
    await settleAndFlush(run);
    await tick(5_000);
    assert.equal(isHeld(repo), false, 'the workspace is released once the tree is confirmed gone');
    run.stopTerminationWatch?.();
  })
);

test(
  'a stuck pre-kill snapshot never blocks the kill: it is sent once the read fails at its deadline',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    const kills = [];
    child.kill = () => {
      kills.push(Date.now());
      return true;
    };
    // The enumerator is stuck until its deadline kills it (the strict read rejects).
    const timedOut = () => new Error('Process enumeration timed out after 20000 ms.');
    let failRead;
    tree.state.next = () => new Promise((_, reject) => (failRead = () => reject(timedOut())));
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'abort');
    await flush();
    await tick(PROCESS_TABLE_READ_BOUND_MS);
    assert.equal(kills.length, 0);
    tree.state.next = () => Promise.reject(timedOut());
    failRead();
    await flush();
    assert.equal(kills.length, 1, 'the kill is sent once the read failed');
    // Never confirmed: the run settles unconfirmed and the folder stays held.
    // Three attempts, each a 5 s deadline (every later read fails at once).
    for (let second = 0; second < 3 * 7 && !run.killUnconfirmed; second += 1) await tick(1_000);
    assert.equal(run.killUnconfirmed, true);
    assert.equal(kills.length, 3, 'every attempt is sent');
    assert.equal(isHeld(repo), true, 'no snapshot is unknown, never empty');
    await tick(60_000);
    assert.equal(isHeld(repo), true, 'no timer releases it');
    run.stopTerminationWatch();
  })
);

// A child the spawn server contains (Windows job without breakaway): the
// server, not a process-table read, reports when its whole tree is gone.
const containedChild = () => Object.assign(runningChild(), { contained: true, treeOutcome: null });

test(
  'a contained tree is killed at once, with no pre-kill snapshot, and released on the server’s empty-job report',
  withTimers(async () => {
    const repo = makeRepo();
    const child = containedChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    tree.state.next = () => new Promise(() => {}); // any table read would hang
    const reads = tree.state.reads;
    let kills = 0;
    child.kill = () => {
      kills += 1;
      return true;
    };
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'cancellation');
    assert.equal(kills, 1, 'the kill is sent synchronously');
    // The server verified the job empty before reporting the exit.
    child.treeOutcome = 'empty';
    exitChild(child, 137);
    await settleAndFlush(run);
    assert.equal(isHeld(repo), false, 'released on the verified-empty job');
    assert.equal(tree.state.reads, reads, 'no process-table read at all');
  })
);

test(
  'a contained kill the server never verifies empty stays unknown: the workspace stays held',
  withTimers(async () => {
    const repo = makeRepo();
    const child = containedChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    const reads = tree.state.reads;
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'timeout');
    child.treeOutcome = 'pending';
    exitChild(child, 137);
    await settleAndFlush(run);
    await tick(60_000);
    assert.equal(isHeld(repo), true, 'a root exit is not a verified-empty job');
    assert.equal(records.published.at(-1)?.terminationUnconfirmed, true, 'shown as termination unconfirmed');
    // A late report (the server kept watching the job) still releases it.
    child.treeOutcome = 'empty';
    await tick(5_000);
    assert.equal(isHeld(repo), false);
    assert.equal(tree.state.reads, reads);
  })
);

// Finding 1: the cancel reached the server only after the root had exited on
// its own and its tree was settled, so the server kept the survivors in their
// job. The process table then says nothing reliable about them: the root's
// pid may already name another process. Kernel creation times (FILETIME).
const ROOT_CREATED = '134000000000000000';
const LATER = (seconds) => String(BigInt(ROOT_CREATED) + BigInt(seconds) * 10_000_000n);

async function cancelRacingNaturalExit(repo, rows) {
  const child = Object.assign(containedChild(), { creationTime: ROOT_CREATED });
  const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
  let kills = 0;
  child.kill = () => {
    kills += 1;
    return true;
  };
  tree.state.kills.length = 0;
  tree.state.next = () => processTable(rows);
  const reads = tree.state.reads;
  run.settle = createSettle(run, () => {});
  treeKillForceSettle(run, 'cancellation');
  child.treeOutcome = 'preserved';
  exitChild(child, 0);
  await settleAndFlush(run);
  return { child, run, kills: () => kills, reads: () => tree.state.reads - reads };
}

test(
  'a reused root pid never hides a kept survivor: held until the server verified the job empty',
  withTimers(async () => {
    const repo = makeRepo();
    // ROOT now names an unrelated process; 4510 is our root's real survivor.
    const raced = await cancelRacingNaturalExit(repo, [
      { pid: ROOT, token: LATER(5) },
      { pid: 4510, ppid: ROOT, token: LATER(1) },
    ]);
    await tick(60_000);
    assert.equal(isHeld(repo), true, 'never released on a table read');
    assert.equal(raced.kills(), 2, 'the kill is re-sent to the kept job');
    raced.child.treeOutcome = 'empty';
    await tick(5_000);
    assert.equal(isHeld(repo), false, 'released once the job is verified empty');
    assert.equal(raced.reads(), 0, 'no process table consulted');
  })
);

test(
  'the dangling children of a reused root pid are never swept as the kept survivors',
  withTimers(async () => {
    const repo = makeRepo();
    // The pid's later owner exited too; 4530 is ITS child, created after our root.
    const raced = await cancelRacingNaturalExit(repo, [{ pid: 4530, ppid: ROOT, token: LATER(3) }]);
    await tick(60_000);
    assert.deepEqual(tree.state.kills, [], 'no process is killed by pid');
    assert.equal(isHeld(repo), true);
    assert.equal(raced.reads(), 0);
    raced.child.treeOutcome = 'empty';
    await tick(5_000);
    assert.equal(isHeld(repo), false);
  })
);

test(
  'kept survivors the server lets go unverified stay unconfirmed: never gone',
  withTimers(async () => {
    const repo = makeRepo();
    const raced = await cancelRacingNaturalExit(repo, []);
    raced.child.treeOutcome = 'released';
    await tick(60_000);
    assert.equal(isHeld(repo), true);
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'session' })).released,
      true
    );
    assert.equal(isHeld(repo), false);
    assert.equal(raced.reads(), 0);
  })
);

// Finding 2: the server stopped verifying a killed job it could not empty.
test(
  'a contained kill the server gives up verifying is never gone: held as unconfirmed until a force-release',
  withTimers(async () => {
    const repo = makeRepo();
    const child = containedChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    const reads = tree.state.reads;
    let treeSettled = false;
    run.settle = createSettle(run, () => {});
    treeKillForceSettle(run, 'timeout');
    child.treeOutcome = 'pending';
    exitChild(child, 137);
    await settleAndFlush(run);
    void run.treeSettled.then(() => (treeSettled = true));
    child.treeOutcome = 'unverified';
    await tick(60_000);
    assert.equal(isHeld(repo), true);
    assert.equal(records.published.at(-1)?.terminationUnconfirmed, true, 'shown as termination unconfirmed');
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'session' })).released,
      true,
      'its owner can still force-release it'
    );
    await flush();
    assert.equal(isHeld(repo), false);
    await tick(60_000);
    assert.equal(treeSettled, false, 'never reported terminated');
    assert.equal(tree.state.reads, reads, 'no process table stands in for the missing verification');
  })
);

test(
  'a session close cancels a contained foreground tree without waiting for a snapshot',
  withTimers(async () => {
    const repo = makeRepo();
    const child = containedChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.killed = false;
    run.foregroundRecordId = 'job_contained_close';
    tree.state.next = () => new Promise(() => {});
    registerForegroundOwnedTree(run, 'sess_contained_close');
    const outcome = cancelOwnedShellTrees('sess_contained_close');
    assert.equal(typeof outcome?.then, 'undefined', 'sent at once, not after a snapshot');
    assert.equal(run.killed, true);
    assert.equal(run.terminationTracker.contained, true);
  })
);

test(
  'a force-release drops the hold but the live tree is not reported settled until it exits',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.foregroundRecordId = 'job_force_live';
    const survivor = { pid: 4420, ppid: ROOT, token: 'worker' };
    await capturedBeforeKill(run, [{ pid: ROOT }, survivor]);
    exitChild(child, 137);
    tree.state.next = () => processTable([{ ...survivor, ppid: 1 }]);
    let result;
    run.resolveResult = (value) => {
      result = value;
    };
    await settleAndFlush(run);
    let ended = false;
    void result.settled.then(() => {
      ended = true;
    });
    assert.deepEqual(await forceReleaseTerminationHold('job_force_live', { callerSessionId: 'session' }), {
      released: true,
    });
    assert.equal(isHeld(repo), false);
    const reads = tree.state.reads;
    await tick(5_000);
    assert.ok(tree.state.reads > reads, 'the tree is still observed');
    assert.equal(ended, false, 'the worker still runs');
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(ended, true);
  })
);

test(
  'after a force-release a permanently unknown tree ends the watch without settling it',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.foregroundRecordId = 'job_force_blind';
    // No pre-kill capture: the exited root's tree can never be confirmed.
    exitChild(child, 137);
    tree.state.next = () => processTable([]);
    let result;
    run.resolveResult = (value) => {
      result = value;
    };
    await settleAndFlush(run);
    let ended = false;
    void result.settled.then(() => {
      ended = true;
    });
    assert.deepEqual(await forceReleaseTerminationHold('job_force_blind', { callerSessionId: 'session' }), {
      released: true,
    });
    assert.equal(isHeld(repo), false);
    await tick(5_000);
    const reads = tree.state.reads;
    await tick(60_000);
    assert.equal(tree.state.reads, reads, 'the watch is disposed');
    assert.equal(ended, false, 'an unconfirmed tree is never reported settled');
  })
);

test(
  'an unconfirmed termination can be force-released only by its owner, and the watch goes on',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    tree.state.next = () => {
      throw new Error('process enumeration denied');
    };
    await settleAndFlush(run);
    assert.equal(isHeld(repo), true);
    assert.equal(records.published.at(-1).terminationUnconfirmed, true);
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'other' })).released,
      false
    );
    assert.equal(isHeld(repo), true);
    assert.deepEqual(await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'session' }), {
      released: true,
    });
    assert.equal(isHeld(repo), false);
    assert.equal(run.workspaceAdmission, null);
    assert.deepEqual(records.retired, ['job_unconfirmed_kill']);
    const reads = tree.state.reads;
    await tick(30_000);
    assert.ok(tree.state.reads > reads, 'a force-release does not end the observation');
    assert.equal(
      (await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'session' })).released,
      false
    );
  })
);

test(
  'session close snapshots a foreground tree before its kill and holds the folder until it is gone',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.killed = false;
    run.foregroundRecordInput.ownerSessionId = 'closing-fg';
    registerForegroundOwnedTree(run, 'closing-fg');
    tree.state.next = () => processTable([{ pid: ROOT }, { pid: 4300, ppid: ROOT }, { pid: 4301, ppid: 4300 }]);
    const cancel = cancelOwnedShellTrees('closing-fg');
    assert.equal(typeof cancel.then, 'function', 'the cancel waits for the pending snapshot');
    await cancel;
    assert.equal(run.ownerCancelled, true);
    assert.equal(run.terminationTracker.complete, true, 'identities were recorded before the kill');
    // The kill took the root and the intermediate: the grandchild's parent
    // link now dangles, so only the snapshot still knows it.
    exitChild(child);
    tree.state.next = () => processTable([{ pid: 4301, ppid: 4300 }]);
    await settleAndFlush(run);
    assert.equal(isHeld(repo), true, 'the orphaned grandchild keeps the folder held');
    assert.equal(records.published.at(-1)?.terminationUnconfirmed, true);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(isHeld(repo), false);
    assert.deepEqual(records.retired, ['job_unconfirmed_kill']);
  })
);

test(
  'session close sends the kill within the bound even when the snapshot read hangs',
  withTimers(async () => {
    const run = { settled: false, autoBackgrounded: false, foregroundRecordId: 'job_hang', child: runningChild() };
    registerForegroundOwnedTree(run, 'closing-hang');
    tree.state.next = () => new Promise(() => {});
    let sent = false;
    void cancelOwnedShellTrees('closing-hang').then(() => {
      sent = true;
    });
    await tick(PROCESS_TABLE_READ_BOUND_MS - 1);
    assert.equal(sent, false);
    await tick(1);
    assert.equal(sent, true, 'the cancel is sent at the bound');
    assert.equal(run.terminationTracker.complete, false, 'no snapshot: the outcome stays unknown');
  })
);

test(
  'a closed session without a pre-kill snapshot keeps an unlinked survivor unconfirmed until explicit release',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.killed = false;
    run.foregroundRecordId = 'job_closed_blind';
    run.foregroundRecordInput.ownerSessionId = 'closing-blind';
    registerForegroundOwnedTree(run, 'closing-blind');
    tree.state.next = () => new Promise(() => {});
    const cancel = cancelOwnedShellTrees('closing-blind');
    await tick(PROCESS_TABLE_READ_BOUND_MS);
    await cancel;
    noteShellOwnerSessionClosed('closing-blind');
    assert.equal(run.terminationTracker.complete, false);
    exitChild(child, 137);
    tree.state.next = () => processTable([{ pid: 4501, ppid: 1, token: 'detached-worker', pgid: 4501 }]);
    await settleAndFlush(run);
    await flush();
    assert.equal(run.terminationTracker.complete, false, 'session close cannot supply the missing snapshot');
    assert.equal(isHeld(repo), true, 'no known survivor is not proof that the tree is gone');
    assert.equal(records.published.at(-1)?.terminationUnconfirmed, true);
    assert.deepEqual(records.retired, []);
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(isHeld(repo), true, 'an empty later table also cannot recover the lost parent link');
    assert.deepEqual(
      await forceReleaseTerminationHold('job_closed_blind', { callerSessionId: 'viewer', callerCwd: repo }),
      { released: true }
    );
    assert.equal(isHeld(repo), false);
    assert.deepEqual(records.retired, ['job_closed_blind']);
    await tick(5_000);
    const reads = tree.state.reads;
    await tick(30_000);
    assert.equal(tree.state.reads, reads, 'a snapshot that can never complete ends the observation');
  })
);

test(
  'a closed session’s tree without a snapshot still sweeps what stays linked to its root',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.killed = false;
    run.foregroundRecordId = 'job_closed_linked';
    run.foregroundRecordInput.ownerSessionId = 'closing-linked';
    registerForegroundOwnedTree(run, 'closing-linked');
    tree.state.next = () => new Promise(() => {});
    const cancel = cancelOwnedShellTrees('closing-linked');
    await tick(PROCESS_TABLE_READ_BOUND_MS);
    await cancel;
    noteShellOwnerSessionClosed('closing-linked');
    exitChild(child, 137);
    const worker = { pid: 4500, ppid: ROOT, token: 'worker' };
    tree.state.next = () => processTable([worker]);
    tree.state.kills.length = 0;
    await settleAndFlush(run);
    await flush();
    assert.deepEqual(tree.state.kills, [4500], 'the linked survivor is killed');
    assert.equal(isHeld(repo), true, 'held while it still runs');
    tree.state.next = () => processTable([]);
    await tick(5_000);
    assert.equal(run.terminationTracker.complete, false);
    assert.equal(isHeld(repo), true, 'sweeping known survivors cannot prove the incomplete tree is gone');
    assert.deepEqual(records.retired, []);
    assert.deepEqual(
      await forceReleaseTerminationHold('job_closed_linked', { callerSessionId: 'viewer', callerCwd: repo }),
      { released: true }
    );
    assert.equal(isHeld(repo), false);
    assert.deepEqual(records.retired, ['job_closed_linked']);
  })
);

test(
  'a closed session’s hold is releasable from any session that sees its workspace',
  withTimers(async () => {
    const repo = makeRepo();
    const elsewhere = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    run.foregroundRecordInput.ownerSessionId = 'closing-owner';
    tree.state.next = () => {
      throw new Error('process enumeration denied');
    };
    await settleAndFlush(run);
    const release = (callerCwd) =>
      forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'viewer', callerCwd });
    assert.equal((await release(repo)).released, false, 'the owner is still open');
    noteShellOwnerSessionClosed('closing-owner');
    assert.equal((await release(elsewhere)).released, false, 'another workspace cannot release it');
    assert.equal(isHeld(repo), true);
    assert.deepEqual(await release(repo), { released: true });
    assert.equal(isHeld(repo), false);
    const reads = tree.state.reads;
    await tick(30_000);
    assert.ok(tree.state.reads > reads, 'a force-release does not end the observation');
  })
);

test(
  'a release requested from another process is honoured at the next observation pass',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    tree.state.next = () => {
      throw new Error('process enumeration denied');
    };
    await settleAndFlush(run);
    const jobsDir = join(process.env.MIXDOG_DATA_DIR, 'shell-jobs');
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(join(jobsDir, 'job_unconfirmed_kill.release-requested'), '');
    assert.equal(isHeld(repo), true, 'nothing is released before the pass');
    await tick(5_000);
    assert.equal(isHeld(repo), false);
    assert.equal(existsSync(join(jobsDir, 'job_unconfirmed_kill.release-requested')), false, 'the request is consumed');
    const reads = tree.state.reads;
    await tick(30_000);
    assert.ok(tree.state.reads > reads, 'a force-release does not end the observation');
  })
);

test('a hold held by another process is released by request, only from a session that sees it', async () => {
  const repo = makeRepo();
  const elsewhere = makeRepo();
  const jobsDir = join(process.env.MIXDOG_DATA_DIR, 'shell-jobs');
  mkdirSync(jobsDir, { recursive: true });
  const record = { status: 'running', terminationUnconfirmed: true, ownerSessionId: 'shard-owner', cwd: repo };
  writeFileSync(join(jobsDir, 'job_remote_hold.json'), JSON.stringify(record));
  const release = (callerCwd) =>
    forceReleaseTerminationHold('job_remote_hold', { callerSessionId: 'viewer', callerCwd });
  assert.equal((await release(repo)).released, false, 'its owner session is still open');
  writeFileSync(join(jobsDir, 'job_remote_hold.json'), JSON.stringify({ ...record, ownerSessionClosed: true }));
  assert.equal((await release(elsewhere)).released, false);
  const marker = join(jobsDir, 'job_remote_hold.release-requested');
  assert.equal(existsSync(marker), false);
  assert.equal((await release(join(repo, 'src'))).released, true);
  assert.equal(existsSync(marker), true, 'the owning process sees the request at its next pass');
});

// On POSIX the descendant probe first asks the kernel whether the command's
// process group still has members, and the scripted root pid names no real
// group — so the probe would answer "nothing left" before ever reading the
// (scripted) process table. The scripted root's group is declared alive, so
// every platform reaches the table read these tests exercise.
function withLiveRootGroup(body) {
  return async () => {
    const realKill = process.kill;
    const spy = mock.method(process, 'kill', (pid, signal) =>
      pid === -ROOT && signal === 0 ? true : realKill.call(process, pid, signal)
    );
    try {
      await body();
    } finally {
      spy.mock.restore();
    }
  };
}

test(
  'an ordinary exit whose descendant probe fails stays visible, held, and releasable',
  withLiveRootGroup(
    withTimers(async () => {
      const repo = makeRepo();
      const child = runningChild();
      const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
      run.killed = false;
      let result = null;
      run.resolveResult = (value) => {
        result = value;
      };
      exitChild(child, 0);
      tree.state.next = () => {
        throw new Error('process enumeration denied');
      };
      await createSettle(run, () => {})(0, null);
      await flush();
      assert.ok(result, 'the command still returns');
      assert.equal(result.exitCode, 1);
      assert.equal(isHeld(repo), true, 'unverified descendants keep the folder held');
      assert.equal(records.published.at(-1)?.terminationUnconfirmed, true, 'the record is kept, marked unconfirmed');
      assert.equal(records.published.at(-1)?.jobId, 'job_unconfirmed_kill');
      const retiredBefore = records.retired.length;
      assert.deepEqual(await forceReleaseTerminationHold('job_unconfirmed_kill', { callerSessionId: 'session' }), {
        released: true,
      });
      assert.equal(isHeld(repo), false);
      assert.equal(run.workspaceAdmission, null);
      assert.equal(records.retired.length, retiredBefore + 1, 'the release retires the kept record');
      const reads = tree.state.reads;
      await tick(30_000);
      assert.ok(tree.state.reads > reads, 'a force-release does not end the observation');
    })
  )
);

test(
  'an ordinary exit whose descendant probe fails is released once a later pass confirms nothing remains',
  withLiveRootGroup(
    withTimers(async () => {
      const repo = makeRepo();
      const child = runningChild();
      const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
      run.killed = false;
      exitChild(child, 0);
      let failures = 2;
      tree.state.next = () => {
        if (failures-- > 0) throw new Error('process enumeration denied');
        return processTable([]);
      };
      await createSettle(run, () => {})(0, null);
      await flush();
      assert.equal(isHeld(repo), true);
      const retiredBefore = records.retired.length;
      await tick(5_000);
      assert.equal(isHeld(repo), false, 'the termination watch confirms and releases');
      assert.equal(records.retired.length, retiredBefore + 1);
    })
  )
);

// Windows keeps a dead parent's pid in its children's parent links and hands
// that pid to the next process. A command whose root got it exits before any
// table read sees it: the spawn's kernel creation time still tells that older
// process apart, so it is not adopted as a survivor holding the folder.
test(
  'a finished command releases its workspace past an older process whose dangling parent link names its pid',
  { skip: process.platform !== 'win32' },
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    child.creationTime = '134062416010000000';
    const { run } = unconfirmedRun(repo, child, { killUnconfirmed: false });
    run.killed = false;
    let result = null;
    run.resolveResult = (value) => {
      result = value;
    };
    exitChild(child, 0);
    tree.state.next = () => processTable([{ pid: 4500, ppid: ROOT, token: '134062416005000000', name: 'soffice.bin' }]);
    await createSettle(run, () => {})(0, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.descendants, null);
    assert.equal(isHeld(repo), false);
  })
);

test(
  'descendants that cannot be verified keep the reservation',
  withTimers(async () => {
    const repo = makeRepo();
    const child = runningChild();
    const { run } = unconfirmedRun(repo, child);
    tree.state.next = () => {
      throw new Error('process enumeration denied');
    };
    await settleAndFlush(run);
    exitChild(child);
    await tick(15_000);
    assert.equal(isHeld(repo), true);
    assert.equal(typeof run.workspaceAdmission, 'function');
    assert.deepEqual(records.retired, []);
    run.stopTerminationWatch();
  })
);
