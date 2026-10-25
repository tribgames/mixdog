// The shell tool: policy preflight → optional inline-script hoist → effect
// analysis → deadline plan → invocation plan → execShellCommand → result
// rendering (backgrounded or completed) → artifact + cache settlement. The
// phases live under bash-tool/; this file wires them and keeps the public
// exports other modules and the shellhardening suites import.
import { execShellCommand, stripAnsi } from '../shell-command.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from '../code-graph-state.mjs';
import { subscribeShellJobSettled } from './shell-jobs.mjs';
import { envFlag } from '../../../../shared/env.mjs';
import { analyzeShellCommandEffects } from './shell-analysis.mjs';
import { recordShellCaptureTelemetry } from './shell-output.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { formatShellToolFailure } from './bash-tool/result-format.mjs';
import {
  cleanupArtifactAfter,
  cleanupArtifactOnTaskSettled,
  removeTransportFileNow,
} from './bash-tool/transport-artifacts.mjs';
import { combineAbortSignals, sessionAbortSignal } from './bash-tool/abort-signals.mjs';
import { beginInterruptibleTaskWait } from '../../session/task-wait-control.mjs';
import { prepareShellCommand } from './bash-tool/command-preflight.mjs';
import { hoistInlineScript } from './bash-tool/inline-hoist.mjs';
import { planShellDeadlines } from './bash-tool/deadline-plan.mjs';
import { planShellInvocation } from './bash-tool/invocation-plan.mjs';
import { renderBackgroundedResult } from './bash-tool/backgrounded-result.mjs';
import { renderCompletedResult } from './bash-tool/completed-result.mjs';
import { effectiveShellCwd, shellCwdError } from './bash-tool/shell-cwd.mjs';

export {
  SURVIVING_DESCENDANTS_WARNING,
  SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
  _backgroundResultLines,
  getDedupedDestructiveWarnings,
  _placeDestructiveWarningsAfterStatus,
  formatShellToolFailure,
  _shellFailureStatus,
  _exitClassDiagnostic,
  _composeShellFailure,
} from './bash-tool/result-format.mjs';
export { _isBenignSearchExitOne } from './bash-tool/benign-exit.mjs';
export { DEFAULT_SHELL_AUTO_BACKGROUND_MS } from './bash-tool/deadline-plan.mjs';
export { buildShellSpawnEnv } from './bash-tool/spawn-env.mjs';
export { executeTaskTool } from './task-tool.mjs';

// Reads cached after a mutating command must not serve pre-command state. A
// promoted command has barely started when the tool returns, a queued one has
// not started at all and a killed tree may still run, so the invalidation
// repeats when it settles.
function settleMutationCaches(shellEffects, backgroundJobId, runSettled = null) {
  const invalidate = () => {
    if (shellEffects.mutationMode === 'paths') {
      invalidateBuiltinResultCache(shellEffects.paths);
      markCodeGraphDirtyPaths(shellEffects.paths);
    } else if (shellEffects.mutationMode === 'global') {
      invalidateBuiltinResultCache();
      drainCodeGraphCache();
    }
  };
  invalidate();
  if (backgroundJobId && shellEffects.mutationMode !== 'none') {
    subscribeShellJobSettled(backgroundJobId, invalidate);
  }
  if (runSettled && shellEffects.mutationMode !== 'none') runSettled.then(invalidate).catch(() => {});
}

