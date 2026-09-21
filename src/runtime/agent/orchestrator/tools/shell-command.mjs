// Async one-shot shell runner.
//
// Replaces the legacy spawnSync path in builtin.mjs shell execution. The
// improvements over spawnSync are:
//   - native process-tree termination on timeout / abort.
//   - automatic spill to $PLUGIN_DATA/shell-output/<taskId>.* once the
//     in-memory buffers exceed SHELL_OUTPUT_INLINE_CAP bytes. The caller
//     receives an outputFilePath marker the model can FileRead later
//     instead of losing the tail past the inline cap.
//   - external AbortSignal hookup so a session-scoped abort (ESC, new
//     prompt) cancels in-flight bash work without orphaning the child.
//
// One run is an explicit state record (lib/shell-run-state.mjs) driven
// through three phases: spawn (lib/shell-run-spawn.mjs), settle
// (lib/shell-run-settle.mjs) and the auto-background promotion
// (lib/shell-run-background.mjs). This module owns admission, preflight and
// the wiring between those phases.
import { resourceAdmission } from '../../../shared/resource-admission.mjs';
import { ExecResult, treeKill } from './shell-exec-output.mjs';
import {
  clearForegroundTimers,
  createShellRun,
  detachAbortHandler,
  elapsedSinceStart,
  releaseResourceLease,
  treeKillForceSettle,
} from './lib/shell-run-state.mjs';
import { spawnShellChild } from './lib/shell-run-spawn.mjs';
import { createPromotedCaptureRelease, createSettle } from './lib/shell-run-settle.mjs';
import { _abortReasonIsInterrupt, createAutoBackground } from './lib/shell-run-background.mjs';

