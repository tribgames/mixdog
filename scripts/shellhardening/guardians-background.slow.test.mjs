import test from 'node:test';
import assert from 'node:assert/strict';
import {
  path,
  spawnSync,
  executeBashTool,
  join,
  _shellFamilyForSpawn,
  descendantsAlive,
  killShellDescendants,
  buildShellCompletion,
  killShellJob,
  normalizeShellJobDetail,
  shellJobPublicTaskResult,
  shellJobTaskStatus,
  executeTaskTool,
  SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
  SURVIVING_DESCENDANTS_WARNING,
  _backgroundResultLines,
  normalizeToolEnvelope,
  spawn,
  fileURLToPath,
  delay,
  childGuardianSpawnEnv,
  startChildGuardian,
  _sharedBrokerPidForTest,
  _brokerTargetsForTest,
  source,
  pidAlive,
  waitUntil,
  spawnIdleNode,
  killIdleNode,
  DETACHING_SHELL_CASES,
  runShellCase,
} from './_shared.mjs';


test('Windows-sensitive Node re-execs keep their windows hidden', () => {
  const cli = source('src/cli.mjs');
  const jitRebuild = source('src/tui/dev/jit-rebuild.mjs');

  assert.match(cli, /spawnSync\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), \.\.\.argv\], \{\r?\n\s*stdio: 'inherit',\r?\n\s*env: \{ \.\.\.process\.env, MIXDOG_SWAP_REEXEC: '1' \},\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
  assert.match(jitRebuild, /spawnSync\(process\.execPath, \[script\], \{\r?\n\s*stdio: process\.env\.MIXDOG_TUI_DEV_VERBOSE \? 'inherit' : 'ignore',\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
});

test('child guardians re-exec Electron as Node without forwarding secrets', () => {
  assert.deepEqual(childGuardianSpawnEnv({
    PATH: 'fixture-path',
    SystemRoot: 'C:\\Windows',
    WINDIR: '',
    ELECTRON_RUN_AS_NODE: '0',
    MIXDOG_TEST_SECRET: 'must-not-forward',
  }), {
    PATH: 'fixture-path',
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
  });
});

test('command-scoped child guardians can stop without killing a reusable child', { timeout: 10_000 }, async () => {
  const child = spawnIdleNode();
  let guardian = null;
  try {
    guardian = startChildGuardian({
      childPid: child.pid,
      childGroupPid: child.pid,
      label: 'guardian-stop-test',
      pollMs: 100,
    });
    assert.ok(guardian?.pid);
    assert.equal(await waitUntil(() => pidAlive(guardian.pid)), true);
    assert.equal(guardian.stop(), true);
    // The broker is SHARED: other subsystems (e.g. the native patch server
    // starting under this suite's imports) may legitimately hold their own
    // targets, so global broker exit is only observable when this test's
    // target was the last one. The invariant here is relative: OUR target
    // deregisters and the child survives.
    assert.equal(await waitUntil(() => !_brokerTargetsForTest().some((t) => t.childPid === child.pid)), true);
    if (_brokerTargetsForTest().length === 0) {
      assert.equal(await waitUntil(() => !pidAlive(guardian.pid)), true);
    }
    assert.equal(pidAlive(child.pid), true);
  } finally {
    guardian?.stop?.();
    killIdleNode(child);
  }
});

test('child guardians share one broker without coupling child lifetimes', { timeout: 10_000 }, async () => {
  const firstChild = spawnIdleNode();
  const secondChild = spawnIdleNode();
  let first = null;
  let second = null;
  try {
    first = startChildGuardian({ childPid: firstChild.pid, pollMs: 100 });
    second = startChildGuardian({ childPid: secondChild.pid, pollMs: 100 });
    assert.ok(first?.pid);
    assert.equal(second?.pid, first.pid);
    assert.equal(first.stop(), true);
    await delay(250);
    // The broker may self-heal across a restart (an `add` racing the
    // empty-grace exit of a previous broker respawns with targets re-sent),
    // so assert that SOME broker keeps serving the second child — the pid
    // captured at start may have been legitimately replaced.
    const currentBrokerAlive = () => {
      const pid = _sharedBrokerPidForTest();
      return pid ? pidAlive(pid) : false;
    };
    assert.equal(await waitUntil(currentBrokerAlive), true, 'a broker remains for the second child');
    assert.equal(pidAlive(firstChild.pid), true);
    assert.equal(pidAlive(secondChild.pid), true);
    assert.equal(second.stop(), true);
    // Same shared-broker caveat as above: full wind-down is only observable
    // when no other subsystem still holds a target.
    assert.equal(await waitUntil(() => !_brokerTargetsForTest().some(
      (t) => t.childPid === firstChild.pid || t.childPid === secondChild.pid,
    )), true);
    if (_brokerTargetsForTest().length === 0) {
      assert.equal(await waitUntil(() => {
        const pid = _sharedBrokerPidForTest();
        return !pid || !pidAlive(pid);
      }), true);
    }
  } finally {
    first?.stop?.();
    second?.stop?.();
    killIdleNode(firstChild);
    killIdleNode(secondChild);
  }
});

test('a naturally exited child is removed from the parent guardian registry', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 150)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const guardian = startChildGuardian({ childPid: child.pid, pollMs: 100 });
  try {
    assert.ok(guardian?.pid);
    assert.equal(await waitUntil(() => !pidAlive(child.pid)), true);
    // Registry removal is the invariant; broker exit only follows when no
    // other subsystem holds a target on the shared broker.
    assert.equal(await waitUntil(() => !_brokerTargetsForTest().some((t) => t.childPid === child.pid)), true);
    if (_brokerTargetsForTest().length === 0) {
      assert.equal(await waitUntil(() => !pidAlive(guardian.pid)), true);
    }
    assert.equal(guardian.stop(), false,
      'natural child exit must clear the parent-side broker target');
  } finally {
    guardian?.stop?.();
    killIdleNode(child);
  }
});

// ---------------------------------------------------------------------------
// Command text is never parsed. There is no operator detection, no heredoc
// grammar and no rewriting left in the shell path: whatever the caller wrote
// reaches the shell byte for byte, and whether the command detached work is
// decided AFTER it ran, from the processes it left behind
// (tools/lib/shell-descendants.mjs).
//
// What survives from the old scanner is the one non-heuristic part: the host
// family of the shell that will actually execute the text, taken from the
// spawn EXECUTABLE. It is used to build commands the tool itself constructs
// (quoting/escaping), never to reinterpret the caller's command.
// ---------------------------------------------------------------------------
test('host family comes from the real spawn executable, never from an argument shape', () => {
  assert.equal(_shellFamilyForSpawn({ shell: 'C:/Program Files/PowerShell/7/pwsh.exe', shellArg: '-Command' }), 'powershell');
  assert.equal(_shellFamilyForSpawn({ shell: 'C:/Windows/System32/cmd.exe', shellArg: '/c' }), 'cmd');
  assert.equal(_shellFamilyForSpawn({ shell: '/bin/bash', shellArg: '-lc' }), 'bash');
  assert.equal(_shellFamilyForSpawn({ shell: 'C:/Program Files/Git/bin/bash.exe', shellArgs: ['-lc'] }), 'bash');
  assert.equal(_shellFamilyForSpawn({ shell: '/bin/zsh', shellArg: '-c' }), 'bash');
  assert.equal(_shellFamilyForSpawn({ shell: '/bin/dash', shellArg: '-c' }), 'posix');
  assert.equal(_shellFamilyForSpawn({ shell: '/bin/sh', shellArg: '-c' }), 'posix');
  // The spawn target wins over contradictory caller metadata.
  assert.equal(_shellFamilyForSpawn({ shellType: 'cmd', shell: 'pwsh.exe', shellArg: '-Command' }), 'powershell');
  assert.equal(_shellFamilyForSpawn({ shellType: 'powershell', shell: 'C:/Windows/System32/cmd.exe', shellArg: '/c' }), 'cmd');
  // An ARGUMENT never classifies: only the executable receiving the command
  // text does, so a `/c` on an unknown binary stays unknown.
  assert.equal(_shellFamilyForSpawn({ shell: '/usr/bin/env', shellArg: 'bash' }), null);
  assert.equal(_shellFamilyForSpawn({ shell: '/usr/bin/env', shellArg: '/c' }), null);
  assert.equal(_shellFamilyForSpawn({ shell: 'C:/tools/custom.exe', shellArgs: ['/c'] }), null);
  assert.equal(_shellFamilyForSpawn({ shellType: 'posix' }), null);
  assert.equal(_shellFamilyForSpawn({}), null);
});

test('the background result block renders its warning slot in order', () => {
  const withWarning = _backgroundResultLines({
    warning: SURVIVING_DESCENDANTS_WARNING,
    taskBlock: '[task_id: job_x]',
    message: 'still running',
  });
  assert.equal(withWarning[0], SURVIVING_DESCENDANTS_WARNING);
  assert.ok(withWarning.includes('[task_id: job_x]'));
  assert.ok(withWarning.includes('still running'));
  const withoutWarning = _backgroundResultLines({ taskBlock: '[task_id: job_x]', message: 'still running' });
  assert.equal(withoutWarning[0], '[task_id: job_x]');
  assert.equal(withoutWarning.some((line) => line === SURVIVING_DESCENDANTS_WARNING), false);
});

test('a real auto-backgrounded command leaves through the background result path', { timeout: 60_000 }, async () => {
  const isWindows = process.platform === 'win32';
  const previous = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = '500';
  let taskId = null;
  try {
    const raw = await executeBashTool(
      { command: isWindows ? 'Start-Sleep -Seconds 20' : 'sleep 20' },
      process.cwd(),
      { sessionId: 'sess_autobg_render', callerSessionId: 'sess_autobg_render' },
    );
    const rendered = normalizeToolEnvelope(raw)?.result ?? String(raw);
    taskId = rendered.match(/^task_id:\s*(\S+)/m)?.[1]
      || rendered.match(/\[task_id:\s*([^\]]+)\]/)?.[1]
      || null;
    assert.ok(taskId, `an auto-backgrounded command must return a task_id:\n${rendered}`);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
    else process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = previous;
    if (taskId) { try { killShellJob(taskId); } catch { /* best-effort */ } }
  }
});

