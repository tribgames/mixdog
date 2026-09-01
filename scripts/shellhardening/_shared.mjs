// Consolidated suite; sources: shell-hardening-test.mjs, shell-failure-diagnostics-test.mjs, windows-hide-spawn-options-test.mjs
import test from 'node:test';
import '../native-spawn-test-runtime.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_SHELL_AUTO_BACKGROUND_MS,
  _placeDestructiveWarningsAfterStatus,
  _exitClassDiagnostic,
  _isBenignSearchExitOne,
  executeBashTool,
} from '../../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import {
  buildPowerShellFilterTeePlan,
  planLongInlineScriptFileTransport,
  planLongShellScriptFileTransport,
  preflightPowerShellHygiene,
} from '../../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import {
    appendGitStartupState,
    describeGitStartupState,
} from '../../src/runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs';
import { checkExecPolicyMessage } from '../../src/runtime/agent/orchestrator/tools/bash-policy-scan.mjs';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildShellOutputTelemetryPayload,
  classifyToolFailure,
} from '../../src/runtime/agent/orchestrator/agent-trace-format.mjs';
import {
  ExecResult,
  execShellCommand,
  _shellFamilyForSpawn,
} from '../../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import {
  descendantsAlive,
  killShellDescendants,
} from '../../src/runtime/agent/orchestrator/tools/lib/shell-descendants.mjs';
import {
  buildShellCompletion,
  killShellJob,
  normalizeShellJobDetail,
  peekShellJob,
  shellJobPublicTaskResult,
  shellJobTaskStatus,
  waitForShellJob,
} from '../../src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs';
import { executeTaskTool } from '../../src/runtime/agent/orchestrator/tools/builtin/task-tool.mjs';
import {
  SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
  SURVIVING_DESCENDANTS_WARNING,
  _backgroundResultLines,
} from '../../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { TaskOutput } from '../../src/runtime/agent/orchestrator/tools/shell-exec-output.mjs';
import { _composeShellFailure, _shellFailureStatus } from '../../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { classifyResultKind, isShellFailureResult } from '../../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { normalizeToolEnvelope } from '../../src/runtime/agent/orchestrator/session/tool-envelope.mjs';
import { shellCommandExitCode } from '../../src/tui/session/tool-result-status.mjs';
import { stripShellExitHeader } from '../../src/tui/session/tool-result-text.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  _bindNativeSearchServerLifecycle,
  _ackNativeSearchCancellationForTest,
  _requestNativeForTest,
  _softDeadlineMsForTest,
} from '../../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs';
import { _runReadOnlyIoWithDeadlineForTest } from '../../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import {
  childGuardianSpawnEnv,
  startChildGuardian,
  _sharedBrokerPidForTest,
  _brokerTargetsForTest,
} from '../../src/runtime/shared/child-guardian.mjs';
import {
  BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES,
  recordShellCaptureTelemetry,
  renderBackgroundPartialOutput,
} from '../../src/runtime/agent/orchestrator/tools/builtin/shell-output.mjs';
import {
  compactShellOutputLosslessly,
  planLosslessShellCompaction,
  renderLosslessRecoveryHint,
} from '../../src/runtime/agent/orchestrator/tools/builtin/shell-lossless-compact.mjs';
import { executeGlobTool } from '../../src/runtime/agent/orchestrator/tools/builtin/search-tool.mjs';

