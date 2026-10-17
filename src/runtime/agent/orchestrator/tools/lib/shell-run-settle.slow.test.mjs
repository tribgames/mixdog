import './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../shared/worktrees/test-support.mjs';
import { createProcessTreeTracker } from './shell-descendants.mjs';
import { createSettle } from './shell-run-settle.mjs';

after(cleanupTempDirs);

// A real child and the real descendant observation: the reservation of a run
// whose kill was never confirmed ends with the process, not before.
test('an unconfirmed kill keeps the folder reserved until the real child has exited', { timeout: 60000 }, async (t) => {
  const repo = makeRepo();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const exited = once(child, 'exit');
  const run = {
    child,
    killed: true,
    killUnconfirmed: true,
    foregroundRecordId: 'job_real_unconfirmed_kill',
    workspaceAdmission: tryAdmitWorkspaceActivity('session', repo, { kind: 'command', pid: child.pid }),
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
  // The kill path records the tree's identities while the root still runs.
  run.terminationTracker = createProcessTreeTracker({ pid: child.pid });
  assert.equal(await run.terminationTracker.capture(), true);
  await createSettle(run, () => {})(1, 'SIGKILL');
  assert.throws(() => holdWorkspaceActivity([repo]), { code: 'WORKTREE_BUSY_JOBS' });
  child.kill();
  await exited;
  for (let attempt = 0; run.workspaceAdmission && attempt < 300; attempt++) await delay(100);
  assert.equal(run.workspaceAdmission, null);
  holdWorkspaceActivity([repo])();
});