for (const entry of DETACHING_SHELL_CASES) {
  test(`${entry.name}: a command that leaves descendants running is observed and cancellable`, {
    timeout: 120_000,
  }, async () => {
    const result = await runShellCase(entry, entry.detaching);
    const handle = result.descendants;
    assert.ok(handle, `${entry.name}: surviving descendants must be observed:\n${JSON.stringify(result, null, 2)}`);
    assert.ok(handle.taskId, `${entry.name}: the survivors must carry a task id`);
    assert.equal(descendantsAlive(handle), true, `${entry.name}: the observed survivors must still be alive`);
    const killed = await killShellDescendants(handle);
    // A reachable survivor must actually be gone; an unreachable one (Windows
    // keeps no live link to a process whose parent already exited) is reported
    // as unconfirmed instead of being claimed dead.
    if (handle.reachable) {
      assert.equal(killed.terminated, true,
        `${entry.name}: cancellation must leave no process behind, survivors=${killed.survivors.join(',')}`);
      assert.equal(await waitUntil(() => !descendantsAlive(handle), 10_000), true,
        `${entry.name}: no descendant may outlive the cancellation`);
    } else {
      assert.equal(process.platform, 'win32',
        `${entry.name}: only Windows can lose the link to a re-parented descendant`);
      assert.ok(Array.isArray(killed.survivors));
    }
  });

  test(`${entry.name}: a command whose descendants all exit reports a plain completion`, {
    timeout: 120_000,
  }, async () => {
    const result = await runShellCase(entry, entry.finishing);
    assert.equal(result.descendants, null,
      `${entry.name}: nothing may be tracked when nothing survived:\n${JSON.stringify(result.descendants)}`);
    assert.equal(result.exitCode, 0);
  });
}

