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
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as nodeUtil from 'node:util';
import { getPluginData } from '../config.mjs';
import { startChildGuardian } from '../../../shared/child-guardian.mjs';
// Runtime-only import (used inside execShellCommand's auto-background
// transition). shell-jobs.mjs imports stripAnsi from this module, so this is
// a static cycle — safe because neither binding is touched at module-eval
// time, only when the respective functions actually run.
import { adoptForegroundShellJob, killShellJob } from './builtin/shell-jobs.mjs';
import {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';

export {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';

// Inline cap. Output above this size is spilled to disk and the caller
// renders a path marker instead of pasting the tail. Matches the
// SHELL_OUTPUT_MAX_CHARS used by the smart-truncate renderer in
// builtin.mjs so spilled output and inline output share the same boundary.
const SHELL_OUTPUT_INLINE_CAP = 30_000;

// Hard ceiling on disk-backed output. Past this the SIZE_WATCHDOG (G2)
// SIGKILLs the child to avoid filling the filesystem. 100 MB is generous
// for any legitimate command output and tight enough to catch a runaway
// loop within ~seconds on a typical SSD.
const SHELL_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

// Background-task disk watchdog cadence. The size guard polls the spilled
// stdout/stderr files every interval and SIGKILLs the child once the
// combined size exceeds SHELL_OUTPUT_DISK_CAP — short enough that a runaway loop is caught within a
// few seconds, long enough that the stat overhead is negligible.
const SIZE_WATCHDOG_INTERVAL_MS = 1_000;

// fsync throttle for spilled output reads. getStdout/getStderr call
// fsyncSync before reading to ensure the caller sees the latest bytes.
// On Windows every fsyncSync is a noticeable I/O syscall, so throttle
// consecutive calls to at most one per this interval. Tune via env
// MIXDOG_SHELL_FSYNC_THROTTLE_MS (default 1000 ms, positive integer).
function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
const MIXDOG_SHELL_FSYNC_THROTTLE_MS = positiveIntEnv('MIXDOG_SHELL_FSYNC_THROTTLE_MS', 1000);

// ANSI / VT control sequence stripper. Falls back to a regex sweep when
// node:util's stripVTControlCharacters isn't available (older Node).
const _ANSI_REGEX =
  /(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:|\\|))/g;
const _stripAnsiImpl =
  typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => String(s).replace(_ANSI_REGEX, () => '');

export function stripAnsi(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return _stripAnsiImpl(s);
}

// Tree-kill helper. spawn alone only signals the direct child, so a
// `sleep 1000 &` or a forked node server inside the shell stays alive
// holding the pipes open. POSIX path signals the process group (we spawn
// with detached:true to give the child its own pgid). Windows uses
// taskkill /T /F to walk the tree. Safe to call repeatedly; all errors
// swallowed.
function treeKill(child) {
  if (!child) return;
  // Track close/exit via the standard child fields (set by Node when
  // the corresponding events fire) instead of `child.killed`, which is
  // true the moment any signal is delivered — even before the child has
  // actually terminated. Using exitCode/signalCode means the SIGKILL
  // escalation only suppresses itself when the process is genuinely
  // gone.
  if (child.exitCode != null || child.signalCode != null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      // Escalate to SIGKILL after 3s so a child that ignores SIGTERM
      // still comes down. Windows taskkill /F is already forceful so
      // skip the escalation timer there.
      const esc = setTimeout(() => {
        if (child.exitCode != null || child.signalCode != null) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }, 3000);
      if (esc.unref) esc.unref();
    }
  } catch {
    /* swallow */
  }
}

