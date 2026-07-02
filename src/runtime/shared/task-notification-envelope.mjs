// Shared production of background-task notification envelopes.
//
// Producers (shell-jobs fire()/prompt-stall) and consumers (session
// ingest/manager detection, TUI parsers reading stored sessions) must agree
// byte-for-byte on the emitted wire format: bracket header fields, the blank
// line body separator, and the completion instruction wording. To keep one
// source of truth, the render helpers and the detection regexes live here.

import { toolCompletionInstruction } from './tool-execution-contract.mjs';

// Render the bracketed shell *completion* envelope body.
// Byte-compatible with the historical inline assembly in shell-jobs.fire().
export function renderShellCompletionEnvelope({
  jobId,
  status,
  exitCode = null,
  elapsedMs = null,
  command = null,
  summary = null,
  stdoutPreview = null,
  stderrPreview = null,
  mergeStderr = false,
} = {}) {
  const lines = [
    `[task_id: ${jobId}]`,
    `[status: ${status}]`,
    `[exit: ${exitCode === null ? 'n/a' : exitCode}]`,
    elapsedMs !== null ? `[elapsed: ${elapsedMs} ms]` : null,
    command ? `[command: ${command}]` : null,
    '',
    summary ? `Summary: ${summary}` : null,
    stdoutPreview ? `\n[stdout preview]\n${stdoutPreview}` : null,
    (mergeStderr !== true && stderrPreview) ? `\n[stderr preview]\n${stderrPreview}` : null,
  ].filter((l) => l !== null && l !== '');
  return lines.join('\n');
}

// Build the shell completion instruction via the shared wording so all async
// surfaces read identically ("The async shell task … has finished …"). The
// exit detail is folded into the shared detail slot.
export function shellCompletionInstruction({ jobId, status, exitCode = null } = {}) {
  return toolCompletionInstruction({
    surface: 'shell',
    id: jobId,
    status,
    detail: `exit ${exitCode === null ? 'n/a' : exitCode}`,
  });
}

// Render the bracketed shell *prompt-stall* progress envelope body.
// Byte-compatible with the historical inline assembly in maybeNotifyPromptStall.
export function renderShellPromptStallEnvelope({
  jobId,
  stalledMs,
  elapsedMs = null,
  command = null,
  tailText = null,
} = {}) {
  return [
    `[task_id: ${jobId}]`,
    '[status: running]',
    `[stalled: no output growth for ${stalledMs} ms]`,
    (elapsedMs !== null && elapsedMs >= 0) ? `[elapsed: ${elapsedMs} ms]` : null,
    command ? `[command: ${command}]` : null,
    '',
    'This background shell task appears to be waiting for interactive input. Background tasks cannot answer prompts automatically; cancel it or rerun with non-interactive flags/input.',
    tailText ? `\n${tailText}` : null,
  ].filter((line) => line !== null && line !== '').join('\n');
}

export function shellPromptStallInstruction({ jobId } = {}) {
  return `The background shell task ${jobId} appears to be waiting for interactive input; inspect the prompt, then cancel or rerun it non-interactively.`;
}
