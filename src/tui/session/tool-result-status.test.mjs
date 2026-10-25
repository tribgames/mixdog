import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateRawResult,
  aggregateRawResultForDisplay,
  aggregateResultPatch,
  aggregateToolMembers,
  assignUiDiffFromMessage,
  failureDetailText,
  shellCommandExitCode,
  stringUiDiffPatch,
  toolCallOutcome,
  toolMetaPatchFromMessage,
  toolResultDisplay,
  uiDiffFromMessage,
  uiDiffPatchFromMessage,
  withCancelledResultMarker,
} from './tool-result-status.mjs';
import {
  deriveToolCardModel,
  deriveToolOutcomeTone,
  displayTerminalStatus,
  shellDisplayStatus,
} from '../../runtime/shared/tool-card-model.mjs';

function settledCard(name, args, result) {
  const outcome = toolCallOutcome({ name, toolKind: /^error:/i.test(result) ? 'error' : 'normal' }, result);
  const callFailedCount = outcome.isCallError ? 1 : 0;
  const exitFailedCount = outcome.isExitError ? 1 : 0;
  const model = deriveToolCardModel({
    name,
    args,
    result,
    rawResult: result,
    isError: outcome.isCallError,
    callErrorCount: callFailedCount,
    exitErrorCount: exitFailedCount,
    count: 1,
    completedCount: 1,
    completedAt: 1,
    nowMs: 2,
  });
  const tone = deriveToolOutcomeTone({
    groupCount: 1,
    callFailedCount,
    exitFailedCount,
    terminalStatus: model.terminalStatus,
  });
  return { model, tone };
}

test('status words inside command output or fetched text do not set the card status', () => {
  const shell = settledCard('shell', { command: 'gh run view' }, '[exit code: 0]\n\nstatus: running\nstatus: failed\n');
  assert.equal(shell.model.terminalStatus, 'completed');
  assert.equal(shell.tone, 'success');
  const page = settledCard('web_fetch', { url: 'https://example.com' }, '# Page\n\nstatus: cancelled\n');
  assert.equal(page.model.terminalStatus, 'completed');
  const background = settledCard(
    'shell',
    { command: 'npm test' },
    'background task\ntask_id: t1\nstatus: running\nstarted: 1\n\nstatus: failed\n'
  );
  assert.equal(background.model.terminalStatus, 'running');
});

test('user takeover and session cancellation render as cancelled, not failed', () => {
  for (const [name, result] of [
    ['computer', 'Error: computer_user_control_active: Computer Use is paused while the user has control'],
    ['computer', 'Error: computer_session_aborted: queued command was cancelled before execution'],
    ['browser', 'Error: Browser command interrupted by local user input. An earlier action may have completed.'],
  ]) {
    const { model, tone } = settledCard(name, {}, result);
    assert.equal(model.terminalStatus, 'cancelled');
    assert.equal(model.detailLine, 'Cancelled');
    assert.equal(tone, 'warning');
  }
  assert.equal(settledCard('browser', {}, 'Error: navigation failed: timed out').tone, 'error');
});

test('git exits render like shell exits and diff exit-code signals stay successful', () => {
  const exit = settledCard('git', { command: 'git show missing' }, 'exit 128\nfatal: missing ref\n');
  assert.equal(exit.model.terminalStatus, 'exit');
  assert.equal(exit.tone, 'warning');
  const signal = settledCard('git', { command: 'git diff --quiet' }, 'exit 1\n[outcome: no-match]\n');
  assert.equal(signal.model.terminalStatus, 'completed');
  assert.equal(signal.tone, 'success');
  const conflicts = settledCard(
    'git',
    { command: 'git merge-tree --write-tree a b' },
    'exit 1\n[outcome: conflicts]\nmerge has conflicts (see the CONFLICT lines); this is a result, not a command failure\n'
  );
  assert.equal(conflicts.model.terminalStatus, 'completed');
  assert.equal(conflicts.tone, 'success');
});

test('graph file misses and out-of-range reads are empty results, not failures', () => {
  const graph = settledCard('code_graph', { mode: 'callers' }, 'Error: callers: file not found: a.mjs');
  assert.equal(graph.tone, 'success');
  const symbol = settledCard(
    'code_graph',
    { mode: 'references' },
    'Error: code_graph references: symbol "run" not found in src/a.mjs'
  );
  assert.equal(symbol.tone, 'success');
  const gitGrep = settledCard('git', { command: 'git grep absent' }, 'exit 1\n[outcome: no-match]\n');
  assert.equal(gitGrep.tone, 'success');
  const read = settledCard('read', { file_path: 'a.mjs' }, '(no lines in range; file has 10 lines)');
  assert.equal(read.model.resultSummary, '0 lines');
});