// Head+tail read helper: avoid pulling a large spill back into memory, but
// preserve BOTH the start of the output (where build / compiler / test errors
// are usually printed first) and the most recent output. Past INLINE_CAP*4
// bytes we return the first half-budget and the trailing half-budget with an
// elision marker between; below that the full body is returned as-is. A tail-
// only slice silently dropped early diagnostics. UTF-8 sequences are at most
// 4 B, so a small padding window lets us cut/advance on codepoint boundaries
// instead of emitting a U+FFFD glyph at the seam.
function _readHeadTail(filePath, fileSize) {
  if (fileSize <= SHELL_OUTPUT_INLINE_CAP * 4) {
    return readFileSync(filePath, 'utf-8');
  }
  const padding = 4;
  const headBudget = Math.floor(SHELL_OUTPUT_INLINE_CAP / 2);
  const tailBudget = SHELL_OUTPUT_INLINE_CAP - headBudget;
  const fd = openSync(filePath, 'r');
  try {
    // Head: first headBudget bytes, dropping a split trailing codepoint.
    const headBuf = Buffer.allocUnsafe(headBudget + padding);
    const hn = readSync(fd, headBuf, 0, headBudget + padding, 0);
    let hEnd = Math.min(headBudget, hn);
    while (hEnd > 0 && hEnd < hn && (headBuf[hEnd] & 0xC0) === 0x80) hEnd--;
    const head = headBuf.slice(0, hEnd).toString('utf-8');
    // Tail: last tailBudget bytes, advancing past a leading split codepoint.
    const tailReadSize = tailBudget + padding;
    const tailStart = Math.max(hEnd, fileSize - tailReadSize);
    const tailBuf = Buffer.allocUnsafe(tailReadSize);
    const tn = readSync(fd, tailBuf, 0, tailReadSize, tailStart);
    let tOff = 0;
    if (tailStart > 0) {
      while (tOff < tn && tOff < padding && (tailBuf[tOff] & 0xC0) === 0x80) tOff++;
    }
    const tail = tailBuf.slice(tOff, tn).toString('utf-8');
    const elided = Math.max(0, (tailStart + tOff) - hEnd);
    return `${head}\n... [${elided} bytes elided of ${fileSize} total — head+tail shown; full output spilled to disk] ...\n${tail}`;
  } finally {
    try { closeSync(fd); } catch {}
  }
}

// Owns the captured stdout/stderr buffers for a single command run. Starts
// fully in memory; once the combined byte total exceeds the spill threshold
// (SHELL_OUTPUT_INLINE_CAP*4), opens append-only files in
// $PLUGIN_DATA/shell-output/ and from then on writes go straight to disk.
// On settle, the caller (execShellCommand) decides whether to keep the
// spilled files based on the final size.
class TaskOutput {
  constructor(taskId) {
    this.taskId = taskId;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this._inlineBytes = 0;
    this.stdoutFd = null;
    this.stderrFd = null;
    this.stdoutPath = null;
    this.stderrPath = null;
    this.spilled = false;
    this.stdoutFileSize = 0;
    this.stderrFileSize = 0;
    this.writeError = null;
    // fsync throttle: task wait/read + tail-read polling can call getStdout/
    // getStderr many times per second. Every call used to fsyncSync(fd),
    // a noticeable I/O tax on Windows. Skip if a recent fsync landed
    // within MIXDOG_SHELL_FSYNC_THROTTLE_MS — the next read still picks up
    // writes via the kernel's normal write-back. Final settle (closeFds)
    // flushes via close anyway.
    this._lastStdoutFsyncMs = 0;
    this._lastStderrFsyncMs = 0;
  }

  _ensureFileBacking() {
    if (this.spilled) return;
    const dir = join(getPluginData(), 'shell-output');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
    this.stdoutPath = join(dir, `${this.taskId}.stdout`);
    this.stderrPath = join(dir, `${this.taskId}.stderr`);
    // openSync failure (EMFILE, EACCES, ENOSPC, ENOTDIR after a race) used
    // to throw straight up into the stream `data` handler, which left the
    // child running with no further writes captured. Catch + record so the
    // run settles cleanly under inline-only mode; the partial buffer in
    // stdoutBuf/stderrBuf survives.
    try {
      this.stdoutFd = openSync(this.stdoutPath, 'a');
      this.stderrFd = openSync(this.stderrPath, 'a');
    } catch (err) {
      this._recordWriteError('spill-open', err);
      if (this.stdoutFd != null) {
        try { closeSync(this.stdoutFd); } catch {}
        this.stdoutFd = null;
      }
      this.stderrFd = null;
      this.stdoutPath = null;
      this.stderrPath = null;
      return;
    }
    if (this.stdoutBuf) {
      try {
        writeSync(this.stdoutFd, this.stdoutBuf);
        this.stdoutFileSize += Buffer.byteLength(this.stdoutBuf, 'utf-8');
      } catch (err) {
        this._recordWriteError('stdout-spill-flush', err);
      }
    }
    if (this.stderrBuf) {
      try {
        writeSync(this.stderrFd, this.stderrBuf);
        this.stderrFileSize += Buffer.byteLength(this.stderrBuf, 'utf-8');
      } catch (err) {
        this._recordWriteError('stderr-spill-flush', err);
      }
    }
    this.spilled = true;
    // The flushed bytes now live in the spill files and getStdout/getStderr
    // read from disk once spilled — drop the inline copies.
    this.stdoutBuf = '';
    this.stderrBuf = '';
  }

