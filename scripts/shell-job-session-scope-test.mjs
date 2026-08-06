// Background shell jobs must be attributed to the SESSION that dispatched
// them, not only to the owning host process. A pooled host (the desktop keeps
// every pane's engine in one process) otherwise shows one session's running
// shell on every other pane — including a blank New task pane.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-shell-jobs-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const jobsDir = join(dataDir, 'shell-jobs');
mkdirSync(jobsDir, { recursive: true });

// This process is the owner: its pid is alive, so every record passes the
// liveness filter without spawning anything.
const ownerPid = process.pid;
function writeJob(jobId, ownerSessionId, pid = ownerPid) {
  writeFileSync(join(jobsDir, `${jobId}.json`), JSON.stringify({
    jobId,
    kind: 'bash',
    status: 'running',
    command: 'sleep 60',
    pid,
    ownerHostPid: ownerPid,
    ...(ownerSessionId ? { ownerSessionId } : {}),
  }), 'utf-8');
  writeFileSync(join(jobsDir, `${jobId}.owner-${ownerPid}`), '', 'utf-8');
}

writeJob('job_1700000000001_aaaaaa', 'session-a');
writeJob('job_1700000000002_bbbbbb', 'session-a');
writeJob('job_1700000000003_cccccc', 'session-b');
writeJob('job_1700000000004_dddddd', null); // legacy record: no session stamp

const { shellJobsStatus } = await import('../src/ui/statusline-segments.mjs');

// The segment is cache-only on the render path: the first call kicks the
// background refresh, so settle before asserting.
async function settledAggregate() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = shellJobsStatus({ clientHostPid: ownerPid });
    if (value.count === 4) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('shell-jobs segment never observed the staged jobs');
}

test('shell job counts bucket by the session that dispatched them', async () => {
  const aggregate = await settledAggregate();
  assert.equal(aggregate.count, 4, 'the owner aggregate keeps counting every live job');
  // Sub-second jobs render no label; the field must still be a string.
  assert.equal(typeof aggregate.elapsedLabel, 'string');
  assert.equal(typeof aggregate.sessions['session-a'].elapsedLabel, 'string');

  assert.equal(shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'session-a' }).count, 2);
  assert.equal(shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'session-b' }).count, 1);
  assert.equal(shellJobsStatus({ clientHostPid: ownerPid, sessionId: 'session-c' }).count, 0,
    "a session that started nothing must not inherit another session's shell");
  assert.equal(shellJobsStatus({ clientHostPid: ownerPid, sessionId: '' }).count, 0,
    'a blank (New task) scope owns no jobs');
});

test('an unstamped job belongs to no session bucket', async () => {
  const aggregate = await settledAggregate();
  const bucketed = Object.values(aggregate.sessions)
    .reduce((total, bucket) => total + bucket.count, 0);
  assert.equal(bucketed, 3, 'the legacy record stays out of every session bucket');
});

test('an unknown owner pid reports nothing', () => {
  assert.equal(shellJobsStatus({ clientHostPid: 0 }).count, 0);
  assert.equal(shellJobsStatus({ clientHostPid: 0, sessionId: 'session-a' }).count, 0);
});

// A shell job belongs to the session that dispatched it. The registries are
// process-global, so a NON-exit dispose (daemon engine swap / adopted
// placeholder / idle eviction) must reap only its own session's jobs — an
// unscoped sweep force-killed another session's running build and, cancelling
// with notify:false, swallowed its completion (user report).
test('a non-exit dispose reaps only the disposing session shell jobs', async () => {
  const { _registerLiveJobPid, _unregisterLiveJobPid } = await import(
    '../src/runtime/agent/orchestrator/tools/builtin/shell-job-process.mjs');
  const { shutdownShellJobs } = await import(
    '../src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs');
  const { readShellJobDetail } = await import(
    '../src/runtime/agent/orchestrator/tools/builtin/shell-job-paths.mjs');
  // Unused pids: the reap DECISION is under test, and no unit test may signal
  // a real process tree.
  const pidA = 999_000_001;
  const pidB = 999_000_002;
  const jobA = 'job_1700000000011_eeeeee';
  const jobB = 'job_1700000000012_ffffff';
  writeJob(jobA, 'session-a', pidA);
  writeJob(jobB, 'session-b', pidB);
  _registerLiveJobPid(pidA, jobA);
  _registerLiveJobPid(pidB, jobB);
  try {
    const reaped = shutdownShellJobs('desktop-engine-dispose', {
      scope: { ownerSessionId: 'session-a' },
    });
    assert.equal(reaped.killed, 1, 'only the disposing session job is killed');
    assert.equal(reaped.cancelledJobs, 1);
    assert.equal(readShellJobDetail(jobA).status, 'cancelled');
    assert.equal(readShellJobDetail(jobB).status, 'running',
      "another session's job must survive an engine dispose");

    // An unattributable dispose (empty placeholder engine) reaps NOTHING.
    const blank = shutdownShellJobs('desktop-engine-dispose', { scope: { ownerSessionId: '' } });
    assert.equal(blank.killed, 0);
    assert.equal(blank.cancelledJobs, 0);
    assert.equal(readShellJobDetail(jobB).status, 'running');
  } finally {
    _unregisterLiveJobPid(pidA);
    _unregisterLiveJobPid(pidB);
  }
});
