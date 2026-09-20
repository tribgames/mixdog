import { statSync, lstatSync, realpathSync, createWriteStream } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { hashText } from './hash-utils.mjs';
import { sleep } from '../../../../shared/sleep.mjs';
import { envFlag } from '../../../../shared/env.mjs';

const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_BACKOFFS_MS = [25, 50, 100, 200, 400, 800, 1200, 1600];

function expectedTargetSnapshotChanged(currentStat, expected) {
  if (!expected) return false;
  const snapshotExists = expected.exists !== false;
  const currentExists = !!currentStat;
  if (snapshotExists !== currentExists) return true;
  if (!snapshotExists || !currentExists) return false;
  if (currentStat.size !== expected.size) return true;
  if (Math.abs(Number(currentStat.mtimeMs) - Number(expected.mtimeMs)) > 1) return true;
  if (Number.isFinite(expected.ctimeMs)) {
    if (Math.abs(Number(currentStat.ctimeMs) - Number(expected.ctimeMs)) > 1) return true;
  }
  if (Number.isFinite(expected.ino) && Number(currentStat.ino) !== Number(expected.ino)) return true;
  return false;
}

function ioTraceEnabled() {
  return envFlag('MIXDOG_IO_TRACE');
}

function ioTraceStart() {
  return ioTraceEnabled() ? performance.now() : 0;
}

function ioTrace(event, fields = {}) {
  if (!ioTraceEnabled()) return;
  try {
    process.stderr.write(
      `[io-trace] ${JSON.stringify({
        event,
        ts: Date.now(),
        ...fields,
      })}\n`
    );
  } catch {}
}

function ioTraceDone(event, started, fields = {}) {
  if (!started || !ioTraceEnabled()) return;
  ioTrace(event, {
    ...fields,
    ms: Number((performance.now() - started).toFixed(3)),
  });
}

function atomicWriteShouldFsync(value) {
  if (value === true || value === false) return value;
  return /^(1|true|yes|on|sync)$/i.test(String(process.env.MIXDOG_ATOMIC_FSYNC || ''));
}

// 'wx' preflight creates an empty placeholder at targetPath; if the write is
// later aborted or the rename fails, remove it so a failed create doesn't
// leave a 0-byte file behind. Only removes a still-empty target — another
// writer's content is never deleted.
async function cleanupEmptyWxTarget(targetPath) {
  try {
    const st = await fsPromises.stat(targetPath);
    if (st.size === 0) await fsPromises.unlink(targetPath);
  } catch {
    /* already gone or unreadable — leave it */
  }
}

// The real file a write aimed at `targetPath` must land on when the leaf is a
// symlink, or null when it is not a link (or is dangling, so there is nothing
// to resolve). Writers rename a temp file into place, which would replace the
// LINK itself with a regular file and silently detach layouts like nginx's
// sites-enabled/default from sites-available/default. Engines that write a
// path themselves use this as "do not hand this target to the engine".
export function symlinkWriteTarget(targetPath) {
  try {
    if (!lstatSync(targetPath).isSymbolicLink()) return null;
    return realpathSync(targetPath);
  } catch {
    return null;
  }
}

async function unlinkQuietly(path) {
  try {
    await fsPromises.unlink(path);
  } catch {
    /* already gone */
  }
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function payloadByteLength(content) {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content ?? ''), 'utf-8');
}

async function resolveWriteSignal(signal, sessionId) {
  if (signal || !sessionId) return signal;
  try {
    return await getAbortSignalForSession(sessionId);
  } catch {
    return null;
  }
}

function abortReasonOf(signal) {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  if (typeof r === 'string' && r) return new Error(r);
  return new Error('atomicWrite aborted');
}

// The payload lands in a 'wx' temp file: an existing temp file (random
// collision or a pre-existing symlink at the temp path) is rejected instead of
// silently truncated. randomBytes(4) keeps collisions astronomically unlikely,
// but 'wx' makes the guarantee explicit and protects against symlink-attack
// scenarios on shared tmp dirs.
async function writeTempFile(tmp, content, { mode, fsync }) {
  let fh = null;
  try {
    if (payloadByteLength(content) > STREAMING_THRESHOLD_BYTES) {
      // Streaming path: avoid buffering the entire payload through
      // fh.writeFile (which copies into a single Buffer).
      const ws = createWriteStream(tmp, { flags: 'wx', mode });
      let source = content; // assume it's a Readable unless it is bytes/text
      if (Buffer.isBuffer(content)) source = Readable.from([content]);
      else if (typeof content === 'string') source = Readable.from([Buffer.from(content, 'utf-8')]);
      await pipeline(source, ws);
      if (fsync) {
        fh = await fsPromises.open(tmp, 'r+');
        await fh.sync();
        await fh.close();
        fh = null;
      }
    } else {
      fh = await fsPromises.open(tmp, 'wx', mode);
      await fh.writeFile(content);
      if (fsync) await fh.sync();
      await fh.close();
      fh = null;
    }
  } catch (writeErr) {
    try {
      if (fh) await fh.close();
    } catch {
      /* already closed */
    }
    await unlinkQuietly(tmp);
    throw writeErr;
  }
}

