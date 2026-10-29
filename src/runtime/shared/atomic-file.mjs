import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  link as linkAsync,
  mkdir as mkdirAsync,
  open as openAsync,
  readFile as readFileAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, relative, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_BACKOFFS_MS, recordLockTiming, withFileLock, withFileLockSync } from './file-lock.mjs';
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

function renameBackoffs(opts) {
  return Array.isArray(opts.backoffs) && opts.backoffs.length > 0 ? opts.backoffs : DEFAULT_BACKOFFS_MS;
}

// Windows answers EPERM/EACCES both for a sharing violation (AV/indexer holds
// the destination: clears in moments) and for renaming over a read-only file
// (never clears). Only the first is worth waiting for.
function isReadOnlyFile(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o200) === 0;
  } catch {
    return false;
  }
}

// Jittered delay before the next rename attempt, or null when this error or
// attempt count ends the loop. Shared so the sync and async paths cannot drift.
function nextRenameDelayMs(err, attempt, backoffs, dst) {
  if (!RETRY_CODES.has(err?.code) || attempt >= backoffs.length) return null;
  if ((err.code === 'EPERM' || err.code === 'EACCES') && isReadOnlyFile(dst)) return null;
  return backoffs[attempt] + Math.floor(Math.random() * Math.min(50, Math.max(1, backoffs[attempt])));
}

/**
 * Attempt `attempt` (0-based) of the renameWithRetry schedule: null when the
 * rename landed, else the delay before the next attempt. Throws the rename's
 * own error when that error or the attempt count ends the loop — the same
 * final error renameWithRetrySync throws. A caller that must not block waits
 * the delay asynchronously between attempts.
 */
export function renameAttempt(src, dst, attempt, opts = {}) {
  try {
    renameSync(src, dst);
    return null;
  } catch (err) {
    const delayMs = nextRenameDelayMs(err, attempt, renameBackoffs(opts), dst);
    if (delayMs === null) throw err;
    return delayMs;
  }
}

export function renameWithRetrySync(src, dst, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const delayMs = renameAttempt(src, dst, attempt, opts);
    if (delayMs === null) return true;
    sleepSync(delayMs);
  }
}

// Windows refuses to rename over a file while any handle on it is open, so
// this process's own reads of a busy state file (a delivery loop polling it)
// could fail every attempt of its writer's rename until the retries ran out.
// Here a rename attempt waits for the reads of its target in flight and holds
// new ones off only while it runs; other processes are what the retries cover.
// A read still open after RENAME_READ_WAIT_MS is left behind with its path's
// entry (a stuck read must not hold the writer, its lock, or later readers),
// and the attempt goes ahead under those same retries. Likewise a rename not
// returned by then: readers held off read anyway, as without it.
export const RENAME_READ_WAIT_MS = 1_000;
const targetUse = new Map();
const targetKey = (path) => {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
};
function useOf(key) {
  let use = targetUse.get(key);
  if (!use) targetUse.set(key, (use = { reads: 0, renaming: null, drained: [] }));
  return use;
}
function forgetIfIdle(key, use) {
  if (use.reads === 0 && !use.renaming && targetUse.get(key) === use) targetUse.delete(key);
}

// Waits for the rename `use` runs; one that has not returned within the bound
// is left behind with the entry, and the caller goes on as without it.
async function outwaitRename(key, use) {
  if (!(await settlesWithin(use.renaming, RENAME_READ_WAIT_MS)) && targetUse.get(key) === use) targetUse.delete(key);
  return useOf(key);
}

function settlesWithin(promise, ms) {
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true), bound]).finally(() => clearTimeout(timer));
}

async function readTarget(path, read) {
  const key = targetKey(path);
  let use = useOf(key);
  while (use.renaming) use = await outwaitRename(key, use);
  use.reads += 1;
  try {
    return await read();
  } finally {
    use.reads -= 1;
    if (use.reads === 0) for (const done of use.drained.splice(0)) done();
    forgetIfIdle(key, use);
  }
}

