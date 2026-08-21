import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateToolMembers,
  failureDetailText,
  shellCommandExitCode,
  toolCallOutcome,
} from './tool-result-status.mjs';
import {
  deriveToolOutcomeTone,
  displayTerminalStatus,
  shellDisplayStatus,
} from '../../runtime/shared/tool-card-model.mjs';

// Outcome taxonomy contract (user report: "Exit 0" rendered as if failed):
// - exit 0            → plain success ("Ok" bucket, success tone)
// - non-zero exit     → command failure (warning tone, never red)
// - envelope isError  → real call failure ("Failed", red)

test('exit 0 is a plain success, never the Exit bucket', () => {
  const rawText = '[exit code: 0]\nall good';
  assert.equal(shellCommandExitCode(rawText), 0);
  assert.deepEqual(toolCallOutcome({ isError: false }, rawText), {
    isCallError: false,
    isExitError: false,
    exitCode: 0,
  });
});

test('a recognized exit 0 wins over a provider error envelope', () => {
  const outcome = toolCallOutcome({ isError: true }, '[exit code: 0]\nnoise on stderr');
  assert.equal(outcome.isCallError, false);
  assert.equal(outcome.isExitError, false);
});

test('non-zero exit is a command failure, not a call error', () => {
  assert.deepEqual(toolCallOutcome({ isError: true }, '[exit code: 2]\nboom'), {
    isCallError: false,
    isExitError: true,
    exitCode: 2,
  });
});

test('offloaded shell previews retain exit classification', () => {
  const rawText = `[tool output offloaded: shell → C:/safe/result.txt (60 KB, 900 lines, sha256 ${'a'.repeat(64)})]\n\n[exit code: 2]\nboom`;
  assert.equal(shellCommandExitCode(rawText), 2);
  assert.deepEqual(toolCallOutcome({ isError: false }, rawText), {
    isCallError: false,
    isExitError: true,
    exitCode: 2,
  });
});

test('recognized no-match is a successful completed probe', () => {
  const rawText = '[exit code: 1]\n[outcome: no-match]\n[completed: shell executed the command]\n\n(no output)';
  assert.deepEqual(toolCallOutcome({ isError: true }, rawText), {
    isCallError: false,
    isExitError: false,
    exitCode: 1,
  });
});

test('timeout/signal results never classify as a plain command exit', () => {
  assert.equal(shellCommandExitCode('[timeout: 5000ms signal: SIGKILL]\n[exit code: 1]'), null);
  const outcome = toolCallOutcome({ isError: true }, '[signal: SIGTERM]\nkilled');
  assert.equal(outcome.isCallError, true);
  assert.equal(outcome.isExitError, false);
});

test('provider envelope error without an exit header is a call failure', () => {
  const outcome = toolCallOutcome({ isError: true }, 'Error: transport failed');
  assert.equal(outcome.isCallError, true);
  assert.equal(outcome.isExitError, false);
});

test('read-only navigation misses stay neutral even with an error envelope', () => {
  const rawText = 'Error: no such path C:\\Users\\missing\\.mixdog\\.';
  assert.deepEqual(toolCallOutcome({ isError: true, toolName: 'find' }, rawText), {
    isCallError: false,
    isExitError: false,
    exitCode: null,
  });
  assert.equal(toolCallOutcome(
    { isError: true, toolName: 'read' },
    'Error: EACCES: permission denied, open C:\\private.txt',
  ).isCallError, true);
});

test('failure detail keeps Ok / Failed / command-failure buckets distinct', () => {
  assert.equal(failureDetailText({ succeeded: 1, realErrors: 1, exitErrors: 1, exitCode: 3 }), '1 Ok · 1 Failed · 1 Exited non-zero');
  assert.equal(failureDetailText({ succeeded: 0, realErrors: 0, exitErrors: 1, exitCode: 3 }), 'Exited 3');
  // Exit 0 no longer feeds exitErrors, so an all-success group is pure Ok.
  assert.equal(failureDetailText({ succeeded: 2, realErrors: 0, exitErrors: 0 }), '2 Ok');
});

test('shared TUI/desktop tone keeps command failures warning and tool failures red', () => {
  assert.equal(shellDisplayStatus({ exitFailedCount: 1 }), 'exit');
  assert.equal(displayTerminalStatus('exit'), 'Exited');
  assert.equal(deriveToolOutcomeTone({ terminalStatus: 'exit', exitFailedCount: 1 }), 'warning');
  assert.equal(deriveToolOutcomeTone({ terminalStatus: 'failed', callFailedCount: 1 }), 'error');
});

test('aggregate members preserve atomic tool identity, inputs, outputs, and order', () => {
  const members = aggregateToolMembers([
    {
      callId: 'call-read',
      name: 'read',
      args: { file_path: 'a.ts' },
      resultText: 'source',
      resolved: true,
      isError: false,
    },
    {
      callId: 'call-shell',
      name: 'shell',
      args: { command: 'exit 2' },
      resultText: 'boom',
      rawResultText: '[exit code: 2]\nboom',
      resolved: true,
      isError: false,
      isExitError: true,
    },
  ]);
  assert.deepEqual(members.map(({ id, name, args, result, rawResult, exitErrorCount }) => ({
    id, name, args, result, rawResult, exitErrorCount,
  })), [
    { id: 'call-read', name: 'read', args: { file_path: 'a.ts' }, result: 'source', rawResult: 'source', exitErrorCount: 0 },
    { id: 'call-shell', name: 'shell', args: { command: 'exit 2' }, result: 'boom', rawResult: '[exit code: 2]\nboom', exitErrorCount: 1 },
  ]);
});
