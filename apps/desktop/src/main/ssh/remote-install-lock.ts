// The server-wide install lock, as server program source (see
// remote-install-program.ts). One atomic `mkdir` under ~/.mixdog-remote
// serialises upload, install, daemon replacement, GC and cleanup across every
// desktop and window that talks to this account.

/** How long an ensure run waits for another holder before `install-locked`. */
export const REMOTE_INSTALL_LOCK_WAIT_MS = 240_000;
/** A holder older than this is presumed crashed even if its pid looks alive
 *  (pid reuse, or a holder on another host sharing an NFS home). */
export const REMOTE_INSTALL_LOCK_STALE_MS = 15 * 60_000;

/** Defines acquireInstallLock(lockDir, options) → { owner, release() }.
 *
 *  Layout: the holder creates lockDir (the atomic mkdir), then its own
 *  token dir lockDir/<token>/ holding owner.json. A lock is stale when its
 *  owner pid on this host is dead or it is older than `staleMs`.
 *
 *  Takeover never displaces a live holder: the stealer deletes exactly the
 *  token dir it judged stale (a holder that took the lock since has another
 *  token, so the stealer finds nothing to delete and re-evaluates), and
 *  lockDir itself only ever goes through rmdir, which refuses a dir a new
 *  holder has entered. A creator that stalled and meets another token dir
 *  next to its own backs off.
 *
 *  Token dirs are deleted in place, never renamed away: Windows refuses to
 *  rename a directory while any process has a file in it open, so waiters
 *  reading owner.json kept a holder's release failing for seconds and starved
 *  each other. Deleting the file and then the empty dir is not blocked by
 *  those readers. */
