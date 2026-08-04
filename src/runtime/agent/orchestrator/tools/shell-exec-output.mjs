// Shell exec output plumbing: inline/disk caps, ANSI strip, tree-kill, bounded capture, results.
// Extracted from shell-command.mjs.
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

export {
  _maybeEncodePowerShellCommand,
  extractPowerShellCommandInner,
} from './shell-powershell.mjs';

// Inline cap. Output above this size is spilled to disk and the caller
// renders a path marker instead of pasting the tail. Matches the
// SHELL_OUTPUT_MAX_CHARS used by the smart-truncate renderer in
// builtin.mjs so spilled output and inline output share the same boundary.

export const SHELL_OUTPUT_INLINE_CAP = 30_000;

// Hard ceiling on disk-backed output. Past this the SIZE_WATCHDOG (G2)
// SIGKILLs the child to avoid filling the filesystem. 100 MB is generous
// for any legitimate command output and tight enough to catch a runaway
// loop within ~seconds on a typical SSD.
export const SHELL_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

// Background-task disk watchdog cadence. The size guard polls the spilled
// stdout/stderr files every interval and SIGKILLs the child once the
// combined size exceeds SHELL_OUTPUT_DISK_CAP — short enough that a runaway loop is caught within a
// few seconds, long enough that the stat overhead is negligible.
export const SIZE_WATCHDOG_INTERVAL_MS = 1_000;

// fsync throttle for spilled output reads. getStdout/getStderr call
// fsyncSync before reading to ensure the caller sees the latest bytes.
// On Windows every fsyncSync is a noticeable I/O syscall, so throttle
// consecutive calls to at most one per this interval. Tune via env
// MIXDOG_SHELL_FSYNC_THROTTLE_MS (default 1000 ms, positive integer).
export function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
const MIXDOG_SHELL_FSYNC_THROTTLE_MS = positiveIntEnv('MIXDOG_SHELL_FSYNC_THROTTLE_MS', 1000);

// ANSI / VT control sequence stripper. Falls back to a regex sweep when
// node:util's stripVTControlCharacters isn't available (older Node).
export const _ANSI_REGEX =
  /(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:|\\|))/g;
export const _stripAnsiImpl =
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
export function treeKill(child) {
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
export class TaskOutput {
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
    // CC parity: direct-capture mode hands the spill files to the child as
    // stdio fds (no JS pipes). Sizes are then tracked via stat, not writes.
    this.direct = false;
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

  // CC parity (ShellCommand file mode): open the spill files BEFORE spawn and
  // hand their fds to the child as stdio[1]/stdio[2]. The child (and any
  // grandchildren) write straight to disk with no parent-side pipes, so a
  // surviving grandchild can never wedge the caller by holding a pipe handle.
  // Returns null when file backing could not be opened — caller falls back to
  // pipe capture.
  openDirectCapture() {
    this._ensureFileBacking();
    if (!this.spilled || this.stdoutFd == null || this.stderrFd == null) return null;
    this.direct = true;
    return { stdoutFd: this.stdoutFd, stderrFd: this.stderrFd };
  }

  // Direct mode has no JS write path, so byte counters must come from the
  // filesystem (CC "poll the file tail" analogue).
  _refreshDirectSizes() {
    if (!this.direct) return;
    try { this.stdoutFileSize = statSync(this.stdoutPath).size; } catch {}
    try { this.stderrFileSize = statSync(this.stderrPath).size; } catch {}
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
    this._refreshDirectSizes();
    return this.stdoutFileSize + this.stderrFileSize;
  }

  // Cheap synchronous tail for live-progress consumers (running tool cards).
  // Never fsyncs and never throws: inline mode slices the in-memory buffers;
  // spilled mode reads the file tails directly (kernel write-back is fresh
  // enough for display). Best-effort — any FS error yields ''.
  getLiveTail(maxChars = 4000) {
    try {
      const merge = (out, err) => {
        const merged = err ? `${out}${out && err ? '\n' : ''}${err}` : out;
        return merged.length > maxChars ? merged.slice(-maxChars) : merged;
      };
      if (!this.spilled) return merge(this.stdoutBuf, this.stderrBuf);
      this._refreshDirectSizes();
      const readTail = (path, size) => {
        if (!path || !(size > 0)) return '';
        const bytes = Math.min(size, maxChars * 3);
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.alloc(bytes);
          const read = readSync(fd, buffer, 0, bytes, Math.max(0, size - bytes));
          return buffer.toString('utf-8', 0, read);
        } finally {
          try { closeSync(fd); } catch {}
        }
      };
      return merge(
        readTail(this.stdoutPath, this.stdoutFileSize),
        readTail(this.stderrPath, this.stderrFileSize),
      );
    } catch {
      return '';
    }
  }

  async getStdout() {
    if (this.spilled) {
      this._refreshDirectSizes();
      const now = Date.now();
      if (!this.direct && now - this._lastStdoutFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
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
      this._refreshDirectSizes();
      const now = Date.now();
      if (!this.direct && now - this._lastStderrFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
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
    this.direct = false;
  }
}


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
    // Why mixdog initiated a tree kill. Keep this separate from `signal`,
    // which is the process-reported termination signal (SIGTERM/SIGKILL).
    this.killCause = opts.killCause || null;
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