  _maybeSpill() {
    if (this.spilled) return;
    // Threshold is in BYTES — string .length counts UTF-16 units, which
    // understates CJK output by up to 3x against the byte-sized cap.
    if (this._inlineBytes > SHELL_OUTPUT_INLINE_CAP * 4) {
      this._ensureFileBacking();
    }
  }

  // Force the in-memory buffers onto disk-backed files regardless of the
  // SHELL_OUTPUT_INLINE_CAP*4 threshold. Used by the auto-background
  // transition: once a foreground command is adopted into a tracked job,
  // every subsequent stdout/stderr chunk must land in the spill files so
  // task wait/read can read it (the caller has already settled and will no
  // longer drain the in-memory buffers). No-op once already spilled.
  forceSpill() {
    if (this.spilled) return;
    this._ensureFileBacking();
  }

  _recordWriteError(stage, err) {
    if (this.writeError) return;
    const msg = (err && err.message) ? err.message : String(err);
    this.writeError = `[output-capture-error: ${stage}] ${msg}`;
  }

  writeStdout(s) {
    if (!s) return;
    if (this.spilled) {
      try {
        writeSync(this.stdoutFd, s);
        this.stdoutFileSize += Buffer.byteLength(s, 'utf-8');
      } catch (err) {
        this._recordWriteError('stdout-write', err);
      }
      return;
    }
    this.stdoutBuf += s;
    this._inlineBytes += Buffer.byteLength(s, 'utf-8');
    this._maybeSpill();
  }

  writeStderr(s) {
    if (!s) return;
    if (this.spilled) {
      try {
        writeSync(this.stderrFd, s);
        this.stderrFileSize += Buffer.byteLength(s, 'utf-8');
      } catch (err) {
        this._recordWriteError('stderr-write', err);
      }
      return;
    }
    this.stderrBuf += s;
    this._inlineBytes += Buffer.byteLength(s, 'utf-8');
    this._maybeSpill();
  }

  totalDiskBytes() {
    return this.stdoutFileSize + this.stderrFileSize;
  }

  async getStdout() {
    if (this.spilled) {
      const now = Date.now();
      if (now - this._lastStdoutFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
        try { fsyncSync(this.stdoutFd); } catch {}
        this._lastStdoutFsyncMs = now;
      }
      try {
        return _readHeadTail(this.stdoutPath, this.stdoutFileSize);
      } catch (err) {
        throw new Error(`[shell-command] spilled stdout read failed (${this.stdoutPath}): ${err.message}`);
      }
    }
    return this.stdoutBuf;
  }

  async getStderr() {
    if (this.spilled) {
      const now = Date.now();
      if (now - this._lastStderrFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
        try { fsyncSync(this.stderrFd); } catch {}
        this._lastStderrFsyncMs = now;
      }
      try {
        return _readHeadTail(this.stderrPath, this.stderrFileSize);
      } catch {
        return '';
      }
    }
    return this.stderrBuf;
  }

  closeFds() {
    if (this.stdoutFd != null) {
      try {
        closeSync(this.stdoutFd);
      } catch {}
      this.stdoutFd = null;
    }
    if (this.stderrFd != null) {
      try {
        closeSync(this.stderrFd);
      } catch {}
      this.stderrFd = null;
    }
  }

