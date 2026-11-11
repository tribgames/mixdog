/**
 * Where a header scan of a session log (session-log-reader.mjs) leaves its
 * place for the next process: one small JSON file per log under a checkpoint
 * directory the caller names, written when the scan has gone SCAN_STRIDE_BYTES
 * past the place the last one was written at, read by a scan that has no place
 * of its own yet (a process or a worker thread that has just started).
 *
 * A checkpoint is a hint, never an authority: the reader resumes from it only
 * where it proves the log is the file it describes (same inode, still reaching
 * the offset, same first and last bytes), and every failure here — a missing,
 * torn, foreign or unwritable file — reads as no checkpoint: the log is
 * scanned from its start, as before.
 *
 * READERS take no lock. A reader that validated a checkpoint just before a
 * retirement removed it (or holds a descriptor of the old log) can resume from
 * it, and what it gets is the old log's content its own descriptor shows it:
 * what it already had a right to read. It can keep nothing of it: the only way
 * to persist anything derived from a scan is publishSync, which takes the lock
 * (refused while a retirement holds it) and opens the log by its path again,
 * where a rewritten or deleted log fails the identity and first-bytes check.
 * A reader never writes back the checkpoint it adopted. (The test 'a scan that
 * adopted the old log cannot publish it', session-scan-checkpoint-processes.test.mjs,
 * holds the check this rests on.)
 *
 * RETIREMENT FAILS CLOSED: an error other than "does not exist" listing the
 * checkpoint directory or removing one of its files, and any failure to take
 * the lock, throws (code ESCANCHECKPOINT, naming the file) before `run` is
 * called, so the log is not touched. A Windows sharing violation is not
 * retried: there is no event to wait for.
 *
 * LIFETIME INVARIANT: a checkpoint never exists for content that no longer
 * exists in its log. It holds digests of the log's first and last bytes, which
 * a guesser can test a candidate secret against, so what protects a redacted
 * or deleted log is that no checkpoint derived from it exists once the rewrite
 * or delete has returned, or can come to exist after:
 *  - one OS exclusive lock (os-exclusive-lock.mjs, the kernel drops it with
 *    its holder however the holder dies) guards a log's checkpoints; it is one
 *    of 256 lock files chosen by the log's path, so there are never more of
 *    them than that;
 *  - PUBLISH is one step under that lock, taken without waiting (a scan that
 *    cannot have it leaves no checkpoint; it is a hint): the log is opened
 *    again and must still be the file the scan covered (same identity, still
 *    reaching the offset, the same first and last bytes), then the checkpoint
 *    is written (atomically). No check follows the write, so no process that
 *    dies leaves a half-done publication of a kind a later step must finish;
 *  - RETIRE (withScanCheckpointsRetired) takes the same lock, waiting for a
 *    publisher that holds it (a few milliseconds), removes every file of the
 *    log (checkpoints and the temporary files of a publisher that died), and
 *    holds the lock through the rewrite or delete. While it is held nothing
 *    can be published; once it is let go the log is a new one (a rewrite
 *    writes a new log id in the first record; a delete leaves no file), so
 *    the validation of any scan that read the old one fails;
 *  - a publisher that dies leaves, at most, a checkpoint of a log that has not
 *    been rewritten yet (the retirement removes it) or a temporary file (the
 *    retirement removes that as well); a retirement that dies leaves no
 *    checkpoint, for nothing could be published while it held the lock;
 *  - orphans (their log gone) are swept at startup and by the stale sweep.
 * The epoch token (`<stem>.epoch`) is not part of this: it tells the summary
 * rows (summary-cache.mjs) that a log was rewritten while they were built.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomicSync } from '../../../../shared/atomic-file.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';

// 3: the first and last bytes the scan covered are kept as SHA-256 digests,
// never as the bytes, so a checkpoint holds nothing of a transcript's text but
// what the scan itself kept (the header; the facts of a facts scan).
const CHECKPOINT_VERSION = 3;
export const SCAN_GUARD_BYTES = 1024;
// A log shorter than this is scanned whole faster than a checkpoint is read.
const DEFAULT_STRIDE_BYTES = 16 * 1024 * 1024;
// A log with more lines that held no record than this is not worth keeping a place in.
const MAX_SKIPPED = 256;
let strideBytes = DEFAULT_STRIDE_BYTES;

/** Tests: the distance a checkpoint is written at. */
export function _setScanCheckpointStrideForTest(bytes) {
  strideBytes = bytes ?? DEFAULT_STRIDE_BYTES;
}

