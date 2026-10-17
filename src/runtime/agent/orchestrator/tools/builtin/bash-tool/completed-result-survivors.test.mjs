import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { holdWorkspaceActivity, tryAdmitWorkspaceActivity } from '../../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../../shared/worktrees/test-support.mjs';
import { processTable, scriptedChildTree } from '../../lib/process-table-fixture.mjs';

const tree = scriptedChildTree();
mock.module('../../../mcp/child-tree.mjs', { namedExports: tree.namedExports });
const { renderCompletedResult } = await import('./completed-result.mjs');
const { adoptShellWorkspaceAdmission } = await import('../lib/shell-job-records.mjs');

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

// A finished foreground command hands its folder reservation to the processes
// it left running; the reservation must end with the last of them.
test('the folder reservation handed to survivors is released once they are gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const repo = makeRepo();
  const jobId = 'job_survivor_handoff';
  adoptShellWorkspaceAdmission(jobId, tryAdmitWorkspaceActivity('session', repo, { kind: 'command' }));
  const survivor = { pid: process.pid, ppid: 1, token: 'survivor' };
  tree.state.next = () => processTable([survivor]);
  renderCompletedResult({
    result: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      descendants: {
        taskId: jobId,
        rootPid: 7100,
        groupPid: null,
        killPids: [process.pid],
        watchPids: [process.pid],
        watch: [{ pid: process.pid, token: 'survivor', name: 'node.exe' }],
        reachable: true,
      },
    },
    command: 'node server.js',
    analysisCommand: 'node server.js',
    cwd: repo,
    options: { sessionId: 'session' },
    startedAtMs: Date.now(),
    stdout: '',
    stderr: '',
    timeout: 0,
  });
  await flush();
  assert.equal(isHeld(repo), true, 'the survivor still runs');
  tree.state.next = () => processTable([]);
  t.mock.timers.tick(5_000);
  await flush();
  await flush();
  assert.equal(isHeld(repo), false);
});
