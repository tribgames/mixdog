// Shell exec output plumbing: inline/disk caps, ANSI strip, tree-kill, bounded capture, results.

// Output capture for the native shell process manager.
import {
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as nodeUtil from 'node:util';
import { getPluginData } from '../config.mjs';
import { TOOL_OUTPUT_MAX_BYTES } from './builtin/tool-output-limit.mjs';
import { envPositiveInt as positiveIntEnv } from '../../../shared/env.mjs';
import {
  FileEncodingSniffer,
  ShellStreamDecoder,
  alignedOffset,
  charBoundaryBefore,
  completeLength,
  decodeShellBytes,
  oemTextEncoding,
} from './shell-codepage.mjs';

// Inline cap, in BYTES. Output at or below this size is pasted whole; above
// it the rendered body becomes head+tail carrying a "full output at <path>"
// marker. Bound to the shared model-facing tool-output budget
// (TOOL_OUTPUT_MAX_BYTES, env MIXDOG_TOOL_OUTPUT_MAX_BYTES) so one shell call
// costs no more context than one read/list call, and so the spill-file
// retention rule in shell-command.mjs keys off this exact boundary.

export const SHELL_OUTPUT_INLINE_CAP = TOOL_OUTPUT_MAX_BYTES;

// Hard ceiling on disk-backed output. Past this the SIZE_WATCHDOG (G2)
// SIGKILLs the child to avoid filling the filesystem. 100 MB is generous
// for any legitimate command output and tight enough to catch a runaway
// loop within ~seconds on a typical SSD.
export const SHELL_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

// fsync throttle for spilled output reads. getStdout/getStderr call
// fsyncSync before reading to ensure the caller sees the latest bytes.
// On Windows every fsyncSync is a noticeable I/O syscall, so throttle
// consecutive calls to at most one per this interval. Tune via env
// MIXDOG_SHELL_FSYNC_THROTTLE_MS (default 1000 ms, positive integer).
const MIXDOG_SHELL_FSYNC_THROTTLE_MS = positiveIntEnv('MIXDOG_SHELL_FSYNC_THROTTLE_MS', 1000);

// ANSI / VT control sequence stripper. Falls back to a regex sweep when
// node:util's stripVTControlCharacters isn't available (older Node).
const _ANSI_REGEX = /(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:|\\|))/g;
const _stripAnsiImpl =
  typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => String(s).replace(_ANSI_REGEX, () => '');

export function stripAnsi(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  // Some Node versions only recognize selected OSC commands. Remove complete
  // CSI/OSC sequences first so window titles and links cannot leak as text.
  return _stripAnsiImpl(s.replace(_ANSI_REGEX, ''));
}

const UNSAFE_TEXT_CONTROL_RE = /[\u0001-\u0006\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

function inspectShellTextChunk(value) {
  const text = String(value ?? '');
  if (!text) return { text: '', binary: false, bytes: 0 };
  const bytes = Buffer.byteLength(text, 'utf8');
  const nulCount = (text.match(/\u0000/g) || []).length;
  const unsafeCount = (text.match(UNSAFE_TEXT_CONTROL_RE) || []).length;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const binary =
    nulCount > 0 ||
    unsafeCount > Math.max(8, Math.floor(text.length * 0.1)) ||
    replacementCount > Math.max(4, Math.floor(text.length * 0.02));
  if (binary) {
    // Sanitize, never stop: the printable remainder is often the answer the
    // caller needs (a git protocol banner, a VM boot log, a PDF text run).
    return {
      text: text.replace(/\u0000/g, '').replace(UNSAFE_TEXT_CONTROL_RE, ''),
      binary: true,
      bytes,
    };
  }
  return {
    text: text.replace(UNSAFE_TEXT_CONTROL_RE, ''),
    binary: false,
    bytes,
  };
}

function detectShellTextEncoding(buffer, final = false) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf16le', bom: 2 };
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf16be', bom: 2 };
  }
  const pairs = Math.min(Math.floor(buffer.length / 2), 128);
  if (pairs >= 4) {
    let evenNuls = 0;
    let oddNuls = 0;
    let printablePartners = 0;
    for (let i = 0; i < pairs * 2; i += 2) {
      if (buffer[i] === 0) evenNuls++;
      if (buffer[i + 1] === 0) oddNuls++;
      const partner = buffer[i] === 0 ? buffer[i + 1] : buffer[i];
      if (partner === 9 || partner === 10 || partner === 13 || (partner >= 0x20 && partner <= 0x7e)) {
        printablePartners++;
      }
    }
    const dominantNuls = Math.max(evenNuls, oddNuls);
    const minorityNuls = Math.min(evenNuls, oddNuls);
    if (dominantNuls / pairs >= 0.6 && minorityNuls / pairs <= 0.1 && printablePartners / pairs >= 0.75) {
      return { encoding: oddNuls > evenNuls ? 'utf16le' : 'utf16be', bom: 0 };
    }
  }
  if (!final && buffer.length < 4) return null;
  return { encoding: 'utf8', bom: 0 };
}