test('the aggregate raw result numbers each resolved member output exactly as before', () => {
  const big = `${'line of tool output\n'.repeat(20_000)}tail`;
  const calls = [
    { resolved: true, name: 'grep', rawResultText: 'a.js:1: hit\n\n  ' },
    { resolved: false, name: 'read', rawResultText: 'still running' },
    { resolved: true, name: '', category: 'Search', resultText: 'only display text' },
    { resolved: true, name: 'read', rawResultText: '   \n' },
    { resolved: true, rawResultText: big },
  ];
  // The previous join-based construction is the reference.
  const reference = [];
  for (const rec of calls) {
    if (rec.resolved !== true) continue;
    const text = String(rec.rawResultText ?? rec.resultText ?? '').replace(/\s+$/, '');
    if (!text.trim()) continue;
    reference.push(`${reference.length + 1}. ${String(rec.name || rec.category || 'tool').trim() || 'tool'}\n${text}`);
  }
  const joined = aggregateRawResult(calls);
  assert.equal(joined, reference.join('\n\n'));
  assert.ok(
    joined.startsWith('1. grep\na.js:1: hit\n\n2. Search\nonly display text\n\n3. tool\nline of tool output\n')
  );
  assert.ok(joined.endsWith('\ntail'));
  assert.equal(aggregateRawResult([]), '');
  assert.equal(aggregateRawResult([{ resolved: false, rawResultText: 'x' }]), '');
  assert.equal(aggregateRawResult(null), '');
});

test('expanded aggregates rebuild numbered rows for read members only', () => {
  const joined = aggregateRawResult([
    { resolved: true, name: 'read', rawResultText: 'a.js [ok]\n[lines 1-2]\nconst a = 1;\n  b();' },
    { resolved: true, name: 'git', rawResultText: '[lines 1-1]\n12\t3\tsrc/a.js' },
  ]);
  assert.equal(
    aggregateRawResultForDisplay(joined),
    '1. read\na.js [ok]\n1→const a = 1;\n2→  b();\n\n2. git\n[lines 1-1]\n12\t3\tsrc/a.js'
  );
});

// Outcome taxonomy contract (user report: "Exit 0" rendered as if failed):
// - exit 0            → plain success ("Ok" bucket, success tone)
// - non-zero exit     → command failure (warning tone, never red)
// - envelope isError  → real call failure ("Failed", red)

test('git raw and batched failures retain exit classification', () => {
  for (const text of [
    'exit 128\nfatal: missing\n',
    '## git status\n## main\n\n## git show missing\nexit 128\nfatal: missing\nerror: command failed: git show missing',
  ]) {
    assert.deepEqual(toolCallOutcome({ name: 'git' }, text), {
      isCallError: false,
      isExitError: true,
      exitCode: 128,
    });
  }
  assert.equal(toolCallOutcome({ name: 'git' }, 'error: git requires command').isCallError, true);
  assert.equal(toolCallOutcome({ name: 'git' }, '## main\n M a.txt\n').isExitError, false);
});

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
  assert.equal(
    toolCallOutcome({ isError: true, toolName: 'read' }, 'Error: EACCES: permission denied, open C:\\private.txt')
      .isCallError,
    true
  );
});