async function renameOver(src, dst) {
  const key = targetKey(dst);
  let use = useOf(key);
  while (use.renaming) use = await outwaitRename(key, use);
  let finish;
  use.renaming = new Promise((resolve) => {
    finish = resolve;
  });
  try {
    if (use.reads > 0 && !(await readsDrained(use, RENAME_READ_WAIT_MS)) && targetUse.get(key) === use) {
      targetUse.delete(key);
    }
    await renameAsync(src, dst);
  } finally {
    use.renaming = null;
    finish();
    forgetIfIdle(key, use);
  }
}

// True once `use` has no read in flight, false after `ms` (its waiter removed).
function readsDrained(use, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const at = use.drained.indexOf(done);
      if (at >= 0) use.drained.splice(at, 1);
      resolve(false);
    }, ms);
    use.drained.push(done);
  });
}

/** Test seam: the per-path coordination left (entries, drain waiters). */
export function _renameCoordinationForTest() {
  let waiters = 0;
  for (const use of targetUse.values()) waiters += use.drained.length;
  return { entries: targetUse.size, waiters };
}

async function renameWithRetry(src, dst, opts = {}) {
  const backoffs = renameBackoffs(opts);
  let lastErr = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      await renameOver(src, dst);
      return true;
    } catch (err) {
      lastErr = err;
      const delayMs = nextRenameDelayMs(err, attempt, backoffs, dst);
      if (delayMs === null) break;
      await sleep(Math.max(1, Number(delayMs) || 1));
    }
  }
  throw lastErr;
}

// Filesystems that refuse fsync on a file (or on a directory) answer with one of
// these codes; durability is best-effort there, so they do not fail the write.
const FILE_FSYNC_TOLERATED = ['EPERM', 'ENOTSUP', 'EINVAL'];
const DIR_FSYNC_TOLERATED = ['EPERM', 'ENOTSUP', 'EINVAL', 'EACCES'];

/** True when `err` is a filesystem refusing fsync on a file (network and
 *  cloud-sync drives), not a real I/O error: durability is best-effort there. */
export function isFileFsyncUnsupported(err) {
  return FILE_FSYNC_TOLERATED.includes(err?.code);
}

// Directory fsync (POSIX durability of the rename). Windows refuses it with
// EPERM, which is tolerated.
function fsyncPathSync(path, tolerated) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (err) {
    if (!tolerated.includes(err?.code)) throw err;
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {}
  }
}

async function fsyncPathAsync(path, tolerated) {
  let fd = null;
  try {
    fd = await openAsync(path, 'r');
    await fd.sync();
  } catch (err) {
    if (!tolerated.includes(err?.code)) throw err;
  } finally {
    try {
      if (fd !== null) await fd.close();
    } catch {}
  }
}

// Writes a file and flushes it through the handle that wrote it. Reopening to
// flush does not work: Windows refuses fsync on a read-only handle (EPERM) and
// may refuse a read-write reopen while AV scans the new file, and a 0o400 file
// cannot be reopened for writing on POSIX. Unflushed, a crash can publish the
// renamed file with its size committed but every byte NUL.
function writeFileDurableSync(path, data, opts) {
  const fd = openSync(path, opts.flag || 'wx', opts.mode !== undefined ? opts.mode : 0o600);
  try {
    writeFileSync(fd, data, { encoding: opts.encoding || 'utf8' });
    if (opts.fsync !== false) {
      try {
        fsyncSync(fd);
      } catch (err) {
        if (!isFileFsyncUnsupported(err)) throw err;
      }
    }
  } finally {
    closeSync(fd);
  }
}

async function writeFileDurableAsync(path, data, opts) {
  const handle = await openAsync(path, opts.flag || 'wx', opts.mode !== undefined ? opts.mode : 0o600);
  try {
    await handle.writeFile(data, { encoding: opts.encoding || 'utf8' });
    if (opts.fsync !== false) {
      try {
        await handle.sync();
      } catch (err) {
        if (!isFileFsyncUnsupported(err)) throw err;
      }
    }
  } finally {
    await handle.close();
  }
}

/** True when `content` (string or Buffer) holds nothing but NUL bytes and
 *  whitespace — what a crash leaves of a file whose data never reached disk. */
