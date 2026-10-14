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
 *  Takeover never displaces a live holder: the stealer renames exactly the
 *  token dir it judged stale (a holder that took the lock since has another
 *  token, so the rename fails and the stealer re-evaluates), and lockDir
 *  itself only ever goes through rmdir, which refuses a dir a new holder has
 *  entered. A creator that stalled and meets another token dir next to its
 *  own backs off. Only a tombstone this process renamed is deleted. */
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
/** Move a token dir out of the lock; true when this call moved it, so the
 *  caller owns the tombstone (and nobody else's lock was touched). The holder
 *  itself retries a refused rename (a reader's open handle on Windows);
 *  only a missing dir means someone else moved it. */
function buryLockToken(lockDir, token, kind, retries = 0) {
  const grave = path.join(path.dirname(lockDir), path.basename(lockDir) + '-' + kind + '-' + token + '-' + crypto.randomBytes(4).toString('hex'));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(path.join(lockDir, token), grave);
      break;
    } catch (error) {
      if (error.code === 'ENOENT' || attempt >= retries) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  removeTree(grave);
  return true;
}
/** rmdir lockDir if empty: a lock a holder has entered is never removed.
 *  True when this call removed it. */
function dropEmptyLock(lockDir, retries = 0) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmdirSync(lockDir);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || attempt >= retries) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
/** Take over the lock judged stale in 'holder' (from inspectInstallLock).
 *  Any mismatch leaves the lock as it is (false) and the caller re-evaluates. */
function stealInstallLock(lockDir, holder) {
  const buried = Boolean(holder.token) && buryLockToken(lockDir, holder.token, 'stale');
  if (holder.token && !buried) return false;
  // Empty now; rmdir refuses a lock a new holder has entered meanwhile.
  return dropEmptyLock(lockDir) || buried;
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
          const release = () => {
            if (released) return;
            released = true;
            process.removeListener('exit', release);
            // Taken over as stale: nothing of this holder is left to remove.
            if (buryLockToken(lockDir, token, 'done', 250)) dropEmptyLock(lockDir, 250);
          };
          process.on('exit', release);
          return { owner, release };
        }
        // Another holder entered while this creator stalled: the later one backs off.
        if (buryLockToken(lockDir, token, 'done', 250)) dropEmptyLock(lockDir, 250);
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
