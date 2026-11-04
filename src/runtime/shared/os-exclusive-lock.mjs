// An exclusive lock on one file that the operating system holds for this
// process, never renewed and never lost to a clock. The kernel drops it however
// the process ends (exit, crash, SIGKILL, TerminateProcess), so the next
// process acquires it at once: nothing guesses whether a holder is alive and
// nothing is ever taken over. It belongs to the process, not to a thread: a
// Windows mutex would be abandoned with the thread that took it.
//
// Nothing else the process does may release it, and Mixdog hosts tools
// (Read, search, backups) that may open any file in the data dir. A POSIX
// record lock (fcntl — what SQLite takes on macOS and Linux) is dropped when
// the process closes ANY descriptor of the file: one readFileSync of it would
// hand the lock to the next process. So each platform takes a lock no other
// descriptor can release:
// - Windows: an exclusive SQLite transaction on the lock file. LockFileEx
//   locks belong to the handle that took them; other handles opened and
//   closed on the file leave them in place.
// - Linux: an abstract-namespace Unix socket bound for as long as the lock is
//   held. The bind is exclusive and the kernel unbinds it with the process; it
//   is no file, so no other descriptor can touch it. Its name is derived from
//   the identity (device, inode) of the lock file: every spelling of a path
//   (symlink, bind mount) names one file, a copy elsewhere is another. (Node
//   exposes no flock, its SQLite builds the flock VFS only for Apple, and
//   Linux has no lock-at-open.) Abstract names are listed to every local user
//   in /proc/net/unix, so no name can be kept secret: a user binding it first
//   can only keep the lock from being taken, never take part in it.
// - macOS and the BSDs: the lock file opened with O_EXLOCK, an flock lock owned
//   by that open file description, which closing other descriptors leaves.
//
// Every step is synchronous (the SQLite module is loaded with
// process.getBuiltinModule, a pipe bind happens inside listen()), so a caller
// on a synchronous path can take the lock where it stands.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';

const SQLITE_BUSY = 5;
// <fcntl.h> on Darwin and the BSDs; Node does not export it.
const O_EXLOCK = 0x20;

// Node 22 flags node:sqlite experimental and prints a warning to stderr when
// it loads; that one warning is kept out of the process's stderr.
let sqlite = null;
function loadSqlite() {
  if (sqlite) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    sqlite = process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
}

function lockBusy(error) {
  return (Number(error?.errcode) & 0xff) === SQLITE_BUSY;
}

function sameFile(a, b) {
  return Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;
}

function heldLock(lockPath, identity, close) {
  return {
    held: true,
    path: lockPath,
    /** False once the lock file was deleted or replaced at its path: a process
     *  acquiring now would lock (or name) a different one. */
    intact() {
      try {
        return sameFile(statSync(lockPath, { bigint: true, throwIfNoEntry: false }), identity);
      } catch {
        // Unreadable metadata (an antivirus scan) is not a replacement.
        return true;
      }
    },
    release() {
      try {
        close();
      } catch {}
    },
  };
}

function acquireSqliteLock(lockPath) {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(lockPath);
  try {
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    if (lockBusy(error)) return { held: false };
    throw error;
  }
  return heldLock(lockPath, statSync(lockPath, { bigint: true }), () => db.close());
}

/** The lock file's identity, creating the file when missing (O_CREAT without
 *  O_EXCL: racing processes all open the one file the first of them created). */
function lockFileIdentity(lockPath) {
  const fd = openSync(lockPath, constants.O_RDONLY | constants.O_CREAT, 0o600);
  try {
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}

function acquireAbstractSocketLock(lockPath, namespace) {
  const identity = lockFileIdentity(lockPath);
  const digest = createHash('sha256').update(`${identity.dev}:${identity.ino}`).digest('hex');
  const name = `\0mixdog-${namespace}-${digest.slice(0, 48)}`;
  // Nothing is served: a connection is the probe of a curious process.
  const server = net.createServer((socket) => socket.destroy());
  // A refused bind is also emitted on the next tick; `listening` below has
  // already answered it.
  server.on('error', () => {});
  server.listen(name);
  if (!server.listening) return { held: false };
  // Never what keeps the process alive.
  server.unref();
  return heldLock(lockPath, identity, () => server.close());
}

function acquireFlockLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o600);
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') return { held: false };
    throw error;
  }
  return heldLock(lockPath, fstatSync(fd, { bigint: true }), () => closeSync(fd));
}

/**
 * Takes the lock on `lockPath` without waiting: `{ held: false }` while another
 * holder (another process, or another handle of this one) has it, else
 * `{ held: true, path, intact(), release() }`. Any other failure (an unwritable
 * directory) is thrown. `namespace` names the Linux socket family
 * (`\0mixdog-<namespace>-<digest>`). The handle must stay referenced for as
 * long as the lock is meant to be held: a collected connection or server is
 * closed.
 */
export function acquireOsExclusiveLockSync(lockPath, { namespace = 'lock' } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (process.platform === 'win32') return acquireSqliteLock(lockPath);
  if (process.platform === 'linux' || process.platform === 'android') {
    return acquireAbstractSocketLock(lockPath, namespace);
  }
  return acquireFlockLock(lockPath);
}

/** acquireOsExclusiveLockSync for callers on an async path. */
export async function acquireOsExclusiveLock(lockPath, options) {
  return acquireOsExclusiveLockSync(lockPath, options);
}

/** Whether a live holder has the lock: asked of the lock itself, taken and
 *  released at once when free. */
export async function osExclusiveLockHeld(lockPath, options) {
  const lock = acquireOsExclusiveLockSync(lockPath, options);
  if (!lock.held) return true;
  lock.release();
  return false;
}
