import { fixtureRoot } from './isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ENUMERATION_DEADLINE_MS, readProcessTable } from '../../mcp/child-tree.mjs';
import { execShellCommand } from '../shell-command.mjs';
import { _shellJobRecordWritesSettledForTest, retireShellJobRecord } from '../builtin/lib/shell-job-records.mjs';
import { waitShellJobTerminated } from '../builtin/shell-jobs.mjs';
import { TERMINATION_RECHECK_MS } from './shell-descendants.mjs';
import {
  _assertNativeSpawnCapabilitiesForTest,
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  ensureNativeSpawnServer,
  listNativeTasks,
  nativeSpawnContainmentRequested,
  shutdownNativeSpawnServer,
  tryNativeSpawn,
  waitNativeTask,
} from './native-spawn-client.mjs';
import { cancelOwnedShellTrees } from './owned-shell-trees.mjs';

test('native spawn rejects binaries without the required lifecycle protocol', () => {
  assert.throws(
    () =>
      _assertNativeSpawnCapabilitiesForTest({
        trackedForeground: true,
        promoteTask: true,
      }),
    (error) => error?.code === 'NATIVE_SPAWN_INCOMPATIBLE' && error.missingCaps?.includes('cancelOwner')
  );
  assert.equal(
    _assertNativeSpawnCapabilitiesForTest({
      trackedForeground: true,
      promoteTask: true,
      cancelOwner: true,
    }),
    true
  );
});

test('containment is asked only of a Windows server that advertises it, unless breakaway is allowed', () => {
  const caps = { verifiedContainment: true };
  const win = { platform: 'win32', env: {} };
  assert.equal(nativeSpawnContainmentRequested(caps, { contain: true }, win), true);
  // An older server: no capability, so the request keeps today's tracking.
  assert.equal(nativeSpawnContainmentRequested({ fileCapture: true }, { contain: true }, win), false);
  assert.equal(nativeSpawnContainmentRequested(caps, {}, win), false, 'only callers that ask');
  assert.equal(nativeSpawnContainmentRequested(caps, { contain: true }, { platform: 'linux', env: {} }), false);
  assert.equal(
    nativeSpawnContainmentRequested(caps, { contain: true }, { platform: 'win32', env: { MIXDOG_SHELL_ALLOW_BREAKAWAY: '1' } }),
    false,
    'the emergency switch in Mixdog’s environment'
  );
  const optedOut = { contain: true, env: { PATH: 'x', MIXDOG_SHELL_ALLOW_BREAKAWAY: '1' } };
  assert.equal(nativeSpawnContainmentRequested(caps, optedOut, win), false, 'one command opts out in its own env');
  assert.equal(
    nativeSpawnContainmentRequested(caps, { contain: true, env: { PATH: 'x' } }, win),
    true,
    'and only that command'
  );
});

// The terminal record follows confirmed termination, i.e. a strict process-
// table read begun after the kill (~1 s healthy, far longer under load). The
// watch's first read may queue behind the pre-kill capture; a pass the read
// outlasts is re-checked one cadence later with a fresh read.
const TERMINATION_CONFIRM_BOUND_MS = 3 * ENUMERATION_DEADLINE_MS + TERMINATION_RECHECK_MS;

// The server's FILETIME and the process table's creation token name the same
// kernel instant; the table holds it to the microsecond (truncated or rounded).
test('a spawned root reports the kernel creation time the process table shows', {
  skip: process.platform !== 'win32',
  timeout: ENUMERATION_DEADLINE_MS + 15_000,
}, async () => {
  const binary = resolve('native/mixdog-spawn/target/debug', 'mixdog-spawn.exe');
  _setNativeSpawnBinaryForTest(binary);
  let child = null;
  try {
    await ensureNativeSpawnServer();
    const native = tryNativeSpawn({ shell: process.execPath, argv: ['-e', 'setTimeout(() => {}, 20000)'] });
    child = native.child;
    await once(child, 'spawn');
    assert.match(String(child.creationTime), /^\d+$/);
    const table = await readProcessTable();
    const gap = BigInt(table.tokenOf.get(child.pid)) / 10n - BigInt(child.creationTime) / 10n;
    assert.ok(gap === 0n || gap === 1n, `table token ${table.tokenOf.get(child.pid)} vs ${child.creationTime}`);
  } finally {
    child?.kill();
    if (child) await once(child, 'close');
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
  }
});

test('foreground shell has stable owner identity before promotion', {
  timeout: TERMINATION_CONFIRM_BOUND_MS + 15_000,
}, async (t) => {
  const binary = resolve(
    'native/mixdog-spawn/target/debug',
    process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
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
      cwd: fixtureRoot,
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
      foreground = listNativeTasks().find(
        (task) => task.status === 'running' && task.ownerSessionId === ownerSessionId
      );
      if (foreground) break;
      await delay(10);
    }
    assert.ok(foreground, 'foreground process was not owner-tracked at spawn');
    jobId = foreground.jobId;

    const result = await running;
    assert.equal(result.backgrounded, true);
    assert.equal(result.jobId, jobId);

    // The owner-wide cancel a session close sends: identities first (bounded),
    // then the native cancel, so the record can confirm the tree is gone.
    assert.ok((await cancelOwnedShellTrees(ownerSessionId)).cancelled >= 1);
    const terminal = await waitNativeTask(jobId, 3_000);
    assert.notEqual(terminal?.status, 'running');
    assert.equal(terminal?.status, 'cancelled');
    // Native termination precedes the confirmation that the tree is gone and
    // the terminal sidecar write that follows it. Wait for both before
    // removing the fixture directory. The watch's timers are unref'd: hold the
    // event loop open between its passes.
    const holdLoop = setInterval(() => {}, 1_000);
    try {
      assert.equal(
        await waitShellJobTerminated(jobId, TERMINATION_CONFIRM_BOUND_MS),
        true,
        'cancelled shell tree was not confirmed gone'
      );
    } finally {
      clearInterval(holdLoop);
    }
    await _shellJobRecordWritesSettledForTest(jobId);
    const donePath = join(root, 'shell-jobs', `${jobId}.done`);
    assert.ok(existsSync(donePath), 'terminal shell record did not finish publication');
  } finally {
    if (jobId) retireShellJobRecord(jobId);
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
