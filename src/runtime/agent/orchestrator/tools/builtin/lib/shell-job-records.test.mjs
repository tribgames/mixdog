import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  completeShellJobRecord,
  listShellJobRecords,
  publishShellJobRecord,
  readShellJobRecord,
  retireShellJobRecord,
} from './shell-job-records.mjs';
import { executeTaskTool } from '../task-tool.mjs';
import { shellJobsStatus } from '../../../../../../ui/statusline-segments.mjs';

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
    publishShellJobRecord({
      jobId: 'job_probe_1',
      pid: process.pid,
      command: 'sleep 30',
      cwd: root,
      startedAt: new Date().toISOString(),
    }, { ownerSessionId: 'sess-probe', clientHostPid: process.pid });

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

test('a completed shell job remains owner-scoped and recoverable after memory loss', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-shell-records-terminal-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const jobId = `job_terminal_${process.pid}`;
  try {
    publishShellJobRecord({
      jobId,
      pid: process.pid,
      command: 'node --version',
      cwd: root,
      startedAt: new Date(Date.now() - 100).toISOString(),
    }, { ownerSessionId: 'sess-owner', clientHostPid: process.pid });
    assert.equal(await completeShellJobRecord(jobId, {
      status: 'failed',
      exitCode: 2,
      command: 'node --version',
      cwd: root,
      ownerSessionId: 'sess-owner',
      stdoutPreview: 'version output',
      finishedAt: new Date().toISOString(),
    }), true);
    const record = await readShellJobRecord(jobId);
    assert.equal(record.status, 'failed');
    assert.equal(record.exitCode, 2);
    assert.equal(record.ownerSessionId, 'sess-owner');
    assert.equal(record.terminal, true);
    assert.ok((await listShellJobRecords()).some((item) => item.jobId === jobId));
    assert.match(await executeTaskTool(
      { action: 'read', task_id: jobId },
      { sessionId: 'sess-owner' },
    ), /recovered: true/);
    assert.match(await executeTaskTool(
      { action: 'read', task_id: jobId },
      { sessionId: 'sess-other' },
    ), /task not found/);
  } finally {
    retireShellJobRecord(jobId);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
