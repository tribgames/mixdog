'use strict';
// Async one-shot shell runner.
//
// Replaces the legacy spawnSync path in builtin.mjs shell execution. The
// improvements over spawnSync are:
//   - native process-tree termination on timeout / abort.
//   - automatic spill to $PLUGIN_DATA/shell-output/<taskId>.* once the
//     in-memory buffers exceed SHELL_OUTPUT_INLINE_CAP*4 bytes. The caller
//     receives an outputFilePath marker the model can FileRead later
//     instead of losing the tail past the inline cap.
//   - external AbortSignal hookup so a session-scoped abort (ESC, new
//     prompt) cancels in-flight bash work without orphaning the child.
//
import { randomUUID } from 'node:crypto';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';
import { acquire as acquireChildSpawnSlot } from '../../../shared/child-spawn-gate.mjs';
// Runtime-only import (used inside execShellCommand's auto-background
// transition). shell-jobs.mjs imports stripAnsi from this module, so this is
// a static cycle — safe because neither binding is touched at module-eval
// time, only when the respective functions actually run.
import {
  adoptForegroundShellJob,
  attachShellJobResourceLease,
  killShellJob,
  publishForegroundShellRecord,
  retireForegroundShellRecord,
} from './builtin/shell-jobs.mjs';
import {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';
import { spawnShellWithRetry as _spawnShellWithRetry } from './lib/shell-spawn-retry.mjs';
import { takeWarmShellStandby } from './lib/shell-warm-standby.mjs';

export {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';

// Inline cap. Output above this size is spilled to disk and the caller
// renders a path marker instead of pasting the tail. Matches the
// SHELL_OUTPUT_MAX_CHARS used by the smart-truncate renderer in
// builtin.mjs so spilled output and inline output share the same boundary.
import { SHELL_OUTPUT_INLINE_CAP, SHELL_OUTPUT_DISK_CAP, stripAnsi, treeKill, TaskOutput, ExecResult, ShellTextDecoder } from './shell-exec-output.mjs';
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
// Foreground visibility threshold. Every shell readout (CLI statusline,
// desktop island) scans the on-disk job records, so a foreground command is
// invisible without one. Commands that settle inside this window can never
// survive long enough for a 1 s status refresh to show them, so publishing
// their record would only cost two file writes per command.
// MIXDOG_SHELL_FOREGROUND_RECORD_MS overrides; 0 publishes every command.
const _envForegroundRecord = Math.floor(Number(process.env.MIXDOG_SHELL_FOREGROUND_RECORD_MS));
const FOREGROUND_RECORD_DELAY_MS = Number.isFinite(_envForegroundRecord) && _envForegroundRecord >= 0
  ? _envForegroundRecord
  : 300;

const _envAdmissionWait = Math.floor(Number(process.env.MIXDOG_SHELL_ADMISSION_WAIT_MS));
const SHELL_ADMISSION_WAIT_MS = Number.isFinite(_envAdmissionWait) && _envAdmissionWait >= 0
  ? _envAdmissionWait
  : 30_000;

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
    detail = ` ${snap.active.shell}/${snap.limits.maxShells} shell leases active`
      + (held ? ` (${held})` : '')
      + `, ${snap.queued} queued.`;
  } catch { /* diagnostics must not mask the timeout */ }
  const error = new Error(
    `shell admission wait exceeded ${waitMs}ms —${detail} `
    + 'Long-held leases usually mean stuck background shell process trees: '
    + 'check task list, cancel stale tasks, kill lingering child processes, or restart the CLI.',
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
  if (!err || err.code !== 'ERESOURCEPRESSURE') return false;
  if (err.metric === 'rss' || err.metric === 'free-memory') return true;
  return /memory metrics unavailable/i.test(String(err.message || ''));
}

function _abortableDelay(ms, signal) {
  return new Promise((resolveDelay) => {
    let onAbort = null;
    // NOT unref'd: this delay is awaited foreground work — an unref'd timer
    // lets the event loop drain and strands the retry loop forever.
    const timer = setTimeout(() => {
      if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
      resolveDelay();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(timer); resolveDelay(); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// True when an abort was raised because the user sent a NEW message while the
// command was running (session-api.mjs raises 'interrupt' when steering is
// pending, 'user-cancel' for a plain ESC). The reason travels as the
// SessionClosedError's `reason` field; a bare string / message fallback keeps
// non-session callers working. Anything unrecognized is treated as a real
// cancellation, so the kill path stays the default.
export function _abortReasonIsInterrupt(abortSignal) {
  const raw = abortSignal?.reason;
  if (!raw) return false;
  if (typeof raw === 'string') return raw === 'interrupt';
  if (typeof raw === 'object') {
    if (raw.reason === 'interrupt') return true;
    if (typeof raw.message === 'string' && /\breason=interrupt\b/.test(raw.message)) return true;
  }
  return false;
}

export async function acquireShellLeaseBounded(admission, {
  abortSignal, label, dependency = 'scoped', ownerKey = null,
} = {}) {
  if (!(SHELL_ADMISSION_WAIT_MS > 0)) {
    return admission.acquire('shell', {
      signal: abortSignal || null, label, dependency, ownerKey,
    });
  }
  const ctl = new AbortController();
  const onAbort = () => {
    try { ctl.abort(abortSignal.reason); } catch { try { ctl.abort(); } catch {} }
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }
  const deadlineAt = Date.now() + SHELL_ADMISSION_WAIT_MS;
  const deadline = setTimeout(() => {
    try { ctl.abort(_admissionSaturationError(admission, SHELL_ADMISSION_WAIT_MS)); } catch {}
  }, SHELL_ADMISSION_WAIT_MS);
  if (deadline.unref) deadline.unref();
  try {
    for (;;) {
      try {
        const lease = await admission.acquire('shell', {
          signal: ctl.signal, label, dependency, ownerKey,
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
    if (abortSignal) { try { abortSignal.removeEventListener('abort', onAbort); } catch {} }
  }
}

// Count of shell spawns currently in-flight (including those parked in an
// EPERM backoff). Logged with each failed spawn so a Defender-induced storm
// is reconstructable: activeSpawnCount > 1 means concurrent spawns were
// racing the AV scan when the failure hit.
// Windows Defender intermittently fails node→PowerShell spawns with EPERM
// while it scans the child image (see shell-runtime.mjs Trojan false-positive
// note). The failure is at spawn() time — before any stdio/side effect — so a
// short bounded retry is safe and never re-runs a command that already ran.
// Retry ONLY on EPERM/win32/powershell; everything else throws on first
// failure. Backoff 100/300/700ms caps added latency at ~1.1s. Every failed
// attempt logs one diagnostic line for later reconstruction.
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
}) {
  return new Promise(async (resolve) => {
    let resultResolved = false;
    const resolveResult = (result) => {
      if (resultResolved) return false;
      resultResolved = true;
      resolve(result);
      return true;
    };
    const taskId = `shell_${randomUUID().slice(0, 8)}`;
    const taskOutput = new TaskOutput(taskId);
    const stdoutDecoder = new ShellTextDecoder();
    const stderrDecoder = new ShellTextDecoder();
    let timedOut = false;
    let killed = false;
    let killCause = null;
    let failurePhase = null;
    let failureReason = null;
    let spawnError = null;
    let pendingChildError = null;
    let settle = null;
    let settled = false;
    let timer = null;
    let abortHandler = null;
    let partialOutput = false;
    let resourceLease = null;
    const releaseResourceLease = async () => {
      if (!resourceLease) return null;
      const lease = resourceLease;
      resourceLease = null;
      try {
        await lease.release();
        return null;
      } catch (error) {
        return error;
      }
    };
    const detachAbortHandler = () => {
      if (abortSignal && abortHandler) {
        try { abortSignal.removeEventListener('abort', abortHandler); } catch {}
        abortHandler = null;
      }
    };
    // MCP live-progress: throttled "running Ns, M lines" emits while the
    // foreground command runs. Inert (never armed) when onProgress is null.
    const _hasProgress = typeof onProgress === 'function';
    const _startMs = Date.now();
    let progressTimer = null;
    // Live output tail: 1 s cadence for in-process transcript consumers
    // (desktop/TUI running tool cards). Independent of the MCP onProgress
    // channel; cleared together with it on settle / auto-background.
    const _hasOutputTail = typeof onOutputTail === 'function';
    let outputTailTimer = null;
    let _lastOutputTail = '';
    const _clearProgressTimer = () => {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      if (outputTailTimer) { clearInterval(outputTailTimer); outputTailTimer = null; }
    };
    // Auto-background transition flag. Set the moment the autoBackgroundMs
    // timer fires and adopts the still-running child. Once
    // true the normal settle()/close/exit/treeKill paths are inert for this
    // run — the call has already resolved with a 'backgrounded' result and
    // the child's lifecycle is owned by the shell-jobs registry. Mutually
    // exclusive with `settled`: whichever transition wins first wins for good.
    let autoBackgrounded = false;
    let autoBackgroundJobId = null;
    let autoBgTimer = null;
    // Treekill + force-settle deadline. treeKill alone leaves settle()
    // pending on 'close'/'exit'; on Windows a taskkill miss or a grandchild
    // holding stdio fds keeps the dispatch stalled until the upstream
    // ceiling. Covers every kill path (timeout / pre-aborted / abort /
    // capture-error / size-watchdog) so the hang risk does not live on
    // outside the timeout branch. Function declaration so callers placed
    // above settle()'s const definition still resolve via hoisting; the
    // 5 s deadline always fires after settle is constructed.
    function _treeKillForceSettle(cause) {
      killed = true;
      killCause = killCause || cause || 'runtime-guard';
      treeKill(child);
      const _killDeadline = setTimeout(() => {
        if (settled) return;
        partialOutput = true;
        settle(1, 'SIGKILL');
      }, 5000);
      if (_killDeadline.unref) _killDeadline.unref();
    }
    // Background commands (trailing `&`) intentionally detach stdio
    // from the parent shell, so 'close' may never fire while the
    // backgrounded grandchild is still alive. For those we settle
    // immediately on direct-child exit instead of waiting for close.
    const _trimmed = String(command || '').replace(/\s+$/, '');
    const _isBackground = /(^|[^&|])&$/.test(_trimmed);

    let child;
    let _onChildErrorRef = null;
    // Live foreground record (see FOREGROUND_RECORD_DELAY_MS). Stamped with
    // the moment the command actually reached a shell — not lease/preflight
    // entry, and not a warm standby's process-creation time.
    let _commandStartedAtMs = 0;
    const _foregroundRecordId = `job_${Date.now()}_${randomUUID().slice(0, 6)}`;
    let _foregroundRecordTimer = null;
    let _foregroundRecordPublished = false;
    const _clearForegroundRecord = () => {
      if (_foregroundRecordTimer) {
        clearTimeout(_foregroundRecordTimer);
        _foregroundRecordTimer = null;
      }
      if (!_foregroundRecordPublished) return;
      _foregroundRecordPublished = false;
      try { retireForegroundShellRecord(_foregroundRecordId); } catch {}
    };
    // Runtime of the COMMAND. _startMs covers admission lease + policy
    // preflight too, so it overstates how long the command itself has run;
    // before a shell exists it is the only stamp available.
    const _elapsedSinceStart = () => Math.max(0, Date.now() - (_commandStartedAtMs || _startMs));
    try {
      resourceLease = await acquireShellLeaseBounded(admission, {
        abortSignal,
        label: String(command || '').slice(0, 120),
        ownerKey: ownerSessionId,
      });
      const _policyErr = await _execPolicyBlockMessage(command);
      if (_policyErr) {
        await releaseResourceLease();
        resolveResult(
          new ExecResult({
            stdout: '',
            stderr: _policyErr,
            exitCode: 1,
            signal: null,
            timedOut: false,
            killed: false,
            taskId,
            failurePhase: 'tool',
            failureReason: 'preflight failed',
          }),
        );
        return;
      }
      const _useDirectArgv = Array.isArray(directArgv);
      const _spawnCommand = _useDirectArgv ? String(command ?? '') : _maybeEncodePowerShellCommand(command);
      const argv = _useDirectArgv
        ? [...directArgv]
        : (Array.isArray(shellArgs) && shellArgs.length > 0
          ? [...shellArgs, _spawnCommand]
          : [shellArg, _spawnCommand]);
      const _onChildError = (err) => {
        spawnError = spawnError || err;
        failurePhase = 'tool';
        failureReason = 'spawn failed';
        if (settle) settle(1, null);
        else pendingChildError = pendingChildError || err;
      };
      _onChildErrorRef = _onChildError;
      // Warm-standby fast path (pwsh only): a pre-spawned bootstrap pwsh
      // reads the script from stdin, skipping CreateProcess + Defender scan
      // for this call. Any miss (env drift, TTL, dead/warming standby,
      // MIXDOG_SHELL_WARM_STANDBY=0) falls through to the gated spawn below.
      let _standby = null;
      if (!_useDirectArgv && shellArg === '-Command') {
        try { _standby = takeWarmShellStandby({ shell, env, cwd }); } catch { _standby = null; }
      }
      // Spawn-burst gate: hold a 'process-spawn' slot only across process
      // creation (CreateProcess + AV scan + EPERM retries), released the
      // moment the child exists. Bounds the Defender convoy a shell burst
      // creates without limiting how many commands RUN concurrently — the
      // full-lifetime gating concern in the note below stays true.
      let spawned = null;
      if (_standby) {
        spawned = _standby.spawned;
      } else {
      const _releaseSpawnSlot = await acquireChildSpawnSlot(abortSignal || null, 'process-spawn', {
        ownerKey: ownerSessionId,
      });
      // Gate drain can grant several waiters in one tick. Yield so CreateProcess
      // + AV does not freeze graph/patch/search callbacks in that same turn.
      await new Promise((resolve) => setImmediate(resolve));
      if (abortSignal?.aborted) {
        try { _releaseSpawnSlot(); } catch { /* idempotent */ }
        throw abortSignal.reason || new Error('aborted');
      }
      try {
        spawned = await _spawnShellWithRetry({
        shell,
        argv,
        shellArg,
        cwd,
        spawnOptions: {
        env,
        cwd,
        outputLimit: SHELL_OUTPUT_DISK_CAP,
        rawOutput: true,
        // NOTE (child-spawn-gate): the full command lifetime is intentionally
        // NOT gated — bash/pwsh commands can run for minutes and would starve
        // rg/code_graph. Only the spawn window above holds a slot.
        // POSIX: detached gives the child its own process group so treeKill can
        // signal the whole group. The child is still CLI-owned because we do
        // not unref it after adoption. Windows detached has different console
        // semantics, so it stays off there.
        },
        });
      } finally {
        try { _releaseSpawnSlot(); } catch { /* idempotent */ }
      }
      }
      child = spawned.child;
      spawned.adoptErrorHandler(_onChildError);
      // Feed the standby only after the error handler is attached; server
      // messages cannot be processed before this synchronous block yields.
      if (_standby) _standby.feed(_spawnCommand, cwd);
      // The command has now reached a shell. This is the start moment every
      // readout measures from, and the point from which a still-running
      // command deserves to be visible in the shell readouts.
      _commandStartedAtMs = Date.now();
      _foregroundRecordTimer = setTimeout(() => {
        _foregroundRecordTimer = null;
        if (settled || autoBackgrounded || !child?.pid) return;
        _foregroundRecordPublished = true;
        publishForegroundShellRecord({
          jobId: _foregroundRecordId,
          command,
          cwd,
          pid: child.pid,
          startedAtMs: _commandStartedAtMs,
          ownerSessionId,
          clientHostPid,
        });
      }, FOREGROUND_RECORD_DELAY_MS);
      _foregroundRecordTimer.unref?.();
    } catch (err) {
      const cleanupError = await releaseResourceLease();
      const spawnText = String((err && err.message) || err);
      const cleanupText = cleanupError
        ? `${spawnText}; resource cleanup failed: ${cleanupError?.message || cleanupError}`
        : spawnText;
      resolveResult(
        new ExecResult({
          stdout: '',
          stderr: cleanupText,
          exitCode: 1,
          signal: null,
          timedOut: false,
          killed: false,
          taskId,
          failurePhase: 'tool',
          failureReason: err?.code === 'ERESOURCEPRESSURE' || err?.code === 'ERESOURCEQUEUEFULL'
            ? 'resource pressure'
            : 'spawn failed',
        }),
      );
      return;
    }

    // Pre-aborted signal: kill immediately if the abort already fired
    // before spawn returned (synchronous reentry from a parent abort), so
    // the child doesn't run for the full timeoutMs window.
    if (abortSignal && abortSignal.aborted) {
      _treeKillForceSettle('cancellation');
    }

    const _stdoutData = (chunk) => {
      const text = stdoutDecoder.write(chunk);
      if (text) taskOutput.writeStdout(text);
      if (taskOutput.binaryOutput && !settled && !autoBackgrounded) _treeKillForceSettle('binary-output');
      if (taskOutput.writeError && !settled && !autoBackgrounded) _treeKillForceSettle('output-capture-error');
    };
    const _stderrData = (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (text) taskOutput.writeStderr(text);
      if (taskOutput.binaryOutput && !settled && !autoBackgrounded) _treeKillForceSettle('binary-output');
      if (taskOutput.writeError && !settled && !autoBackgrounded) _treeKillForceSettle('output-capture-error');
    };
    if (child.stdout) {
      child.stdout.on('data', _stdoutData);
    }
    if (child.stderr) {
      child.stderr.on('data', _stderrData);
    }

    settle = async (exitCode, signal) => {
      if (settled || autoBackgrounded) return;
      settled = true;
      // Off the readouts the instant the command is over, before any awaited
      // output capture — a finished command must never linger as "running".
      _clearForegroundRecord();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      _clearProgressTimer();
      if (autoBgTimer) {
        clearTimeout(autoBgTimer);
        autoBgTimer = null;
      }
      detachAbortHandler();
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) taskOutput.writeStdout(stdoutTail);
      if (stderrTail) taskOutput.writeStderr(stderrTail);
      // getStdout/getStderr can throw on a spilled-file read failure (EBADF
      // after unlink race, EACCES). Without this catch the rejection bubbles
      // up and leaves the outer settle promise unresolved, hanging the call.
      // Capture as writeError so the caller sees outputCaptureError and the
      // partial inline buffer (if any) is still surfaced via partialOutput.
      let stdout = '';
      let stderr = '';
      try { stdout = await taskOutput.getStdout(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      try { stderr = await taskOutput.getStderr(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      if (spawnError && !stderr) stderr = String(spawnError.message || spawnError);
      // Inline-only path: nothing spilled. Nothing to clean up.
      // Spilled but tiny: drop the files — outputFilePath would duplicate
      // the inline body. Spilled and large: keep the files, caller renders
      // the path marker.
      if (
        taskOutput.spilled &&
        stdout.length + stderr.length <= SHELL_OUTPUT_INLINE_CAP
      ) {
        taskOutput.deleteFiles();
      } else {
        taskOutput.closeFds();
      }
      void releaseResourceLease();
      resolveResult(
        new ExecResult({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          killed,
          killCause,
          stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
          partialOutput,
          outputCaptureError: taskOutput.writeError,
          failurePhase,
          failureReason,
        }),
      );
    };

    // P1 fix: settle on 'close', not 'exit'. 'exit' fires when the child
    // terminates but stdout/stderr streams may still be flushing buffered
    // bytes; settling there can lose the tail of the output. 'close' fires
    // after stdio is fully drained, so getStdout()/getStderr() see the
    // complete capture.
    const _onChildClose = (code, signal) => settle(code, signal);
    child.once('close', _onChildClose);
    if (pendingChildError) settle(1, null);
    // 'close' only fires after stdio drains; a forked grandchild that
    // inherited stdout/stderr fds can hold them open past direct-child
    // exit and stall settle() until timeoutMs. 'exit' fires on direct
    // child termination regardless — give 'close' a 2 s grace then
    // settle anyway.
    const _onChildExit = (code, signal) => {
      if (_isBackground) {
        setImmediate(() => settle(code == null ? 1 : code, signal));
        return;
      }
      const grace = setTimeout(() => {
        if (settled || autoBackgrounded) return;
        partialOutput = true;
        settle(code == null ? 1 : code, signal);
      }, 2000);
      if (grace.unref) grace.unref();
    };
    child.once('exit', _onChildExit);
    // Auto-background transition. Two triggers
    // resolve the call immediately with a 'backgrounded' result while the
    // child keeps running, adopted into the shell-jobs registry but still
    // owned by this CLI process:
    //   1. the autoBackgroundMs soft foreground threshold — an EARLIER
    //      promotion before the timeout, and
    //   2. the foreground timeout deadline (backgroundOnTimeout) — the default
    //      promote-on-timeout that replaces the old tree-kill.
    // A capped explicit foreground timeout supplies its remaining deadline to
    // the adopted job; otherwise adoption remains unlimited as before.
    // Mutually exclusive with settle() via the autoBackgrounded flag set
    // synchronously at the top before any await.
    const _autoBackground = async ({ reason = 'threshold' } = {}) => {
      // Win the race: bail if a terminal transition already happened, and
      // claim the transition synchronously so a concurrently-queued settle()
      // (which checks autoBackgrounded) becomes inert.
      if (settled || autoBackgrounded || killed || timedOut) return;
      if (child.exitCode != null || child.signalCode != null) return;
      autoBackgrounded = true;
      // The foreground capture is over; stop the local watchdogs/timers so
      // they cannot treeKill the now-adopted child.
      if (timer) { clearTimeout(timer); timer = null; }
      _clearProgressTimer();
      if (autoBgTimer) { clearTimeout(autoBgTimer); autoBgTimer = null; }
      // Keep the abort handler ATTACHED through the promotion window. A user
      // cancel racing in after promotion starts must still bring the adopted
      // child down — the handler's treeKill(child) does exactly that (settle()
      // is inert once autoBackgrounded, but the kill itself still lands, and
      // refreshShellJob then flags the job failed). We only detach on a real
      // settle() or on the adoption-failure fallback below.
      // Every subsequent stdout/stderr chunk must hit disk — the call is
      // about to resolve and nobody will drain the in-memory buffers again.
      try { taskOutput.forceSpill(); } catch {}
      // The foreground sizeWatchdog was cleared above; the output cap now
      // travels with the adopted job — adoptForegroundShellJob arms a periodic
      // refreshShellJob tick that enforces SHELL_JOB_OUTPUT_DISK_CAP against the
      // same spill files (stdoutPath/stderrPath below), killing + flagging a
      // runaway background producer even with no active task waiter.
      const stdoutPath = taskOutput.spilled ? taskOutput.stdoutPath : null;
      const stderrPath = taskOutput.spilled ? taskOutput.stderrPath : null;
      let job = null;
      // The adopted job publishes its own record under the real task id; drop
      // the foreground marker first so the command is never counted twice.
      _clearForegroundRecord();
      const elapsedMs = _elapsedSinceStart();
      const adoptedTimeoutMs = reason === 'timeout'
        ? promotedTimeoutMs
        : (backgroundDeadlineMs > 0
          ? Math.max(1, backgroundDeadlineMs - elapsedMs)
          : 0);
      try {
        job = await adoptForegroundShellJob({
          command,
          cwd,
          pid: child.pid,
          timeoutMs: adoptedTimeoutMs,
          // Carry the command's own start moment into the job: adoption time
          // and a standby's process-creation time are both wrong.
          startedAtMs: _commandStartedAtMs,
          mergeStderr: false,
          stdoutPath,
          stderrPath,
          // Stamp the adopted job with the dispatching terminal's claude.exe
          // pid so the statusline scopes it to the owning session.
          clientHostPid,
          // …and with the dispatching SESSION, so a pooled host (desktop) can
          // show the job on its own pane only.
          ownerSessionId,
        });
      } catch {
        job = null;
      }
      // Adoption failed AFTER the foreground timers/size-watchdog were already
      // torn down. Do NOT resolve as backgrounded — that would leave the child
      // running unlimited with no task_id and no watcher. Release the claim and
      // fall back to the old kill path so the command never outlives a failed
      // promotion. (The abort handler is still attached, so an in-flight cancel
      // is honored by the kill path too.)
      if (!job) {
        autoBackgrounded = false;
        if (reason === 'timeout') {
          timedOut = true;
          _treeKillForceSettle('timeout');
        } else {
          _treeKillForceSettle('background-adoption-failed');
        }
        return;
      }
      const jobId = job.jobId;
      autoBackgroundJobId = jobId;
      const promotedLease = resourceLease;
      resourceLease = null;
      if (promotedLease) {
        try {
          await promotedLease.detachDependency?.();
          attachShellJobResourceLease(jobId, promotedLease);
        } catch (error) {
          try { await promotedLease.release(); } catch {}
          throw error;
        }
      }
      // Snapshot the partial output captured so far for the immediate result.
      let stdout = '';
      let stderr = '';
      try { stdout = await taskOutput.getStdout(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      try { stderr = await taskOutput.getStderr(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      // Re-check after the awaited capture reads: cancellation can race after
      // adoption commits. Never report that cancelled process as a successful
      // still-running background task.
      // EXCEPTION: an interrupt-driven promotion starts FROM an aborted signal
      // by design (the user typed a new message), so this guard must not undo
      // the very transition it was asked to perform. A plain cancellation still
      // reverts adoption and kills.
      if (abortSignal && abortSignal.aborted
        && !(reason === 'interrupt' && _abortReasonIsInterrupt(abortSignal))) {
        killed = true;
        killCause = 'cancellation';
        try { killShellJob(jobId); } catch {}
        try { treeKill(child); } catch {}
        resolveResult(new ExecResult({
          stdout,
          stderr,
          exitCode: null,
          signal: child.signalCode || null,
          timedOut: false,
          killed: true,
          killCause,
          stdoutPath,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
          partialOutput: true,
          outputCaptureError: taskOutput.writeError,
          backgrounded: false,
        }));
        return;
      }
      // Completed-during-promotion race: the child
      // finished while adoption was committing. Report a clean COMPLETED
      // result instead of backgrounded — the caller then never arms the
      // completion watcher, so no redundant task notification fires. Write
      // the exit/done files here as well: when 'close' fired before the
      // once('close') wiring above, nothing else would ever flip the adopted
      // job detail off 'running'.
      if (child.exitCode != null || child.signalCode != null) {
        detachAbortHandler();
        resolveResult(new ExecResult({
          stdout,
          stderr,
          exitCode: child.exitCode,
          signal: child.signalCode || null,
          timedOut: false,
          killed: false,
          stdoutPath,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
          partialOutput: false,
          outputCaptureError: taskOutput.writeError,
          backgrounded: false,
        }));
        return;
      }
      // The adopted job now owns cancellation through task control. Retaining
      // the foreground caller's signal listener would keep the completed tool
      // frame alive and could later kill an unrelated, already-returned job.
      detachAbortHandler();
      const secs = Math.max(0, Math.round(_elapsedSinceStart() / 1000));
      const _verb = reason === 'timeout'
        ? `moved to background at timeout after ${secs}s`
        : `auto-backgrounded after ${secs}s`;
      resolveResult(
        new ExecResult({
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          timedOut: false,
          killed: false,
          stdoutPath,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
          partialOutput: true,
          outputCaptureError: taskOutput.writeError,
          backgrounded: true,
          jobId,
          backgroundTimeoutMs: adoptedTimeoutMs,
          backgroundMessage: jobId
            ? `${_verb}; still running.`
            : `${_verb}; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.`,
        }),
      );
    };
    const fireAutoBackground = (options) => {
      void _autoBackground(options).catch((error) => {
        if (resultResolved) return;
        settled = true;
        autoBackgrounded = true;
        // A promotion that threw before it could clear the marker must still
        // leave nothing behind: the child is killed right below.
        _clearForegroundRecord();
        killed = true;
        killCause = 'resource-cleanup-error';
        detachAbortHandler();
        try { if (autoBackgroundJobId) killShellJob(autoBackgroundJobId); } catch {}
        try { treeKill(child); } catch {}
        resolveResult(new ExecResult({
          stdout: '',
          stderr: `resource cleanup failed during background promotion: ${error?.message || error}`,
          exitCode: 1,
          signal: child?.signalCode || null,
          timedOut: false,
          killed: true,
          killCause,
          taskId,
          partialOutput: true,
          outputCaptureError: taskOutput.writeError,
          failurePhase: 'tool',
          failureReason: 'resource cleanup failed',
          backgrounded: false,
        }));
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // Promote-on-timeout: if the caller allows backgrounding and the child
        // is still running (not a trailing-`&` detach), adopt it as a tracked
        // background job instead of tree-killing it. Falls through to the old
        // kill path for disallowed/opted-out commands (backgroundOnTimeout
        // false) or when a terminal transition already won the race.
        if (
          backgroundOnTimeout &&
          !_isBackground &&
          !settled &&
          !autoBackgrounded &&
          !killed &&
          child.exitCode == null &&
          child.signalCode == null
        ) {
          fireAutoBackground({ reason: 'timeout' });
          return;
        }
        timedOut = true;
        _treeKillForceSettle('timeout');
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    // Live-progress heartbeat: every 2 s while the foreground command runs,
    // emit "running Ns" so the MCP client renders live progress
    // instead of an opaque hang. Only armed for a genuine foreground run with
    // a subscribed client; trailing-`&` background commands settle on exit and
    // never need it. Cleared on settle / auto-background (see above).
    if (_hasProgress && !_isBackground) {
      progressTimer = setInterval(() => {
        if (settled || autoBackgrounded) return;
        const secs = Math.round(_elapsedSinceStart() / 1000);
        try { onProgress(`running ${secs}s`); } catch {}
      }, 2000);
      if (progressTimer.unref) progressTimer.unref();
    }

    // Live output tail pump (see declaration above). Emits only on change so
    // idle commands cost one getLiveTail per second and zero downstream work.
    if (_hasOutputTail && !_isBackground) {
      outputTailTimer = setInterval(() => {
        if (settled || autoBackgrounded) return;
        try {
          const tail = taskOutput.getLiveTail(4000);
          if (tail && tail !== _lastOutputTail) {
            _lastOutputTail = tail;
            onOutputTail(tail);
          }
        } catch { /* best effort */ }
      }, 1000);
      if (outputTailTimer.unref) outputTailTimer.unref();
    }

    // Arm the auto-background timer only for the genuine foreground one-shot
    // path: a positive threshold strictly below the hard timeout, and not a
    // trailing-`&` background command (those already detach + settle on exit).
    if (
      typeof autoBackgroundMs === 'number' &&
      autoBackgroundMs > 0 &&
      !_isBackground &&
      (timeoutMs <= 0 || autoBackgroundMs < timeoutMs)
    ) {
      autoBgTimer = setTimeout(() => { fireAutoBackground(); }, autoBackgroundMs);
      if (autoBgTimer.unref) autoBgTimer.unref();
    }

    if (abortSignal) {
      abortHandler = () => {
        // Interrupt (the user typed a NEW message while this was running) is a
        // "also look at this" signal, not "stop that" — it backgrounds instead
        // of killing there, and throwing away a long build the user never asked
        // to stop is the worse outcome. Explicit cancellation (ESC) keeps the
        // kill. The promotion reuses the timeout path's guards verbatim so a
        // detached / already-settled / already-exited child can never be
        // adopted as a job.
        if (
          _abortReasonIsInterrupt(abortSignal) &&
          backgroundOnTimeout &&
          !_isBackground &&
          !settled &&
          !autoBackgrounded &&
          !killed &&
          child?.exitCode == null &&
          child?.signalCode == null
        ) {
          fireAutoBackground({ reason: 'interrupt' });
          return;
        }
        _treeKillForceSettle('cancellation');
      };
      try {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      } catch {}
    }
  });
}
