import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyToolFailure } from '../src/runtime/agent/orchestrator/agent-trace-format.mjs';
import { ExecResult, execShellCommand } from '../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import { _composeShellFailure, _shellFailureStatus } from '../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs';
import { isShellFailureResult } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';

test('shell outcome is read from status markers, never a leading Error: line', () => {
  // Real failures, including a warning-prefixed shell failure.
  assert.equal(isShellFailureResult('Error: [shell-run-failed] [exit code: 2]\n\nboom'), true);
  assert.equal(isShellFailureResult('Error: [shell-tool-failed] PowerShell preflight blocked this command'), true);
  assert.equal(isShellFailureResult('⚠️ destructive command warning\nError: [shell-run-failed] [signal: SIGKILL]'), true);
  assert.equal(isShellFailureResult('[exit code: 7]\n\n(no output)'), true);
  // Command stdout that merely starts with "Error:" is NOT a shell failure.
  assert.equal(isShellFailureResult('Error: not really — this is stdout\n'), false);
  assert.equal(isShellFailureResult('ok\n'), false);
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

test('apply_patch taxonomy separates parse, context, verification, path and resource guards', () => {
  const patch = (text) => classifyToolFailure(text, 'apply_patch');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/1 (a.mjs); no files were written.\n'
    + "apply_patch: V4A parse failed — missing *** End Patch",
  ), 'patch/parse');
  assert.equal(patch(
    'Error: apply_patch: parse failed — hunk header mismatch; prefer V4A envelope for multi-hunk edits',
  ), 'patch/parse');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 2/13 (SourceControlDock.tsx); no files were written.\n'
    + 'V4A hunk SourceControlDock.tsx: context not found: (no anchor); expected first old line: "const [stashes"; '
    + 'nearest line 216: "const [stashes"; first divergent line: old[4] expected "}" vs file line 220 actual "  );"',
  ), 'patch/stale-context');
  assert.equal(patch(
    'Error: native patch failed — a/scripts/x.mjs: hunk rejected in a/scripts/x.mjs',
  ), 'patch/stale-context');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\n'
    + 'V4A hunk x.mjs: context not found: (no anchor); expected first old line: "const a = 1;"; '
    + 'use exact current context or a broader @@ anchor; no stubs. '
    + 'Copy the context lines verbatim from the excerpt below — do not retype them from memory.\n'
    + '  1 | const b = 2;',
  ), 'patch/context');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\n'
    + 'V4A hunk anchor not found: function build > const rows; '
    + 'use an existing @@ anchor from the current file or add exact context lines; no stubs.',
  ), 'patch/context');
  assert.equal(patch('Error: patch contained no file sections'), 'patch/parse');
  assert.equal(patch('Error: apply_patch: patch contained no file sections'), 'patch/parse');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\n'
    + 'apply_patch: V4A parse failed — V4A patch contained no file sections',
  ), 'patch/parse');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/2 (x.mjs); no files were written.\n'
    + 'apply_patch: only one V4A rename (*** Move to:) per patch is supported; split into separate patches.',
  ), 'patch/verification');
  assert.equal(patch(
    'Error: apply_patch preflight rejected section 1/1 (x.mjs); no files were written.\n'
    + 'V4A update target unreadable: x.mjs (ENOENT).',
  ), 'path/enoent');
  assert.equal(patch(
    'Error: apply_patch: patch too large (9000000 bytes > 4194304 byte cap); split into smaller patches',
  ), 'patch/limit');
  assert.equal(patch(
    'Error: advisory lock timeout: C:\\Project\\mixdog\\src\\.UtilityDock.tsx.mixdog-lock held by pid 53232',
  ), 'resource/lock');
  assert.equal(patch(
    'Error: apply_patch: a block failed in sequential group 1/2; every edit listed below was already applied to disk (writes committed) and left in place:',
  ), 'patch/partial-apply');
  assert.equal(patch(
    'Error: apply_patch sequence stopped at section 2/3 (a.mjs); 1 earlier section(s) were applied to disk (committed) and left in place; '
    + '1 later section(s) were skipped (not attempted).\n--- applied (committed to disk) ---\nApplied 1 File\n'
    + '--- failed section: a.mjs ---\nV4A hunk a.mjs: context not found: (no anchor); expected first old line: "x"',
  ), 'patch/partial-apply');
  assert.equal(patch(
    'Error: apply_patch: "format" must be "unified" or "v4a"',
  ), 'schema/args');
  assert.equal(patch(
    'Error: [tool-input-validation] apply_patch received a compacted-history placeholder, not executable patch content.',
  ), 'expected-preflight');
});

