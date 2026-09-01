import test from 'node:test';
import assert from 'node:assert/strict';
import {
  os,
  path,
  _placeDestructiveWarningsAfterStatus,
  _isBenignSearchExitOne,
  executeBashTool,
  mkdtempSync,
  rmSync,
  tmpdir,
  join,
  classifyToolFailure,
  classifyResultKind,
  isShellFailureResult,
  normalizeToolEnvelope,
  shellCommandExitCode,
  stripShellExitHeader,
  executeGlobTool,
  BENIGN,
  NOT_BENIGN,
} from './_shared.mjs';


test('A: benign search / git-diff exit-1 pipelines are benign', () => {
    for (const cmd of BENIGN) {
        assert.equal(
            _isBenignSearchExitOne(cmd, 1, null, ''), true,
            `expected benign: ${cmd}`);
    }
});

test('A: ambiguous / non-search / bare-diff exit-1 stay Error', () => {
    for (const cmd of NOT_BENIGN) {
        assert.equal(
            _isBenignSearchExitOne(cmd, 1, null, ''), false,
            `expected NOT benign: ${cmd}`);
    }
});

test('A: exit!=1, a signal, or non-blank stderr are never benign', () => {
    // exit 2 (grep real error), not a no-match signal.
    assert.equal(_isBenignSearchExitOne('grep x file', 2, null, ''), false);
    // stderr present → a real failure, stay Error even at exit 1.
    assert.equal(_isBenignSearchExitOne('grep x file', 1, null, 'grep: file: No such file'), false);
    // a terminating signal is always Error.
    assert.equal(_isBenignSearchExitOne('grep x file', 1, 'SIGTERM', ''), false);
    // node -e that happens to mention grep — head is `node`, not a search cmd.
    assert.equal(_isBenignSearchExitOne('node -e "process.exit(1); grep"', 1, null, ''), false);
});

