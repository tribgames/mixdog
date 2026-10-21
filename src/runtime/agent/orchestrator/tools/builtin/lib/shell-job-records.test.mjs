import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  _shellJobRecordWritesSettledForTest,
  completeShellJobRecord,
  listShellJobRecords,
  publishShellJobRecord,
  readShellJobRecord,
  retireShellJobRecord,
} from './shell-job-records.mjs';
import { holdWorkspaceActivity } from '../../../../../shared/worktrees/activity-gate.mjs';
import { cleanupTempDirs, makeRepo } from '../../../../../shared/worktrees/test-support.mjs';
import { executeTaskTool } from '../task-tool.mjs';
import { shellJobsStatus } from '../../../../../shared/statusline/statusline-segments.mjs';

// The reader caches for 1s and refreshes in the background, so a probe polls
// until the scan lands instead of assuming the first call is populated.
async function readStatus(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = shellJobsStatus({ clientHostPid: process.pid });
    if (predicate(value)) return value;
    await delay(60);
  }
  return shellJobsStatus({ clientHostPid: process.pid });
}

test('a running shell job publishes a record the statusline reader counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shell-records-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    publishShellJobRecord(
      {
        jobId: 'job_probe_1',
        pid: process.pid,
        command: 'sleep 30',
        cwd: root,
        startedAt: new Date().toISOString(),
      },
      { ownerSessionId: 'sess-probe', clientHostPid: process.pid }
    );

    const running = await readStatus((value) => value.count > 0);
    assert.equal(running.count, 1);
    assert.equal(running.jobs[0].command, 'sleep 30');
    assert.equal(running.sessions['sess-probe'].count, 1);
    // Pane scope: the desktop chip asks for one session's own bucket.
    assert.equal(shellJobsStatus({ clientHostPid: process.pid, sessionId: 'sess-probe' }).count, 1);
    assert.equal(shellJobsStatus({ clientHostPid: process.pid, sessionId: 'other' }).count, 0);

    retireShellJobRecord('job_probe_1');
    const settled = await readStatus((value) => value.count === 0);
    assert.equal(settled.count, 0);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a NUL-filled job record is no record, even for a strict reader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shell-records-nul-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    mkdirSync(join(root, 'shell-jobs'), { recursive: true });
    writeFileSync(join(root, 'shell-jobs', 'job_nul.json'), '\0'.repeat(40));
    assert.equal(await readShellJobRecord('job_nul', { strict: true }), null);
    assert.deepEqual(await listShellJobRecords({ strict: true }), []);
    // Beside a readable record the NUL one is skipped, not listed or fatal.
    writeFileSync(
      join(root, 'shell-jobs', 'job_ok.json'),
      JSON.stringify({ jobId: 'job_ok', status: 'running', cwd: root, recordedAt: new Date().toISOString() })
    );
    assert.deepEqual(
      (await listShellJobRecords({ strict: true })).map((record) => record.jobId),
      ['job_ok']
    );
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a completed shell job remains owner-scoped and recoverable after memory loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shell-records-terminal-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const jobId = `job_terminal_${process.pid}`;
  try {
    publishShellJobRecord(
      {
        jobId,
        pid: process.pid,
        command: 'node --version',
        cwd: root,
        startedAt: new Date(Date.now() - 100).toISOString(),
      },
      { ownerSessionId: 'sess-owner', clientHostPid: process.pid }
    );
    assert.equal(
      await completeShellJobRecord(jobId, {
        status: 'failed',
        exitCode: 2,
        command: 'node --version',
        cwd: root,
        ownerSessionId: 'sess-owner',
        stdoutPreview: 'version output',
        finishedAt: new Date().toISOString(),
      }),
      true
    );
    const record = await readShellJobRecord(jobId);
    assert.equal(record.status, 'failed');
    assert.equal(record.exitCode, 2);
    assert.equal(record.ownerSessionId, 'sess-owner');
    assert.equal(record.terminal, true);
    assert.ok((await listShellJobRecords()).some((item) => item.jobId === jobId));
    assert.match(
      await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId: 'sess-owner' }),
      /recovered: true/
    );
    assert.match(
      await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId: 'sess-other' }),
      /task not found/
    );
    assert.match(
      await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId: 'sess-owner' }),
      /no new output/
    );
    assert.match(
      await executeTaskTool({ action: 'read', task_id: jobId, output: 'tail' }, { sessionId: 'sess-owner' }),
      /version output/
    );
    assert.match(
      await executeTaskTool({ action: 'read', task_id: jobId, output: 'tail' }, { sessionId: 'sess-other' }),
      /task not found/
    );
  } finally {
    retireShellJobRecord(jobId);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── foreground retire vs. background promote ────────────────────────────────
// A promoted job keeps the foreground job's id, so the foreground marker's
// retire and the promoted job's publish address the SAME `<id>.json` /
// `<id>.owner-<pid>` paths. The interleaving is forced, not timed: the stale
// retire is parked inside its filesystem `rm` of the `.json` while the
// promotion publishes, then released.

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return predicate();
}