test('committed or uncertain patch writes outrank lock and permission detail', () => {
  const patch = (text) => classifyToolFailure(text, 'apply_patch');
  // Rollback itself failed: on-disk state is uncertain even though the
  // triggering detail is a lock guard.
  assert.equal(patch(
    'Error: apply_patch sequence stopped at section 2/2 (a.mjs); 1 earlier section(s) were applied, but rollback was incomplete; '
    + '0 later section(s) were skipped (not attempted).\n--- applied before rollback ---\nApplied 1 File\n'
    + '--- failed section: a.mjs ---\nadvisory lock timeout: C:\\Project\\mixdog\\src\\.a.mjs.mixdog-lock held by pid 91\n'
    + '--- rollback incomplete ---\napply_patch: rollback restore failed for a.mjs',
  ), 'patch/partial-apply');
  // Committed-by-design (partial mode) with a permission word in the failure.
  assert.equal(patch(
    'Error: apply_patch sequence stopped at section 3/4 (b.mjs); 2 earlier section(s) were applied to disk (committed) and left in place; '
    + '1 later section(s) were skipped (not attempted).\n--- failed section: b.mjs ---\n'
    + 'native patch failed — atomic write C:\\locked.txt: Access is denied. (os error 5)',
  ), 'patch/partial-apply');
  // No committed writes: the lock/permission taxonomy is untouched.
  assert.equal(patch(
    'Error: advisory lock timeout: C:\\Project\\mixdog\\src\\.a.mjs.mixdog-lock held by pid 91',
  ), 'resource/lock');
  assert.equal(patch(
    'Error: native patch failed — atomic write C:\\locked.txt: Access is denied. (os error 5)',
  ), 'path/permission');
});

test('shell-quoted patch output stays a command exit, never a patch failure', () => {
  assert.equal(classifyToolFailure(
    'Error: [shell-run-failed] [exit code: 1]\n\nerror: patch failed: src/a.mjs:12\nhunk rejected; context not found',
    'shell',
  ), 'command-exit');
  assert.equal(classifyToolFailure(
    'Error: [exit code: 1]\n\n1 test failed; hunk rejected in a/x.mjs',
    'shell',
  ), 'command-exit');
});

test('shell failure rendering preserves actual signals and runtime kill causes', () => {
  const status = (opts) => _shellFailureStatus(new ExecResult({
    stdout: '', stderr: '', exitCode: null, taskId: 'test', ...opts,
  }), 500).statusDetail;
  assert.match(status({ signal: 'SIGKILL' }), /^\[signal: SIGKILL\]$/);
  assert.match(status({ signal: 'SIGTERM', killed: true, killCause: 'cancellation' }),
    /^\[signal: SIGTERM cause: cancellation\]$/);
  assert.match(status({ signal: 'SIGTERM', killed: true, timedOut: true, killCause: 'timeout' }),
    /^\[timeout: 500ms signal: SIGTERM cause: timeout\]/);
  assert.match(status({
    killed: true,
    killCause: 'output-capture-error',
    outputCaptureError: new Error('disk full'),
  }), /^\[output capture failed cause: output-capture-error signal: SIGKILL\]$/);
  assert.match(status({ signal: 'SIGKILL', killed: true, killCause: 'output-limit' }),
    /^\[signal: SIGKILL cause: output-limit\]$/);
});