test('glob empty-result diagnostics reuse settled stat records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-empty-glob-'));
    try {
        const result = await executeGlobTool({
            pattern: '**/*.definitely-missing',
            path: dir,
            head_limit: 10,
            offset: 0,
        }, process.cwd());
        assert.match(result, /\(no files found\)/);
        assert.match(result, /path exists \(dir\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ==== from shell-failure-diagnostics-test.mjs ====
test('shell outcome is read from status markers, never a leading Error: line', () => {
  // Completed process exits are results; control-plane/interruption is failure.
  assert.equal(isShellFailureResult('Error: [shell-run-failed] [exit code: 2]\n\nboom'), false);
  assert.equal(isShellFailureResult('Error: [shell-tool-failed] PowerShell preflight blocked this command'), true);
  assert.equal(isShellFailureResult('⚠️ destructive command warning\nError: [shell-run-failed] [signal: SIGKILL]'), true);
  assert.equal(isShellFailureResult('[exit code: 7]\n\n(no output)'), false);
  // Command stdout that merely starts with "Error:" is NOT a shell failure.
  assert.equal(isShellFailureResult('Error: not really — this is stdout\n'), false);
  assert.equal(isShellFailureResult('ok\n'), false);
});

test('foreground shell completion always leads with exit status and preserves explicit success', async () => {
  const zero = normalizeToolEnvelope(await executeBashTool(
    { command: `node -e 'process.stderr.write("warning: diagnostic\\\\n")'`, timeout_ms: 10_000 },
    process.cwd(),
  ));
  assert.equal(zero.explicitSuccess, true);
  assert.match(zero.result, /^\[exit code: 0\]\n\nwarning: diagnostic/);
  assert.equal(classifyResultKind(zero.result, zero.explicitSuccess), 'normal');

  const errorText = normalizeToolEnvelope(await executeBashTool(
    { command: `node -e 'process.stdout.write("Error: diagnostic")'`, timeout_ms: 10_000 },
    process.cwd(),
  ));
  assert.equal(errorText.explicitSuccess, true);
  assert.match(errorText.result, /^\[exit code: 0\]\n\nError: diagnostic/);
  assert.equal(classifyResultKind(errorText.result, errorText.explicitSuccess), 'normal');

  const nonzero = normalizeToolEnvelope(await executeBashTool(
    { command: `node -e 'process.exit(7)'`, timeout_ms: 10_000 },
    process.cwd(),
  ));
  assert.equal(nonzero.explicitSuccess, true);
  assert.match(nonzero.result, /^\[exit code: 7\]\n\[completed:/);
});

test('foreground shell status remains first when destructive warnings are present', () => {
  const rendered = _placeDestructiveWarningsAfterStatus(
    'rm -rf ./concrete-test-output',
    '[exit code: 0]\n\n(no output)',
  );
  assert.match(rendered, /^\[exit code: 0\]\n⚠️ /);
});

test('TUI renders new and legacy completed command exits as Exit N', () => {
  assert.equal(shellCommandExitCode('[exit code: 0]\n\nwarning: diagnostic'), 0);
  assert.equal(shellCommandExitCode('[exit code: 7]\n[completed: command result]\n\nboom'), 7);
  assert.equal(shellCommandExitCode('Error: [shell-run-failed] [exit code: 2]\n\nboom'), 2);
  assert.equal(shellCommandExitCode('[session: s1]\n[exit code: 3]\n[closed]\n\nboom'), 3);
  assert.equal(shellCommandExitCode('[signal: SIGKILL]\n\nboom'), null);
  assert.equal(
    stripShellExitHeader('[exit code: 7]\n[completed: command result]\n\nboom'),
    'boom',
  );
});

test('shell trace classification uses only the leading status marker', () => {
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [exit code: 1]\n\ncommand timed out while parsing an aborted field',
    'shell',
  ), 'command-exit');
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [signal: SIGKILL]\n\n(no output)',
    'shell',
  ), 'process/signal');
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [timeout: 500ms signal: SIGTERM cause: timeout]',
    'shell',
  ), 'timeout/abort');
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [signal: SIGTERM cause: cancellation]',
    'shell',
  ), 'timeout/abort');
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [signal: SIGKILL cause: output-limit]',
    'shell',
  ), 'runtime/failure');
  assert.equal(classifyToolFailure(
    'Session "sess_cancelled" closed: aborted during call',
    'shell',
  ), 'expected-cancellation');
  assert.equal(classifyToolFailure(
    'call aborted',
    'read',
  ), 'timeout/abort');
  assert.equal(classifyToolFailure(
    '⚠️ destructive command warning\nError: [shell-run-failed] [signal: SIGKILL]',
    'shell',
  ), 'process/signal');
  assert.equal(classifyToolFailure(
    'Error: [tool-input-validation] apply_patch received a compacted-history placeholder',
    'apply_patch',
  ), 'expected-preflight');
  assert.equal(classifyToolFailure(
    'Error: apply_patch sequence stopped\ncontext not found; expected first old line: "before"',
    'apply_patch',
  ), 'patch/context');
  assert.equal(classifyToolFailure(
    'Error: native patch failed — atomic write C:\\locked.txt: Access is denied. (os error 5)',
    'apply_patch',
  ), 'path/permission');
  assert.equal(classifyToolFailure(
    'Error: unknown memory action: add',
    'memory',
  ), 'schema/args');
});

test('glob missing bases are navigation misses, not runtime failures', () => {
  assert.equal(classifyToolFailure(
    'Error: path does not exist: C:/missing (ENOENT)',
    'glob',
  ), 'navigation/miss');
  assert.equal(classifyToolFailure('Error: no such path C:/missing/.', 'find'), 'navigation/miss');
  assert.equal(classifyToolFailure('Error: ENOENT: no such file or directory, stat C:/missing', 'read'), 'navigation/miss');
  assert.equal(classifyToolFailure('Error: path does not exist: C:/missing', 'grep'), 'navigation/miss');
  assert.equal(classifyToolFailure('Error: file not found in graph: src/missing.ts', 'code_graph'), 'navigation/miss');
  assert.equal(classifyToolFailure('Error: EACCES: permission denied, stat C:/private', 'read'), 'path/permission');
});