async function withDataDir(prefix, run) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function holdJsonRemovals(root) {
  const original = fsp.rm;
  const held = [];
  fsp.rm = (path, ...rest) => {
    const target = String(path);
    if (!target.startsWith(root) || !target.endsWith('.json')) return original(path, ...rest);
    return new Promise((resolve, reject) => {
      held.push(() => {
        const done = original(path, ...rest);
        done.then(resolve, reject);
        return done.catch(() => {});
      });
    });
  };
  syncBuiltinESMExports();
  return {
    held,
    release: () => Promise.all(held.splice(0).map((run) => run())),
    restore() {
      fsp.rm = original;
      syncBuiltinESMExports();
    },
  };
}

const jobPaths = (root, jobId) => ({
  json: join(root, 'shell-jobs', `${jobId}.json`),
  owner: join(root, 'shell-jobs', `${jobId}.owner-${process.pid}`),
});

function hasBackgroundRecord(root, jobId) {
  const { json, owner } = jobPaths(root, jobId);
  if (!existsSync(owner)) return false;
  try {
    return JSON.parse(readFileSync(json, 'utf8')).foreground !== true;
  } catch {
    return false;
  }
}

// Mirrors the real promotion: the foreground marker is published, then
// clearForegroundRecord retires it, then (after the registry round trip) the
// promoted job publishes under the same id. Each retire is parked mid-removal.
async function promoteBehindParkedRetire(root, jobIds, { foregroundSettled }) {
  const gate = holdJsonRemovals(root);
  try {
    const host = { ownerSessionId: 'sess-race', clientHostPid: process.pid };
    const task = (jobId) => ({
      jobId,
      pid: process.pid,
      command: `sleep ${jobId}`,
      cwd: root,
      startedAt: new Date().toISOString(),
    });
    for (const jobId of jobIds) publishShellJobRecord(task(jobId), { ...host, foreground: true });
    if (foregroundSettled) {
      assert.ok(
        await waitFor(() => jobIds.every((jobId) => existsSync(jobPaths(root, jobId).owner)), 2000),
        'foreground markers land before the promotion'
      );
    }
    for (const jobId of jobIds) {
      retireShellJobRecord(jobId);
      publishShellJobRecord(task(jobId), host);
    }
    assert.ok(
      await waitFor(() => gate.held.length === jobIds.length, 2000),
      'every foreground retire reaches its removal'
    );
    // An unordered promotion publish lands inside this window; an ordered one
    // is still queued behind the parked retire and never does.
    await waitFor(() => jobIds.every((jobId) => hasBackgroundRecord(root, jobId)), 150);
    await gate.release();
    const missing = [];
    const landed = await waitFor(() => {
      missing.length = 0;
      for (const jobId of jobIds) if (!hasBackgroundRecord(root, jobId)) missing.push(jobId);
      return missing.length === 0;
    }, 2000);
    const onDisk = (jobId) => {
      const { json, owner } = jobPaths(root, jobId);
      return `${jobId} (.json ${existsSync(json) ? 'present' : 'missing'}, owner ${existsSync(owner) ? 'present' : 'missing'})`;
    };
    assert.ok(landed, `promoted job record lost after the foreground retire: ${missing.map(onDisk).join('; ')}`);
  } finally {
    gate.restore();
    await gate.release();
  }
}

for (const foregroundSettled of [true, false]) {
  const phase = foregroundSettled ? 'settled' : 'still publishing';
  test(`a parked foreground retire cannot delete the promoted job record (foreground ${phase})`, async () => {
    await withDataDir('mixdog-shell-records-race-', async (root) => {
      const jobId = `job_race_${foregroundSettled ? 'settled' : 'inflight'}_${process.pid}`;
      try {
        await promoteBehindParkedRetire(root, [jobId], { foregroundSettled });
        const { json, owner } = jobPaths(root, jobId);
        assert.ok(existsSync(json), 'promoted job keeps its .json');
        assert.ok(existsSync(owner), 'promoted job keeps its owner marker');
        assert.equal(JSON.parse(readFileSync(json, 'utf8')).status, 'running');
      } finally {
        retireShellJobRecord(jobId);
      }
    });
  });
}