test('WMIC rewrite note follows the leading shell failure marker', () => {
  const rendered = _composeShellFailure(
    '[shell-run-failed] [exit code: 1]',
    'Error: ',
    '[auto-rewrite: deprecated wmic process query -> PowerShell; timeout capped at 30000ms]',
    '(no output)',
  );
  assert.match(rendered, /^Error: \[shell-run-failed\] \[exit code: 1\]\n\[auto-rewrite:/);
  assert.equal(classifyToolFailure(rendered, 'shell'), 'command-exit');
});

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

test('asynchronous ENOENT spawn errors remain shell tool failures', async () => {
  const missing = await withoutUnhandledProcessFailure(() => execShellCommand({
    shell: join(tmpdir(), `mixdog-missing-shell-${process.pid}`),
    shellArg: '-c',
    command: 'echo unreachable',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 1000,
  }));
  assertSpawnToolFailure(missing);
  assert.match(missing.stderr, /ENOENT|not found/i);
});

test('asynchronous EACCES spawn errors remain shell tool failures', async (t) => {
  if (process.platform === 'win32') return t.skip('executable-bit case is POSIX-only');
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-eacces-shell-'));
  try {
    const denied = join(dir, 'denied.sh');
    writeFileSync(denied, '#!/bin/sh\necho unreachable\n');
    chmodSync(denied, 0o600);
    const result = await withoutUnhandledProcessFailure(() => execShellCommand({
      shell: denied,
      shellArg: '-c',
      command: 'echo unreachable',
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 1000,
    }));
    assertSpawnToolFailure(result);
    assert.match(result.stderr, /EACCES|permission denied/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execShellCommand carries cancellation cause alongside process signal', async () => {
  const controller = new AbortController();
  const isWindows = process.platform === 'win32';
  const promise = execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'ping 127.0.0.1 -n 20 > nul' : 'sleep 10',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    abortSignal: controller.signal,
    backgroundOnTimeout: false,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert.equal(result.killed, true);
  assert.equal(result.killCause, 'cancellation');
  assert.ok(result.signal || process.platform === 'win32');
});

test('cancellation racing with auto-background adoption is returned as cancelled', async () => {
  let abortReads = 0;
  const racingSignal = {
    get aborted() { abortReads += 1; return abortReads >= 2; },
    addEventListener() {},
    removeEventListener() {},
  };
  const isWindows = process.platform === 'win32';
  const result = await execShellCommand({
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'ping 127.0.0.1 -n 20 > nul' : 'sleep 10',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    abortSignal: racingSignal,
    autoBackgroundMs: 25,
    backgroundOnTimeout: false,
  });
  assert.equal(result.backgrounded, false);
  assert.equal(result.killed, true);
  assert.equal(result.killCause, 'cancellation');
});

test('tool-failures excludes session cancellations but retains real abort failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-tool-failures-test-'));
  try {
    const history = join(dir, 'history');
    mkdirSync(history);
    const rows = [
      { ts: 1, tool_name: 'shell', category: 'process/signal', error_first_line: 'SIGKILL' },
      { ts: 2, tool_name: 'shell', category: 'runtime/failure', error_first_line: 'capture guard' },
      { ts: 3, tool_name: 'shell', category: 'timeout/abort', error_first_line: 'Session "sess_cancelled" closed: aborted during call' },
      {
        ts: 4,
        tool_name: 'shell',
        category: 'timeout/abort',
        error_first_line: '⚠️ destructive command warning',
        error_preview: '⚠️ destructive command warning\nSession "sess_warning" closed: aborted during call',
      },
      { ts: 5, tool_name: 'shell', category: 'timeout/abort', error_first_line: 'request timed out' },
      ...Array.from({ length: 45 }, (_, index) => ({
        ts: index + 6,
        tool_name: 'shell',
        category: 'command-exit',
        error_first_line: `exit ${index}`,
      })),
    ];
    writeFileSync(join(history, 'tool-failures.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
    const script = resolve('scripts/tool-failures.mjs');
    const text = spawnSync(process.execPath, [script, '--data-dir', dir, '--limit', '2'], { encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /actionable failures: 2\/3 shown/);
    assert.match(text.stdout, /command exits: 2\/45 shown \(retained\)/);
    assert.doesNotMatch(text.stdout, /aborted during call/);
    assert.equal((text.stdout.match(/^- /gm) || []).length, 4);
    const json = spawnSync(process.execPath, [script, '--data-dir', dir, '--limit', '2', '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.deepEqual(report.actionable_failures, { shown: 2, matched: 3 });
    assert.deepEqual(report.command_exits, { shown: 2, matched: 45 });
    assert.equal(report.rows.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tool-failures report separates patch failures from command exits and absorbed preflights', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-patch-failure-report-test-'));
  try {
    const history = join(dir, 'history');
    mkdirSync(history);
    const rows = [
      { ts: 1, tool_name: 'apply_patch', category: 'patch/stale-context', error_first_line: 'context not found; nearest line 216' },
      { ts: 2, tool_name: 'apply_patch', category: 'patch/parse', error_first_line: 'V4A parse failed' },
      { ts: 3, tool_name: 'apply_patch', category: 'expected-preflight', error_first_line: 'compacted-history placeholder' },
      { ts: 4, tool_name: 'shell', category: 'command-exit', error_first_line: 'npm test exited 1' },
      { ts: 5, tool_name: 'shell', category: 'command-exit', error_first_line: 'node --test exited 1' },
      { ts: 6, tool_name: 'shell', category: 'command-exit', error_first_line: 'tsc exited 2' },
      { ts: 7, tool_name: 'shell', category: 'timeout/abort', error_first_line: 'Session "sess_x" closed: aborted during call' },
    ];
    writeFileSync(join(history, 'tool-failures.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
    const script = resolve('scripts/tool-failures.mjs');
    const run = (args) => spawnSync(process.execPath, [script, '--data-dir', dir, ...args], { encoding: 'utf8' });

    const text = run(['--limit', '5']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /actionable failures: 2\/2 shown \(excludes command exits/);
    assert.match(text.stdout, /command exits: 3\/3 shown \(retained\)/);
    assert.match(text.stdout, /expected\/absorbed: 1\/1 shown \(retained\)/);
    assert.match(text.stdout, /session cancellations: 1 matched \(not shown\)/);
    assert.match(text.stdout, /patch failures \(matched\): 2 — patch\/(?:stale-context|parse):1/);
    assert.doesNotMatch(text.stdout, /aborted during call/);
    // Command exits stay visible but never inflate the actionable headline.
    assert.equal((text.stdout.match(/^- /gm) || []).length, 6);

    const json = JSON.parse(run(['--limit', '5', '--json']).stdout);
    assert.deepEqual(json.actionable_failures, { shown: 2, matched: 2 });
    assert.deepEqual(json.command_exits, { shown: 3, matched: 3 });
    assert.deepEqual(json.expected_absorbed, { shown: 1, matched: 1 });
    assert.deepEqual(json.session_cancellations, { shown: 0, matched: 1 });
    assert.deepEqual(json.patch_failures, {
      matched: 2,
      categories: { 'patch/stale-context': 1, 'patch/parse': 1 },
    });
    assert.deepEqual(json.actionable_categories, { 'patch/stale-context': 1, 'patch/parse': 1 });
    assert.deepEqual(json.actionable_families, { patch: 2 });
    assert.equal(json.command_exit_tools.apply_patch, undefined);

    const onlyActionable = run(['--limit', '5', '--only', 'actionable', '--json']);
    const scoped = JSON.parse(onlyActionable.stdout);
    assert.equal(scoped.rows.length, 2);
    assert.deepEqual(scoped.command_exits, { shown: 0, matched: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session cancellations remain traceable without entering tool-failures.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-cancellation-test-'));
  try {
    const tracePath = join(dir, 'agent-trace.jsonl');
    const failurePath = join(dir, 'tool-failures.jsonl');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readFileSync } from 'node:fs';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      traceAgentTool({
        sessionId: 'sess_cancelled',
        iteration: 1,
        toolName: 'read',
        toolKind: 'function',
        toolMs: 1,
        toolArgs: { path: 'ignored' },
        agent: 'worker',
        model: 'test',
        cwd: process.cwd(),
        resultKind: 'error',
        resultText: 'Session "sess_cancelled" closed: aborted during call',
      });
      await drainAgentTrace();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const trace = JSON.parse(readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8').trim());
      process.stdout.write(JSON.stringify({
        failureLogExists: existsSync(process.env.MIXDOG_TOOL_FAILURE_LOG_PATH),
        category: trace.result_error_category,
      }));
    `], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_AGENT_TRACE_PATH: tracePath,
        MIXDOG_TOOL_FAILURE_LOG_PATH: failurePath,
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
        MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      failureLogExists: false,
      category: 'expected-cancellation',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
