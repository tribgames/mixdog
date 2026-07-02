import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderShellCompletionEnvelope,
  shellCompletionInstruction,
  renderShellPromptStallEnvelope,
  shellPromptStallInstruction,
  isInternalRuntimeNotificationText,
  isBracketedShellNotificationEnvelope,
} from './task-notification-envelope.mjs';

test('completion envelope matches historical assembly plus the corrected blank-line separator', () => {
  const jobId = 'shell_job_1';
  const status = 'completed';
  const exitCode = 0;
  const elapsedMs = 1234;
  const detail = {
    command: 'npm test',
    summary: 'ok',
    stdoutPreview: 'out',
    stderrPreview: 'err',
    mergeStderr: false,
  };
  const expected = [
    `[task_id: ${jobId}]`,
    `[status: ${status}]`,
    `[exit: ${exitCode === null ? 'n/a' : exitCode}]`,
    elapsedMs !== null ? `[elapsed: ${elapsedMs} ms]` : null,
    detail.command ? `[command: ${detail.command}]` : null,
    // The historical inline assembly filtered this '' out, gluing `Summary:`
    // onto the header block; the corrected renderer keeps exactly one blank
    // line between the bracket headers and the body sections.
    '',
    detail.summary ? `Summary: ${detail.summary}` : null,
    detail.stdoutPreview ? `\n[stdout preview]\n${detail.stdoutPreview}` : null,
    (detail.mergeStderr !== true && detail.stderrPreview) ? `\n[stderr preview]\n${detail.stderrPreview}` : null,
  ].filter((l) => l !== null).join('\n');
  const actual = renderShellCompletionEnvelope({ jobId, status, exitCode, elapsedMs, ...detail });
  assert.equal(actual, expected);
  assert.equal(isInternalRuntimeNotificationText(actual), true);
  assert.equal(isBracketedShellNotificationEnvelope(actual), true);
});

test('summary-only completion envelope keeps one blank line before the body', () => {
  const actual = renderShellCompletionEnvelope({
    jobId: 'shell_job_1',
    status: 'completed',
    exitCode: 0,
    summary: 'ok',
  });
  const expected = [
    '[task_id: shell_job_1]',
    '[status: completed]',
    '[exit: 0]',
    '',
    'Summary: ok',
  ].join('\n');
  assert.equal(actual, expected);
  // The blank-line separator must survive so body detectors see a body.
  assert.match(actual, /\n\s*\n/);
});

test('bodyless completion envelope has no trailing blank line', () => {
  const actual = renderShellCompletionEnvelope({
    jobId: 'shell_job_1',
    status: 'completed',
    exitCode: 0,
  });
  assert.equal(actual, ['[task_id: shell_job_1]', '[status: completed]', '[exit: 0]'].join('\n'));
  assert.doesNotMatch(actual, /\n\s*\n/);
});

test('completion instruction uses shared async wording + exit detail', () => {
  assert.equal(
    shellCompletionInstruction({ jobId: 'shell_job_1', status: 'completed', exitCode: 0 }),
    'The async shell task shell_job_1 has finished (completed, exit 0) - review this result in your next step.',
  );
  assert.match(shellCompletionInstruction({ jobId: 'x', status: 'failed', exitCode: null }), /exit n\/a/);
});

test('prompt-stall envelope is byte-compatible with historical inline assembly', () => {
  const jobId = 'shell_job_1';
  const stalledMs = 5000;
  const elapsedMs = 6000;
  const tail = { text: 'Password:' };
  const detail = { command: 'ssh host' };
  const expected = [
    `[task_id: ${jobId}]`,
    '[status: running]',
    `[stalled: no output growth for ${stalledMs} ms]`,
    elapsedMs >= 0 ? `[elapsed: ${elapsedMs} ms]` : null,
    detail.command ? `[command: ${detail.command}]` : null,
    '',
    'This background shell task appears to be waiting for interactive input. Background tasks cannot answer prompts automatically; cancel it or rerun with non-interactive flags/input.',
    tail.text ? `\n${tail.text}` : null,
  ].filter((line) => line !== null && line !== '').join('\n');
  const actual = renderShellPromptStallEnvelope({ jobId, stalledMs, elapsedMs, command: detail.command, tailText: tail.text });
  assert.equal(actual, expected);
  assert.equal(isInternalRuntimeNotificationText(actual), true);
});

test('prompt-stall instruction wording unchanged', () => {
  assert.equal(
    shellPromptStallInstruction({ jobId: 'shell_job_1' }),
    'The background shell task shell_job_1 appears to be waiting for interactive input; inspect the prompt, then cancel or rerun it non-interactively.',
  );
});