  // Drop the spilled files when the inline body already covers the full
  // output. Called when total spilled bytes <= SHELL_OUTPUT_INLINE_CAP, so
  // outputFilePath would only point at a duplicate of what the caller is
  // already pasting into the result.
  deleteFiles() {
    this.closeFds();
    if (this.stdoutPath) {
      try {
        unlinkSync(this.stdoutPath);
      } catch {}
      this.stdoutPath = null;
    }
    if (this.stderrPath) {
      try {
        unlinkSync(this.stderrPath);
      } catch {}
      this.stderrPath = null;
    }
    this.spilled = false;
  }
}

export { TaskOutput };

// Result envelope. Status markers ([exit code: N], [signal: SIGTERM]) are
// the caller's responsibility — shell execution owns that
// rendering convention.
export class ExecResult {
  constructor(opts) {
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal || null;
    this.timedOut = opts.timedOut === true;
    this.killed = opts.killed === true;
    this.stdoutPath = opts.stdoutPath || null;
    this.stdoutFileSize = opts.stdoutFileSize || 0;
    this.stderrPath = opts.stderrPath || null;
    this.stderrFileSize = opts.stderrFileSize || 0;
    this.taskId = opts.taskId;
    this.partialOutput = opts.partialOutput === true;
    this.outputCaptureError = opts.outputCaptureError || null;
    // Distinguish a shell tool/control-plane failure (spawn/preflight/capture)
    // from a command process failure (non-zero exit/signal/timeout). The
    // renderer in builtin/bash-tool.mjs turns this into a model-visible marker.
    this.failurePhase = opts.failurePhase || null;
    this.failureReason = opts.failureReason || null;
    // Auto-background transition (CC startBackgrounding analogue). When a
    // foreground command outlives autoBackgroundMs the call settles with
    // backgrounded:true + the jobId for manual task control. The
    // child stays owned by the CLI process; stdout/stderr keep flowing to
    // the spill files now adopted by the shell-jobs registry.
    this.backgrounded = opts.backgrounded === true;
    this.jobId = opts.jobId || null;
    this.backgroundMessage = opts.backgroundMessage || null;
  }
}

// One-shot async shell runner. abortSignal optional (session-scoped abort
// from getAbortSignalForSession in builtin.mjs). Timeout implemented via
// treeKill so forked grandchildren also come down. Output streams capture
// to TaskOutput which transparently spills to disk past the inline cap.
async function _execPolicyBlockMessage(command) {
  const { checkExecPolicyMessage } = await import('./bash-policy-scan.mjs');
  return checkExecPolicyMessage(command);
}

// Count of shell spawns currently in-flight (including those parked in an
// EPERM backoff). Logged with each failed spawn so a Defender-induced storm
// is reconstructable: activeSpawnCount > 1 means concurrent spawns were
// racing the AV scan when the failure hit.
let _activeShellSpawns = 0;

function _isPowerShellSpawn(shell, shellArg) {
  return /pwsh|powershell/i.test(String(shell || '')) || shellArg === '-Command';
}

