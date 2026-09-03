// shell and task execution behaviors: envelopes, timeouts, project cwd,
// auto-backgrounding, and task action argument shapes.
import './_env.mjs';
import test from 'node:test';
import { resolve } from 'node:path';
import { root } from './_env.mjs';
import { assertOk, waitFor } from './_helpers.mjs';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { validateBuiltinArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { normalizeToolEnvelope } from '../../src/runtime/agent/orchestrator/session/tool-envelope.mjs';
import { stripShellExitHeader } from '../../src/tui/session/tool-result-text.mjs';

function shellTaskId(text) {
  return (/task_id:\s*(\S+)/i.exec(String(text)) || [])[1] || '';
}
function shellNotifyOptions(events, suffix) {
  const sessionId = `sess_shell_notify_${suffix}_${Date.now()}`;
  return {
    sessionId,
    callerSessionId: sessionId,
    routingSessionId: sessionId,
    notifyFn: (text, meta) => {
      events.push({ text: String(text), meta });
      return true;
    },
  };
}
function assertBackgroundStart(label, output) {
  const text = String(output);
  const taskId = shellTaskId(text);
  if (!taskId) {
    throw new Error(`${label} must return a tracked task_id:\n${text}`);
  }
  return taskId;
}
async function assertSingleShellCompletion(events, taskId, label) {
  await waitFor(
    () => events.some((event) => event.text.includes(taskId)),
    `${label} completion notification`,
    5000,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const matches = events.filter((event) => event.text.includes(taskId));
  if (matches.length !== 1) {
    throw new Error(`${label} must notify exactly once, got ${matches.length}: ${JSON.stringify(events)}`);
  }
}

test('shell rejects retired args and absorbs timeout edge values', () => {
  for (const retired of ['timeout', 'cwd', 'workdir', 'mode', 'shell', 'persistent', 'session_id', 'merge_stderr', 'run_in_background', 'monitor_interval_ms']) {
    const err = validateBuiltinArgs('shell', { command: 'node --version', [retired]: retired === 'mode' ? 'async' : true });
    if (!/unsupported.*command and timeout_ms/i.test(err || '')) {
      throw new Error(`shell retired arg must be rejected (${retired}): ${err}`);
    }
  }
  const shellZeroTimeoutErr = validateBuiltinArgs('shell', { command: 'node --version', timeout_ms: 0 });
  const shellNegativeTimeoutErr = validateBuiltinArgs('shell', { command: 'node --version', timeout_ms: -1 });
  if (shellZeroTimeoutErr || !/non-negative number/.test(String(shellNegativeTimeoutErr))) {
    throw new Error(`shell timeout_ms must absorb 0 and reject negatives: zero=${shellZeroTimeoutErr} negative=${shellNegativeTimeoutErr}`);
  }
});

test('task action argument ownership and unknown-task reporting', async () => {
  for (const [action, taskId, waitCeiling] of [
    ['list', '', 0],
    ['read', 'task_action_shape_smoke', 0],
    ['cancel', 'task_action_shape_smoke', 300_000],
  ]) {
    const args = { action, task_id: taskId, timeout_ms: waitCeiling };
    const err = validateBuiltinArgs('task', args);
    if (err
      || Object.prototype.hasOwnProperty.call(args, 'timeout_ms')
      || (action === 'list' && Object.prototype.hasOwnProperty.call(args, 'task_id'))) {
      throw new Error(`task ${action} must discard fields owned by other actions: err=${err} args=${JSON.stringify(args)}`);
    }
  }
  const taskWaitShapeArgs = {
    action: 'wait',
    task_id: 'task_action_shape_smoke',
    timeout_ms: 300_000,
  };
  const taskWaitShapeErr = validateBuiltinArgs('task', taskWaitShapeArgs);
  if (taskWaitShapeErr || taskWaitShapeArgs.timeout_ms !== 300_000) {
    throw new Error(`task wait must retain its ceiling: err=${taskWaitShapeErr} args=${JSON.stringify(taskWaitShapeArgs)}`);
  }
  const taskWaitBadCeilingErr = validateBuiltinArgs('task', {
    action: 'wait',
    task_id: 'task_action_shape_smoke',
    timeout_ms: 'soon',
  });
  if (!/non-negative integer/i.test(String(taskWaitBadCeilingErr))) {
    throw new Error(`task wait must reject a non-integer ceiling: ${taskWaitBadCeilingErr}`);
  }
  const taskReadMissingIdArgs = { action: 'read', timeout_ms: 0 };
  const taskReadMissingIdErr = validateBuiltinArgs('task', taskReadMissingIdArgs);
  if (!/requires "task_id"/i.test(String(taskReadMissingIdErr))
    || Object.prototype.hasOwnProperty.call(taskReadMissingIdArgs, 'timeout_ms')) {
    throw new Error(`task read must discard wait fields but retain task_id validation: err=${taskReadMissingIdErr} args=${JSON.stringify(taskReadMissingIdArgs)}`);
  }
  const taskWaitMissingOut = await executeBuiltinTool('task', {
    action: 'wait',
    task_id: 'task_missing_wait_smoke',
    timeout_ms: 10_000,
  }, root);
  if (!/^Error[\s:[]/.test(String(taskWaitMissingOut)) || !/task not found/i.test(String(taskWaitMissingOut))) {
    throw new Error(`task wait must report an unknown task instead of blocking:\n${taskWaitMissingOut}`);
  }
  const taskImplicitActionOut = await executeBuiltinTool('task', {
    task_id: 'task_implicit_action_smoke',
  }, root);
  if (!/^Error[\s:[]/.test(String(taskImplicitActionOut)) || !/explicit "action"/i.test(String(taskImplicitActionOut))) {
    throw new Error(`task must reject an implicit status action:\n${taskImplicitActionOut}`);
  }
});

test('shell command-local cd never leaks out of one invocation', async () => {
  const shellProjectCwdSession = `tool-contracts-project-cwd-${process.pid}`;
  const shellLocalCdOut = await executeBuiltinTool('shell', {
    command: process.platform === 'win32'
      ? 'Set-Location scripts; Get-Location | Select-Object -ExpandProperty Path'
      : 'cd scripts && pwd',
    timeout_ms: 30_000,
  }, root, { sessionId: shellProjectCwdSession });
  const shellLocalCdPath = stripShellExitHeader(String(normalizeToolEnvelope(shellLocalCdOut).result)).trim();
  if (resolve(shellLocalCdPath) !== resolve(root, 'scripts')) {
    throw new Error(`shell command-local cd did not enter scripts: ${shellLocalCdOut}`);
  }
  const shellProjectResetOut = await executeBuiltinTool('shell', {
    command: process.platform === 'win32'
      ? 'Get-Location | Select-Object -ExpandProperty Path'
      : 'pwd',
    timeout_ms: 30_000,
  }, root, { sessionId: shellProjectCwdSession });
  const shellProjectResetPath = stripShellExitHeader(String(normalizeToolEnvelope(shellProjectResetOut).result)).trim();
  if (resolve(shellProjectResetPath) !== root) {
    throw new Error(`one-shot shell leaked command-local cwd instead of returning to the Project root: ${shellProjectResetOut}`);
  }
});

test('shell result envelopes: success, non-zero exit, timeout, and preflight', async () => {
  const shellOutPromise = executeBuiltinTool('shell', {
    command: 'node --version',
    timeout_ms: 30_000,
  }, root);
  const shellFailOutPromise = executeBuiltinTool('shell', {
    command: 'node -e "console.error(\'tool-contracts-bash-fail\'); process.exit(7)"',
    timeout_ms: 30_000,
  }, root);

  const shellOut = await shellOutPromise;
  assertOk('shell default runtime', shellOut, /v\d+\.\d+\.\d+/);

  const shellFailOut = await shellFailOutPromise;
  const normalizedShellFailOut = normalizeToolEnvelope(shellFailOut);
  const shellFailText = String(normalizedShellFailOut.result);
  if (
    normalizedShellFailOut.explicitSuccess !== true
    || /^Error[\s:[]/.test(shellFailText)
    || /\[shell-run-failed\]/.test(shellFailText)
    || !/\[exit code: 7\]/.test(shellFailText)
    || !/\[completed: shell executed the command\b/.test(shellFailText)
  ) {
    throw new Error(`bash non-zero exit must be a completed command-result envelope:\n${shellFailText}`);
  }

  // Keep the deadline probe isolated from the concurrent shell-pool checks
  // above: it verifies timeout semantics, not admission/pool scheduling.
  const shellTimeoutOut = await executeBuiltinTool('shell', {
    command: 'node -e "setTimeout(() => console.log(\'tool-contracts-timeout-missed\'), 1500)"',
    timeout_ms: 500,
  }, root);
  if (!/^Error[\s:[]/.test(String(shellTimeoutOut)) || !/\[shell-run-failed\]/.test(String(shellTimeoutOut)) || !/\[timeout: 500ms\b/.test(String(shellTimeoutOut))) {
    throw new Error(`bash timeout must be milliseconds and classified as shell-run-failed Error:\n${shellTimeoutOut}`);
  }

  const shellArgFailOut = await executeBuiltinTool('shell', {
    command: '',
  }, root);
  if (!/^Error[\s:[]/.test(String(shellArgFailOut)) || !/\[shell-tool-failed\]/.test(String(shellArgFailOut))) {
    throw new Error(`shell tool/preflight failures must be classified as shell-tool-failed Error:\n${shellArgFailOut}`);
  }
});

test('short shell commands complete inline without tasks or notifications', async () => {
  const shellShortNotifyEvents = [];
  const shellShortNotifyOptions = shellNotifyOptions(shellShortNotifyEvents, 'short_inline');
  const shellShortOut = await executeBuiltinTool('shell', {
    command: 'node -e "setTimeout(() => console.log(\'tool-contracts-short-inline-done\'), 300)"',
    timeout_ms: 5000,
  }, root, shellShortNotifyOptions);
  const shellShortText = String(normalizeToolEnvelope(shellShortOut).result);
  if (!/tool-contracts-short-inline-done/.test(shellShortText) || shellTaskId(shellShortText)) {
    throw new Error(`short shell command must complete inline without task_id:\n${shellShortOut}`);
  }
  if (shellShortNotifyEvents.length !== 0) {
    throw new Error(`short inline shell command must not notify asynchronously: ${JSON.stringify(shellShortNotifyEvents)}`);
  }
});

test('task read returns snapshots and task wait returns only settled tasks', async () => {
  const shellCheckEvents = [];
  const shellCheckOptions = shellNotifyOptions(shellCheckEvents, 'snapshot_read');
  const _priorSnapshotAutoBg = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = '50';
  let shellCheckOut;
  try {
    shellCheckOut = await executeBuiltinTool('shell', {
      command: 'node -e "console.log(\'tool-contracts-snapshot-read-progress\'); setTimeout(() => console.log(\'tool-contracts-snapshot-read-done\'), 1500)"',
      timeout_ms: 5000,
    }, root, shellCheckOptions);
  } finally {
    if (_priorSnapshotAutoBg === undefined) delete process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
    else process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = _priorSnapshotAutoBg;
  }
  const shellCheckTaskId = assertBackgroundStart('shell snapshot-read start', shellCheckOut);
  const shellSnapshotRead = await executeBuiltinTool('task', {
    action: 'read',
    task_id: shellCheckTaskId,
  }, root, shellCheckOptions);
  if (!/status:\s*running/i.test(String(shellSnapshotRead))
    || !/"status":\s*"running"/i.test(String(shellSnapshotRead))) {
    throw new Error(`task read must return the current running snapshot:\n${shellSnapshotRead}`);
  }
  // wait replaces the polling loop: one call returns the settled task, so a
  // still-running status here would mean the wait handed back a bare snapshot.
  const shellWaitSettled = await executeBuiltinTool('task', {
    action: 'wait',
    task_id: shellCheckTaskId,
    timeout_ms: 30_000,
  }, root, shellCheckOptions);
  if (/"status":\s*"running"/i.test(String(shellWaitSettled))) {
    throw new Error(`task wait must return only after the task settles:\n${shellWaitSettled}`);
  }
  await assertSingleShellCompletion(shellCheckEvents, shellCheckTaskId, 'shell snapshot read');
});

test('auto-promotion returns a tracked task with completion guidance', async () => {
  // Auto-promotion: a sync foreground command still running past the soft budget
  // returns a tracked task and completion notification.
  const _priorAutoBgBudget = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = '50';
  const shellAutoNotifyEvents = [];
  const shellAutoNotifyOptions = shellNotifyOptions(shellAutoNotifyEvents, 'auto');
  let shellAutoPromoteOut;
  try {
    shellAutoPromoteOut = await executeBuiltinTool('shell', {
      command: 'node -e "setTimeout(() => console.log(\'tool-contracts-autopromote-done\'), 600)"',
      timeout_ms: 5000,
    }, root, shellAutoNotifyOptions);
  } finally {
    if (_priorAutoBgBudget === undefined) delete process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
    else process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS = _priorAutoBgBudget;
  }
  if (!/auto-backgrounded/i.test(String(shellAutoPromoteOut))
      || !/Completion is automatic/i.test(String(shellAutoPromoteOut))) {
    throw new Error(`shell auto-promotion must return a tracked task with automatic-completion guidance:\n${shellAutoPromoteOut}`);
  }
  const shellAutoPromoteTaskId = assertBackgroundStart('shell auto-promotion', shellAutoPromoteOut);
  await assertSingleShellCompletion(shellAutoNotifyEvents, shellAutoPromoteTaskId, 'shell auto-promotion');
});