/** `kind`: '' for a scan that keeps the header, `facts-<version>` for one that
 *  keeps a fact of each message too. */
export function scanCheckpointPath(dir, logPath, kind = '') {
  return join(dir, `${createHash('sha1').update(logPath).digest('hex')}${kind ? `.${kind}` : ''}.json`);
}

/** Whether a scan that stopped at `offset` (its last checkpoint at `persisted`)
 *  should leave one: `replay` is what it amounts to. */
export function wantsScanCheckpoint(replay, offset, persisted) {
  return !replay.damage && replay.skipped.length <= MAX_SKIPPED && offset - persisted >= strideBytes;
}

/** What a checkpoint keeps of the log's first and last bytes. */
export function bytesDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function encode(logPath, { ino, offset, first, guard, replay }) {
  const { base, count, length, lastCompacted, skipped, project, messages } = replay;
  return JSON.stringify({
    v: CHECKPOINT_VERSION,
    path: logPath,
    ino: String(ino),
    offset,
    first: bytesDigest(first),
    guard: bytesDigest(guard),
    replay: { base, count, length, lastCompacted, skipped, ...(project ? { facts: messages } : {}) },
  });
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** The scan state a checkpoint's text holds for `logPath`, as
 *  `{ ino (BigInt), offset, guardLength, firstDigest, guardDigest, replay }`, or null when it holds
 *  none. Nothing about the log itself is proven here. */
function decode(text, logPath, kind) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const replay = doc?.replay;
  if (doc?.v !== CHECKPOINT_VERSION || doc.path !== logPath || !isCount(doc.offset)) return null;
  if (typeof doc.ino !== 'string' || !/^\d+$/.test(doc.ino)) return null;
  if (!/^[0-9a-f]{64}$/.test(doc.first) || !/^[0-9a-f]{64}$/.test(doc.guard)) return null;
  if (!replay || typeof replay !== 'object' || !replay.base || typeof replay.base !== 'object') return null;
  if (!isCount(replay.count) || replay.count < 2 || !isCount(replay.length) || !Array.isArray(replay.skipped)) return null;
  if (!Number.isSafeInteger(replay.lastCompacted) || replay.lastCompacted < 0) return null;
  // A checkpoint of facts is read by a scan that keeps them, and only by it.
  if (Boolean(kind) !== Array.isArray(replay.facts)) return null;
  const { base, count, length, lastCompacted, skipped } = replay;
  return {
    ino: BigInt(doc.ino),
    offset: doc.offset,
    // Both digests cover this many bytes: the first of the log, the last before `offset`.
    guardLength: Math.min(SCAN_GUARD_BYTES, doc.offset),
    firstDigest: doc.first,
    guardDigest: doc.guard,
    replay: { base, count, length, lastCompacted, skipped, messages: replay.facts, damage: null, tornTail: null },
  };
}

export function loadScanCheckpointSync(dir, logPath, kind = '') {
  try {
    return decode(readFileSync(scanCheckpointPath(dir, logPath, kind), 'utf8'), logPath, kind);
  } catch {
    return null;
  }
}

export async function loadScanCheckpoint(dir, logPath, kind = '') {
  try {
    return decode(await readFile(scanCheckpointPath(dir, logPath, kind), 'utf8'), logPath, kind);
  } catch {
    return null;
  }
}

const stemOf = (logPath) => createHash('sha1').update(logPath).digest('hex');
const epochPath = (dir, logPath) => join(dir, `${stemOf(logPath)}.epoch`);
const tokenOf = (text) => {
  try {
    const token = JSON.parse(text)?.t;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
};

/** The epoch of `logPath` (null: never retired): what a summary row is built under. */
export async function scanEpoch(dir, logPath) {
  try {
    return tokenOf(await readFile(epochPath(dir, logPath), 'utf8'));
  } catch {
    return null;
  }
}

// A bump of the log's epoch token: summary rows built while it changed are built again.
function bumpEpoch(dir, logPath) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(epochPath(dir, logPath), JSON.stringify({ path: logPath, t: randomBytes(12).toString('hex') }));
  } catch {
    /* the retirement itself does not depend on it */
  }
}

