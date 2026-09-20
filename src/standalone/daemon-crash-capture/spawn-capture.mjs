// One boot's spawn capture: the launcher hands the child an APPEND FILE
// DESCRIPTOR for fd 2 instead of a pipe, so native fatal output lands in a
// file even when the launcher is long gone; a JSON sidecar records the
// correlated lifecycle (pid, spawn/ready/exit timestamps, exit code/signal)
// as far as the launcher can observe it, and new stderr bytes are mirrored
// into the launcher's log once per lifecycle event.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { daemonCrashCaptureDir } from './paths.mjs';
import { pruneDaemonCrashCaptures } from './retention.mjs';

// Bounded search for an unused boot identity; the raw capture is created
// exclusively, so an existing artifact can never be adopted or overwritten.
const CAPTURE_ID_ATTEMPTS = 8;
// One mirrored drain per lifecycle event; a crashing daemon must never push
// megabytes of native text through the launcher's own log.
const MIRROR_MAX_BYTES = 16 * 1024;
const MESSAGE_MAX_CHARS = 512;
const HEAP_FLAG_RE = /^--max-(?:old-space|semi-space|heap)-size=/;

function stamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function boundedMessage(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= MESSAGE_MAX_CHARS ? text : `${text.slice(0, MESSAGE_MAX_CHARS)}…`;
}

function heapFlags(execArgv) {
  return (Array.isArray(execArgv) ? execArgv : []).map((arg) => String(arg)).filter((arg) => HEAP_FLAG_RE.test(arg));
}

// ---------------------------------------------------------------------------
// Capture state, shared by every step below:
//   record        — the sidecar document (pid, timestamps, exit, stderrBytes…)
//   log, now      — launcher log sink and clock
//   startedAtMs   — spawn time the uptime is measured from
//   stem, capturePath, recordPath — boot identity; null when unavailable
//   writeFd       — the launcher's copy of the fd 2 descriptor until released
//   readOffset    — bytes already mirrored into the launcher log
//   removed       — the capture was dropped as uninteresting
//   pipeDrained   — resolves when a fallback stderr pipe has ended
//   stderrStdio   — what the launcher puts in stdio[2]: the fd or 'pipe'

// EXCLUSIVE create: a colliding identity must never adopt, reuse or overwrite
// somebody else's evidence.
function allocateCaptureFiles(captureDir, { startedAtMs, launcherPid, nonce }) {
  for (let attempt = 1; ; attempt += 1) {
    const stem = `daemon-${stamp(startedAtMs)}-${launcherPid}-${nonce()}`;
    const capturePath = path.join(captureDir, `${stem}.err.log`);
    const recordPath = path.join(captureDir, `${stem}.json`);
    let fd = null;
    try {
      fd = fs.openSync(capturePath, 'ax');
      if (fs.existsSync(recordPath)) {
        // A sidecar without its raw file still owns this identity.
        fs.closeSync(fd);
        fd = null;
        fs.rmSync(capturePath, { force: true });
        throw Object.assign(new Error('capture identity in use'), { code: 'EEXIST' });
      }
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (error?.code === 'EEXIST' && attempt < CAPTURE_ID_ATTEMPTS) continue;
      throw error;
    }
    return { fd, stem, capturePath, recordPath };
  }
}

function openCapture(capture, { captureDir, prune, launcherPid, nonce }) {
  try {
    fs.mkdirSync(captureDir, { recursive: true });
    if (prune) pruneDaemonCrashCaptures({ dir: captureDir });
    const files = allocateCaptureFiles(captureDir, { startedAtMs: capture.startedAtMs, launcherPid, nonce });
    capture.writeFd = files.fd;
    capture.stem = files.stem;
    capture.capturePath = files.capturePath;
    capture.recordPath = files.recordPath;
    capture.record.stderrFile = `${files.stem}.err.log`;
    // Claim ownership before the fork: a concurrent launcher pruning this
    // directory must see a launch in progress, not an orphan raw file.
    persist(capture);
  } catch (error) {
    closeWriteFd(capture);
    capture.capturePath = null;
    capture.recordPath = null;
    capture.record.stderrFile = null;
    capture.log(`daemon crash capture unavailable: ${boundedMessage(error?.message || error)}`);
  }
}

function closeWriteFd(capture) {
  if (capture.writeFd === null) return;
  try {
    fs.closeSync(capture.writeFd);
  } catch {}
  capture.writeFd = null;
}