test('a finished command that left descendants is tracked and cancelled through the task tool', {
  timeout: 120_000,
}, async () => {
  const isWindows = process.platform === 'win32';
  const command = isWindows
    ? 'Start-Process -NoNewWindow ping -ArgumentList "-n","30","127.0.0.1"'
    : 'sleep 30 &';
  const sessionId = 'sess_descendants_tracked';
  const raw = await executeBashTool({ command }, process.cwd(), { sessionId, callerSessionId: sessionId });
  const rendered = normalizeToolEnvelope(raw)?.result ?? String(raw);
  const taskId = rendered.match(/^task_id:\s*(\S+)/m)?.[1]
    || rendered.match(/\[task_id:\s*([^\]]+)\]/)?.[1]
    || null;
  assert.ok(
    rendered.includes(SURVIVING_DESCENDANTS_WARNING)
    || rendered.includes(SURVIVING_DESCENDANTS_UNREACHABLE_WARNING),
    `a command that left descendants must say so:\n${rendered}`,
  );
  assert.ok(taskId, `surviving descendants must be tracked under a task_id:\n${rendered}`);
  assert.doesNotMatch(rendered, /shell-tool-failed/);
  const cancelled = String(await executeTaskTool(
    { action: 'cancel', task_id: taskId },
    { sessionId, callerSessionId: sessionId },
  ));
  assert.match(cancelled, /cancelled|cancel-unconfirmed/);
  assert.doesNotMatch(cancelled, /task not found/);
});