const LOCK_OPTIONS = { namespace: 'scan-checkpoint' };
// A lock file per 256th of the logs: never deleted, so two processes never
// hold "the same" lock through two files; a log shares its lock with the
// others of its stripe, which only means a publisher or a retirement of
// another log may wait or skip for as long as this one takes.
const lockPathOf = (dir, logPath) => join(`${dir}.locks`, `${stemOf(logPath).slice(0, 2)}.lock`);
// The locks this thread's retirements hold (lock path → { lock, count }): the
// lock belongs to the process, so retirements of two logs of a stripe (a
// redaction and a delete) share it here instead of waiting for each other.
const retiring = new Map();
// The wait for a publisher in another process, or a retirement of another log of the stripe.
let retireWaitMs = 60_000;
/** Tests: how long a retirement waits for a lock another process holds. */
export function _setRetirementWaitForTest(ms) {
  retireWaitMs = ms ?? 60_000;
}
const RETIRE_RETRY_MS = 2;

const checkpointError = (message, path, cause) =>
  Object.assign(new Error(`${message}: ${path}${cause ? ` (${cause.code ?? cause.message})` : ''}`, cause ? { cause } : undefined), {
    code: 'ESCANCHECKPOINT',
    path,
  });

// True: the retirement holds the lock now. False: another holder. An error
// opening the lock file throws: without the lock a publisher could write a
// checkpoint during the rewrite.
function takeRetirementLock(path) {
  const mine = retiring.get(path);
  if (mine) {
    mine.count += 1;
    return true;
  }
  let lock;
  try {
    lock = acquireOsExclusiveLockSync(path, LOCK_OPTIONS);
  } catch (error) {
    throw checkpointError('the lock of a session log\'s checkpoints cannot be taken', path, error);
  }
  if (!lock.held) return false;
  retiring.set(path, { lock, count: 1 });
  return true;
}

function releaseRetirementLock(path) {
  const mine = retiring.get(path);
  if (!mine || --mine.count > 0) return;
  retiring.delete(path);
  mine.lock.release();
}

const lockTimeout = (path) => checkpointError('the checkpoints of a session log are locked by another process', path);

async function awaitRetirementLock(path) {
  // The OS offers a lock that is taken or refused, never waited for; the
  // holder is a publisher's few milliseconds, so the retries are few.
  const deadline = Date.now() + retireWaitMs;
  while (!takeRetirementLock(path)) {
    if (Date.now() >= deadline) throw lockTimeout(path);
    await new Promise((resolve) => setTimeout(resolve, RETIRE_RETRY_MS));
  }
}

const syncPause = new Int32Array(new SharedArrayBuffer(4));

function awaitRetirementLockSync(path) {
  const deadline = Date.now() + retireWaitMs;
  while (!takeRetirementLock(path)) {
    if (Date.now() >= deadline) throw lockTimeout(path);
    // The exit drain cannot yield; without this pause the wait for another
    // process's retirement (a rewrite of a large log) would spin a core.
    Atomics.wait(syncPause, 0, 0, RETIRE_RETRY_MS);
  }
}

function retire(dir, logPath) {
  bumpEpoch(dir, logPath);
  removeScanCheckpoints(dir, logPath);
}

/** The log is about to be rewritten or deleted: `run` does it, with every
 *  checkpoint of the log removed first and none publishable until it has ended
 *  (the lifetime invariant above). Throws, without running `run`, when the lock
 *  cannot be had within a minute. */
export async function withScanCheckpointsRetired(dir, logPath, run) {
  const path = lockPathOf(dir, logPath);
  // A lock that is free is taken without yielding: `run` starts in the caller's
  // turn, as a write without a retirement does (the exit drain relies on a
  // rewrite being queued by the time a save returns its promise).
  if (!takeRetirementLock(path)) await awaitRetirementLock(path);
  try {
    retire(dir, logPath);
    return await run();
  } finally {
    bumpEpoch(dir, logPath);
    releaseRetirementLock(path);
  }
}

/** withScanCheckpointsRetired for the exit drain's synchronous rewrite. */
export function withScanCheckpointsRetiredSync(dir, logPath, run) {
  const path = lockPathOf(dir, logPath);
  awaitRetirementLockSync(path);
  try {
    retire(dir, logPath);
    return run();
  } finally {
    bumpEpoch(dir, logPath);
    releaseRetirementLock(path);
  }
}

