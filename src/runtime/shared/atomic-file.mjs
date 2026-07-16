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
} from 'fs';
import { dirname, basename, join } from 'path';
import { randomBytes } from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const _execFileAsync = promisify(execFile);

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
const LOCK_WAIT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const DEFAULT_BACKOFFS_MS = Object.freeze([25, 50, 100, 200, 400, 800, 1200, 1600]);
const DEFAULT_LOCK_TIMEOUT_MS = 8000;

// Per-process owner identity. A bare pid is not a durable holder identity:
// after a holder crashes the OS can recycle its pid onto an unrelated live
// process (or onto THIS process), making a corpse lock look "held by a live
// pid" — including "held by me" — which starves every waiter. Stamping a
// random per-instance token alongside the pid lets reclaim/release tell our
// current lock apart from a same-pid prior/other instance's leftover.
const _OWNER_TOKEN = randomBytes(12).toString('hex');

function sleepSync(ms) {
  try {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, Math.max(1, Number(ms) || 1));
  } catch {
    const end = Date.now() + Math.max(1, Number(ms) || 1);
    while (Date.now() < end) {}
  }
}

// Best-effort holder snapshot for lock-failure diagnostics: pid/token/age
// read from the lock file AT THROW TIME, so ELOCKTIMEOUT/ELOCKCONTENDED
// messages identify the culprit without needing a live repro. Never throws.
function _describeLockHolder(lockPath) {
  try {
    const st = statSync(lockPath);
    const owner = _readLockOwner(lockPath);
    const ageMs = Math.max(0, Math.round(Date.now() - st.mtimeMs));
    const live = owner.pid === null ? 'unknown' : (_ownerIsLive(owner) ? 'live' : 'dead');
    const token = owner.token === null ? '?' : String(owner.token).slice(0, 8);
    return `holder pid=${owner.pid ?? '?'} token=${token} age=${ageMs}ms ${live}`;
  } catch {
    return 'holder unknown (lock file unreadable/absent)';
  }
}

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

export function withFileLockSync(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  let attempt = 0;
  let lastErr = null;
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      lastErr = err;
      if (!LOCK_WAIT_CODES.has(err?.code)) throw err;
      // try-once semantics: timeoutMs:0 makes a single openSync attempt and
      // never sleeps — on contention it throws ELOCKCONTENDED immediately so
      // the main loop is never blocked by Atomics.wait. No stale-reclaim,
      // since reclaim would require waiting on the guard.
      if (timeoutMs <= 0) {
        const contErr = new Error(`atomic lock contended (try-once): ${lockPath} [${_describeLockHolder(lockPath)}]`);
        contErr.code = 'ELOCKCONTENDED';
        contErr.cause = err;
        throw contErr;
      }
      // Reclaim only when owner death is positively established. Age, an
      // unreadable owner, or a same-pid foreign token remain contended.
      try {
        if (_tryReclaimStaleLock(lockPath, staleMs)) continue;
      } catch {}
      if (Date.now() >= deadline) break;
      const base = DEFAULT_BACKOFFS_MS[Math.min(attempt, DEFAULT_BACKOFFS_MS.length - 1)];
      const jitter = Math.floor(Math.random() * Math.min(75, Math.max(1, base)));
      sleepSync(Math.min(Math.max(1, deadline - Date.now()), base + jitter));
      attempt += 1;
      continue;
    }
    // Stamp pid + per-instance token so stale-lock recovery and the
    // finally-unlink below can verify OUR identity instead of blindly
    // deleting whatever lock file happens to be at this path. Format
    // `<pid> <ts> <token>` is a superset of the old `<pid> <ts>`; a
    // tokenless (old-format) lock is still read as pid-authoritative.
    try { writeFileSync(fd, `${process.pid} ${Date.now()} ${_OWNER_TOKEN}\n`, 'utf8'); } catch {}
    // For secret-bearing critical sections, the lock file sits beside
    // the secret in the same (shared-home) directory; clamp it owner-only
    // too. Fail-closed: an unenforceable ACL aborts before fn() runs.
    try {
      if (opts.secret === true) _enforceOwnerOnlyAclWin32(lockPath);
      return fn();
    } finally {
      try { closeSync(fd); } catch {}
      // Only unlink if we still own the lock. If the path was externally
      // replaced, unconditionally unlinking would destroy the new owner's
      // lock and break mutual exclusion for whoever is queued behind it.
      try {
        if (_lockOwnedBySelf(lockPath)) unlinkSync(lockPath);
      } catch {}
    }
  }
  const timeoutErr = new Error(`atomic lock timeout after ${timeoutMs}ms: ${lockPath} [${_describeLockHolder(lockPath)}]`);
  timeoutErr.code = 'ELOCKTIMEOUT';
  timeoutErr.cause = lastErr;
  throw timeoutErr;
}