export const REMOTE_LOCK_SOURCE = `
const LOCK_TOKEN = /^[0-9a-f]{24}$/;
/** Token dirs inside lockDir, or null when lockDir does not exist. */
function lockHolders(lockDir) {
  try { return fs.readdirSync(lockDir).filter((name) => LOCK_TOKEN.test(name)).sort(); } catch (error) { return error.code === 'ENOENT' ? null : []; }
}
function inspectInstallLock(lockDir, staleMs) {
  const holders = lockHolders(lockDir);
  if (holders === null) return { gone: true, stale: false, token: null, owner: null };
  if (holders.length === 0) {
    // Created this instant (the token dir follows the mkdir), or its creator
    // died in between.
    let since = Date.now();
    try { since = fs.statSync(lockDir).mtimeMs; } catch { return { gone: true, stale: false, token: null, owner: null }; }
    return { gone: false, stale: Date.now() - since > 30000, token: null, owner: null };
  }
  const token = holders[0];
  let since = 0;
  try { since = fs.statSync(path.join(lockDir, token)).mtimeMs; } catch { return { gone: false, stale: false, token: null, owner: null }; }
  const owner = readJson(path.join(lockDir, token, 'owner.json'));
  if (owner && Number(owner.startedAt) > 0) since = Number(owner.startedAt);
  const age = Date.now() - since;
  // owner.json lands right after the token dir: one still without it is
  // being written this instant or was abandoned mid-creation.
  if (!owner) return { gone: false, stale: age > 30000, token, owner: null };
  const deadOwner = owner.host === os.hostname() && !alive(Number(owner.pid));
  return { gone: false, stale: deadOwner || age > staleMs, token, owner };
}
/** Delete one token dir from the lock, touching only that token's files:
 *  'removed' by this call, 'gone' when someone else removed it, 'busy' when
 *  every attempt was refused (a Windows without POSIX delete semantics while
 *  a reader has owner.json open). */
function removeLockToken(lockDir, token, retries = 0) {
  const dir = path.join(lockDir, token);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(path.join(dir, 'owner.json'), { force: true });
      fs.rmdirSync(dir);
      return 'removed';
    } catch (error) {
      if (error.code === 'ENOENT') return 'gone';
      if (attempt >= retries) return 'busy';
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
/** rmdir lockDir if empty: a lock a holder has entered is never removed.
 *  'removed' by this call, 'kept' when it is gone or entered, 'busy' when
 *  every attempt was refused. */
function dropEmptyLock(lockDir, retries = 0) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmdirSync(lockDir);
      return 'removed';
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return 'kept';
      if (attempt >= retries) return 'busy';
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
/** Take over the lock judged stale in 'holder' (from inspectInstallLock).
 *  Any mismatch leaves the lock as it is (false) and the caller re-evaluates. */
function stealInstallLock(lockDir, holder) {
  const removed = Boolean(holder.token) && removeLockToken(lockDir, holder.token) === 'removed';
  if (holder.token && !removed) return false;
  // Empty now; rmdir refuses a lock a new holder has entered meanwhile.
  return dropEmptyLock(lockDir) === 'removed' || removed;
}
function describeLockOwner(owner) {
  if (!owner) return 'owner unknown';
  const parts = ['pid ' + owner.pid + ' on ' + owner.host];
  if (owner.purpose) parts.push(owner.purpose);
  if (Number(owner.startedAt) > 0) parts.push('since ' + new Date(Number(owner.startedAt)).toISOString());
  return parts.join(', ');
}
async function acquireInstallLock(lockDir, options) {
  const waitMs = Math.max(0, Number(options.waitMs) || 0);
  const staleMs = Number(options.staleMs) || 900000;
  const pollMs = Number(options.pollMs) || 500;
  const token = crypto.randomBytes(12).toString('hex');
  const owner = { token, pid: process.pid, host: os.hostname(), purpose: String(options.purpose || ''), startedAt: Date.now() };
  const mine = path.join(lockDir, token);
  const waitStarted = Date.now();
  // A dir being deleted on Windows (desktop unit tests) refuses mkdir with EPERM.
  const contended = (error) => error.code === 'EEXIST' || (process.platform === 'win32' && error.code === 'EPERM');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lockDir);
      created = true;
    } catch (error) {
      if (!contended(error)) fail('install-failed', 'Cannot create the install lock ' + lockDir + ': ' + error.message);
    }
    if (created) {
      let entered = false;
      try {
        fs.mkdirSync(mine);
        entered = true;
      } catch (error) {
        // lockDir went away (judged abandoned while this creator stalled): retry.
        if (error.code !== 'ENOENT' && !contended(error)) fail('install-failed', 'Cannot create the install lock ' + lockDir + ': ' + error.message);
      }
      if (entered) {
        fs.writeFileSync(path.join(mine, 'owner.json'), JSON.stringify(owner));
        const holders = lockHolders(lockDir) || [];
        if (holders.length === 1 && holders[0] === token) {
          let released = false;
          let tokenSettled = false;
          let rootPending = false;
          const release = () => {
            if (released) return;
            // Released only once the cleanup finished: a refused delete leaves
            // the exit hook (or a later call) to try again from that step.
            if (!tokenSettled) {
              const own = removeLockToken(lockDir, token, 250);
              if (own === 'busy') return;
              tokenSettled = true;
              // 'gone': taken over as stale, so the root is no longer this holder's to drop.
              rootPending = own === 'removed';
            }
            // 'kept' (a successor entered, or the root is gone) also ends the release.
            if (rootPending && dropEmptyLock(lockDir, 250) === 'busy') return;
            released = true;
            process.removeListener('exit', release);
          };
          process.on('exit', release);
          return { owner, release };
        }
        // Another holder entered while this creator stalled: the later one backs off.
        if (removeLockToken(lockDir, token, 250) === 'removed') dropEmptyLock(lockDir, 250);
      }
      await sleep(Math.min(pollMs, 20 + Math.floor(Math.random() * 30)));
      continue;
    }
    const holder = inspectInstallLock(lockDir, staleMs);
    if (holder.gone) continue;
    // A takeover that found the lock changed falls through to the wait.
    if (holder.stale && stealInstallLock(lockDir, holder)) continue;
    if (Date.now() - waitStarted >= waitMs) {
      fail('install-locked', 'Another Mixdog install on the server holds ' + lockDir + ' (' + describeLockOwner(holder.owner) + '). Try again when it has finished.');
    }
    await sleep(pollMs);
  }
}
`;
