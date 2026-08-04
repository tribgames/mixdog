'use strict';
// Async one-shot shell runner.
//
// Replaces the legacy spawnSync path in builtin.mjs shell execution. The
// improvements over spawnSync are:
//   - tree-kill on timeout / abort (Windows taskkill /T /F, POSIX process
//     group SIGTERM->SIGKILL escalation) so forked children come down with
//     the parent shell instead of being orphaned holding pipes.
//   - automatic spill to $PLUGIN_DATA/shell-output/<taskId>.* once the
//     in-memory buffers exceed SHELL_OUTPUT_INLINE_CAP*4 bytes. The caller
//     receives an outputFilePath marker the model can FileRead later
//     instead of losing the tail past the inline cap.
//   - external AbortSignal hookup so a session-scoped abort (ESC, new
//     prompt) cancels in-flight bash work without orphaning the child.
//
// Persistent shells in bash-session.mjs keep their separate stdin-marker
// protocol — that runner is stateful and uses a different model entirely.

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as nodeUtil from 'node:util';
import { getPluginData } from '../config.mjs';
import { startChildGuardian } from '../../../shared/child-guardian.mjs';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';
// Runtime-only import (used inside execShellCommand's auto-background
// transition). shell-jobs.mjs imports stripAnsi from this module, so this is
// a static cycle — safe because neither binding is touched at module-eval
// time, only when the respective functions actually run.
import { adoptForegroundShellJob, killShellJob } from './builtin/shell-jobs.mjs';
import { trackProcessTreeQuiescence } from './builtin/shell-job-process.mjs';
import {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';
import { spawnShellWithRetry as _spawnShellWithRetry } from './lib/shell-spawn-retry.mjs';
import { takePwshStandby } from './lib/pwsh-standby-pool.mjs';

export {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';

// Inline cap. Output above this size is spilled to disk and the caller
// renders a path marker instead of pasting the tail. Matches the
// SHELL_OUTPUT_MAX_CHARS used by the smart-truncate renderer in
// builtin.mjs so spilled output and inline output share the same boundary.
import { SHELL_OUTPUT_INLINE_CAP, SHELL_OUTPUT_DISK_CAP, SIZE_WATCHDOG_INTERVAL_MS, stripAnsi, treeKill, TaskOutput, ExecResult } from './shell-exec-output.mjs';
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
const SHELL_ADMISSION_WAIT_MS = Number.isFinite(_envAdmissionWait) && _envAdmissionWait >= 0
  ? _envAdmissionWait
  : 30_000;

// CC parity default: capture child output via file fds (TaskOutput direct
// mode) instead of parent-side pipes. Opt back into pipe capture with
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
const SHELL_DIRECT_CAPTURE = process.platform !== 'win32'
  && !/^(1|true|yes|on)$/i.test(
    String(process.env.MIXDOG_SHELL_PIPE_CAPTURE || '').trim(),
  );

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

export async function acquireShellLeaseBounded(admission, { abortSignal, label, dependency = 'scoped' } = {}) {
  if (!(SHELL_ADMISSION_WAIT_MS > 0)) {
    return admission.acquire('shell', { signal: abortSignal || null, label, dependency });
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
        const lease = await admission.acquire('shell', { signal: ctl.signal, label, dependency });
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

// After the direct child exits, descendants that survive tree-kill (GUI/daemon
// helpers such as Electron crashpad) can keep the quiescence tracker pending
// forever, permanently holding an admission lease. Cap the post-exit linger:
// the tree stays observed, but the admission capacity is reclaimed so new
// shell work cannot deadlock on saturation. 0 disables the cap.
const _envLeaseLinger = Math.floor(Number(process.env.MIXDOG_SHELL_LEASE_LINGER_MAX_MS));
const SHELL_LEASE_LINGER_MAX_MS = Number.isFinite(_envLeaseLinger) && _envLeaseLinger >= 0
  ? _envLeaseLinger
  : 120_000;

function _armLeaseLingerCap(getLease, label) {
  if (!(SHELL_LEASE_LINGER_MAX_MS > 0)) return;
  const timer = setTimeout(() => {
    let lease = null;
    try { lease = typeof getLease === 'function' ? getLease() : getLease; } catch {}
    if (!lease || lease.released) return;
    console.warn(
      `[shell] ${label}: admission lease force-released ${SHELL_LEASE_LINGER_MAX_MS}ms after root exit; `
      + 'descendant processes are still alive and remain untracked daemons.',
    );
    try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
  }, SHELL_LEASE_LINGER_MAX_MS);
  if (timer.unref) timer.unref();
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
  backgroundOnTimeout,
  promotedTimeoutMs = 0,
  admission = resourceAdmission,
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
    let timedOut = false;
    let killed = false;
    let killCause = null;
    let failurePhase = null;
    let failureReason = null;
    let spawnError = null;
    let pendingChildError = null;
    let childGuardian = null;
    let settle = null;
    let settled = false;
    let timer = null;
    let abortHandler = null;
    let partialOutput = false;
    let resourceLease = null;
    let resourceLeaseSettlement = null;
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
    const releaseResourceLeaseWhenTreeQuiescent = (pid, { waitForRootExit = false } = {}) => {
      if (resourceLeaseSettlement) return resourceLeaseSettlement;
      if (!resourceLease) return { pending: false, promise: Promise.resolve() };
      const lease = resourceLease;
      resourceLease = null;
      const cleanup = Promise.withResolvers();
      const tracker = trackProcessTreeQuiescence(pid, () => {
        try {
          Promise.resolve(lease.release()).then(
            () => cleanup.resolve({ error: null }),
            (error) => cleanup.resolve({ error }),
          );
        } catch (error) {
          cleanup.resolve({ error });
        }
      }, { waitForRootExit });
      resourceLeaseSettlement = {
        lease,
        tracker,
        get pending() { return tracker.pending; },
        promise: cleanup.promise,
      };
      return resourceLeaseSettlement;
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
    let _standby = null;
    let _viaMarker = false;
    let _standbyDetach = null;
    let _markerFilters = null;
    let _onChildErrorRef = null;
    try {
      resourceLease = await acquireShellLeaseBounded(admission, {
        abortSignal,
        label: String(command || '').slice(0, 120),
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
      const _spawnCommand = _maybeEncodePowerShellCommand(command);
      const argv = Array.isArray(shellArgs) && shellArgs.length > 0
        ? [...shellArgs, _spawnCommand]
        : [shellArg, _spawnCommand];
      const _onChildError = (err) => {
        spawnError = spawnError || err;
        failurePhase = 'tool';
        failureReason = 'spawn failed';
        if (settle) settle(1, null);
        else pendingChildError = pendingChildError || err;
      };
      _onChildErrorRef = _onChildError;
      // Warm standby adoption (Windows/pwsh only, see pwsh-standby-pool.mjs):
      // a pre-spawned pwsh blocked on stdin replaces the cold spawn. The
      // command is fed via stdin AFTER the stdio/exit wiring below, so no
      // output can be produced before the capture handlers are attached.
      // Standby children always use pipe capture — identical to the win32
      // default (SHELL_DIRECT_CAPTURE is false on win32).
      _standby = takePwshStandby({ shell, shellArgs, env });
      if (_standby) {
        child = _standby.child;
        child.on('error', _onChildError);
      } else {
      // Direct capture (CC file-mode parity): the child writes stdout/stderr
      // into the spill files via inherited fds. No parent pipes exist, so
      // 'close' fires with 'exit' and grandchildren cannot hold the capture
      // open. Falls back to pipe capture if the files cannot be opened.
      const _directCapture = SHELL_DIRECT_CAPTURE ? taskOutput.openDirectCapture() : null;
      const spawned = await _spawnShellWithRetry({
        shell,
        argv,
        shellArg,
        cwd,
        spawnOptions: {
        env,
        cwd,
        windowsHide: true,
        stdio: _directCapture
          ? ['ignore', _directCapture.stdoutFd, _directCapture.stderrFd]
          : ['ignore', 'pipe', 'pipe'],
        // NOTE (child-spawn-gate): intentionally NOT routed through
        // src/runtime/shared/child-spawn-gate.mjs. bash/pwsh commands can run
        // for minutes (or auto-background), so holding a finite gate slot for
        // the whole lifetime would let a few long shells starve rg/code_graph —
        // the opposite of the gate's intent. TODO: if shell saturation becomes
        // a problem, gate only the brief spawn burst (release on first output /
        // adoption), not the full run.
        // POSIX: detached gives the child its own process group so treeKill can
        // signal the whole group. The child is still CLI-owned because we do
        // not unref it after adoption. Windows detached has different console
        // semantics, so it stays off there.
        detached: process.platform !== 'win32',
        },
      });
      child = spawned.child;
      spawned.adoptErrorHandler(_onChildError);
      }
      childGuardian = startChildGuardian({
        childPid: child.pid,
        childGroupPid: child.pid,
        label: 'shell-command',
        protectHostMemory: true,
      });
      // Windows has no process-group handle. Begin observing while the owned
      // root still exists so descendants can be proven before root exit.
      // Standby children skip the eager tracker: their root stays ALIVE across
      // commands (waitForRootExit could never confirm and its CIM polling
      // would run for the standby's whole lifetime). Marker settle releases
      // the lease through the recycle path instead; kill/exit fallbacks below
      // create the tracker lazily once the root is really gone.
      if (!_standby) releaseResourceLeaseWhenTreeQuiescent(child.pid, { waitForRootExit: true });
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

    // Pipe-capture wiring only; direct mode has no parent-side streams.
    // Standby children speak the marker protocol: per-command completion
    // markers on BOTH streams are stripped from the capture and drive settle()
    // (the process stays alive for the next command), while kill/exit paths
    // still settle through 'close' as before.
    let _stdoutData = (chunk) => { taskOutput.writeStdout(chunk); };
    let _stderrData = (chunk) => taskOutput.writeStderr(chunk);
    if (_standby) {
      const donePrefix = _standby.doneMarkerPrefix;
      const stalePrefix = _standby.staleMarkerPrefix;
      const _mk = { outDone: false, errDone: false, code: 1 };
      const tryComplete = () => {
        if (!_mk.outDone || !_mk.errDone) return;
        if (settled || autoBackgrounded || killed) return;
        // Both streams delivered their marker — everything the command wrote
        // is already in the capture. Detach BEFORE settle so late output from
        // an undiscovered descendant can never pollute this task, then settle
        // through the marker path (recycle + direct lease release).
        _standbyDetach?.();
        _viaMarker = true;
        settle(_mk.code, null);
      };
      const makeFilter = (write, onMarkerLine) => {
        let tail = '';
        return {
          data: (chunk) => {
            tail += chunk;
            let idx;
            let out = '';
            while ((idx = tail.indexOf('\n')) !== -1) {
              const line = tail.slice(0, idx + 1);
              tail = tail.slice(idx + 1);
              if (line.startsWith(donePrefix)) { onMarkerLine(line); continue; }
              // Same-nonce marker with a DIFFERENT run token: a straggler
              // from an earlier command on this standby entry. Drop it from
              // the capture and log — this is the observable trace of the
              // late-flush/offset condition the per-command token defuses.
              if (stalePrefix && line.startsWith(stalePrefix)) {
                try { process.stderr.write(`[pwsh-standby] dropped stale marker from a previous command (pid=${child.pid})\n`); } catch { /* diagnostics only */ }
                continue;
              }
              out += line;
            }
            if (out) write(out);
            // A marker always ends with a newline, so only a pathological
            // marker-free run can grow the tail; spill it but keep enough to
            // recognize a marker split across chunks.
            if (tail.length > 65536) { write(tail.slice(0, -256)); tail = tail.slice(-256); }
          },
          flush: () => { if (tail) { write(tail); tail = ''; } },
        };
      };
      const outFilter = makeFilter((s) => taskOutput.writeStdout(s), (line) => {
        const m = /^:(-?\d+)>>>/.exec(line.slice(donePrefix.length));
        _mk.code = m ? Number(m[1]) : 1;
        _mk.outDone = true;
        tryComplete();
      });
      const errFilter = makeFilter((s) => taskOutput.writeStderr(s), () => {
        _mk.errDone = true;
        tryComplete();
      });
      _markerFilters = [outFilter, errFilter];
      _stdoutData = outFilter.data;
      _stderrData = errFilter.data;
    }
    if (child.stdout) {
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', _stdoutData);
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', _stderrData);
    }

    // Standby path: the capture handlers are attached — release the command
    // into the waiting pwsh now. Skipped when a pre-fired abort already
    // tree-killed the child (its close still settles the call).
    if (_standby && !killed) {
      const _spawnCommandForStandby = _maybeEncodePowerShellCommand(command);
      _standby.run(_spawnCommandForStandby, cwd);
    }

    // If the spill writer hits an I/O failure (full disk, EBADF after
    // an unlink race) bring the child down so the agent isn't deceived
    // by a successful exit code on a truncated capture.
    const _abortOnCaptureError = () => {
      if (taskOutput.writeError && !killed && !settled && !autoBackgrounded) {
        _treeKillForceSettle('output-capture-error');
      }
    };

    let sizeWatchdog = null;
    settle = async (exitCode, signal) => {
      if (settled || autoBackgrounded) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      _clearProgressTimer();
      if (sizeWatchdog) {
        clearInterval(sizeWatchdog);
        sizeWatchdog = null;
      }
      if (autoBgTimer) {
        clearTimeout(autoBgTimer);
        autoBgTimer = null;
      }
      detachAbortHandler();
      // Marker-free paths (kill/exit) may hold a partial last line in the
      // standby stream filters — flush it so the capture keeps the tail.
      if (_markerFilters) {
        for (const f of _markerFilters) { try { f.flush(); } catch { /* best-effort */ } }
      }
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
      if (_viaMarker && _standby) {
        // Marker-settled standby: the root pwsh is ALIVE by design, so the
        // waitForRootExit tracker could never confirm. recycle() probes for
        // leftover descendants off the result path (returns the standby to the
        // pool when clean, tree-kills it otherwise) and the lease frees after.
        const lease = resourceLease;
        resourceLease = null;
        // The standby root survives this command and may return to the pool.
        // Stop this command-scoped guardian so every reuse does not leave
        // another detached Node process watching the same pwsh forever.
        const standbyGuardian = childGuardian;
        childGuardian = null;
        void _standby.recycle()
          .catch(() => false)
          .then(() => { try { return Promise.resolve(lease?.release()).catch(() => {}); } catch { return null; } })
          .finally(() => standbyGuardian?.stop?.());
      } else {
      childGuardian?.stop?.();
      childGuardian = null;
      const leaseSettlement = resourceLeaseSettlement
        || releaseResourceLeaseWhenTreeQuiescent(child.pid);
      leaseSettlement.tracker?.rootExited?.();
      // Decoupled lease settlement: the tool RESULT resolves immediately —
      // the output is fully captured above and nothing in ExecResult depends
      // on admission accounting. The quiescence proof (a Windows CIM process
      // snapshot costing ~200ms per call) and the lease release continue in
      // the background: exactly-once release is owned by the tracker/lease,
      // and the linger cap still bounds a stuck descendant tree.
      void (async () => {
        try {
          await leaseSettlement.tracker?.afterRootExitCheck?.();
          if (!leaseSettlement.pending) await leaseSettlement.promise;
          else _armLeaseLingerCap(() => leaseSettlement.lease, taskId);
        } catch { /* background release must never throw */ }
      })();
      }
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
    // Standby recycle prerequisite: THIS command's listeners must come off the
    // long-lived child before it can serve another command (otherwise every
    // reuse would stack another close/exit/data listener and stale handlers
    // would keep writing into this task's finished capture).
    _standbyDetach = () => {
      try { child.stdout?.removeListener('data', _stdoutData); } catch { /* best-effort */ }
      try { child.stderr?.removeListener('data', _stderrData); } catch { /* best-effort */ }
      try { child.removeListener('close', _onChildClose); } catch { /* best-effort */ }
      try { child.removeListener('exit', _onChildExit); } catch { /* best-effort */ }
      if (_onChildErrorRef) {
        try { child.removeListener('error', _onChildErrorRef); } catch { /* best-effort */ }
      }
    };

    // Auto-background transition (CC startBackgrounding analogue). Two triggers
    // resolve the call immediately with a 'backgrounded' result while the
    // child keeps running, adopted into the shell-jobs registry but still
    // owned by this CLI process:
    //   1. the optional autoBackgroundMs soft threshold (MIXDOG_SHELL_AUTO_
    //      BACKGROUND_MS opt-in) — an EARLIER promotion before the timeout, and
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
      // Standby handoff: stop feeding this process. Once the in-flight
      // command completes, the marker loop reads stdin EOF and exits with
      // that command's code — the adopted job's close-wired exit file then
      // records the real command exit, and the standby is never reused.
      if (_standby) { try { _standby.endStdin(); } catch { /* best-effort */ } }
      // The foreground capture is over; stop the local watchdogs/timers so
      // they cannot treeKill the now-adopted child.
      if (timer) { clearTimeout(timer); timer = null; }
      _clearProgressTimer();
      if (sizeWatchdog) { clearInterval(sizeWatchdog); sizeWatchdog = null; }
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
      const adoptedTimeoutMs = reason === 'timeout' ? promotedTimeoutMs : 0;
      try {
        job = adoptForegroundShellJob({
          command,
          cwd,
          pid: child.pid,
          timeoutMs: adoptedTimeoutMs,
          mergeStderr: false,
          stdoutPath,
          stderrPath,
          // Stamp the adopted job with the dispatching terminal's claude.exe
          // pid so the statusline scopes it to the owning session.
          clientHostPid,
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
      const promotedLease = resourceLeaseSettlement?.lease || resourceLease;
      child.once('close', () => { resourceLeaseSettlement?.tracker?.rootExited?.(); });
      // Wire the lifecycle: on close, write the exit-code file FIRST then
      // touch donePath STRICTLY AFTER — the exact ordering refreshShellJob()
      // gates completion on (donePath visible ⇒ exit file fully flushed).
      if (job && job.exitPath && job.donePath) {
        child.once('close', (code, signal) => {
          const rc = code == null ? (signal ? 1 : 0) : code;
          try { writeFileSync(job.exitPath, String(rc)); } catch {}
          try { writeFileSync(job.donePath, ''); } catch {}
          // The adopted child is done writing; release the parent's spill fds.
          try { taskOutput.closeFds(); } catch {}
        });
      }
      // Snapshot the partial output captured so far for the immediate result.
      let stdout = '';
      let stderr = '';
      try { stdout = await taskOutput.getStdout(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      try { stderr = await taskOutput.getStderr(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      const jobId = job ? job.jobId : null;
      autoBackgroundJobId = jobId;
      // Re-check after the awaited capture reads: cancellation can race after
      // adoption commits. Never report that cancelled process as a successful
      // still-running background task.
      if (abortSignal && abortSignal.aborted) {
        killed = true;
        killCause = 'cancellation';
        try { killShellJob(jobId); } catch {}
        try { treeKill(child); } catch {}
        await promotedLease?.detachDependency?.();
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
      // CC parity (BashTool completed-during-promotion race): the child
      // finished while adoption was committing. Report a clean COMPLETED
      // result instead of backgrounded — the caller then never arms the
      // completion watcher, so no redundant task notification fires. Write
      // the exit/done files here as well: when 'close' fired before the
      // once('close') wiring above, nothing else would ever flip the adopted
      // job detail off 'running'.
      if (child.exitCode != null || child.signalCode != null) {
        const rc = child.exitCode == null ? 1 : child.exitCode;
        if (job && job.exitPath && job.donePath) {
          try { writeFileSync(job.exitPath, String(rc)); } catch {}
          try { writeFileSync(job.donePath, ''); } catch {}
        }
        await promotedLease?.detachDependency?.();
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
      // Promotion changes a scoped dependency into detached lifetime work.
      // Re-admit the continuing parent through the normal bounded queue before
      // returning control; if the child exits first, its close release supplies
      // the capacity that completes this restoration.
      await promotedLease?.detachDependency?.();
      // The adopted job now owns cancellation through task control. Retaining
      // the foreground caller's signal listener would keep the completed tool
      // frame alive and could later kill an unrelated, already-returned job.
      detachAbortHandler();
      const secs = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
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
            ? `${_verb}; still running. Waiting is a decision, not a default: judge from the partial output whether this will finish within your remaining budget — if progress looks slow or stalled, diagnose the cause and pursue an alternative instead of waiting. Completion will be delivered as a background task notification; use task with task_id:${jobId} only for manual wait/status/read/cancel.`
            : `${_verb}; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.`,
        }),
      );
    };
    const fireAutoBackground = (options) => {
      void _autoBackground(options).catch((error) => {
        if (resultResolved) return;
        settled = true;
        autoBackgrounded = true;
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
        const secs = Math.round((Date.now() - _startMs) / 1000);
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

    // Size watchdog — a stuck command pumping GBs of stdout into the spill
    // file would fill the user's disk before the timeout fires. Poll the
    // running disk total every 5 s and SIGKILL once we cross the cap. The
    // settle() path clears this interval directly (see top of this Promise
    // body) so no extra exit / error listeners are needed here.
    sizeWatchdog = setInterval(() => {
      if (settled || autoBackgrounded) return;
      _abortOnCaptureError();
      if (taskOutput.totalDiskBytes() > SHELL_OUTPUT_DISK_CAP) {
        _treeKillForceSettle('output-limit');
      }
    }, SIZE_WATCHDOG_INTERVAL_MS);
    if (sizeWatchdog.unref) sizeWatchdog.unref();

    if (abortSignal) {
      abortHandler = () => {
        _treeKillForceSettle('cancellation');
      };
      try {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      } catch {}
    }
  });
}