export {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';
export { stripAnsi, ExecResult } from './shell-exec-output.mjs';

async function _execPolicyBlockMessage(command) {
  const { checkExecPolicyMessage } = await import('./bash-policy-scan.mjs');
  return checkExecPolicyMessage(command);
}

// Admission-wait ceiling. Without it a saturated shell lane (all leases held
// by stuck background process trees) blocks acquire() BEFORE spawn — no child
// exists, so neither timeoutMs nor background promotion can ever fire and the
// tool call hangs silently forever. Bound the wait and fail with an
// actionable saturation diagnostic instead. 0 disables the ceiling.
const _envAdmissionWait = Math.floor(Number(process.env.MIXDOG_SHELL_ADMISSION_WAIT_MS));
const SHELL_ADMISSION_WAIT_MS =
  Number.isFinite(_envAdmissionWait) && _envAdmissionWait >= 0 ? _envAdmissionWait : 30_000;

// Default: capture child output via file fds (direct mode) instead of
// parent-side pipes. Opt back into pipe capture with
// MIXDOG_SHELL_PIPE_CAPTURE=1 (diagnostic escape hatch).
// win32 EXCEPTION: fd-based stdio entries are UV_INHERIT_FD, which makes
// libuv DROP CREATE_NO_WINDOW (libuv PR #1659) — the child shell then
// attaches to the PARENT console (the TUI terminal) instead of a fresh
// invisible one. Console-writing grandchildren (plink 0.82+ writes host-key
// prompts straight to CONOUT$, bypassing redirected stderr) tear through the
// ink render and can even consume keystrokes. Verified empirically:
// stdio ['ignore','pipe','pipe'] → GetConsoleProcessList = child only;
// stdio ['ignore', fd, fd]      → shares the console with node + terminal.
// Pipe capture keeps the hide flag; the exit→2s-grace settle fallback below
// already covers the grandchild-holds-pipe wedge that direct mode was
// built to avoid.
function _admissionSaturationError(admission, waitMs) {
  let detail = '';
  try {
    const snap = admission.snapshot();
    const held = (snap.activeLeases || [])
      .filter((lease) => lease.kind === 'shell')
      .map((lease) => `[${Math.round(lease.ageMs / 1000)}s] ${String(lease.label || '(unlabeled)')}`)
      .join(' | ');
    detail =
      ` ${snap.active.shell}/${snap.limits.maxShells} shell leases active` +
      (held ? ` (${held})` : '') +
      `, ${snap.queued} queued.`;
  } catch {
    /* diagnostics must not mask the timeout */
  }
  const error = new Error(
    `shell admission wait exceeded ${waitMs}ms —${detail} ` +
      'Long-held leases usually mean stuck background shell process trees: ' +
      'check task list, cancel stale tasks, kill lingering child processes, or restart the CLI.'
  );
  error.code = 'ERESOURCEPRESSURE';
  return error;
}

// Memory-pressure rejections from resource-admission are TRANSIENT: they clear
// when concurrent work finishes releasing RSS/host memory. Measured 2026-08:
// ~25 shell calls/14d failed instantly on `[resource pressure]` during
// parallel bench/build waves. Instead of failing the tool call, retry the
// acquire on a short backoff inside the existing admission deadline so most
// of those become slightly-delayed successes. Non-memory errors (queue full,
// detached-dependency, saturation deadline, aborts) still throw immediately.
function _isMemoryPressureError(err) {
  if (err?.code !== 'ERESOURCEPRESSURE') return false;
  if (err.metric === 'rss' || err.metric === 'free-memory') return true;
  return /memory metrics unavailable/i.test(String(err.message || ''));
}

function _abortableDelay(ms, signal) {
  return new Promise((resolveDelay) => {
    let onAbort = null;
    // NOT unref'd: this delay is awaited foreground work — an unref'd timer
    // lets the event loop drain and strands the retry loop forever.
    const timer = setTimeout(() => {
      if (onAbort && signal) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {}
      }
      resolveDelay();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolveDelay();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Host family of the shell that will ACTUALLY execute the command, resolved
 *  from the spawn target itself: the binary being launched and its arguments.
 *  Caller-supplied metadata never overrides the target — a spec claiming `cmd`
 *  while launching pwsh.exe is answered `powershell`, because pwsh is what
 *  parses the text. Returns null when the target cannot be identified; callers
 *  must then leave the command exactly as written rather than rewrite it on a
 *  guess. (A union of "plausible" families was worse than the ambiguity: it
 *  rewrote a valid CMD `echo literal ^&` into `echo literal ^`.) */
// Arguments are accepted for call-site convenience but never classify.
export function _shellFamilyForSpawn({ shell = '', shellArg: _shellArg = '', shellArgs: _shellArgs = null } = {}) {
  const name = String(shell || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .split(/[\\/]/)
    .pop();
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  // bash-family shells add `$'…'` / `$"…"`; sh/dash/ash/busybox do not, and
  // their delimiter words keep `$` as an ordinary character.
  if (/^(?:bash|zsh|ksh|ksh93|mksh)$/.test(name)) return 'bash';
  if (/^(?:sh|dash|ash|busybox)$/.test(name)) return 'posix';
  // Arguments never classify: `/c` looks like cmd.exe, but `{shell:'/usr/bin/env',
  // shellArg:'/c'}` is not cmd — only the executable receiving the command text
  // decides, and an unrecognized one means detect nothing and rewrite nothing.
  return null;
}

async function acquireShellLeaseBounded(
  admission,
  { abortSignal, label, dependency = 'scoped', ownerKey = null } = {}
) {
  if (!(SHELL_ADMISSION_WAIT_MS > 0)) {
    return admission.acquire('shell', {
      signal: abortSignal || null,
      label,
      dependency,
      ownerKey,
    });
  }
  const ctl = new AbortController();
  const onAbort = () => {
    try {
      ctl.abort(abortSignal.reason);
    } catch {
      try {
        ctl.abort();
      } catch {}
    }
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const deadlineAt = Date.now() + SHELL_ADMISSION_WAIT_MS;
  const deadline = setTimeout(() => {
    try {
      ctl.abort(_admissionSaturationError(admission, SHELL_ADMISSION_WAIT_MS));
    } catch {}
  }, SHELL_ADMISSION_WAIT_MS);
  if (deadline.unref) deadline.unref();
  try {
    for (;;) {
      try {
        const lease = await admission.acquire('shell', {
          signal: ctl.signal,
          label,
          dependency,
          ownerKey,
        });
        // Hand governance back to the caller's signal: the internal deadline
        // controller may still fire in a lost race after grant, and a stale
        // aborted signal on the lease would poison later parent-restore paths.
        lease.signal = abortSignal || null;
        return lease;
      } catch (err) {
        const remainingMs = deadlineAt - Date.now();
        if (!_isMemoryPressureError(err) || ctl.signal.aborted || remainingMs <= 1_200) throw err;
        await _abortableDelay(Math.min(1_000, remainingMs), ctl.signal);
      }
    }
  } finally {
    clearTimeout(deadline);
    if (abortSignal) {
      try {
        abortSignal.removeEventListener('abort', onAbort);
      } catch {}
    }
  }
}

const failedResult = (run, stderr, failureReason) =>
  new ExecResult({
    stdout: '',
    stderr,
    exitCode: 1,
    signal: null,
    timedOut: false,
    killed: false,
    taskId: run.taskId,
    failurePhase: 'tool',
    failureReason,
  });

// Admission lease, policy preflight, then the spawn. Resolves the run with a
// tool-phase failure and returns false when the command never reaches a shell.
async function admitAndSpawn(run, params) {
  const { admission, command, ownerSessionId, abortSignal } = params;
  try {
    run.resourceLease = await acquireShellLeaseBounded(admission, {
      abortSignal,
      label: String(command || '').slice(0, 120),
      ownerKey: ownerSessionId,
    });
    const policyErr = await _execPolicyBlockMessage(command);
    if (policyErr) {
      await releaseResourceLease(run);
      run.resolveResult(failedResult(run, policyErr, 'preflight failed'));
      return false;
    }
    await spawnShellChild({ run, ...params });
    return true;
  } catch (err) {
    const cleanupError = await releaseResourceLease(run);
    const spawnText = String(err?.message || err);
    const cleanupText = cleanupError
      ? `${spawnText}; resource cleanup failed: ${cleanupError?.message || cleanupError}`
      : spawnText;
    run.resolveResult(
      failedResult(
        run,
        cleanupText,
        err?.code === 'ERESOURCEPRESSURE' || err?.code === 'ERESOURCEQUEUEFULL' ? 'resource pressure' : 'spawn failed'
      )
    );
    return false;
  }
}

// A fault in the wiring BELOW admitAndSpawn (capture, settle, deadlines) has
// no phase of its own to report it: nothing is armed yet, so no timer, exit
// handler or settle() can ever resolve the run. Tear the half-built run down
// by hand and report the same tool-phase failure the spawn path reports.
function settleSetupFailure(run, err) {
  detachAbortHandler(run);
  clearForegroundTimers(run);
  try {
    treeKill(run.child);
  } catch {}
  void releaseResourceLease(run);
  run.resolveResult(failedResult(run, String(err?.message || err), 'spawn failed'));
}

// Binary bytes are sanitized by the capture layer and the run CONTINUES.
// Killing the whole process tree on the first non-text chunk also killed
// the servers and pipelines that legitimately emit binary (git http
// protocol, VM stdout, PDF/ISO dumps) and returned zero output for work
// that had already succeeded. Runaway volume stays bounded by the inline
// cap and the SHELL_OUTPUT_DISK_CAP watchdog.
function attachOutputCapture(run) {
  const { child, taskOutput } = run;
  const onCaptureError = () => {
    if (taskOutput.writeError && !run.settled && !run.autoBackgrounded)
      treeKillForceSettle(run, 'output-capture-error');
  };
  child.stdout?.on('data', (chunk) => {
    const text = run.stdoutDecoder.write(chunk);
    if (text) taskOutput.writeStdout(text);
    onCaptureError();
  });
  child.stderr?.on('data', (chunk) => {
    const text = run.stderrDecoder.write(chunk);
    if (text) taskOutput.writeStderr(text);
    onCaptureError();
  });
}

function attachChildExit(run, releasePromotedCapture) {
  const { child } = run;
  // Settle on 'close', not 'exit'. 'exit' fires when the child terminates but
  // stdout/stderr streams may still be flushing buffered bytes; settling
  // there can lose the tail of the output. 'close' fires after stdio is fully
  // drained, so getStdout()/getStderr() see the complete capture.
  child.once('close', (code, signal) => run.settle(code, signal));
  if (run.pendingChildError) run.settle(1, null);
  // 'close' only fires after stdio drains; a forked grandchild that
  // inherited stdout/stderr fds can hold them open past direct-child
  // exit and stall settle() until timeoutMs. 'exit' fires on direct
  // child termination regardless — give 'close' a 3 s grace then
  // settle anyway. The grace outlives the spawn server's own 2 s drain
  // deadline, so the real exit status normally still arrives first.
  child.once('exit', (code, signal) => {
    if (!run.rootExitAtMs) run.rootExitAtMs = Date.now();
    const grace = setTimeout(() => {
      if (run.settled) return;
      if (run.autoBackgrounded) {
        // A promoted child whose 'close' never arrives (grandchild holding
        // the stdio) would otherwise keep its spill descriptors forever:
        // 'exit' is the only terminal event this path gets.
        releasePromotedCapture();
        return;
      }
      run.partialOutput = true;
      run.settle(code == null ? 1 : code, signal);
    }, 3000);
    if (grace.unref) grace.unref();
  });
}

// Live-progress heartbeat: every 2 s while the foreground command runs, emit
// "running Ns" so the MCP client renders live progress instead of an opaque
// hang. Only armed for a genuine foreground run with a subscribed client.
// The live output tail (1 s cadence) serves in-process transcript consumers
// (desktop/TUI running tool cards) on an independent channel. Both are
// cleared together on settle / auto-background.
function armProgressTimers(run, { onProgress, onOutputTail }) {
  if (typeof onProgress === 'function') {
    run.progressTimer = setInterval(() => {
      if (run.settled || run.autoBackgrounded) return;
      const secs = Math.round(elapsedSinceStart(run) / 1000);
      try {
        onProgress(`running ${secs}s`);
      } catch {}
    }, 2000);
    if (run.progressTimer.unref) run.progressTimer.unref();
  }
  // Emits only on change so idle commands cost one getLiveTail per second
  // and zero downstream work.
  if (typeof onOutputTail === 'function') {
    run.outputTailTimer = setInterval(() => {
      if (run.settled || run.autoBackgrounded) return;
      try {
        const tail = run.taskOutput.getLiveTail(4000);
        if (tail && tail !== run.lastOutputTail) {
          run.lastOutputTail = tail;
          onOutputTail(tail);
        }
      } catch {
        /* best effort */
      }
    }, 1000);
    if (run.outputTailTimer.unref) run.outputTailTimer.unref();
  }
}

// A still-running, not-yet-terminal child that the caller allows to be
// promoted. Shared by the timeout deadline and the interrupt abort so a
// detached / already-settled / already-exited child can never be promoted.
const promotable = (run, backgroundOnTimeout) =>
  backgroundOnTimeout &&
  !run.settled &&
  !run.autoBackgrounded &&
  !run.killed &&
  run.child?.exitCode == null &&
  run.child?.signalCode == null;

function armDeadlines(run, { timeoutMs, autoBackgroundMs, backgroundOnTimeout, abortSignal }, fireAutoBackground) {
  if (timeoutMs > 0) {
    run.timer = setTimeout(() => {
      // Promote-on-timeout: if the caller allows backgrounding and the child
      // is still running, promote it as a tracked background job instead of
      // tree-killing it. Falls through to the old kill path for
      // disallowed/opted-out commands (backgroundOnTimeout false) or when a
      // terminal transition already won the race.
      if (promotable(run, backgroundOnTimeout)) {
        fireAutoBackground({ reason: 'timeout' });
        return;
      }
      run.timedOut = true;
      treeKillForceSettle(run, 'timeout');
    }, timeoutMs);
    if (run.timer.unref) run.timer.unref();
  }
  // Arm the auto-background timer only for the genuine foreground one-shot
  // path: a positive threshold strictly below the hard timeout.
  if (
    typeof autoBackgroundMs === 'number' &&
    autoBackgroundMs > 0 &&
    (timeoutMs <= 0 || autoBackgroundMs < timeoutMs)
  ) {
    run.autoBgTimer = setTimeout(() => {
      fireAutoBackground();
    }, autoBackgroundMs);
    if (run.autoBgTimer.unref) run.autoBgTimer.unref();
  }
  if (abortSignal) {
    run.abortHandler = () => {
      // Interrupt (the user typed a NEW message while this was running) is a
      // "also look at this" signal, not "stop that" — it backgrounds instead
      // of killing there, and throwing away a long build the user never asked
      // to stop is the worse outcome. Explicit cancellation (ESC) keeps the
      // kill. The promotion reuses the timeout path's guards verbatim.
      if (_abortReasonIsInterrupt(abortSignal) && promotable(run, backgroundOnTimeout)) {
        fireAutoBackground({ reason: 'interrupt' });
        return;
      }
      treeKillForceSettle(run, 'cancellation');
    };
    try {
      abortSignal.addEventListener('abort', run.abortHandler, { once: true });
    } catch {}
  }
}

// Windows Defender intermittently fails node→PowerShell spawns with EPERM
// while it scans the child image (see shell-runtime.mjs Trojan false-positive
// note). The failure is at spawn() time — before any stdio/side effect — so a
// short bounded retry is safe and never re-runs a command that already ran
// (lib/shell-spawn-retry.mjs).
export function execShellCommand({
  shell,
  shellArg,
  shellArgs,
  command,
  env,
  cwd,
  timeoutMs,
  abortSignal,
  autoBackgroundMs,
  onProgress,
  onOutputTail,
  clientHostPid,
  ownerSessionId,
  backgroundOnTimeout,
  promotedTimeoutMs = 0,
  backgroundDeadlineMs = 0,
  admission = resourceAdmission,
  directArgv = null,
  // What the shell PARSES, when that must differ from what the caller shows.
  // `command` stays the display/record text (job labels, telemetry, shell-job
  // rows); `execScript` is the argv payload. They diverge only when a caller
  // hands the script to the shell out-of-band — see the POSIX env+eval path in
  // bash-tool.mjs, which keeps the command body out of the child's argv.
  execScript = null,
}) {
  return new Promise(async (resolve) => {
    const run = createShellRun({ abortSignal, resolve });
    // An async executor's throw is NOT routed to this Promise — it becomes an
    // unhandled rejection of the executor's own promise while the awaiting
    // caller hangs forever. Every path below therefore has to settle the run
    // itself, including the unexpected one.
    try {
      const spawned = await admitAndSpawn(run, {
        admission,
        shell,
        shellArg,
        shellArgs,
        command,
        env,
        cwd,
        abortSignal,
        directArgv,
        execScript,
        ownerSessionId,
        clientHostPid,
      });
      if (!spawned) return;

      // Pre-aborted signal: kill immediately if the abort already fired
      // before spawn returned (synchronous reentry from a parent abort), so
      // the child doesn't run for the full timeoutMs window.
      if (abortSignal?.aborted) {
        treeKillForceSettle(run, 'cancellation');
      }
      attachOutputCapture(run);
      const releasePromotedCapture = createPromotedCaptureRelease(run);
      run.settle = createSettle(run, releasePromotedCapture);
      attachChildExit(run, releasePromotedCapture);
      const fireAutoBackground = createAutoBackground({
        run,
        command,
        cwd,
        clientHostPid,
        ownerSessionId,
        promotedTimeoutMs,
        backgroundDeadlineMs,
      });
      armDeadlines(run, { timeoutMs, autoBackgroundMs, backgroundOnTimeout, abortSignal }, fireAutoBackground);
      armProgressTimers(run, { onProgress, onOutputTail });
    } catch (err) {
      settleSetupFailure(run, err);
    }
  });
}
