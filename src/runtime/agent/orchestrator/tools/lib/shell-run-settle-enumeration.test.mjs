import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';

// The real process-table reader runs; only the OS enumerator it starts on the
// process-runner worker is replaced, by one that never answers until the
// runner kills it at its deadline (ETIMEDOUT, as run-child.mjs does).
const enumerators = [];
mock.module('../../../../shared/process-runner.mjs', {
  namedExports: {
    runProcessOffThread: (_command, _args, { timeoutMs }) => {
      const child = { alive: true, timeoutMs };
      enumerators.push(child);
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          child.alive = false;
          reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
        }, timeoutMs);
      });
    },
  },
});
const records = { published: [], retired: [] };
mock.module('../builtin/shell-jobs.mjs', {
  namedExports: {
    publishForegroundShellRecord: (input) => records.published.push(input),
    retireForegroundShellRecord: (jobId) => records.retired.push(jobId),
  },
});
const { ENUMERATION_DEADLINE_MS } = await import('../../mcp/child-tree.mjs');
const { createSettle } = await import('./shell-run-settle.mjs');
const { forceReleaseTerminationHold } = await import('../builtin/lib/shell-job-records.mjs');

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

// The POSIX probe answers from the process group first and never enumerates
// for a group that is gone; the hung enumerator is a Windows settle path.
test('a hung enumerator is killed at the deadline and the finished command still returns, releasable', {
  skip: process.platform !== 'win32' && 'requires Windows: POSIX settles from the process group and never enumerates',
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: 0, signalCode: null });
  let result = null;
  const run = {
    child,
    killed: false,
    killUnconfirmed: false,
    settled: false,
    autoBackgrounded: false,
    foregroundRecordId: 'job_hung_enumerator',
    foregroundRecordPublished: true,
    foregroundRecordInput: { command: 'node build.js', cwd: repo, ownerSessionId: 'session' },
    commandStartedAtMs: 1,
    workspaceAdmission: tryAdmitWorkspaceActivity('session', repo, { kind: 'command' }),
    resourceLease: null,
    stdoutDecoder: { end: () => '' },
    stderrDecoder: { end: () => '' },
    taskOutput: {
      spilled: false,
      getStdout: async () => 'done',
      getStderr: async () => '',
      closeFds() {},
      writeStdout() {},
      writeStderr() {},
    },
    resolveResult(value) {
      result = value;
    },
  };
  const settled = createSettle(run, () => {})(0, null);
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(enumerators.length, 1, 'the post-exit probe is enumerating');
  assert.equal(result, null, 'held only by the hung enumerator');
  t.mock.timers.tick(ENUMERATION_DEADLINE_MS);
  await settled;
  assert.ok(result, 'the command returns once the deadline passes');
  assert.equal(result.stdout, 'done');
  assert.equal(enumerators[0].timeoutMs, ENUMERATION_DEADLINE_MS, 'the runner kills the hung enumerator');
  assert.equal(enumerators[0].alive, false);
  assert.equal(isHeld(repo), true, 'unverified descendants keep the folder held');
  assert.equal(records.published.at(-1)?.terminationUnconfirmed, true);
  // The termination watch's own pass is bounded the same way.
  await flush();
  t.mock.timers.tick(ENUMERATION_DEADLINE_MS);
  await flush();
  assert.equal(enumerators.filter((enumerator) => enumerator.alive).length, 0, 'no enumerator is left running');
  assert.deepEqual(await forceReleaseTerminationHold('job_hung_enumerator', { callerSessionId: 'session' }), {
    released: true,
  });
  assert.equal(isHeld(repo), false);
  assert.equal(run.workspaceAdmission, null);
});