// Windows Defender intermittently fails node→PowerShell spawns with EPERM
// while it scans the child image (see shell-runtime.mjs Trojan false-positive
// note). The failure is at spawn() time — before any stdio/side effect — so a
// short bounded retry is safe and never re-runs a command that already ran.
// Retry ONLY on EPERM/win32/powershell; everything else throws on first
// failure. Backoff 100/300/700ms caps added latency at ~1.1s. Every failed
// attempt logs one diagnostic line for later reconstruction.
async function _spawnShellWithRetry({ shell, argv, spawnOptions, shellArg, cwd }) {
  const _delays = [100, 300, 700];
  const _isPowerShell = _isPowerShellSpawn(shell, shellArg);
  _activeShellSpawns++;
  try {
    let attempt = 0;
    for (;;) {
      try {
        return spawn(shell, argv, spawnOptions);
      } catch (err) {
        try {
          console.error('[shell-spawn-retry] ' + JSON.stringify({
            code: (err && err.code) || null,
            syscall: (err && err.syscall) || null,
            shell,
            cwd,
            activeSpawnCount: _activeShellSpawns,
          }));
        } catch { /* logging must never mask the spawn error */ }
        const _canRetry = err && err.code === 'EPERM'
          && process.platform === 'win32'
          && _isPowerShell
          && attempt < _delays.length;
        if (!_canRetry) throw err;
        await new Promise((r) => setTimeout(r, _delays[attempt++]));
      }
    }
  } finally {
    _activeShellSpawns--;
  }
}

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
  clientHostPid,
  backgroundOnTimeout,
}) {
  return new Promise(async (resolve) => {
    const taskId = `shell_${randomUUID().slice(0, 8)}`;
    const taskOutput = new TaskOutput(taskId);
    let timedOut = false;
    let killed = false;
    let settled = false;
    let timer = null;
    let abortHandler = null;
    let partialOutput = false;
    // MCP live-progress: throttled "running Ns, M lines" emits while the
    // foreground command runs. Inert (never armed) when onProgress is null.
    const _hasProgress = typeof onProgress === 'function';
    const _startMs = Date.now();
    let progressTimer = null;
    const _clearProgressTimer = () => {
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    };
    // Auto-background transition flag. Set the moment the autoBackgroundMs
    // timer fires and adopts the still-running child. Once
    // true the normal settle()/close/exit/treeKill paths are inert for this
    // run — the call has already resolved with a 'backgrounded' result and
    // the child's lifecycle is owned by the shell-jobs registry. Mutually
    // exclusive with `settled`: whichever transition wins first wins for good.
    let autoBackgrounded = false;
    let autoBgTimer = null;
    // Treekill + force-settle deadline. treeKill alone leaves settle()
    // pending on 'close'/'exit'; on Windows a taskkill miss or a grandchild
    // holding stdio fds keeps the dispatch stalled until the upstream
    // ceiling. Covers every kill path (timeout / pre-aborted / abort /
    // capture-error / size-watchdog) so the hang risk does not live on
    // outside the timeout branch. Function declaration so callers placed
    // above settle()'s const definition still resolve via hoisting; the
    // 5 s deadline always fires after settle is constructed.
    function _treeKillForceSettle() {
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
    try {
      const _policyErr = await _execPolicyBlockMessage(command);
      if (_policyErr) {
        resolve(
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
      child = await _spawnShellWithRetry({
        shell,
        argv,
        shellArg,
        cwd,
        spawnOptions: {
        env,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      startChildGuardian({
        childPid: child.pid,
        childGroupPid: child.pid,
        label: 'shell-command',
      });
    } catch (err) {
      resolve(
        new ExecResult({
          stdout: '',
          stderr: String((err && err.message) || err),
          exitCode: 1,
          signal: null,
          timedOut: false,
          killed: false,
          taskId,
          failurePhase: 'tool',
          failureReason: 'spawn failed',
        }),
      );
      return;
    }

    // Pre-aborted signal: kill immediately if the abort already fired
    // before spawn returned (synchronous reentry from a parent abort), so
    // the child doesn't run for the full timeoutMs window.
    if (abortSignal && abortSignal.aborted) {
      killed = true;
      _treeKillForceSettle();
    }

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      taskOutput.writeStdout(chunk);
    });
    child.stderr.on('data', (chunk) => taskOutput.writeStderr(chunk));

    // If the spill writer hits an I/O failure (full disk, EBADF after
    // an unlink race) bring the child down so the agent isn't deceived
    // by a successful exit code on a truncated capture.
    const _abortOnCaptureError = () => {
      if (taskOutput.writeError && !killed && !settled && !autoBackgrounded) {
        killed = true;
        _treeKillForceSettle();
      }
    };

    let sizeWatchdog = null;
    const settle = async (exitCode, signal) => {
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
      if (abortSignal && abortHandler) {
        try {
          abortSignal.removeEventListener('abort', abortHandler);
        } catch {}
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
      resolve(
        new ExecResult({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          killed,
          stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
          partialOutput,
          outputCaptureError: taskOutput.writeError,
        }),
      );
    };

    // P1 fix: settle on 'close', not 'exit'. 'exit' fires when the child
    // terminates but stdout/stderr streams may still be flushing buffered
    // bytes; settling there can lose the tail of the output. 'close' fires
    // after stdio is fully drained, so getStdout()/getStderr() see the
    // complete capture.
    child.once('close', (code, signal) => settle(code, signal));
    child.once('error', () => settle(1, null));
    // 'close' only fires after stdio drains; a forked grandchild that
    // inherited stdout/stderr fds can hold them open past direct-child
    // exit and stall settle() until timeoutMs. 'exit' fires on direct
    // child termination regardless — give 'close' a 2 s grace then
    // settle anyway.
    child.once('exit', (code, signal) => {
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
    });

    // Auto-background transition (CC startBackgrounding analogue). Two triggers
    // resolve the call immediately with a 'backgrounded' result while the
    // child keeps running, adopted into the shell-jobs registry but still
    // owned by this CLI process:
    //   1. the optional autoBackgroundMs soft threshold (MIXDOG_SHELL_AUTO_
    //      BACKGROUND_MS opt-in) — an EARLIER promotion before the timeout, and
    //   2. the foreground timeout deadline (backgroundOnTimeout) — the default
    //      promote-on-timeout that replaces the old tree-kill.
    // Either way the adopted job runs UNLIMITED (timeoutMs 0, matching the
    // async default): the original foreground timeout no longer bounds it, and
    // the adopted-job cap poll still enforces the 100 MB output ceiling.
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
      // they cannot treeKill the now-adopted child. The adopted job runs
      // unlimited; refreshShellJob only enforces the output cap.
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
      try {
        job = adoptForegroundShellJob({
          command,
          cwd,
          pid: child.pid,
          // Unlimited: the promoted job is no longer bounded by the foreground
          // timeout (matches the async omitted-default behavior).
          timeoutMs: 0,
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
        if (reason === 'timeout') timedOut = true; else killed = true;
        _treeKillForceSettle();
        return;
      }
      // Wire the lifecycle: on close, write the exit-code file FIRST then
      // touch donePath STRICTLY AFTER — the exact ordering refreshShellJob()
      // gates completion on (donePath visible ⇒ exit file fully flushed).
      if (job && job.exitPath && job.donePath) {
        child.once('close', (code, signal) => {
          const rc = code == null ? (signal ? 1 : 0) : code;
          try { writeFileSync(job.exitPath, String(rc)); } catch {}
          try { writeFileSync(job.donePath, ''); } catch {}
        });
      }
      // Adoption committed. If a cancel already fired (before or during the
      // adoption window), bring the now-adopted child down via its jobId so the
      // promotion can't outlive a user abort. Idempotent with the still-attached
      // abort handler's treeKill.
      if (abortSignal && abortSignal.aborted) {
        try { killShellJob(job.jobId); } catch {}
        try { treeKill(child); } catch {}
      }
      // Snapshot the partial output captured so far for the immediate result.
      let stdout = '';
      let stderr = '';
      try { stdout = await taskOutput.getStdout(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      try { stderr = await taskOutput.getStderr(); }
      catch (err) { taskOutput.writeError = taskOutput.writeError || err; }
      const jobId = job ? job.jobId : null;
      const secs = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
      const _verb = reason === 'timeout'
        ? `moved to background at timeout after ${secs}s`
        : `auto-backgrounded after ${secs}s`;
      resolve(
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
          backgroundMessage: jobId
            ? `${_verb}; still running — completion will be delivered as a background task notification. Use task with task_id:${jobId} only for manual wait/status/read/cancel.`
            : `${_verb}; still running`,
        }),
      );
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
          _autoBackground({ reason: 'timeout' });
          return;
        }
        timedOut = true;
        _treeKillForceSettle();
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

    // Arm the auto-background timer only for the genuine foreground one-shot
    // path: a positive threshold strictly below the hard timeout, and not a
    // trailing-`&` background command (those already detach + settle on exit).
    if (
      typeof autoBackgroundMs === 'number' &&
      autoBackgroundMs > 0 &&
      !_isBackground &&
      (timeoutMs <= 0 || autoBackgroundMs < timeoutMs)
    ) {
      autoBgTimer = setTimeout(() => { _autoBackground(); }, autoBackgroundMs);
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
        killed = true;
        _treeKillForceSettle();
      }
    }, SIZE_WATCHDOG_INTERVAL_MS);
    if (sizeWatchdog.unref) sizeWatchdog.unref();

    if (abortSignal) {
      abortHandler = () => {
        killed = true;
        _treeKillForceSettle();
      };
      try {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      } catch {}
    }
  });
}
