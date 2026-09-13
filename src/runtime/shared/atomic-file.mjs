import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import {
  link as linkAsync,
  mkdir as mkdirAsync,
  open as openAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { dirname, basename, join } from 'path';
import { randomBytes } from 'crypto';
import { DEFAULT_BACKOFFS_MS, withFileLock, withFileLockSync } from './file-lock.mjs';
import {
  enforceOwnerOnlyAclWin32 as _enforceOwnerOnlyAclWin32,
  enforceOwnerOnlyAclWin32Async as _enforceOwnerOnlyAclWin32Async,
} from './file-permissions.mjs';
import { sleep, sleepSync } from './sleep.mjs';

export { withFileLock, withFileLockSync };

// Async atomic writes from many daemon sessions share one disk. Keep enough
// parallelism for SSD throughput, then use additive-increase/multiplicative-
// decrease when latency shows the filesystem is saturated. This gate never
// touches synchronous compatibility paths and never revokes in-flight writes.
const _ioCeiling = Math.max(1, Math.floor(Number(process.env.MIXDOG_FILE_IO_MAX_CONCURRENCY) || 16));
let _ioLimit = Math.min(4, _ioCeiling);
let _ioActive = 0;
let _ioFastStreak = 0;
const _ioQueue = [];

function _drainAdaptiveFileIo() {
  while (_ioActive < _ioLimit && _ioQueue.length > 0) {
    const item = _ioQueue.shift();
    _ioActive += 1;
    const startedAt = Date.now();
    Promise.resolve()
      .then(item.run)
      .then(item.resolve, item.reject)
      .finally(() => {
        const elapsed = Date.now() - startedAt;
        _ioActive = Math.max(0, _ioActive - 1);
        if (elapsed >= 250) {
          _ioLimit = Math.max(1, Math.ceil(_ioLimit / 2));
          _ioFastStreak = 0;
        } else if (elapsed <= 40 && _ioLimit < _ioCeiling) {
          _ioFastStreak += 1;
          if (_ioFastStreak >= _ioLimit * 4) {
            _ioLimit += 1;
            _ioFastStreak = 0;
          }
        } else {
          _ioFastStreak = 0;
        }
        _drainAdaptiveFileIo();
      });
  }
}

function _runAdaptiveFileIo(run) {
  return new Promise((resolve, reject) => {
    _ioQueue.push({ run, resolve, reject });
    _drainAdaptiveFileIo();
  });
}

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

export function renameWithRetrySync(src, dst, opts = {}) {
  const backoffs = Array.isArray(opts.backoffs) && opts.backoffs.length > 0
    ? opts.backoffs
    : DEFAULT_BACKOFFS_MS;
  let lastErr = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      renameSync(src, dst);
      return true;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err?.code) || attempt >= backoffs.length) break;
      const jitter = Math.floor(Math.random() * Math.min(50, Math.max(1, backoffs[attempt])));
      sleepSync(backoffs[attempt] + jitter);
    }
  }
  throw lastErr;
}

async function renameWithRetry(src, dst, opts = {}) {
  const backoffs = Array.isArray(opts.backoffs) && opts.backoffs.length > 0
    ? opts.backoffs
    : DEFAULT_BACKOFFS_MS;
  let lastErr = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      await renameAsync(src, dst);
      return true;
    } catch (err) {
      lastErr = err;
      if (!RETRY_CODES.has(err?.code) || attempt >= backoffs.length) break;
      const jitter = Math.floor(Math.random() * Math.min(50, Math.max(1, backoffs[attempt])));
      await sleep(Math.max(1, Number(backoffs[attempt] + jitter) || 1));
    }
  }
  throw lastErr;
}

export function writeFileAtomicSync(filePath, data, opts = {}) {
  const run = () => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const writeOpts = { encoding: opts.encoding || 'utf8', flag: 'wx', mode: opts.mode !== undefined ? opts.mode : 0o600 };
      writeFileSync(tmp, data, writeOpts);
      // Secure the file before publication. Rename and hard links retain this
      // file's ACL; resetting permissions afterward would expose a published
      // secret if the subsequent owner grant failed.
      if (opts.secret === true) _enforceOwnerOnlyAclWin32(tmp, { fresh: true });
      if (opts.fsync !== false) {
        let fd = null;
        try {
          fd = openSync(tmp, 'r');
          fsyncSync(fd);
        } catch (err) {
          if (!['EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) throw err;
        } finally {
          try { if (fd !== null) closeSync(fd); } catch {}
        }
      }
      if (opts.createOnly === true) {
        // Atomic create-if-absent: linkSync fails with EEXIST if the
        // target already exists at link time, so a concurrent
        // non-locking writer (user/editor) that creates the file
        // between any prior existsSync gate and this call still
        // wins — we drop the temp and report `false` so the caller
        // can record the path as skipped rather than overwriting.
        try {
          linkSync(tmp, filePath);
        } catch (err) {
          try { unlinkSync(tmp); } catch {}
          if (err?.code === 'EEXIST') return false;
          throw err;
        }
        try { unlinkSync(tmp); } catch {}
      } else {
        try {
          renameWithRetrySync(tmp, filePath, opts);
        } catch (err) {
          // Opt-in fallback for callers whose target is a rename-lock hot
          // spot on win32 (e.g. AV/indexer briefly holding the destination
          // handle open), where rename-over keeps failing with EPERM/EACCES
          // /EBUSY even after renameWithRetrySync's backoff loop. The write
          // is already serialized by the caller's own withFileLockSync
          // (opts.lock / updateJsonAtomicSync's lock), so a direct
          // truncate+write of the target here is still race-safe against
          // other writers using the same lock path; it just loses the
          // rename's fully-atomic-swap guarantee for THIS write. Default
          // behavior (throw) is unchanged for every other caller.
          if (
            opts.renameFallback === 'truncate'
            && opts.secret !== true
            && process.platform === 'win32'
            && RETRY_CODES.has(err?.code)
          ) {
            const data = readFileSync(tmp);
            writeFileSync(filePath, data, { mode: opts.mode !== undefined ? opts.mode : 0o600 });
            try { unlinkSync(tmp); } catch {}
          } else {
            throw err;
          }
        }
      }
      if (opts.fsyncDir === true) {
        let dfd = null;
        try {
          dfd = openSync(dir, 'r');
          fsyncSync(dfd);
        } catch (err) {
          if (!['EPERM', 'ENOTSUP', 'EINVAL', 'EACCES'].includes(err?.code)) throw err;
        } finally {
          try { if (dfd !== null) closeSync(dfd); } catch {}
        }
      }
      return true;
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      throw err;
    }
  };
  if (opts.lock === true) {
    return withFileLockSync(`${filePath}.lock`, run, opts);
  }
  return run();
}