export function holdsNoData(content) {
  if (typeof content === 'string') return /^[\0\s]*$/.test(content);
  for (const byte of content) {
    if (byte !== 0 && byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return true;
}

// `backup: true` keeps the version a write replaces as `<file>.bak`, the last
// good copy readJsonState* restores when the file is later found damaged.
// Damaged bytes are never promoted to the backup.
const keepsAsBackup = (opts, content) => (opts.backupAccepts ? opts.backupAccepts(content) : !holdsNoData(content));
const backupWriteOpts = (opts) => ({ mode: opts.mode, secret: opts.secret, fsync: opts.fsync });

function keepBackupSync(filePath, opts) {
  let previous;
  try {
    previous = readFileSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (keepsAsBackup(opts, previous)) publishFileSync(`${filePath}.bak`, previous, backupWriteOpts(opts));
}

async function keepBackupAsync(filePath, opts) {
  let previous;
  try {
    previous = await readFileAsync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  if (keepsAsBackup(opts, previous)) await publishFileAsync(`${filePath}.bak`, previous, backupWriteOpts(opts));
}

// Node sets NODE_TEST_CONTEXT in every `--test` process. A secret (credential)
// write from a test must land under the temp dir; anything else is a fixture
// about to overwrite a real profile, so fail loudly instead.
function assertTestSecretWriteSafe(filePath, opts) {
  if (opts.secret !== true || !process.env.NODE_TEST_CONTEXT) return;
  const rel = relative(resolve(tmpdir()).toLowerCase(), resolve(filePath).toLowerCase());
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`refusing to write a secret outside the temp dir under node --test: ${filePath}`);
}

export function writeFileAtomicSync(filePath, data, opts = {}) {
  assertTestSecretWriteSafe(filePath, opts);
  const run = () => publishFileSync(filePath, data, opts);
  if (opts.lock === true) {
    return withFileLockSync(`${filePath}.lock`, run, opts);
  }
  return run();
}

// Windows cloud-sync drives (Naver MYBOX, #138) refuse to create a file whose
// name starts with '.', so neither a temp file nor a quarantined copy may
// carry one. The temp shape is the edit tool's `<name>.mixdog-tmp-<hex>`.
function publishTempPath(filePath) {
  return join(dirname(filePath), `${basename(filePath)}.mixdog-tmp-${randomBytes(8).toString('hex')}`);
}

function publishFileSync(filePath, data, opts) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = publishTempPath(filePath);
  try {
    writeFileDurableSync(tmp, data, { ...opts, flag: 'wx' });
    // Secure the file before publication. Rename and hard links retain this
    // file's ACL; resetting permissions afterward would expose a published
    // secret if the subsequent owner grant failed.
    if (opts.secret === true) _enforceOwnerOnlyAclWin32(tmp, { fresh: true });
    if (opts.backup === true && opts.createOnly !== true) keepBackupSync(filePath, opts);
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
        try {
          unlinkSync(tmp);
        } catch {}
        if (err?.code === 'EEXIST') return false;
        throw err;
      }
      try {
        unlinkSync(tmp);
      } catch {}
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
          opts.renameFallback === 'truncate' &&
          opts.secret !== true &&
          process.platform === 'win32' &&
          RETRY_CODES.has(err?.code)
        ) {
          writeFileDurableSync(filePath, readFileSync(tmp), { ...opts, flag: 'w', encoding: undefined });
          try {
            unlinkSync(tmp);
          } catch {}
        } else {
          throw err;
        }
      }
    }
    if (opts.fsyncDir === true) fsyncPathSync(dir, DIR_FSYNC_TOLERATED);
    return true;
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// A JSON write's backup takes only a replaced version that still parses.
const jsonBackupOpts = (opts) =>
  opts.backup === true && !opts.backupAccepts ? { ...opts, backupAccepts: isJsonContent } : opts;

export function writeJsonAtomicSync(filePath, value, opts = {}) {
  return writeFileAtomicSync(filePath, `${JSON.stringify(value, null, opts.compact ? 0 : 2)}\n`, jsonBackupOpts(opts));
}