export class ShellTextDecoder {
  constructor(oem = oemTextEncoding()) {
    this.oem = oem;
    this.encoding = null;
    this.decoder = null;
    this.pending = Buffer.alloc(0);
    this.byteRemainder = Buffer.alloc(0);
  }

  _decode(buffer) {
    if (this.encoding !== 'utf16be') return this.decoder.write(buffer);
    const joined = this.byteRemainder.length > 0 ? Buffer.concat([this.byteRemainder, buffer]) : buffer;
    const evenLength = joined.length - (joined.length % 2);
    this.byteRemainder = evenLength < joined.length ? joined.subarray(evenLength) : Buffer.alloc(0);
    if (evenLength === 0) return '';
    return this.decoder.write(Buffer.from(joined.subarray(0, evenLength)).swap16());
  }

  _start(final = false) {
    const detected = detectShellTextEncoding(this.pending, final);
    if (!detected) return '';
    this.encoding = detected.encoding;
    this.decoder =
      this.encoding === 'utf8'
        ? new ShellStreamDecoder(this.oem)
        : new StringDecoder(this.encoding === 'utf16be' ? 'utf16le' : this.encoding);
    const buffered = this.pending.subarray(detected.bom);
    this.pending = Buffer.alloc(0);
    return this._decode(buffered);
  }

  write(value) {
    if (value == null || value.length === 0) return '';
    if (typeof value === 'string') {
      const prefix = this.encoding ? '' : this._start(true);
      return prefix + value;
    }
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!this.encoding) {
      this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, buffer]) : buffer;
      return this._start(false);
    }
    return this._decode(buffer);
  }

  end() {
    let text = this.encoding ? '' : this._start(true);
    if (this.encoding === 'utf16be' && this.byteRemainder.length > 0) {
      text += '\uFFFD';
      this.byteRemainder = Buffer.alloc(0);
    }
    if (this.decoder) text += this.decoder.end();
    return text;
  }
}