function readWindow(fd, length, position) {
  const bytes = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, bytes, got, length - got, position + got);
    if (n === 0) return null;
    got += n;
  }
  return bytes;
}

// Whether the file at `logPath` is, now, the one `state` describes.
function logIsStill(logPath, { ino, offset, first, guard }) {
  let fd;
  try {
    fd = openSync(logPath, 'r');
    const st = fstatSync(fd, { bigint: true });
    if (st.ino !== ino || st.size < BigInt(offset)) return false;
    return readWindow(fd, first.length, 0)?.equals(first) === true && readWindow(fd, guard.length, offset - guard.length)?.equals(guard) === true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The one synchronous step: lock (without waiting), validate, write.
function publishSync(dir, logPath, state, kind, text) {
  const path = lockPathOf(dir, logPath);
  if (retiring.has(path)) return;
  let lock;
  try {
    lock = acquireOsExclusiveLockSync(path, LOCK_OPTIONS);
  } catch {
    return;
  }
  if (!lock.held) return;
  try {
    if (!logIsStill(logPath, state)) return;
    mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(scanCheckpointPath(dir, logPath, kind), text);
  } catch {
    /* a checkpoint is only a hint */
  } finally {
    lock.release();
  }
}

export function saveScanCheckpointSync(dir, logPath, state, kind = '') {
  try {
    publishSync(dir, logPath, state, kind, encode(logPath, state));
  } catch {
    /* a checkpoint is only a hint */
  }
}

/** The log is gone: so is the place kept in it. */
export function dropScanCheckpoint(dir, logPath, kind = '') {
  try {
    unlinkSync(scanCheckpointPath(dir, logPath, kind));
  } catch {
    /* none, or not ours to remove */
  }
}

// Also the temporary file of a publication a process died in (writeFileAtomicSync).
const CHECKPOINT_FILE = /^([0-9a-f]{40})(?:\.facts-[^.\\/]+)?\.json(?:\.mixdog-tmp-[0-9a-f]+)?$/;

/** The log is gone or rewritten: so is every place kept in it (of each kind
 *  of scan). Throws (ESCANCHECKPOINT, naming the file) when one cannot be
 *  listed or removed. */
export function removeScanCheckpoints(dir, logPath) {
  const stem = stemOf(logPath);
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw checkpointError('the checkpoints of a session log cannot be listed', dir, error);
  }
  for (const name of names) {
    if (CHECKPOINT_FILE.exec(name)?.[1] !== stem) continue;
    try {
      unlinkSync(join(dir, name));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw checkpointError('a checkpoint of a session log cannot be removed', join(dir, name), error);
    }
  }
}

// The log a checkpoint file is of, from its first bytes (`path` is written
// right after the version): null when they do not say, undefined when the
// file cannot be read.
async function checkpointLogPath(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    const match = /^\{"(?:v":\d+,"path|path)":("(?:[^"\\]|\\.)*")/.exec(buffer.toString('utf8', 0, bytesRead));
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// A retirement's token outlives its log this long (a scan that began before
// the delete cannot still be running); then the sweep removes it.
const EPOCH_FILE = /^[0-9a-f]{40}\.epoch$/;
const EPOCH_KEEP_MS = 10 * 60 * 1000;

/** Removes the checkpoints whose log is gone (its session deleted by another
 *  process or by a delete cut short, the data directory moved or restored).
 *  A file that cannot be read stays. Resolves how many it removed. */
export async function sweepOrphanScanCheckpoints(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const isEpoch = EPOCH_FILE.test(name);
    if (!isEpoch && !CHECKPOINT_FILE.test(name)) continue;
    const file = join(dir, name);
    if (isEpoch) {
      const info = await stat(file).catch(() => null);
      if (!info || Date.now() - info.mtimeMs < EPOCH_KEEP_MS) continue;
    }
    const logPath = await checkpointLogPath(file);
    if (logPath === undefined) continue;
    if (logPath !== null) {
      const present = await stat(logPath).then(
        () => true,
        (err) => err?.code !== 'ENOENT'
      );
      if (present) continue;
    }
    if (await unlink(file).then(() => true, () => false)) removed += 1;
  }
  return removed;
}