export function writeJsonAtomicSync(filePath, value, opts = {}) {
  return writeFileAtomicSync(filePath, JSON.stringify(value, null, opts.compact ? 0 : 2) + '\n', opts);
}

function recoverJsonMutationRead(error) {
  // Missing/malformed JSON retains the existing initializer contract. An I/O
  // or permission failure is not an empty document and must never authorize
  // replacing unreadable user state with a newly initialized value.
  if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
  throw error;
}

export function updateJsonAtomicSync(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLockSync(`${filePath}.lock`, () => {
    let cur = null;
    try {
      cur = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      cur = recoverJsonMutationRead(error);
    }
    const next = mutator(cur);
    if (next === undefined) return cur;
    writeJsonAtomicSync(filePath, next, { ...writeOpts, lock: false });
    return next;
  }, opts);
}

// ── Async atomic file write ─────────────────────────────────────────
// Mirror of writeFileAtomicSync using promise-based filesystem calls and async
// ACL enforcement. Large summary/pending-message JSON writes therefore never
// block the host event loop on read/write/fsync/rename.
// Async writes retain atomic rename publication; truncate recovery is sync-only.
export async function writeFileAtomicAsync(filePath, data, opts = {}) {
  const run = async () => {
    const dir = dirname(filePath);
    await mkdirAsync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const writeOpts = { encoding: opts.encoding || 'utf8', flag: 'wx', mode: opts.mode !== undefined ? opts.mode : 0o600 };
      await writeFileAsync(tmp, data, writeOpts);
      // Both publication paths retain the secured file's existing ACL.
      if (opts.secret === true) await _enforceOwnerOnlyAclWin32Async(tmp, { fresh: true });
      if (opts.fsync !== false) {
        let fd = null;
        try {
          fd = await openAsync(tmp, 'r');
          await fd.sync();
        } catch (err) {
          if (!['EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) throw err;
        } finally {
          try { if (fd !== null) await fd.close(); } catch {}
        }
      }
      if (opts.createOnly === true) {
        try {
          await linkAsync(tmp, filePath);
        } catch (err) {
          try { await unlinkAsync(tmp); } catch {}
          if (err?.code === 'EEXIST') return false;
          throw err;
        }
        try { await unlinkAsync(tmp); } catch {}
      } else {
        await renameWithRetry(tmp, filePath, opts);
      }
      if (opts.fsyncDir === true) {
        let dfd = null;
        try {
          dfd = await openAsync(dir, 'r');
          await dfd.sync();
        } catch (err) {
          if (!['EPERM', 'ENOTSUP', 'EINVAL', 'EACCES'].includes(err?.code)) throw err;
        } finally {
          try { if (dfd !== null) await dfd.close(); } catch {}
        }
      }
      return true;
    } catch (err) {
      try { await unlinkAsync(tmp); } catch {}
      throw err;
    }
  };
  // Acquire the file lock before occupying an I/O slot. Otherwise a waiter can
  // exhaust the gate while the current lock owner needs it to finish its write.
  return opts.lock === true
    ? withFileLock(`${filePath}.lock`, () => _runAdaptiveFileIo(run), opts)
    : _runAdaptiveFileIo(run);
}

export function writeJsonAtomicAsync(filePath, value, opts = {}) {
  return writeFileAtomicAsync(filePath, JSON.stringify(value, null, opts.compact ? 0 : 2) + '\n', opts);
}

// Async read-modify-write. Same lock path (`${filePath}.lock`) and protocol
// as updateJsonAtomicSync, so it is mutually exclusive with the sync variant.
// The lock wait and filesystem critical section are both asynchronous. JSON
// parse/mutation/stringify remain synchronous CPU work, but no disk operation
// or rename retry sleeps on the host event loop.
export async function updateJsonAtomic(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLock(`${filePath}.lock`, async () => {
    let cur = null;
    try {
      cur = JSON.parse(await readFileAsync(filePath, 'utf8'));
    } catch (error) {
      cur = recoverJsonMutationRead(error);
    }
    const next = mutator(cur);
    if (next === undefined) return cur;
    await writeJsonAtomicAsync(filePath, next, { ...writeOpts, lock: false });
    return next;
  }, opts);
}