// ---------------------------------------------------------------------------
// One status for a promoted non-zero command (shell-jobs.mjs +
// shell-job-insights.mjs). Wrapper status, notification envelope and public
// task result must agree; a foreground run of the same command reports
// `[exit code: N]` and is not a failure.
// ---------------------------------------------------------------------------
test('a promoted non-zero command reports one consistent status on every surface', () => {
  const native = {
    jobId: 'job_nonzero_status',
    status: 'failed',
    exitCode: 3,
    timedOut: false,
    killed: false,
    error: null,
    command: 'npm test',
    cwd: process.cwd(),
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    finishedAt: new Date().toISOString(),
    stdoutPreview: 'running tests',
    stderrPreview: '3 failing',
  };
  const canonical = normalizeShellJobDetail(native);
  assert.equal(canonical.status, 'completed');
  assert.equal(canonical.nativeStatus, 'failed');
  assert.equal(shellJobTaskStatus(canonical), 'completed');
  const completion = buildShellCompletion(canonical.jobId, canonical);
  assert.equal(completion.taskStatus, 'completed');
  assert.match(completion.body, /\[status: completed\]/);
  assert.match(completion.body, /\[outcome: command-failed\]/);
  assert.equal(completion.error, null);
  assert.equal(completion.result.status, 'completed');
  assert.equal(completion.result.exit_code, 3);
  assert.equal(shellJobPublicTaskResult(canonical).status, 'completed');
  // A signal death is a genuine failure on every surface. `Number(null)` is 0,
  // so an integer test on the coerced exit code once reported a crash as a
  // completed task.
  const signalled = normalizeShellJobDetail({ ...native, exitCode: null, signal: 'SIGSEGV' });
  assert.equal(signalled.status, 'failed');
  assert.equal(signalled.nativeStatus, 'failed');
  const signalledCompletion = buildShellCompletion(signalled.jobId, signalled);
  assert.equal(signalledCompletion.taskStatus, 'failed');
  assert.match(signalledCompletion.body, /\[status: failed\]/);
  assert.equal(shellJobPublicTaskResult(signalled).status, 'failed');
  // The failure carries its cause on every surface, even though the native
  // task has no `error` of its own for a signal death.
  assert.match(signalledCompletion.error, /terminated by signal SIGSEGV/);
  assert.equal(signalledCompletion.result.error, signalledCompletion.error);
  assert.match(signalledCompletion.body, /terminated by signal SIGSEGV/);
  // Even when the platform also reports a numeric code for the signal death.
  assert.equal(normalizeShellJobDetail({ ...native, exitCode: 139, signal: 'SIGSEGV' }).status, 'failed');
  // A failed status with exit 0 is a control-plane failure, not a command result.
  assert.equal(normalizeShellJobDetail({ ...native, exitCode: 0 }).status, 'failed');
  assert.equal(normalizeShellJobDetail({ ...native, exitCode: null }).status, 'failed');
  // Control-plane failures stay failed everywhere.
  const timedOut = normalizeShellJobDetail({ ...native, timedOut: true, exitCode: 124 });
  assert.equal(timedOut.status, 'failed');
  assert.equal(buildShellCompletion(timedOut.jobId, timedOut).taskStatus, 'failed');
  assert.equal(shellJobPublicTaskResult(timedOut).status, 'failed');
  // Running is never rewritten into a terminal status.
  assert.equal(normalizeShellJobDetail({ ...native, status: 'running', exitCode: null }).status, 'running');
  assert.equal(shellJobTaskStatus('running'), 'running');
});
