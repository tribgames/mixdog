// Crash and lifecycle capture for the machine-global daemon's launchers.
//
// A V8 fatal error — the heap-limit OOM abort above all — is printed by the
// runtime itself straight to FILE DESCRIPTOR 2, below every JS hook: the
// daemon's own stream/console redirect (daemon-log.mjs) never sees it, and the
// launcher's stderr PIPE stops being drained the moment the launcher detaches
// or exits. That is how a detached daemon can disappear with no fatal text and
// no exit record anywhere on disk.
//
// So the launcher hands the child an APPEND FILE DESCRIPTOR for fd 2 instead of
// a pipe. The kernel keeps that descriptor open for the daemon's whole life,
// independent of the parent, so native fatal output lands in a file even when
// the launcher is long gone. A JSON sidecar records the correlated lifecycle
// (pid, spawn/ready/exit timestamps, exit code/signal) as far as the launcher
// can observe it. The record carries no environment, argument or credential
// material — only the heap flags that explain an OOM.
//
// Retention, stated exactly:
//   * COMPLETED boots (the launcher saw the exit, or neither the daemon nor its
//     launcher is alive any more) share a budget of CRASH_CAPTURE_KEEP_BOOTS
//     boots and CRASH_CAPTURE_KEEP_BYTES bytes. An oversized completed capture
//     is TRIMMED to its last CRASH_CAPTURE_TAIL_BYTES — the fatal report is the
//     tail — and keeps its sidecar; the newest completed boot is never deleted,
//     because that is the crash somebody is about to investigate.
//   * ACTIVE boots (a live daemon, or a launch still in progress) and UNKNOWN
//     boots (identity missing or damaged, so nobody can prove the writer is
//     gone) are never read-modified, never trimmed and never unlinked. Their
//     bytes sit OUTSIDE the completed-boot budget: at any moment the directory
//     holds the completed budget PLUS the active and unknown captures, and an
//     active capture's size is bounded only by what the daemon writes to fd 2
//     until it exits. Retention never guesses from age: losing a live daemon's
//     fatal evidence is worse than keeping an orphan file.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPidAlive } from '../runtime/shared/pid-liveness.mjs';
import { writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';

const CAPTURE_DIR_NAME = 'daemon-crash';
// Prune only files this module creates: `daemon-<yyyymmdd>-<hhmmss>-<pid>-<rand>`.
const CAPTURE_STEM_RE = /^daemon-\d{8}-\d{6}-\d+-[0-9a-f]{4}$/;
const CAPTURE_SUFFIXES = ['.err.log', '.json'];
// Debris from this module's own atomic sidecar writes (writeFileAtomicSync
// names its temp `.<basename>.<hex>.tmp`), never anyone else's file.
const CAPTURE_TEMP_RE = /^\.daemon-\d{8}-\d{6}-(\d+)-[0-9a-f]{4}\.json\.[0-9a-f]+\.tmp$/;
export const CRASH_CAPTURE_KEEP_BOOTS = 8;
export const CRASH_CAPTURE_KEEP_BYTES = 2 * 1024 * 1024;
export const CRASH_CAPTURE_TAIL_BYTES = 256 * 1024;
// Bounded search for an unused boot identity; the raw capture is created
// exclusively, so an existing artifact can never be adopted or overwritten.
const CAPTURE_ID_ATTEMPTS = 8;
// One mirrored drain per lifecycle event; a crashing daemon must never push
// megabytes of native text through the launcher's own log.
const MIRROR_MAX_BYTES = 16 * 1024;
const MESSAGE_MAX_CHARS = 512;
const HEAP_FLAG_RE = /^--max-(?:old-space|semi-space|heap)-size=/;

export function daemonDataDir(env = process.env) {
  return env.MIXDOG_DATA_DIR
    ? path.resolve(env.MIXDOG_DATA_DIR)
    : path.join(env.MIXDOG_HOME || path.join(os.homedir(), '.mixdog'), 'data');
}

export function daemonCrashCaptureDir({ dataDir = null, env = process.env } = {}) {
  const base = dataDir ? path.resolve(dataDir) : daemonDataDir(env);
  return path.join(base, CAPTURE_DIR_NAME);
}

function captureStem(name) {
  for (const suffix of CAPTURE_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const stem = name.slice(0, -suffix.length);
    if (CAPTURE_STEM_RE.test(stem)) return stem;
  }
  return null;
}

function stamp(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function boundedMessage(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= MESSAGE_MAX_CHARS ? text : `${text.slice(0, MESSAGE_MAX_CHARS)}…`;
}

function heapFlags(execArgv) {
  return (Array.isArray(execArgv) ? execArgv : [])
    .map((arg) => String(arg))
    .filter((arg) => HEAP_FLAG_RE.test(arg));
}

/**
 * Ownership state of one boot's capture: `completed`, `active` or `unknown`.
 *
 * Only a PROVEN dead owner makes a boot prunable — an exit the launcher
 * recorded, or a child pid that is recorded and no longer alive. Anything the
 * metadata cannot prove (no sidecar yet, a damaged sidecar, a launcher that
 * died before publishing its child pid) is `unknown` and stays on disk: age is
 * not evidence, and an hours-old capture may still belong to a running daemon
 * whose metadata was damaged.
 */
export function daemonCaptureBootState(boot, { pidAlive = isPidAlive } = {}) {
  let record = null;
  if (boot.recordPath) {
    try { record = JSON.parse(fs.readFileSync(boot.recordPath, 'utf8')); } catch { record = null; }
  }
  if (!record || typeof record !== 'object') return 'unknown';
  if (record.exitedAt) return 'completed';
  if (pidAlive(record.pid)) return 'active';
  if (record.pid === null || record.pid === undefined) {
    // Launch in progress: fd 2 is open and no child pid has been published.
    // A dead launcher here proves nothing about a child it may have forked.
    return pidAlive(record.launcherPid) ? 'active' : 'unknown';
  }
  // A recorded child pid that is gone: that daemon is provably over, even when
  // the launcher died before it could write the exit record.
  return 'completed';
}

/** Keep the tail of an oversized COMPLETED capture instead of deleting the
 *  whole file: a V8 fatal report is the last thing written. */
function trimCaptureTail(rawPath, maxBytes) {
  try {
    const size = fs.statSync(rawPath).size;
    if (size <= maxBytes) return size;
    const handle = fs.openSync(rawPath, 'r');
    let tail = Buffer.allocUnsafe(maxBytes);
    try {
      const bytesRead = fs.readSync(handle, tail, 0, maxBytes, size - maxBytes);
      tail = tail.subarray(0, bytesRead);
    } finally {
      fs.closeSync(handle);
    }
    const header = Buffer.from(`[capture trimmed: dropped ${size - tail.length} earlier byte(s)]\n`);
    fs.writeFileSync(rawPath, Buffer.concat([header, tail]));
    return header.length + tail.length;
  } catch {
    return -1;
  }
}

function collectBoots(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const boots = new Map();
  const temps = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const temp = CAPTURE_TEMP_RE.exec(entry.name);
    if (temp) {
      // Our own atomic-write temp. Its writer is the launcher pid encoded in
      // the target stem — the only thing that can prove it is debris.
      temps.push({ path: path.join(dir, entry.name), writerPid: Number(temp[1]) || 0 });
      continue;
    }
    const stem = captureStem(entry.name);
    if (!stem) continue;
    const full = path.join(dir, entry.name);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch { continue; }
    const boot = boots.get(stem) || {
      stem, files: [], bytes: 0, mtimeMs: 0, recordPath: null, rawPath: null, rawBytes: 0,
    };
    boot.files.push(full);
    boot.bytes += size;
    boot.mtimeMs = Math.max(boot.mtimeMs, mtimeMs);
    if (entry.name.endsWith('.json')) boot.recordPath = full;
    else { boot.rawPath = full; boot.rawBytes = size; }
    boots.set(stem, boot);
  }
  return {
    ordered: [...boots.values()].sort((a, b) => (
      b.mtimeMs - a.mtimeMs || (a.stem < b.stem ? 1 : -1)
    )),
    temps,
  };
}

/** Bound retained COMPLETED captures across daemon restarts. Active captures
 *  are left exactly as they are, the newest completed crash is never deleted,
 *  and nothing outside this module's own naming is ever touched. */
export function pruneDaemonCrashCaptures({
  dir = daemonCrashCaptureDir(),
  keepBoots = CRASH_CAPTURE_KEEP_BOOTS,
  keepBytes = CRASH_CAPTURE_KEEP_BYTES,
  tailBytes = CRASH_CAPTURE_TAIL_BYTES,
  pidAlive = isPidAlive,
} = {}) {
  const maxBoots = Math.max(1, Number(keepBoots) || CRASH_CAPTURE_KEEP_BOOTS);
  const maxBytes = Math.max(64 * 1024, Number(keepBytes) || CRASH_CAPTURE_KEEP_BYTES);
  const maxTail = Math.max(4 * 1024, Number(tailBytes) || CRASH_CAPTURE_TAIL_BYTES);
  const collected = collectBoots(dir);
  if (!collected) {
    return { removed: 0, trimmed: 0, keptBoots: 0, keptBytes: 0, activeBoots: 0, unknownBoots: 0 };
  }
  const { ordered, temps } = collected;
  for (const temp of temps) {
    // Only a dead writer proves a temp is debris. A live (or unidentifiable)
    // writer keeps it: an unfinished atomic write is not garbage by age.
    if (!temp.writerPid || pidAlive(temp.writerPid)) continue;
    try { fs.rmSync(temp.path, { force: true }); } catch {}
  }
  let removed = 0;
  let trimmed = 0;
  let keptBoots = 0;
  let keptBytes = 0;
  let activeBoots = 0;
  let unknownBoots = 0;
  let newestCompletedSeen = false;
  for (const boot of ordered) {
    const state = daemonCaptureBootState(boot, { pidAlive });
    if (state !== 'completed') {
      // Active and unknown boots are untouchable and sit outside the budget.
      if (state === 'active') activeBoots += 1;
      else unknownBoots += 1;
      continue;
    }
    const newestCompleted = !newestCompletedSeen;
    newestCompletedSeen = true;
    let bytes = boot.bytes;
    if (boot.rawPath && boot.rawBytes > maxTail) {
      const size = trimCaptureTail(boot.rawPath, maxTail);
      if (size >= 0) {
        bytes = bytes - boot.rawBytes + size;
        trimmed += 1;
      }
    }
    // The newest completed boot survives even when it alone spends the whole
    // byte budget: its trimmed tail and sidecar ARE the crash evidence.
    if (newestCompleted || (keptBoots < maxBoots && keptBytes + bytes <= maxBytes)) {
      keptBoots += 1;
      keptBytes += bytes;
      continue;
    }
    for (const file of boot.files) {
      try {
        fs.rmSync(file, { force: true });
        removed += 1;
      } catch { /* a locked capture simply stays */ }
    }
  }
  return { removed, trimmed, keptBoots, keptBytes, activeBoots, unknownBoots };
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
  let stem = null;
  const record = {
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
  };

  let capturePath = null;
  let recordPath = null;
  let writeFd = null;
  let readOffset = 0;
  let removed = false;
  let pipeDrained = null;

  try {
    fs.mkdirSync(captureDir, { recursive: true });
    if (prune) pruneDaemonCrashCaptures({ dir: captureDir });
    for (let attempt = 1; ; attempt += 1) {
      const candidate = `daemon-${stamp(startedAtMs)}-${launcherPid}-${nonce()}`;
      const candidatePath = path.join(captureDir, `${candidate}.err.log`);
      const candidateRecord = path.join(captureDir, `${candidate}.json`);
      let fd = null;
      try {
        // EXCLUSIVE create: a colliding identity must never adopt, reuse or
        // overwrite somebody else's evidence.
        fd = fs.openSync(candidatePath, 'ax');
        if (fs.existsSync(candidateRecord)) {
          // A sidecar without its raw file still owns this identity.
          fs.closeSync(fd);
          fd = null;
          fs.rmSync(candidatePath, { force: true });
          throw Object.assign(new Error('capture identity in use'), { code: 'EEXIST' });
        }
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        if (error?.code === 'EEXIST' && attempt < CAPTURE_ID_ATTEMPTS) continue;
        throw error;
      }
      writeFd = fd;
      stem = candidate;
      capturePath = candidatePath;
      recordPath = candidateRecord;
      record.stderrFile = `${candidate}.err.log`;
      break;
    }
    // Claim ownership before the fork: a concurrent launcher pruning this
    // directory must see a launch in progress, not an orphan raw file.
    persist();
  } catch (error) {
    if (writeFd !== null) {
      try { fs.closeSync(writeFd); } catch {}
    }
    writeFd = null;
    capturePath = null;
    recordPath = null;
    record.stderrFile = null;
    log(`daemon crash capture unavailable: ${boundedMessage(error?.message || error)}`);
  }

  // Captured BEFORE the parent closes its copy: the child keeps its own
  // duplicate of this descriptor for its whole life.
  const stderrStdio = writeFd === null ? 'pipe' : writeFd;

  function closeWriteFd() {
    if (writeFd === null) return;
    try { fs.closeSync(writeFd); } catch {}
    writeFd = null;
  }

  function persist() {
    if (!recordPath || removed) return;
    try {
      // Atomic: a pruner reading this sidecar concurrently must never see a
      // half-written document and conclude the boot is dead.
      writeJsonAtomicSync(recordPath, record, { mode: 0o600 });
    } catch { /* diagnostics are best effort */ }
  }

  function captureSize() {
    if (!capturePath) return 0;
    try { return fs.statSync(capturePath).size; } catch { return 0; }
  }

  function removeCapture() {
    removed = true;
    for (const file of [capturePath, recordPath]) {
      if (!file) continue;
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }

  function mirrorText(text) {
    for (const line of String(text || '').split('\n')) {
      const row = line.trimEnd();
      if (row) log(row);
    }
  }

  /** Mirror only the bytes not mirrored yet, so one line never reaches the
   *  launcher's log twice across ready/exit/timeout drains. */
  function mirror() {
    if (!capturePath || removed) return;
    const size = captureSize();
    if (size <= readOffset) return;
    let skipped = 0;
    if (size - readOffset > MIRROR_MAX_BYTES) {
      skipped = size - readOffset - MIRROR_MAX_BYTES;
      readOffset = size - MIRROR_MAX_BYTES;
    }
    let text = '';
    try {
      const handle = fs.openSync(capturePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(size - readOffset);
        const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, readOffset);
        readOffset += bytesRead;
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch { return; }
    if (skipped > 0) log(`daemon stderr: skipped ${skipped} earlier byte(s), full text in ${capturePath}`);
    mirrorText(text);
  }

  function noteReady() {
    if (record.ready) return;
    record.ready = true;
    record.readyAt = new Date(now()).toISOString();
    mirror();
    persist();
  }

  function noteExit({ code = null, signal = null } = {}) {
    closeWriteFd();
    if (record.exitedAt) return;
    const at = now();
    record.exitedAt = new Date(at).toISOString();
    record.exitCode = Number.isInteger(code) ? code : null;
    record.exitSignal = signal ? String(signal) : null;
    record.uptimeMs = Math.max(0, at - startedAtMs);
    record.stderrBytes = captureSize();
    mirror();
    // A contender that lost the singleton claim exits 0 with nothing to say:
    // keeping a file per losing spawn would bury the boots that do matter.
    const uninteresting = !record.ready
      && record.exitCode === 0
      && record.exitSignal === null
      && record.stderrBytes === 0
      && !record.error;
    if (uninteresting) removeCapture();
    else persist();
    log(
      `daemon exit pid=${record.pid ?? '?'} code=${record.exitCode ?? '-'}`
      + ` signal=${record.exitSignal ?? '-'} ready=${record.ready ? 1 : 0}`
      + ` uptimeMs=${record.uptimeMs} stderrBytes=${record.stderrBytes}`
      + (removed || !capturePath ? '' : ` capture=${capturePath}`),
    );
  }

  /** Record a spawn failure — the synchronous `fork` throw AND the
   *  asynchronous `'error'` event, which may arrive with no `'exit'` at all.
   *  Idempotent, so a launcher may call it alongside the tracked listener. */
  function noteSpawnError(error) {
    closeWriteFd();
    if (record.error === null) record.error = boundedMessage(error?.message || error);
    if (!record.pid && !record.exitedAt) {
      // No child ever existed: this boot is terminal, so the sidecar must not
      // look like a launch still in progress.
      record.exitedAt = new Date(now()).toISOString();
      record.stderrBytes = captureSize();
      if (record.stderrBytes === 0 && capturePath) {
        // Nothing was ever written to fd 2: keep the record, drop the empty file.
        try { fs.rmSync(capturePath, { force: true }); } catch {}
        record.stderrFile = null;
        capturePath = null;
      }
    }
    // A child that did spawn keeps its lifecycle open: `noteExit` still fills
    // in the code/signal if the runtime reports one.
    persist();
  }

  /** Attach to the forked child: record its identity and keep a lifetime
   *  listener that survives the ready handoff, so a later exit is still
   *  correlated to this pid, boot time and ready state. */
  function track(child, { detached = false, execArgv = [] } = {}) {
    record.pid = Number(child?.pid) || null;
    record.detached = Boolean(detached);
    record.heapFlags = heapFlags(execArgv);
    // The child holds its own duplicate; the launcher must not keep the file
    // open for its own lifetime.
    closeWriteFd();
    persist();
    if (capturePath) log(`daemon crash capture pid=${record.pid ?? '?'} file=${capturePath}`);
    if (stderrStdio === 'pipe' && child?.stderr) {
      const stream = child.stderr;
      const onData = (chunk) => { mirrorText(String(chunk || '')); };
      stream.on('data', onData);
      // Pipe delivery is independent of the IPC 'ready' message and of the
      // child's exit: bytes written before ready can still be in flight after
      // it, and a native fd 2 error arrives long after. Drain until the STREAM
      // itself ends — cutting at ready or at exit silently drops those lines.
      // (The daemon's own redirect moves its JS logging to the file at ready,
      // so this cannot duplicate daemon log lines.) The launcher still unrefs
      // this stream, so nothing here extends its lifetime.
      pipeDrained = new Promise((resolve) => {
        const finish = () => {
          try { stream.off('data', onData); } catch {}
          resolve();
        };
        stream.once('end', finish);
        stream.once('close', finish);
        stream.once('error', finish);
      });
    }
    // `once` never refs the event loop by itself, so this adds no parent-side
    // lifetime dependency for the detached daemon.
    child?.once?.('exit', (code, signal) => noteExit({ code, signal }));
    // An asynchronous spawn failure (bad exec path, EACCES) emits 'error' and
    // need not emit 'exit' at all — without this the sidecar would keep
    // claiming a launch in progress forever.
    child?.once?.('error', (error) => noteSpawnError(error));
  }

  return {
    stderrStdio,
    get stem() { return stem; },
    get capturePath() { return capturePath; },
    get recordPath() { return recordPath; },
    track,
    noteReady,
    noteExit,
    noteSpawnError,
    mirror,
    /** Resolves when a fallback stderr pipe has ended; immediate when fd 2 is
     *  captured to a file. Lets a caller observe the last mirrored line. */
    whenDrained: () => pipeDrained || Promise.resolve(),
    /** Drop the launcher's own copy of the capture descriptor without
     *  recording anything — the child, if any, keeps its duplicate. */
    release: closeWriteFd,
    snapshot: () => ({ ...record }),
  };
}