// ==== from shell-hardening-test.mjs ====
// Regression + integration tests for three recent shell hardening changes:
//   A) benign exit-1 detection for search-style / `git diff --exit-code`
//      pipelines (bash-tool.mjs `_isBenignSearchExitOne`) — exit 1 is a signal
//      (no match / has diff), not a failure, so it must NOT be surfaced as
//      Error. Ambiguous syntax (subst/subshell/escaped pipe) or a multi-segment
//      chain must stay Error.
//   B) PowerShell hygiene preflight (shell-analysis.mjs
//      `preflightPowerShellHygiene`) — PS-only lossless `/x/…`→`X:\…` rewrite
//      (quoted literals untouched) + hard-block bash-isms (grep|tail|sed|awk
//      stages, real `&&` on PS 5.1, `$PID=` reassignment); POSIX is a no-op.
//   C) shell tool description (builtin-tools.mjs) carries the PowerShell cheat
//      only on win32 (process.platform branch, fixed at module load).
// Unit style: real modules imported, cases fed directly to the exported fns.
// Integration (Windows only, fresh pwsh process): verify the live exit-1
// premise A relies on actually holds — Select-String nomatch and
// `git diff --quiet` on a dirty repo really exit 1.

// ---------------------------------------------------------------------------
// A) _isBenignSearchExitOne — unit
// ---------------------------------------------------------------------------
const BENIGN = [
    'grep x | sls',
    'Select-String foo',
    'git diff --quiet',
    'git -C . diff --exit-code',
    'grep -n foo file',
    'findstr foo file.txt',
    'git diff --check',
];
const NOT_BENIGN = [
    'grep x file && echo done',        // multi-segment chain → ambiguous
    '... < <(printf x | grep y)',       // process substitution → ambiguous
    'echo hi `| Select-String x`',      // backtick → ambiguous
    'git diff-index --quiet',           // not the `diff` subcommand
    'git diff',                         // no --exit-code/--quiet/--check
];

// ---------------------------------------------------------------------------
// B) preflightPowerShellHygiene — unit
// ---------------------------------------------------------------------------
const PS = { shellType: 'powershell', shellName: 'powershell.exe' }; // legacy PS 5.1
const PWSH = { shellType: 'powershell', shellName: 'pwsh' };

// ---------------------------------------------------------------------------
// Integration (Windows only, live pwsh/git): confirm the exit-1 premise A
// relies on is real in a fresh process. Skips when not win32 or the tool is
// missing. Temp repo/files under os.tmpdir, cleaned up in finally.
// ---------------------------------------------------------------------------
function hasCmd(cmd, args) {
    try {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        return !r.error;
    } catch { return false; }
}

async function withoutUnhandledProcessFailure(run) {
  const uncaught = [];
  const rejected = [];
  const onUncaught = (err) => uncaught.push(err);
  const onRejected = (err) => rejected.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejected);
  try {
    const result = await run();
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.deepEqual(uncaught, [], `unexpected uncaught error: ${uncaught[0]?.stack || uncaught[0]}`);
    assert.deepEqual(rejected, [], `unexpected unhandled rejection: ${rejected[0]?.stack || rejected[0]}`);
    return result;
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejected);
  }
}

function assertSpawnToolFailure(result) {
  assert.equal(result.failurePhase, 'tool');
  assert.equal(result.failureReason, 'spawn failed');
  const status = _shellFailureStatus(result, 1000);
  assert.equal(status.shellToolFailed, true);
  const rendered = _composeShellFailure(
    `[shell-tool-failed] ${status.statusDetail}`,
    'Error: ',
    '',
    result.stderr,
  );
  assert.match(rendered, /^Error: \[shell-tool-failed\] \[spawn failed\]/);
  assert.equal(classifyToolFailure(rendered, 'shell'), 'tool-call/failure');
}

// ==== from windows-hide-spawn-options-test.mjs ====
const root = fileURLToPath(new URL('../..', import.meta.url));