// Lock-ownership helpers. The lock file's first whitespace-separated
// token is the owner pid (see the writeFileSync above). Best-effort
// only: a parse failure or stat error is treated as "not ours" /
// "owner unknown" so we err on the side of NOT stealing.
// Full owner identity: pid plus per-instance token. token is null for an
// old-format (`<pid> <ts>`) lock, in which case callers fall back to
// pid-authoritative handling so a still-running old-format holder is
// respected. A read/parse error yields {pid:null, token:null} ("unknown").
function _readLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parts = String(raw).trim().split(/\s+/);
    const pid = Number.parseInt(parts[0], 10);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      token: parts.length >= 3 ? parts[2] : null,
    };
  } catch {
    return { pid: null, token: null };
  }
}

// Is this recorded owner a genuinely live holder?
//  - pid null (empty/unparseable): not live (unknown owner).
//  - pid === our pid: treated as LIVE. A foreign/absent token on our own
//    pid is ambiguous — it may be a recycled-pid corpse, but it may also
//    be a live sibling worker_thread (which shares process.pid). Ambiguity
//    is never reclaimed.
//  - foreign pid: probed with kill(pid, 0); ESRCH ⇒ dead, else live.
function _ownerIsLive(owner) {
  if (owner.pid === null) return false;
  if (owner.pid === process.pid) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

// Release-time guard: unlink only if the lock still carries OUR identity
// (our pid AND our token). Protects against deleting a lock another
// instance stole+recreated, and against a same-pid sibling.
function _lockOwnedBySelf(lockPath) {
  const owner = _readLockOwner(lockPath);
  if (owner.pid !== process.pid) return false;
  return owner.token === null ? true : owner.token === _OWNER_TOKEN;
}

// Shared stale-lock reclaim used by BOTH withFileLockSync and withFileLock.
// The whole operation is synchronous; the two variants differ only in how
// they wait between attempts. Returns true iff lockPath was reclaimed.
//
// Reclaim decision table (owner = identity recorded in the lock file):
//   owner pid DEAD (ESRCH) → reclaim
//   owner pid NULL/uncertain or same-pid foreign token → back off
//   owner token MISMATCH on guarded re-read (new holder took over) → back off
//   owner LIVE → back off regardless of age
function _tryReclaimStaleLock(lockPath, staleMs) {
  try { statSync(lockPath); } catch { return false; }
  const owner = _readLockOwner(lockPath);
  const dead = owner.pid !== null && !_ownerIsLive(owner);
  if (!dead) return false;
  const reclaim = _tryAcquireReclaimGuard(lockPath, staleMs);
  if (reclaim === null) return false;
  try {
    let cur;
    try { cur = statSync(lockPath); } catch { return false; }
    const curOwner = _readLockOwner(lockPath);
    // Re-verify the SAME identity (pid AND token) we decided to reclaim is
    // still present. A reused-pid new holder that grabbed the lock during
    // the guard window has a different token and is not mistaken for the
    // corpse — so we never yank a freshly-acquired live lock.
    if (curOwner.pid !== owner.pid || curOwner.token !== owner.token) return false;
    const curDead = curOwner.pid !== null && !_ownerIsLive(curOwner);
    if (curDead) {
      try { unlinkSync(lockPath); return true; } catch { return false; }
    }
    return false;
  } finally {
    _releaseReclaimGuard(reclaim);
  }
}

function _tryAcquireReclaimGuard(lockPath, staleMs) {
  const guardPath = `${lockPath}.reclaim`;
  const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString('hex')}\n`;
  const stagedPath = `${guardPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    // Publish a fully formed guard with no empty-file window. linkSync is
    // atomic and fails rather than replacing an existing pathname.
    writeFileSync(stagedPath, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    linkSync(stagedPath, guardPath);
    unlinkSync(stagedPath);
    return { guardPath };
  } catch (err) {
    try { unlinkSync(stagedPath); } catch {}
    if (LOCK_WAIT_CODES.has(err?.code)) {
      // There is no portable ownership-conditional unlink. Never revoke a
      // published guard: age and contents are diagnostic only, and deleting
      // after a pathname re-read admits an ABA that can steal a live guard.
      return null;
    }
    throw err;
  }
}

function _releaseReclaimGuard(reclaim) {
  // Protocol participants cannot replace a published guard: contenders only
  // wait, so the exact owner may remove its non-revocable pathname directly.
  try { unlinkSync(reclaim.guardPath); } catch {}
}

// ── Async lock variant (non-blocking wait) ──────────────────────────
// Identical lock protocol to withFileLockSync (same lockPath, same pid
// stamp, same stale/ownership/reclaim rules) so a sync holder and an
// async holder are mutually exclusive against one another — they contend
// for the SAME openSync('wx') on the SAME path. The ONLY difference is
// the wait: instead of Atomics.wait blocking the event loop, we yield via
// setTimeout backoff. Intended for UI-process consistency-required writes
// that must not stall the render loop.
function _asyncSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(1, Number(ms) || 1)); });
}

