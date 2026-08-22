import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { execShellCommand } from '../shell-command.mjs';
import { retireShellJobRecord } from '../builtin/lib/shell-job-records.mjs';
import {
  _assertNativeSpawnCapabilitiesForTest,
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  cancelNativeTasks,
  listNativeTasks,
  shutdownNativeSpawnServer,
  waitNativeTask,
} from './native-spawn-client.mjs';

test('native spawn rejects binaries without the required lifecycle protocol', () => {
  assert.throws(
    () => _assertNativeSpawnCapabilitiesForTest({
      trackedForeground: true,
      promoteTask: true,
    }),
    (error) => error?.code === 'NATIVE_SPAWN_INCOMPATIBLE'
      && error.missingCaps?.includes('cancelOwner'),
  );
  assert.equal(_assertNativeSpawnCapabilitiesForTest({
    trackedForeground: true,
    promoteTask: true,
    cancelOwner: true,
  }), true);
});

test('foreground shell has stable owner identity before promotion', { timeout: 15_000 }, async (t) => {
  const binary = resolve(
    'native/mixdog-spawn/target/debug',
    process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn',
  );
  if (!existsSync(binary)) {
    t.skip(`native spawn test binary not found: ${binary}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'mixdog-native-owner-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const ownerSessionId = `sess_native_owner_${process.pid}`;
  let jobId = null;
  const admission = {
    async acquire() {
      return {
        signal: null,
        async detachDependency() {},
        async release() {},
      };
    },
  };
  try {
    _setNativeSpawnBinaryForTest(binary);
    const running = execShellCommand({
      shell: process.execPath,
      shellArg: '',
      command: 'native stable foreground ownership test',
      directArgv: ['-e', 'setTimeout(() => {}, 10000)'],
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 5_000,
      autoBackgroundMs: 250,
      backgroundOnTimeout: true,
      promotedTimeoutMs: 5_000,
      backgroundDeadlineMs: 5_000,
      ownerSessionId,
      clientHostPid: process.pid,
      admission,
    });

    let foreground = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      foreground = listNativeTasks().find((task) =>
        task.status === 'running' && task.ownerSessionId === ownerSessionId);
      if (foreground) break;
      await delay(10);
    }
    assert.ok(foreground, 'foreground process was not owner-tracked at spawn');
    jobId = foreground.jobId;

    const result = await running;
    assert.equal(result.backgrounded, true);
    assert.equal(result.jobId, jobId);

    assert.ok(cancelNativeTasks({ ownerSessionId }).cancelled >= 1);
    const terminal = await waitNativeTask(jobId, 3_000);
    assert.notEqual(terminal?.status, 'running');
    assert.equal(terminal?.status, 'cancelled');
  } finally {
    if (jobId) retireShellJobRecord(jobId);
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