function source(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function spawnIdleNode() {
  return spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

function killIdleNode(child) {
  if (!child?.pid || !pidAlive(child.pid)) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Detaching work is decided by OBSERVATION, with real processes on the shells
// that are actually installed. Every command below runs UNMODIFIED — nothing
// in the shell path looks at its text — and the outcome is read from the
// processes it left behind.
// ---------------------------------------------------------------------------
const DETACHING_SHELL_CASES = (process.platform === 'win32'
  ? [
    {
      name: 'git-bash',
      shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      shellArg: '-lc',
      detaching: 'sleep 30 &',
      finishing: 'sleep 1 & wait',
    },
    {
      name: 'pwsh',
      shell: 'pwsh.exe',
      shellArg: '-Command',
      // PowerShell's own `&` job dies with its host, so the detaching idiom
      // that really survives a pwsh -Command run is Start-Process.
      detaching: 'Start-Process -NoNewWindow ping -ArgumentList "-n","30","127.0.0.1"',
      finishing: 'Start-Sleep -Milliseconds 200',
    },
    {
      name: 'cmd',
      shell: process.env.ComSpec || 'cmd.exe',
      shellArg: '/c',
      detaching: 'start /b ping -n 30 127.0.0.1',
      finishing: 'echo done',
    },
  ]
  : [
    {
      name: 'sh',
      shell: '/bin/sh',
      shellArg: '-c',
      detaching: 'sleep 30 &',
      finishing: 'sleep 1 & wait',
    },
    {
      name: 'bash',
      shell: '/bin/bash',
      shellArg: '-lc',
      detaching: 'sleep 30 &',
      finishing: 'sleep 1 & wait',
    },
  ]).filter((entry) => entry.shell.includes('/') || entry.shell.includes('\\')
    ? fs.existsSync(entry.shell)
    : true);

async function runShellCase(entry, command) {
  return execShellCommand({
    shell: entry.shell,
    shellArg: entry.shellArg,
    command,
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 20_000,
    backgroundOnTimeout: false,
  });
}

export {
  os,
  fs,
  path,
  spawnSync,
  createHash,
  EventEmitter,
  DEFAULT_SHELL_AUTO_BACKGROUND_MS,
  _placeDestructiveWarningsAfterStatus,
  _exitClassDiagnostic,
  _isBenignSearchExitOne,
  executeBashTool,
  buildPowerShellFilterTeePlan,
  planLongInlineScriptFileTransport,
  planLongShellScriptFileTransport,
  preflightPowerShellHygiene,
  BUILTIN_TOOLS,
  appendGitStartupState,
  describeGitStartupState,
  checkExecPolicyMessage,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  tmpdir,
  join,
  resolve,
  buildShellOutputTelemetryPayload,
  classifyToolFailure,
  ExecResult,
  execShellCommand,
  _shellFamilyForSpawn,
  descendantsAlive,
  killShellDescendants,
  buildShellCompletion,
  killShellJob,
  normalizeShellJobDetail,
  peekShellJob,
  shellJobPublicTaskResult,
  shellJobTaskStatus,
  waitForShellJob,
  executeTaskTool,
  SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
  SURVIVING_DESCENDANTS_WARNING,
  _backgroundResultLines,
  TaskOutput,
  _composeShellFailure,
  _shellFailureStatus,
  classifyResultKind,
  isShellFailureResult,
  normalizeToolEnvelope,
  shellCommandExitCode,
  stripShellExitHeader,
  spawn,
  readFileSync,
  fileURLToPath,
  pathToFileURL,
  delay,
  _bindNativeSearchServerLifecycle,
  _ackNativeSearchCancellationForTest,
  _requestNativeForTest,
  _softDeadlineMsForTest,
  _runReadOnlyIoWithDeadlineForTest,
  childGuardianSpawnEnv,
  startChildGuardian,
  _sharedBrokerPidForTest,
  _brokerTargetsForTest,
  BACKGROUND_PARTIAL_OUTPUT_MAX_BYTES,
  recordShellCaptureTelemetry,
  renderBackgroundPartialOutput,
  compactShellOutputLosslessly,
  planLosslessShellCompaction,
  renderLosslessRecoveryHint,
  executeGlobTool,
  BENIGN,
  NOT_BENIGN,
  PS,
  PWSH,
  hasCmd,
  withoutUnhandledProcessFailure,
  assertSpawnToolFailure,
  root,
  source,
  pidAlive,
  waitUntil,
  spawnIdleNode,
  killIdleNode,
  DETACHING_SHELL_CASES,
  runShellCase,
};