export async function withFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : 30000;
  const deadline = Date.now() + timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true });
  let attempt = 0;
  let lastErr = null;
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      lastErr = err;
      if (!LOCK_WAIT_CODES.has(err?.code)) throw err;
      if (timeoutMs <= 0) {
        const contErr = new Error(`atomic lock contended (try-once): ${lockPath} [${_describeLockHolder(lockPath)}]`);
        contErr.code = 'ELOCKCONTENDED';
        contErr.cause = err;
        throw contErr;
      }
      // Stale-lock reclaim (shared with the sync variant): dead owner pid,
      // a same-pid-but-foreign-token corpse from a reused pid, or a
      // pidless/empty corpse lock. A live foreign holder is never stolen.
      try {
        if (_tryReclaimStaleLock(lockPath, staleMs)) continue;
      } catch {}
      if (Date.now() >= deadline) break;
      const base = DEFAULT_BACKOFFS_MS[Math.min(attempt, DEFAULT_BACKOFFS_MS.length - 1)];
      const jitter = Math.floor(Math.random() * Math.min(75, Math.max(1, base)));
      await _asyncSleep(Math.min(Math.max(1, deadline - Date.now()), base + jitter));
      attempt += 1;
      continue;
    }
    try { writeFileSync(fd, `${process.pid} ${Date.now()} ${_OWNER_TOKEN}\n`, 'utf8'); } catch {}
    try {
      // Async ACL enforcement (promisified execFile) so a secret-bearing
      // async holder never blocks the event loop on icacls; identical
      // fail-closed semantics to the sync variant.
      if (opts.secret === true) await _enforceOwnerOnlyAclWin32Async(lockPath);
      return await fn();
    } finally {
      try { closeSync(fd); } catch {}
      try {
        if (_lockOwnedBySelf(lockPath)) unlinkSync(lockPath);
      } catch {}
    }
  }
  const timeoutErr = new Error(`atomic lock timeout after ${timeoutMs}ms: ${lockPath} [${_describeLockHolder(lockPath)}]`);
  timeoutErr.code = 'ELOCKTIMEOUT';
  timeoutErr.cause = lastErr;
  throw timeoutErr;
}

// ── Windows owner-only ACL enforcement (fail-closed) ─────────────────
// POSIX 0o600/0o700 mode bits are advisory-at-best on Windows: NTFS
// ignores them and the file inherits the parent ACL, which in shared or
// roaming-profile setups can be world-readable. For secret-bearing
// writes we MUST lock the file/dir down to the current user only. This
// is invariant-based and fail-closed: if we cannot prove the ACL was
// tightened (icacls missing, SystemRoot unset, user unresolvable, or a
// non-zero exit), we throw so the caller never persists a secret that
// might be left readable by other accounts.

let _cachedUserSid = null;

function _resolveCurrentUserPrincipal() {
  // Prefer the current-user SID to avoid localized account-name parsing
  // (e.g. "Administrators"/"Users" differ per locale). Resolve via
  // `whoami /user` using the deterministic System32 binary path. This is
  // fail-closed: if the SID cannot be proven we throw immediately rather
  // than recovering from a (spoofable) account name.
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) {
    const whoami = join(systemRoot, 'System32', 'whoami.exe');
    if (existsSync(whoami)) {
      try {
        const out = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const m = String(out).match(/S-1-5-[0-9-]+/);
        if (m) return m[0];
      } catch {}
    }
  }
  const err = new Error('cannot resolve current Windows user for owner-only ACL enforcement');
  err.code = 'EACLNOUSER';
  throw err;
}