const TTL_MS = 30 * 60 * 1000;

test('an old completion TTL timer cannot delete a record republished under the same id', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withDataDir('mixdog-shell-records-ttl-republish-', async (root) => {
    const jobId = `job_ttl_republish_${process.pid}`;
    const { json, owner } = jobPaths(root, jobId);
    const task = { jobId, pid: process.pid, command: 'sleep 1', cwd: root };
    try {
      publishShellJobRecord(task, { ownerSessionId: 'sess-ttl' });
      assert.equal(await completeShellJobRecord(jobId, { status: 'completed', exitCode: 0 }), true);
      publishShellJobRecord(task, { ownerSessionId: 'sess-ttl' });
      assert.ok(await waitFor(() => existsSync(owner), 2000), 'the republished record landed');
      t.mock.timers.tick(TTL_MS);
      await delay(100);
      assert.ok(existsSync(json), 'the stale timer left the new .json alone');
      assert.ok(existsSync(owner), 'the stale timer left the new owner marker alone');
      assert.equal(JSON.parse(readFileSync(json, 'utf8')).status, 'running');
    } finally {
      retireShellJobRecord(jobId);
    }
  });
});

test('the newest completion owns expiry and removes its files after the TTL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withDataDir('mixdog-shell-records-ttl-expire-', async (root) => {
    const jobId = `job_ttl_expire_${process.pid}`;
    const { json } = jobPaths(root, jobId);
    publishShellJobRecord({ jobId, pid: process.pid, command: 'sleep 1', cwd: root });
    await completeShellJobRecord(jobId, { status: 'completed', exitCode: 0 });
    await completeShellJobRecord(jobId, { status: 'completed', exitCode: 1 });
    assert.ok(existsSync(json));
    t.mock.timers.tick(TTL_MS);
    assert.ok(await waitFor(() => !existsSync(json), 2000), 'the current incarnation expired');
  });
});

test('a failed terminal-record write still releases the workspace admission', async () => {
  await withDataDir('mixdog-shell-records-write-fail-', async (root) => {
    const repo = makeRepo();
    const jobId = `job_write_fail_${process.pid}`;
    const isHeld = () => {
      try {
        holdWorkspaceActivity([repo])();
        return false;
      } catch (error) {
        assert.equal(error.code, 'WORKTREE_BUSY_JOBS');
        return true;
      }
    };
    try {
      publishShellJobRecord({ jobId, pid: process.pid, command: 'sleep 1', cwd: repo }, { ownerSessionId: 'sess-w' });
      await _shellJobRecordWritesSettledForTest(jobId);
      assert.equal(isHeld(), true);
      // The records directory becomes unwritable: every terminal write fails.
      rmSync(join(root, 'shell-jobs'), { recursive: true, force: true });
      writeFileSync(join(root, 'shell-jobs'), '');
      assert.equal(await completeShellJobRecord(jobId, { status: 'completed', exitCode: 0 }), false);
      assert.equal(isHeld(), false, 'the admission does not depend on the record write');
    } finally {
      retireShellJobRecord(jobId);
      await _shellJobRecordWritesSettledForTest(jobId);
      cleanupTempDirs();
    }
  });
});

test('three concurrent promotions are all visible to shellJobsStatus', async () => {
  await withDataDir('mixdog-shell-records-concurrent-', async (root) => {
    const jobIds = [1, 2, 3].map((n) => `job_concurrent_${n}_${process.pid}`);
    try {
      await promoteBehindParkedRetire(root, jobIds, { foregroundSettled: false });
      for (const jobId of jobIds) {
        const { json, owner } = jobPaths(root, jobId);
        assert.ok(existsSync(json), `${jobId} keeps its .json`);
        assert.ok(existsSync(owner), `${jobId} keeps its owner marker`);
      }
      const status = await readStatus((value) => value.count === 3);
      assert.equal(status.count, 3);
      assert.deepEqual(status.jobs.map((job) => job.taskId).sort(), [...jobIds].sort());
      assert.equal(shellJobsStatus({ clientHostPid: process.pid, sessionId: 'sess-race' }).count, 3);
    } finally {
      for (const jobId of jobIds) retireShellJobRecord(jobId);
    }
  });
});