// Delegate process-tree termination to the native manager.
export function treeKill(child) {
  if (!child?.__nativeSpawn || typeof child.kill !== 'function') return false;
  try {
    return child.kill() !== false;
  } catch {
    return false;
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
// `label` null = encoding undecided (live): decode as UTF-8. Unless `final`
// (the producer finished), an incomplete trailing character is held back.
function _readHeadTail(filePath, fileSize, label = 'utf-8', final = false) {
  const oem = oemTextEncoding();
  const eff = label || 'utf-8';
  if (fileSize <= SHELL_OUTPUT_INLINE_CAP) {
    const all = readFileSync(filePath);
    return decodeShellBytes(final ? all : all.subarray(0, completeLength(all, eff)), oem, eff);
  }
  const padding = 4;
  const headBudget = Math.floor(SHELL_OUTPUT_INLINE_CAP / 2);
  const tailBudget = SHELL_OUTPUT_INLINE_CAP - headBudget;
  const fd = openSync(filePath, 'r');
  try {
    // Head: first headBudget bytes, dropping a split trailing codepoint.
    const headBuf = Buffer.allocUnsafe(headBudget + padding);
    const hn = readSync(fd, headBuf, 0, headBudget + padding, 0);
    const hEnd = charBoundaryBefore(headBuf.subarray(0, hn), headBudget, eff);
    const head = decodeShellBytes(headBuf.subarray(0, hEnd), oem, eff);
    // Tail: last tailBudget bytes, advancing past a leading split codepoint.
    const tailReadSize = tailBudget + padding;
    let tailStart = Math.max(hEnd, fileSize - tailReadSize);
    if (tailStart > hEnd) tailStart = alignedOffset(fd, tailStart, eff);
    const tailBuf = Buffer.allocUnsafe(tailReadSize);
    const tn = readSync(fd, tailBuf, 0, tailReadSize, tailStart);
    const tailBytes = tailBuf.subarray(0, tn);
    const tail = decodeShellBytes(final ? tailBytes : tailBytes.subarray(0, completeLength(tailBytes, eff)), oem, eff);
    const elided = Math.max(0, tailStart - hEnd);
    return `${head}\n... [${elided} bytes elided of ${fileSize} total — head+tail shown; full output at ${filePath}] ...\n${tail}`;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

// Spill files outlive their task record (30 min), and transcripts keep naming
// them ("full output at <path>"), so a session resumed days later may still
// read them. Keep a week, then drop them: swept once per process, in the
// background, when the first command spills.
export const SHELL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let shellOutputSweepStarted = false;

export async function sweepExpiredShellOutput(dir, now = Date.now()) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = now - SHELL_OUTPUT_RETENTION_MS;
  for (const name of names) {
    const file = join(dir, name);
    try {
      if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
    } catch {}
  }
}

// Owns the captured stdout/stderr buffers for a single command run. Starts
// fully in memory; once the combined byte total exceeds the spill threshold
// (SHELL_OUTPUT_INLINE_CAP), opens append-only files in
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
    this.binaryOutput = null;
    // Direct-capture mode hands the spill files to the child as
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
    if (!shellOutputSweepStarted) {
      shellOutputSweepStarted = true;
      void sweepExpiredShellOutput(dir);
    }
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
        try {
          closeSync(this.stdoutFd);
        } catch {}
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
    if (this._inlineBytes > SHELL_OUTPUT_INLINE_CAP) {
      this._ensureFileBacking();
    }
  }

  // Force the in-memory buffers onto disk-backed files regardless of the
  // SHELL_OUTPUT_INLINE_CAP threshold. Used by the auto-background
  // transition: once a foreground command is promoted into a tracked job,
  // every subsequent stdout/stderr chunk must land in the spill files so
  // task wait/read can read it (the caller has already settled and will no
  // longer drain the in-memory buffers). No-op once already spilled.
  forceSpill() {
    if (this.spilled) return;
    this._ensureFileBacking();
  }

  // File mode: open the spill files BEFORE spawn and
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
  // filesystem (a "poll the file tail" approach).
  _refreshDirectSizes() {
    if (!this.direct) return;
    try {
      this.stdoutFileSize = statSync(this.stdoutPath).size;
    } catch {}
    try {
      this.stderrFileSize = statSync(this.stderrPath).size;
    } catch {}
  }

  _recordWriteError(stage, err) {
    if (this.writeError) return;
    const msg = err?.message ? err.message : String(err);
    this.writeError = `[output-capture-error: ${stage}] ${msg}`;
  }

  writeStdout(s) {
    if (!s) return;
    s = this._sanitizeChunk(s, 'stdout');
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
    s = this._sanitizeChunk(s, 'stderr');
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
        const separator = out && err ? '\n' : '';
        const merged = err ? `${out}${separator}${err}` : out;
        return merged.length > maxChars ? merged.slice(-maxChars) : merged;
      };
      if (!this.spilled) return merge(this.stdoutBuf, this.stderrBuf);
      this._refreshDirectSizes();
      const readTail = (path, size, channel) => {
        if (!path || !(size > 0)) return '';
        const bytes = Math.min(size, maxChars * 3);
        const fd = openSync(path, 'r');
        try {
          const label = this._fileLabel(channel, fd, false);
          const eff = label || 'utf-8';
          const from = size > bytes ? alignedOffset(fd, size - bytes, eff) : 0;
          const buffer = Buffer.alloc(size - from);
          const read = readSync(fd, buffer, 0, buffer.length, from);
          // Live view: an incomplete trailing character is held back.
          const live = buffer.subarray(0, completeLength(buffer.subarray(0, read), eff));
          return decodeShellBytes(live, oemTextEncoding(), eff);
        } finally {
          try {
            closeSync(fd);
          } catch {}
        }
      };
      const merged = merge(
        readTail(this.stdoutPath, this.stdoutFileSize, 'stdout'),
        readTail(this.stderrPath, this.stderrFileSize, 'stderr')
      );
      // Display-only path: scrub escape codes in direct mode, but never record
      // a binary verdict from an arbitrary tail slice.
      return this.direct ? inspectShellTextChunk(merged).text : merged;
    } catch {
      return '';
    }
  }

  // The per-chunk binary/control-character scrub. writeStdout/writeStderr
  // apply it as chunks arrive; direct capture has NO JS write path, so the
  // getters apply it at read time, keeping what the caller sees identical
  // across both capture modes.
  _sanitizeChunk(text, channel) {
    if (!text) return text;
    const inspected = inspectShellTextChunk(text);
    if (inspected.binary && !this.binaryOutput) {
      this.binaryOutput = { channel, bytes: inspected.bytes };
      return `[binary output on ${channel} sanitized; non-printable bytes removed]\n${inspected.text}`;
    }
    return inspected.text;
  }

  // Encoding of a spilled capture file. JS-written captures are UTF-8 text;
  // direct captures hold the child's raw bytes and are sniffed per stream (the
  // first non-ASCII byte may be anywhere). `final` only when the producer has
  // finished; a live read may get null (undecided).
  _fileLabel(channel, fd = null, final = true) {
    const oem = oemTextEncoding();
    if (!oem || !this.direct) return 'utf-8';
    this._sniffers ??= {};
    this._sniffers[channel] ??= new FileEncodingSniffer(oem);
    const sniffer = this._sniffers[channel];
    const path = channel === 'stdout' ? this.stdoutPath : this.stderrPath;
    let own = null;
    try {
      if (fd == null) own = openSync(path, 'r');
      const use = fd ?? own;
      return sniffer.probe(use, fstatSync(use).size, final) || (final ? 'utf-8' : null);
    } catch {
      return 'utf-8';
    } finally {
      if (own != null) {
        try {
          closeSync(own);
        } catch {}
      }
    }
  }

  // `final`: the producer has finished (settle after exit). Mid-run readers
  // (promotion snapshot) leave it false: incomplete tails are held back and no
  // encoding is committed early.
  async getStdout(final = false) {
    if (this.spilled) {
      this._refreshDirectSizes();
      const now = Date.now();
      if (!this.direct && now - this._lastStdoutFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
        try {
          fsyncSync(this.stdoutFd);
        } catch {}
        this._lastStdoutFsyncMs = now;
      }
      try {
        const text = _readHeadTail(this.stdoutPath, this.stdoutFileSize, this._fileLabel('stdout', null, final), final);
        return this.direct ? this._sanitizeChunk(text, 'stdout') : text;
      } catch (err) {
        throw new Error(`[shell-command] spilled stdout read failed (${this.stdoutPath}): ${err.message}`);
      }
    }
    return this.stdoutBuf;
  }

  async getStderr(final = false) {
    if (this.spilled) {
      this._refreshDirectSizes();
      const now = Date.now();
      if (!this.direct && now - this._lastStderrFsyncMs >= MIXDOG_SHELL_FSYNC_THROTTLE_MS) {
        try {
          fsyncSync(this.stderrFd);
        } catch {}
        this._lastStderrFsyncMs = now;
      }
      try {
        const text = _readHeadTail(this.stderrPath, this.stderrFileSize, this._fileLabel('stderr', null, final), final);
        return this.direct ? this._sanitizeChunk(text, 'stderr') : text;
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
    // Auto-background transition. When a
    // foreground command outlives autoBackgroundMs the call settles with
    // backgrounded:true + the jobId for manual task control. The
    // child stays owned by the CLI process; stdout/stderr keep flowing to
    // the spill files now owned by the shell-jobs registry.
    this.backgrounded = opts.backgrounded === true;
    this.jobId = opts.jobId || null;
    // A command queued behind a saturated shell lane is no shell job; this
    // promise settles when the queued run finishes. A foreground result
    // reported while its tree may still run (a kill, unverified descendants)
    // carries the promise that settles once that tree is gone.
    this.settled = opts.settled || null;
    this.backgroundMessage = opts.backgroundMessage || null;
    // Survivors observed AFTER the shell process exited (process group on
    // POSIX, process tree + held stdio on win32). Non-null means the command
    // finished but left live descendants, which the caller turns into a
    // tracked, cancellable task. See tools/lib/shell-descendants.mjs.
    this.descendants = opts.descendants || null;
  }
}