// Windows editors and PowerShell 5 save UTF-8 with a leading byte order mark,
// which JSON.parse rejects; a hand-edited state file must still load.
export function parseJsonText(text) {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function isJsonContent(content) {
  try {
    parseJsonText(String(content));
    return true;
  } catch {
    return false;
  }
}

// ── Damaged JSON state ──────────────────────────────────────────────
// A state file whose text does not parse, or that the caller's `validate`
// rejects (throws), is damaged: empty or NUL-filled after a crash, truncated,
// or broken by hand. Its feature must keep working, so the damaged file is
// moved aside to `<file>.corrupt-<ts>` (its bytes are kept, never overwritten)
// and the last good copy `<file>.bak` is restored when there is one. A file
// that cannot be READ (EACCES, EBUSY…) is not damaged and still throws.
// `decode` turns the file's bytes into JSON text (e.g. unsealing an encrypted
// file); throwing there marks the file damaged too.
// The rename that moves a damaged file aside replaces an existing destination,
// so the name is the first `<file>.corrupt-<ms>` that does not exist yet: two
// recoveries in one millisecond (or after a clock rollback) never overwrite a
// kept copy, and the name is no longer than the original shape. Recovery runs
// under the file's lock, so nothing else creates a quarantine name between
// this check and the rename.
export const quarantinePath = (filePath) => {
  let stamp = Date.now();
  while (existsSync(`${filePath}.corrupt-${stamp}`)) stamp += 1;
  return `${filePath}.corrupt-${stamp}`;
};
const LOCK_BUSY_CODES = new Set(['ELOCKCONTENDED', 'ELOCKTIMEOUT']);
const STATE_UNSUPPORTED = 'ESTATEUNSUPPORTED';
const acceptAny = (value) => value;
const utf8Text = (content) => content.toString('utf8');

/** For `validate`: the file is intact but in a format a newer build wrote.
 *  It is not damage — the file stays in place, untouched, and the read
 *  answers the fallback, so a downgrade never discards a newer build's data. */
export function unsupportedState(message) {
  return Object.assign(new Error(message), { code: STATE_UNSUPPORTED });
}

const stateParser =
  (validate = acceptAny, decode = utf8Text) =>
  (content) => {
    if (content === null) return { state: 'absent' };
    try {
      return { state: 'ok', value: validate(parseJsonText(decode(content))), content };
    } catch (error) {
      return { state: error?.code === STATE_UNSUPPORTED ? 'unsupported' : 'damaged', error };
    }
  };

function readContentOrNullSync(filePath) {
  try {
    return readFileSync(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function readContentOrNullAsync(filePath) {
  try {
    return await readTarget(filePath, () => readFileAsync(filePath));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function reportDamaged(filePath, error, outcome) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escapes C0 control characters (U+0000-U+001F) so a damaged-file message stays on one log line.
  const reason = String(error?.message || error).replace(/[\0-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`);
  process.stderr.write(`[state] ${filePath} is damaged (${reason}); ${outcome}\n`);
}

const restoreOpts = (opts) => ({ mode: opts.mode, secret: opts.secret });
const KEPT_IN_PLACE = 'left in place: no good copy to restore';

const NO_BACKUP = { state: 'absent' };

// Caller holds `${filePath}.lock`. The file is re-read under the lock, so a
// file another process has repaired meanwhile is kept. `keepWithoutBackup` leaves a
// damaged file in place when there is no good copy: for a file other readers
// treat "missing" as permissive (e.g. a deny list), moving it would fail open.
// `restoreBackup: false` never restores `.bak` — for files where an older copy
// is worse than none (e.g. permission grants a later revocation removed).
function recoverDamagedSync(filePath, parse, opts) {
  const current = parse(readContentOrNullSync(filePath));
  if (current.state !== 'damaged') return current;
  const backup = opts.restoreBackup === false ? NO_BACKUP : parse(readContentOrNullSync(`${filePath}.bak`));
  if (backup.state !== 'ok' && opts.keepWithoutBackup) {
    reportDamaged(filePath, current.error, KEPT_IN_PLACE);
    return { state: 'absent' };
  }
  const aside = quarantinePath(filePath);
  renameWithRetrySync(filePath, aside, opts);
  if (backup.state === 'ok') publishFileSync(filePath, backup.content, restoreOpts(opts));
  reportDamaged(filePath, current.error, recoveredOutcome(aside, backup));
  return backup.state === 'ok' ? backup : { state: 'absent' };
}

async function recoverDamagedAsync(filePath, parse, opts) {
  const current = parse(await readContentOrNullAsync(filePath));
  if (current.state !== 'damaged') return current;
  const backup = opts.restoreBackup === false ? NO_BACKUP : parse(await readContentOrNullAsync(`${filePath}.bak`));
  if (backup.state !== 'ok' && opts.keepWithoutBackup) {
    reportDamaged(filePath, current.error, KEPT_IN_PLACE);
    return { state: 'absent' };
  }
  const aside = quarantinePath(filePath);
  await renameWithRetry(filePath, aside, opts);
  if (backup.state === 'ok') await publishFileAsync(filePath, backup.content, restoreOpts(opts));
  reportDamaged(filePath, current.error, recoveredOutcome(aside, backup));
  return backup.state === 'ok' ? backup : { state: 'absent' };
}

const recoveredOutcome = (aside, backup) =>
  `kept as ${aside}${backup.state === 'ok' ? '; restored the last good copy' : '; starting empty'}`;

/** Reads a JSON state file that must never block its feature. Returns the
 *  validated value, or `fallback` (as is) when the file is missing or damaged
 *  and has no good backup. `validate` maps the parsed value and throws to mark
 *  it damaged; `decode` maps the raw bytes to JSON text. Other opts (`secret`,
 *  `mode`, lock timing) apply to the lock and to a restored file. */
export function readJsonStateSync(filePath, { validate, decode, fallback = null, ...opts } = {}) {
  const parse = stateParser(validate, decode);
  const first = parse(readContentOrNullSync(filePath));
  if (first.state === 'ok') return first.value;
  if (first.state !== 'damaged') return fallback;
  let recovered;
  try {
    recovered = withFileLockSync(`${filePath}.lock`, () => recoverDamagedSync(filePath, parse, opts), opts);
  } catch (err) {
    if (!LOCK_BUSY_CODES.has(err?.code)) throw err;
    reportDamaged(filePath, first.error, 'left in place while another writer holds its lock');
    return fallback;
  }
  return recovered.state === 'ok' ? recovered.value : fallback;
}

export async function readJsonState(filePath, { validate, decode, fallback = null, ...opts } = {}) {
  const parse = stateParser(validate, decode);
  const first = parse(await readContentOrNullAsync(filePath));
  if (first.state === 'ok') return first.value;
  if (first.state !== 'damaged') return fallback;
  let recovered;
  try {
    recovered = await withFileLock(`${filePath}.lock`, () => recoverDamagedAsync(filePath, parse, opts), opts);
  } catch (err) {
    if (!LOCK_BUSY_CODES.has(err?.code)) throw err;
    reportDamaged(filePath, first.error, 'left in place while another writer holds its lock');
    return fallback;
  }
  return recovered.state === 'ok' ? recovered.value : fallback;
}

// Read-modify-write start: a missing file is null; a damaged one is kept
// aside (never silently overwritten) and its last good copy, if any, is the
// mutator's input. I/O failures throw — an unreadable file is not empty.
const parseAnyJson = stateParser();

function readForMutationSync(filePath, opts) {
  const current = parseAnyJson(readContentOrNullSync(filePath));
  if (current.state === 'ok') return current.value;
  if (current.state === 'absent') return null;
  const recovered = recoverDamagedSync(filePath, parseAnyJson, opts);
  return recovered.state === 'ok' ? recovered.value : null;
}

async function readForMutationAsync(filePath, opts) {
  const current = parseAnyJson(await readContentOrNullAsync(filePath));
  if (current.state === 'ok') return current.value;
  if (current.state === 'absent') return null;
  const recovered = await recoverDamagedAsync(filePath, parseAnyJson, opts);
  return recovered.state === 'ok' ? recovered.value : null;
}

export function updateJsonAtomicSync(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLockSync(
    `${filePath}.lock`,
    () => {
      const cur = readForMutationSync(filePath, writeOpts);
      const next = mutator(cur);
      if (next === undefined) return cur;
      writeJsonAtomicSync(filePath, next, { ...writeOpts, lock: false });
      return next;
    },
    opts
  );
}

// ── Async atomic file write ─────────────────────────────────────────
// Mirror of writeFileAtomicSync using promise-based filesystem calls and async
// ACL enforcement. Large summary/pending-message JSON writes therefore never
// block the host event loop on read/write/fsync/rename.
// Async writes retain atomic rename publication; truncate recovery is sync-only.
export async function writeFileAtomicAsync(filePath, data, opts = {}) {
  assertTestSecretWriteSafe(filePath, opts);
  const run = () => publishFileAsync(filePath, data, opts);
  // Acquire the file lock before occupying an I/O slot. Otherwise a waiter can
  // exhaust the gate while the current lock owner needs it to finish its write.
  if (opts.lock !== true) return _runAdaptiveFileIo(run);
  const lockPath = `${filePath}.lock`;
  return withFileLock(
    lockPath,
    async () => {
      const queuedAt = Date.now();
      let startedAt = 0;
      try {
        return await _runAdaptiveFileIo(() => {
          startedAt = Date.now();
          return run();
        });
      } finally {
        const now = Date.now();
        // Recorded from this (lock-owner) context so the held warning can
        // split the hold into gate wait vs. the write itself.
        recordLockTiming(lockPath, {
          ioGateWaitMs: (startedAt || now) - queuedAt,
          writeMs: startedAt ? now - startedAt : 0,
        });
      }
    },
    opts
  );
}

// Never re-enters the I/O gate: a backup or restore runs inside a slot the
// caller already holds.
async function publishFileAsync(filePath, data, opts) {
  const dir = dirname(filePath);
  await mkdirAsync(dir, { recursive: true });
  const tmp = publishTempPath(filePath);
  try {
    await writeFileDurableAsync(tmp, data, { ...opts, flag: 'wx' });
    // Both publication paths retain the secured file's existing ACL.
    if (opts.secret === true) await _enforceOwnerOnlyAclWin32Async(tmp, { fresh: true });
    if (opts.backup === true && opts.createOnly !== true) await keepBackupAsync(filePath, opts);
    if (opts.createOnly === true) {
      try {
        await linkAsync(tmp, filePath);
      } catch (err) {
        try {
          await unlinkAsync(tmp);
        } catch {}
        if (err?.code === 'EEXIST') return false;
        throw err;
      }
      try {
        await unlinkAsync(tmp);
      } catch {}
    } else {
      await renameWithRetry(tmp, filePath, opts);
    }
    if (opts.fsyncDir === true) await fsyncPathAsync(dir, DIR_FSYNC_TOLERATED);
    return true;
  } catch (err) {
    try {
      await unlinkAsync(tmp);
    } catch {}
    throw err;
  }
}

export function writeJsonAtomicAsync(filePath, value, opts = {}) {
  return writeFileAtomicAsync(filePath, `${JSON.stringify(value, null, opts.compact ? 0 : 2)}\n`, jsonBackupOpts(opts));
}

// Async read-modify-write. Same lock path (`${filePath}.lock`) and protocol
// as updateJsonAtomicSync, so it is mutually exclusive with the sync variant.
// The lock wait and filesystem critical section are both asynchronous. JSON
// parse/mutation/stringify remain synchronous CPU work, but no disk operation
// or rename retry sleeps on the host event loop.
export async function updateJsonAtomic(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLock(
    `${filePath}.lock`,
    async () => {
      const cur = await readForMutationAsync(filePath, writeOpts);
      const next = mutator(cur);
      if (next === undefined) return cur;
      await writeJsonAtomicAsync(filePath, next, { ...writeOpts, lock: false });
      return next;
    },
    opts
  );
}