function persist(capture) {
  if (!capture.recordPath || capture.removed) return;
  try {
    // Atomic: a pruner reading this sidecar concurrently must never see a
    // half-written document and conclude the boot is dead.
    writeJsonAtomicSync(capture.recordPath, capture.record, { mode: 0o600 });
  } catch {
    /* diagnostics are best effort */
  }
}

function captureSize(capture) {
  if (!capture.capturePath) return 0;
  try {
    return fs.statSync(capture.capturePath).size;
  } catch {
    return 0;
  }
}

function removeCapture(capture) {
  capture.removed = true;
  for (const file of [capture.capturePath, capture.recordPath]) {
    if (!file) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function mirrorText(log, text) {
  for (const line of String(text || '').split('\n')) {
    const row = line.trimEnd();
    if (row) log(row);
  }
}

/** Mirror only the bytes not mirrored yet, so one line never reaches the
 *  launcher's log twice across ready/exit/timeout drains. */
function mirror(capture) {
  if (!capture.capturePath || capture.removed) return;
  const size = captureSize(capture);
  if (size <= capture.readOffset) return;
  let skipped = 0;
  if (size - capture.readOffset > MIRROR_MAX_BYTES) {
    skipped = size - capture.readOffset - MIRROR_MAX_BYTES;
    capture.readOffset = size - MIRROR_MAX_BYTES;
  }
  let text = '';
  try {
    const handle = fs.openSync(capture.capturePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(size - capture.readOffset);
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, capture.readOffset);
      capture.readOffset += bytesRead;
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return;
  }
  if (skipped > 0) {
    capture.log(`daemon stderr: skipped ${skipped} earlier byte(s), full text in ${capture.capturePath}`);
  }
  mirrorText(capture.log, text);
}

function noteReady(capture) {
  const { record } = capture;
  if (record.ready) return;
  record.ready = true;
  record.readyAt = new Date(capture.now()).toISOString();
  mirror(capture);
  persist(capture);
}

function noteExit(capture, { code = null, signal = null } = {}) {
  const { record } = capture;
  closeWriteFd(capture);
  if (record.exitedAt) return;
  const at = capture.now();
  record.exitedAt = new Date(at).toISOString();
  record.exitCode = Number.isInteger(code) ? code : null;
  record.exitSignal = signal ? String(signal) : null;
  record.uptimeMs = Math.max(0, at - capture.startedAtMs);
  record.stderrBytes = captureSize(capture);
  mirror(capture);
  // A contender that lost the singleton claim exits 0 with nothing to say:
  // keeping a file per losing spawn would bury the boots that do matter.
  const uninteresting =
    !record.ready && record.exitCode === 0 && record.exitSignal === null && record.stderrBytes === 0 && !record.error;
  if (uninteresting) removeCapture(capture);
  else persist(capture);
  capture.log(
    `daemon exit pid=${record.pid ?? '?'} code=${record.exitCode ?? '-'}` +
      ` signal=${record.exitSignal ?? '-'} ready=${record.ready ? 1 : 0}` +
      ` uptimeMs=${record.uptimeMs} stderrBytes=${record.stderrBytes}` +
      (capture.removed || !capture.capturePath ? '' : ` capture=${capture.capturePath}`)
  );
}

/** Record a spawn failure — the synchronous `fork` throw AND the
 *  asynchronous `'error'` event, which may arrive with no `'exit'` at all.
 *  Idempotent, so a launcher may call it alongside the tracked listener. */
function noteSpawnError(capture, error) {
  const { record } = capture;
  closeWriteFd(capture);
  if (record.error === null) record.error = boundedMessage(error?.message || error);
  if (!record.pid && !record.exitedAt) {
    // No child ever existed: this boot is terminal, so the sidecar must not
    // look like a launch still in progress.
    record.exitedAt = new Date(capture.now()).toISOString();
    record.stderrBytes = captureSize(capture);
    if (record.stderrBytes === 0 && capture.capturePath) {
      // Nothing was ever written to fd 2: keep the record, drop the empty file.
      try {
        fs.rmSync(capture.capturePath, { force: true });
      } catch {}
      record.stderrFile = null;
      capture.capturePath = null;
    }
  }
  // A child that did spawn keeps its lifecycle open: `noteExit` still fills
  // in the code/signal if the runtime reports one.
  persist(capture);
}

// Pipe delivery is independent of the IPC 'ready' message and of the
// child's exit: bytes written before ready can still be in flight after
// it, and a native fd 2 error arrives long after. Drain until the STREAM
// itself ends — cutting at ready or at exit silently drops those lines.
// (The daemon's own redirect moves its JS logging to the file at ready,
// so this cannot duplicate daemon log lines.) The launcher still unrefs
// this stream, so nothing here extends its lifetime.
function drainStderrPipe(capture, stream) {
  const onData = (chunk) => {
    mirrorText(capture.log, String(chunk || ''));
  };
  stream.on('data', onData);
  return new Promise((resolve) => {
    const finish = () => {
      try {
        stream.off('data', onData);
      } catch {}
      resolve();
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

/** Attach to the forked child: record its identity and keep a lifetime
 *  listener that survives the ready handoff, so a later exit is still
 *  correlated to this pid, boot time and ready state. */
function trackChild(capture, child, { detached = false, execArgv = [] } = {}) {
  const { record } = capture;
  record.pid = Number(child?.pid) || null;
  record.detached = Boolean(detached);
  record.heapFlags = heapFlags(execArgv);
  // The child holds its own duplicate; the launcher must not keep the file
  // open for its own lifetime.
  closeWriteFd(capture);
  persist(capture);
  if (capture.capturePath) capture.log(`daemon crash capture pid=${record.pid ?? '?'} file=${capture.capturePath}`);
  if (capture.stderrStdio === 'pipe' && child?.stderr) {
    capture.pipeDrained = drainStderrPipe(capture, child.stderr);
  }
  // `once` never refs the event loop by itself, so this adds no parent-side
  // lifetime dependency for the detached daemon.
  child?.once?.('exit', (code, signal) => noteExit(capture, { code, signal }));
  // An asynchronous spawn failure (bad exec path, EACCES) emits 'error' and
  // need not emit 'exit' at all — without this the sidecar would keep
  // claiming a launch in progress forever.
  child?.once?.('error', (error) => noteSpawnError(capture, error));
}

/**
 * Open one boot's capture before forking the daemon.
 *
 * `stderrStdio` is the value the launcher must put in `stdio[2]`: a file
 * descriptor when the capture opened, otherwise `'pipe'` so boot diagnostics
 * still reach the launcher's log. The launcher keeps owning its own spawn
 * promise; this handle only records and mirrors.
 */
export function beginDaemonSpawnCapture({
  launcher = 'daemon',
  log = () => {},
  dataDir = null,
  env = process.env,
  dir = null,
  launcherPid = process.pid,
  now = Date.now,
  prune = true,
  nonce = () => randomBytes(2).toString('hex'),
} = {}) {
  const captureDir = dir || daemonCrashCaptureDir({ dataDir, env });
  const startedAtMs = now();
  const capture = {
    record: {
      kind: 'mixdog-daemon-crash-capture',
      launcher: String(launcher),
      launcherPid: Number(launcherPid) || 0,
      pid: null,
      detached: null,
      heapFlags: [],
      stderrFile: null,
      spawnedAt: new Date(startedAtMs).toISOString(),
      readyAt: null,
      exitedAt: null,
      ready: false,
      exitCode: null,
      exitSignal: null,
      uptimeMs: null,
      stderrBytes: 0,
      error: null,
    },
    log,
    now,
    startedAtMs,
    stem: null,
    capturePath: null,
    recordPath: null,
    writeFd: null,
    readOffset: 0,
    removed: false,
    pipeDrained: null,
    stderrStdio: 'pipe',
  };
  openCapture(capture, { captureDir, prune, launcherPid, nonce });
  // Captured BEFORE the parent closes its copy: the child keeps its own
  // duplicate of this descriptor for its whole life.
  capture.stderrStdio = capture.writeFd === null ? 'pipe' : capture.writeFd;

  return {
    stderrStdio: capture.stderrStdio,
    get stem() {
      return capture.stem;
    },
    get capturePath() {
      return capture.capturePath;
    },
    get recordPath() {
      return capture.recordPath;
    },
    track: (child, options) => trackChild(capture, child, options),
    noteReady: () => noteReady(capture),
    noteExit: (outcome) => noteExit(capture, outcome),
    noteSpawnError: (error) => noteSpawnError(capture, error),
    mirror: () => mirror(capture),
    /** Resolves when a fallback stderr pipe has ended; immediate when fd 2 is
     *  captured to a file. Lets a caller observe the last mirrored line. */
    whenDrained: () => capture.pipeDrained || Promise.resolve(),
    /** Drop the launcher's own copy of the capture descriptor without
     *  recording anything — the child, if any, keeps its duplicate. */
    release: () => closeWriteFd(capture),
    snapshot: () => ({ ...capture.record }),
  };
}