function _icaclsPrincipal(principal) {
  // icacls takes a raw SID prefixed with '*'; account names pass through.
  return /^S-1-/.test(principal) ? `*${principal}` : principal;
}

function _enforceOwnerOnlyAclWin32(targetPath) {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot) {
    const err = new Error('SystemRoot not set; cannot locate icacls.exe for owner-only ACL enforcement');
    err.code = 'EACLNOROOT';
    throw err;
  }
  // DETERMINISTIC binary path — never rely on PATH lookup for a
  // security-critical tool (PATH could resolve a planted icacls.exe).
  const icacls = join(systemRoot, 'System32', 'icacls.exe');
  if (!existsSync(icacls)) {
    const err = new Error(`icacls.exe not found at ${icacls}; refusing to leave secret world-readable`);
    err.code = 'EACLNOICACLS';
    throw err;
  }
  if (_cachedUserSid === null) _cachedUserSid = _resolveCurrentUserPrincipal();
  const principal = _icaclsPrincipal(_cachedUserSid);
  try {
    // STEP 1 — /reset discards ALL pre-existing EXPLICIT ACEs on the
    // target, restoring it to the parent's inherited-only DACL. Without
    // this, overwriting a previously-permissive file/dir keeps any
    // explicit non-owner ACEs (which /inheritance:r alone does NOT
    // touch — that flag only strips INHERITED ACEs), leaving the secret
    // readable by others. execFileSync throws on a non-zero exit, which
    // is exactly the fail-closed behaviour we want.
    execFileSync(icacls, [targetPath, '/reset'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    // STEP 2 — /inheritance:r strips the now-inherited ACEs left by the
    // reset; /grant:r replaces the principal's ACE so the resulting DACL
    // grants ONLY the current user full control. After both steps no
    // explicit or inherited non-owner ACE survives.
    execFileSync(icacls, [targetPath, '/inheritance:r', '/grant:r', `${principal}:(F)`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    const e = new Error(`icacls failed to apply owner-only ACL to ${targetPath}: ${err?.message || err}`);
    e.code = 'EACLFAIL';
    e.cause = err;
    throw e;
  }
}

// ── Async owner-only ACL enforcement (non-blocking, fail-closed) ─────
// Byte-for-byte the same policy as `_enforceOwnerOnlyAclWin32`, but the two
// icacls invocations (and the one-time whoami SID resolution) run through
// promisified execFile so the event loop is never blocked on a subprocess.
// Shares the `_cachedUserSid` cache with the sync variant, and throws the
// same EACL* codes so callers keep their fail-closed guarantees.
async function _resolveCurrentUserPrincipalAsync() {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) {
    const whoami = join(systemRoot, 'System32', 'whoami.exe');
    if (existsSync(whoami)) {
      try {
        const { stdout } = await _execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        const m = String(stdout).match(/S-1-5-[0-9-]+/);
        if (m) return m[0];
      } catch {}
    }
  }
  const err = new Error('cannot resolve current Windows user for owner-only ACL enforcement');
  err.code = 'EACLNOUSER';
  throw err;
}

async function _enforceOwnerOnlyAclWin32Async(targetPath) {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot) {
    const err = new Error('SystemRoot not set; cannot locate icacls.exe for owner-only ACL enforcement');
    err.code = 'EACLNOROOT';
    throw err;
  }
  const icacls = join(systemRoot, 'System32', 'icacls.exe');
  if (!existsSync(icacls)) {
    const err = new Error(`icacls.exe not found at ${icacls}; refusing to leave secret world-readable`);
    err.code = 'EACLNOICACLS';
    throw err;
  }
  if (_cachedUserSid === null) _cachedUserSid = await _resolveCurrentUserPrincipalAsync();
  const principal = _icaclsPrincipal(_cachedUserSid);
  try {
    await _execFileAsync(icacls, [targetPath, '/reset'], { windowsHide: true });
    await _execFileAsync(icacls, [targetPath, '/inheritance:r', '/grant:r', `${principal}:(F)`], { windowsHide: true });
  } catch (err) {
    const e = new Error(`icacls failed to apply owner-only ACL to ${targetPath}: ${err?.message || err}`);
    e.code = 'EACLFAIL';
    e.cause = err;
    throw e;
  }
}

export function writeFileAtomicSync(filePath, data, opts = {}) {
  const run = () => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const writeOpts = { encoding: opts.encoding || 'utf8', flag: 'wx', mode: opts.mode !== undefined ? opts.mode : 0o600 };
      writeFileSync(tmp, data, writeOpts);
      // Lock the temp down to the current user BEFORE it is published at
      // filePath. On win32 an NTFS rename carries the file's explicit
      // DACL, so tightening tmp here means the secret never appears at
      // the final path with a permissive ACL. Fail-closed: if the ACL
      // cannot be applied, the throw below unlinks tmp and aborts.
      if (opts.secret === true) _enforceOwnerOnlyAclWin32(tmp);
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
      if (opts.secret === true) {
        // Re-assert owner-only on the final path (createOnly's linkSync may
        // not carry the temp DACL the same way a rename does). Throws
        // fail-closed if the ACL cannot be enforced.
        //
        // NOTE: we deliberately do NOT clamp the parent dir. On win32
        // `_enforceOwnerOnlyAclWin32` runs `icacls /inheritance:r /grant:r
        // user:(F)` which is NOT the POSIX-0o700 analogue it looks like —
        // on a directory it breaks inheritance and cascade-strips inherited
        // ACEs from EVERY descendant, leaving the whole tree with empty DACLs and
        // access-denied for everyone, owner included. The file ACL above
        // already protects the secret's contents regardless of dir listing.
        _enforceOwnerOnlyAclWin32(filePath);
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

export function updateJsonAtomicSync(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLockSync(`${filePath}.lock`, () => {
    let cur = null;
    try {
      cur = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      cur = null;
    }
    const next = mutator(cur);
    if (next === undefined) return cur;
    writeJsonAtomicSync(filePath, next, { ...writeOpts, lock: false });
    return next;
  }, opts);
}

// ── Async atomic file write (non-blocking secret ACL) ───────────────
// Mirror of writeFileAtomicSync, but the owner-only ACL enforcement on the
// temp and final path runs through the async icacls variant so a debounced
// timer flush never blocks the event loop on a subprocess. The tiny
// writeFileSync/renameSync of a small JSON payload stay synchronous (they are
// not the hitch); only the icacls calls — the actual blockers — are awaited.
// The truncate renameFallback branch is intentionally omitted: it only ever
// applied to non-secret writes (opts.secret !== true), and every async caller
// here is a secret config write, so behavior is identical.
export async function writeFileAtomicAsync(filePath, data, opts = {}) {
  const run = async () => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(filePath)}.${randomBytes(12).toString('hex')}.tmp`);
    try {
      const writeOpts = { encoding: opts.encoding || 'utf8', flag: 'wx', mode: opts.mode !== undefined ? opts.mode : 0o600 };
      writeFileSync(tmp, data, writeOpts);
      if (opts.secret === true) await _enforceOwnerOnlyAclWin32Async(tmp);
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
        try {
          linkSync(tmp, filePath);
        } catch (err) {
          try { unlinkSync(tmp); } catch {}
          if (err?.code === 'EEXIST') return false;
          throw err;
        }
        try { unlinkSync(tmp); } catch {}
      } else {
        renameWithRetrySync(tmp, filePath, opts);
      }
      if (opts.secret === true) await _enforceOwnerOnlyAclWin32Async(filePath);
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
    return withFileLock(`${filePath}.lock`, run, opts);
  }
  return run();
}

export function writeJsonAtomicAsync(filePath, value, opts = {}) {
  return writeFileAtomicAsync(filePath, JSON.stringify(value, null, opts.compact ? 0 : 2) + '\n', opts);
}

// Async read-modify-write. Same lock path (`${filePath}.lock`) and protocol
// as updateJsonAtomicSync, so it is mutually exclusive with the sync variant.
// The critical section itself is synchronous (readFileSync + writeJsonAtomicSync);
// only the lock WAIT is async, so the event loop is never blocked on contention.
export async function updateJsonAtomic(filePath, mutator, opts = {}) {
  const { lock: _lock, ...writeOpts } = opts;
  return withFileLock(`${filePath}.lock`, () => {
    let cur = null;
    try {
      cur = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      cur = null;
    }
    const next = mutator(cur);
    if (next === undefined) return cur;
    writeJsonAtomicSync(filePath, next, { ...writeOpts, lock: false });
    return next;
  }, opts);
}