// Opt-in metadata preservation: utimes/owner of the existing target applied to
// the temp file before rename. Skip chown on Windows (process.geteuid is
// absent). Best-effort — failures are non-fatal.
async function preserveTargetMetadata(tmp, existingStat) {
  try {
    await fsPromises.utimes(tmp, existingStat.atime, existingStat.mtime);
  } catch {
    /* best-effort */
  }
  if (process.platform !== 'win32' && typeof process.geteuid === 'function') {
    try {
      await fsPromises.chown(tmp, existingStat.uid, existingStat.gid);
    } catch {
      /* best-effort: requires privilege or same-owner */
    }
  }
}

// 'wx' create: the target must still be absent right before the rename. The
// empty placeholder this leaves is removed by cleanupEmptyWxTarget when a later
// step fails.
async function assertExclusiveCreate(writeTarget, targetPath, tmp) {
  let excl = null;
  try {
    excl = await fsPromises.open(writeTarget, 'wx');
    await excl.close();
  } catch {
    if (excl)
      try {
        await excl.close();
      } catch {
        /* already closed */
      }
    await unlinkQuietly(tmp);
    throw Object.assign(new Error(`create target already exists (race detected): ${targetPath}`), {
      code: 'EEXIST',
      __skip: true,
    });
  }
}

async function assertTargetUnchanged(writeTarget, expectedTargetSnapshot, tmp) {
  if (!expectedTargetSnapshotChanged(statOrNull(writeTarget), expectedTargetSnapshot)) return;
  await unlinkQuietly(tmp);
  const err = new Error(`target changed between preflight and rename (TOCTOU): ${writeTarget}`);
  err.code = 'ESTALE_TARGET';
  throw err;
}

// Directory fsync makes the rename itself durable across power-loss. It is a
// no-op / unsupported on Windows; EPERM / EISDIR / EINVAL are swallowed there.
async function fsyncDirectory(dir) {
  let dirHandle = null;
  try {
    dirHandle = await fsPromises.open(dir, 'r');
    await dirHandle.sync();
  } catch {
    /* unsupported on this platform — best effort */
  } finally {
    if (dirHandle)
      try {
        await dirHandle.close();
      } catch {
        /* already closed */
      }
  }
}

// Rename the temp file into place, retrying transient Windows sharing errors.
// Resolves to the attempt count; a TOCTOU mismatch or the final failure
// removes the temp file (and an empty 'wx' placeholder) before throwing.
async function renameIntoPlace({ tmp, writeTarget, expectedTargetSnapshot, flags }) {
  let lastErr = null;
  const maxAttempts = process.platform === 'win32' ? WINDOWS_RENAME_RETRY_BACKOFFS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (expectedTargetSnapshot) await assertTargetUnchanged(writeTarget, expectedTargetSnapshot, tmp);
    try {
      await fsPromises.rename(tmp, writeTarget);
      return attempt + 1;
    } catch (err) {
      lastErr = err;
      if (process.platform === 'win32' && WINDOWS_RENAME_RETRY_CODES.has(err?.code) && attempt < maxAttempts - 1) {
        await sleep(WINDOWS_RENAME_RETRY_BACKOFFS_MS[attempt] + Math.floor(Math.random() * 40));
        continue;
      }
      break;
    }
  }
  await unlinkQuietly(tmp);
  if (flags === 'wx') await cleanupEmptyWxTarget(writeTarget);
  throw lastErr;
}

export async function atomicWrite(
  targetPath,
  content,
  { mode, signal, sessionId, flags, fsync, preserveMetadata = false, expectedTargetSnapshot } = {}
) {
  const traceStart = ioTraceStart();
  const resolvedSignal = await resolveWriteSignal(signal, sessionId);
  if (resolvedSignal?.aborted) throw abortReasonOf(resolvedSignal);

  // Write THROUGH a leaf symlink: resolve it first so the rename replaces the
  // file the link points at, not the link. Resolving also keeps the temp file
  // beside the real target, so the rename stays on one filesystem.
  const writeTarget = symlinkWriteTarget(targetPath) ?? targetPath;
  const dir = dirname(writeTarget);
  const tmp = join(dir, `.${basename(writeTarget)}.mixdog-tmp-${randomBytes(4).toString('hex')}`);
  const existingStat = statOrNull(writeTarget);
  let effectiveMode = mode;
  if (effectiveMode === undefined && existingStat) effectiveMode = existingStat.mode & 0o777;
  if (effectiveMode === undefined) effectiveMode = 0o644;
  const shouldFsync = atomicWriteShouldFsync(fsync);

  await writeTempFile(tmp, content, { mode: effectiveMode, fsync: shouldFsync });
  if (preserveMetadata && existingStat) await preserveTargetMetadata(tmp, existingStat);
  if (flags === 'wx') await assertExclusiveCreate(writeTarget, targetPath, tmp);
  if (resolvedSignal?.aborted) {
    await unlinkQuietly(tmp);
    if (flags === 'wx') await cleanupEmptyWxTarget(writeTarget);
    throw abortReasonOf(resolvedSignal);
  }
  const attempts = await renameIntoPlace({ tmp, writeTarget, expectedTargetSnapshot, flags });
  if (shouldFsync) await fsyncDirectory(dir);
  ioTraceDone('atomic_write', traceStart, {
    pathHash: hashText(targetPath).slice(0, 12),
    bytes: payloadByteLength(content),
    flags: flags || '',
    fsync: shouldFsync,
    attempts,
  });
}
