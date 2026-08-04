// Regression: informational shell exit-1 probes (grep-family no-match inside
// compound commands — useful stdout, blank stderr) must not arm the
// unresolved-tool-failure stop hook, while real failures still do and an
// informational result never clears an armed failure. Live misfire source:
// terminal-bench kv-store-grpc /proc PID scan (exit 1) blocked a valid final
// report and forced +2 turns.
import assert from 'node:assert/strict';
import test from 'node:test';
import { isInformationalShellExitOne } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { createToolFailureStopHook } from '../src/runtime/agent/orchestrator/session/loop/stop-hooks.mjs';

const INFORMATIONAL = 'Error: [shell-run-failed] [exit code: 1]\n\n/proc/1417/cmdline\nPID 1417: python3 server.py';

test('isInformationalShellExitOne signature matrix', () => {
  assert.equal(isInformationalShellExitOne(INFORMATIONAL), true);
  // stderr block present → real failure evidence
  assert.equal(isInformationalShellExitOne('Error: [shell-run-failed] [exit code: 1]\n\nout\n\n[stderr]\nboom'), false);
  // stderr spilled to file → stderr existed
  assert.equal(isInformationalShellExitOne('Error: [shell-run-failed] [exit code: 1]\n\nout\n\n[stderr: /tmp/x.log (3 KB)]'), false);
  // no stdout at all → nothing informational about it
  assert.equal(isInformationalShellExitOne('Error: [shell-run-failed] [exit code: 1]\n\n(no output)'), false);
  // other exit codes / signals / tool-plane failures never match
  assert.equal(isInformationalShellExitOne('Error: [shell-run-failed] [exit code: 2]\n\nout'), false);
  assert.equal(isInformationalShellExitOne('Error: [shell-run-failed] [signal: SIGKILL]\n\nout'), false);
  assert.equal(isInformationalShellExitOne('Error: [shell-tool-failed] [exit code: 1]\n\nout'), false);
  // destructive-warning prefix disqualifies (conservative)
  assert.equal(isInformationalShellExitOne('⚠️ may recursively force-remove files\nError: [shell-run-failed] [exit code: 1]\n\nout'), false);
  assert.equal(isInformationalShellExitOne(null), false);
});

test('informational exit-1 does not arm the stop hook', () => {
  const hook = createToolFailureStopHook();
  hook.observeToolResult({ role: 'tool', toolKind: 'error', toolCallId: 'c1', content: INFORMATIONAL });
  hook.endBatch([{ id: 'c1', name: 'shell' }]);
  assert.equal(hook.unresolvedFailure, false);
  assert.equal(hook.takeContinuationPrompt(), null);
});

test('real failure still arms; informational neither clears nor re-arms', () => {
  const hook = createToolFailureStopHook();
  hook.observeToolResult({ role: 'tool', toolKind: 'error', toolCallId: 'c1', content: 'Error: [shell-run-failed] [exit code: 2]\n\nboom' });
  hook.endBatch([{ id: 'c1', name: 'shell' }]);
  assert.equal(hook.unresolvedFailure, true);
  // A later informational exit-1 batch is neutral: the armed failure stays.
  hook.observeToolResult({ role: 'tool', toolKind: 'error', toolCallId: 'c2', content: INFORMATIONAL });
  hook.endBatch([{ id: 'c2', name: 'shell' }]);
  assert.equal(hook.unresolvedFailure, true);
  const prompt = hook.takeContinuationPrompt();
  assert.match(String(prompt), /failed and no tool call has succeeded/);
  // Hook fires once per turn.
  assert.equal(hook.takeContinuationPrompt(), null);
});