test('failure detail keeps Ok / Failed / command-failure buckets distinct', () => {
  assert.equal(
    failureDetailText({ succeeded: 1, realErrors: 1, exitErrors: 1, exitCode: 3 }),
    '1 Ok · 1 Failed · 1 Exited non-zero'
  );
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

test('message uiDiff copies a present string and blanks a malformed value', () => {
  assert.equal(uiDiffFromMessage(undefined), undefined);
  assert.equal(uiDiffFromMessage({ result: 'ok' }), undefined);
  assert.equal(uiDiffFromMessage({ uiDiff: 'diff --git a b' }), 'diff --git a b');
  assert.equal(uiDiffFromMessage({ uiDiff: 12 }), '');
  assert.deepEqual(uiDiffPatchFromMessage({ uiDiff: 'patch' }), { uiDiff: 'patch' });
  assert.deepEqual(uiDiffPatchFromMessage({}), {});
  const rec = {};
  assignUiDiffFromMessage(rec, { uiDiff: 'kept' });
  assert.equal(rec.uiDiff, 'kept');
  assert.deepEqual(stringUiDiffPatch('only-strings'), { uiDiff: 'only-strings' });
  assert.deepEqual(stringUiDiffPatch(1), {});
});

test('tool result display keeps shell exits as detail and envelope errors as failures', () => {
  assert.deepEqual(toolResultDisplay({ isError: true }, '[exit code: 2]\nboom', 'shell'), {
    isCallError: false,
    isExitError: true,
    exitCode: 2,
    isError: false,
    text: 'boom',
  });
  const failed = toolResultDisplay({ isError: true }, 'transport failed', 'grep');
  assert.equal(failed.isCallError, true);
  assert.equal(failed.isError, true);
  assert.match(failed.text, /^Error:/);
});

test('cancellation preserves terminal status from arguments and trusted result fields', () => {
  for (const item of [{ args: { status: ' DONE ' } }, { result: '[status: failed]' }, { text: 'status: canceled' }]) {
    assert.equal(withCancelledResultMarker('detail', item), 'detail');
  }
  assert.equal(withCancelledResultMarker('[status: cancelled]\ndetail'), '[status: cancelled]\ndetail');
});

test('cancellation marks unfinished cards without trusting raw tool output', () => {
  assert.equal(withCancelledResultMarker(' \n'), '[status: cancelled]\n');
  assert.equal(
    withCancelledResultMarker('detail', { args: { status: 'running' }, rawResult: '[status: completed]' }),
    '[status: cancelled]\ndetail'
  );
});

test('aggregate result patch shares Ok/Failed/Exited counts across live and restore paths', () => {
  const calls = [
    { isError: false, isCallError: false, isExitError: false, summary: '12 lines' },
    { isError: true, isCallError: true, isExitError: false, summary: null },
  ];
  const patch = aggregateResultPatch({ calls }, calls, 2);
  assert.equal(patch.isError, true);
  assert.equal(patch.errorCount, 1);
  assert.equal(patch.callErrorCount, 1);
  assert.equal(patch.exitErrorCount, 0);
  assert.equal(patch.count, 2);
  assert.equal(patch.result, '1 Ok · 1 Failed');
  assert.equal(patch.text, patch.result);
  assert.equal(patch.toolMembers.length, 2);
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
      uiDiff: 'diff --git a b',
    },
  ]);
  assert.deepEqual(
    members.map(({ id, name, args, result, rawResult, exitErrorCount }) => ({
      id,
      name,
      args,
      result,
      rawResult,
      exitErrorCount,
    })),
    [
      {
        id: 'call-read',
        name: 'read',
        args: { file_path: 'a.ts' },
        result: 'source',
        rawResult: 'source',
        exitErrorCount: 0,
      },
      {
        id: 'call-shell',
        name: 'shell',
        args: { command: 'exit 2' },
        result: 'boom',
        rawResult: '[exit code: 2]\nboom',
        exitErrorCount: 1,
      },
    ]
  );
  assert.equal(Object.hasOwn(members[0], 'uiDiff'), false);
  assert.equal(members[1].uiDiff, 'diff --git a b');
});

test('toolMeta carries only a stable code and capability names from a tool result', () => {
  const meta = { code: 'computer_capability_unavailable', missing: ['windows', 'pointer'] };
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: meta }), { toolMeta: meta });
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: { ...meta, extra: 1, missing: ['windows', 7, ''] } }), {
    toolMeta: { code: 'computer_capability_unavailable', missing: ['windows'] },
  });
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: { missing: ['windows'] } }), {});
  assert.deepEqual(toolMetaPatchFromMessage({ content: 'text' }), {});
  assert.deepEqual(toolMetaPatchFromMessage(null), {});
});

test("toolMeta keeps a visualize result's owner session (stored, restored), never a malformed id", () => {
  const owner = { code: 'visualize_owner', missing: [], ownerSessionId: 'sess_lead-1' };
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: owner }), { toolMeta: owner });
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: { ...owner, ownerSessionId: '../x y' } }), {
    toolMeta: { code: 'visualize_owner', missing: [] },
  });
  assert.deepEqual(toolMetaPatchFromMessage({ toolMeta: { ...owner, ownerSessionId: 7 } }), {
    toolMeta: { code: 'visualize_owner', missing: [] },
  });
});