export async function executeBashTool(args, workDir, options = {}) {
  // A call starts from the current Project root unless it names a `cwd`. A
  // command-local `cd` never creates a second session cwd authority beside it.
  const bashWorkDir = effectiveShellCwd(args, workDir);
  if (bashWorkDir !== workDir) {
    const cwdError = await shellCwdError(bashWorkDir);
    if (cwdError) return formatShellToolFailure(cwdError);
  }
  // Approval comes from the runtime's options, never from model-supplied args.
  const elevationApproved = options?.elevationApproved === true;
  const prepared = prepareShellCommand(args, { elevationApproved });
  if (prepared.failure) return prepared.failure;
  const { resolvedSpec, wmicRewrite, bashismRewrite } = prepared;
  // Effects are analyzed on the command as the caller meant it, before the
  // hoist turns it into a file run.
  const analysisCommand = prepared.analysisCommand;
  const hoisted = hoistInlineScript(prepared.command, resolvedSpec.shellType);
  const command = hoisted.command;

  let shellEffects;
  try {
    shellEffects = await analyzeShellCommandEffects(analysisCommand, bashWorkDir);
  } catch (err) {
    return formatShellToolFailure(normalizeErrorMessage(err instanceof Error ? err.message : String(err)));
  }
  // The truthy MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS env restores the old
  // foreground-only behavior (no promotion at timeout, no auto-background).
  const backgroundOnTimeout = !envFlag('MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS');
  const deadlines = planShellDeadlines({ args, wmicRewrite, backgroundOnTimeout });

  let combinedAbort = null;
  // New user input ends the hold early, the same wake `task wait` uses.
  const inputWake = backgroundOnTimeout ? beginInterruptibleTaskWait(options?.sessionId) : null;
  let backgrounded = false;
  let backgroundJobId = null;
  // A queued run, or a foreground tree that may outlive its result, settles later.
  let runSettled = null;
  try {
    const invocation = await planShellInvocation({ command, resolvedSpec, cwd: bashWorkDir });
    if (invocation.failure) return invocation.failure;
    combinedAbort = combineAbortSignals(await sessionAbortSignal(options?.sessionId), options?.abortSignal || null);
    const startedAtMs = Date.now();
    const result = await execShellCommand({
      shell: invocation.execShell,
      shellArg: invocation.execShellArg,
      shellArgs: invocation.execShellArgs,
      command: invocation.wrappedCommand,
      execScript: invocation.execScript,
      directArgv: invocation.directArgv,
      elevationApproved,
      env: invocation.spawnEnv,
      cwd: bashWorkDir,
      timeoutMs: deadlines.timeout,
      abortSignal: combinedAbort.signal,
      wakeSignal: inputWake?.signal || null,
      autoBackgroundReason: args.background === true ? 'background' : 'threshold',
      autoBackgroundMs: deadlines.autoBackgroundMs,
      // On a foreground timeout, promote the still-running child to a tracked
      // background job (task_id + notify) instead of tree-killing it.
      backgroundOnTimeout: deadlines.promoteAtTimeout,
      promotedTimeoutMs: deadlines.promotedTimeoutMs,
      backgroundDeadlineMs: deadlines.backgroundDeadlineMs,
      // Threaded so an auto-backgrounded foreground job is stamped with the
      // dispatching terminal's claude.exe pid (per-terminal scope) and the
      // dispatching session (per-pane scope).
      clientHostPid: options?.clientHostPid,
      ownerSessionId: options?.callerSessionId || options?.sessionId || null,
      // MCP live-progress reporter (throttled "running Ns" frames) and the
      // in-process live-output tail for transcript consumers.
      onProgress: typeof options?.onProgress === 'function' ? options.onProgress : null,
      onOutputTail: typeof options?.onOutputTail === 'function' ? options.onOutputTail : null,
    });
    backgrounded = result.backgrounded === true;
    backgroundJobId = backgrounded ? result.jobId || null : null;
    runSettled = result.settled || null;
    const stdout = stripAnsi(result.stdout || '');
    const stderr = stripAnsi(result.stderr || '');
    recordShellCaptureTelemetry(options?.resultTelemetry, result, stdout, stderr);
    const rendering = {
      result,
      command,
      cwd: bashWorkDir,
      options,
      startedAtMs,
      teePlan: invocation.teePlan,
      stdout,
      stderr,
    };
    if (backgrounded) return renderBackgroundedResult(rendering);
    return renderCompletedResult({
      ...rendering,
      analysisCommand,
      timeout: deadlines.timeout,
      rewriteNote: [wmicRewrite?.note, bashismRewrite?.note].filter(Boolean).join('\n'),
    });
  } finally {
    inputWake?.dispose();
    combinedAbort?.cleanup?.();
    if (hoisted.hoistPath) {
      // A promoted or queued command still runs from the hoisted file, and so
      // may a killed tree until it settles; a finished foreground one is done
      // with it now (an unconfirmed kill may keep it locked — retried).
      if (runSettled) cleanupArtifactAfter(hoisted.hoistPath, runSettled);
      else if (backgrounded) cleanupArtifactOnTaskSettled(hoisted.hoistPath, backgroundJobId);
      else removeTransportFileNow(hoisted.hoistPath);
    }
    settleMutationCaches(shellEffects, backgroundJobId, runSettled);
  }
}
