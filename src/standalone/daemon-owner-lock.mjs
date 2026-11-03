// The daemon's ownership of a data dir: an OS-held lock kept for the whole
// life of the process, never renewed and never lost to a clock. The kernel
// drops it however the process ends (exit, crash, SIGKILL, TerminateProcess),
// so the next daemon acquires it at once. It belongs to the process, not to a
// thread: a Windows mutex would be abandoned with the thread that took it.
//
// Nothing else the process does may release it, and the daemon hosts tools
// (Read, search, backups) that may open any file in the data dir. A POSIX
// record lock (fcntl — what SQLite takes on macOS and Linux) is dropped when
// the process closes ANY descriptor of the file: one readFileSync of it handed
// the lock to the next daemon. So each platform takes a lock no other
// descriptor can release:
// - Windows: an exclusive SQLite transaction on the lock file. LockFileEx
//   locks belong to the handle that took them; other handles opened and
//   closed on the file leave them in place.
// - Linux: an abstract-namespace Unix socket bound for the process lifetime.
//   The bind is exclusive and the kernel unbinds it with the process; it is no
//   file, so no other descriptor can touch it. Its name is derived from the
//   uid, the data dir's canonical path and a random secret in the
//   (owner-only) lock file: unique to this data dir, and not computable by
//   another local user to squat it. (Node's SQLite builds the flock VFS only
//   for Apple, and Linux has no lock-at-open.)
// - macOS and the BSDs: the lock file opened with O_EXLOCK, an flock lock owned
//   by that open file description, which closing other descriptors leaves.
//
// Daemons on one data dir run one platform, so the three never meet. The lock
// file is created once and, once valid, never rewritten or unlinked: one deleted or
// replaced while held would let a new daemon lock (or name) another, so
// `intact()` compares the identity at its path with the file locked.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';

const SQLITE_BUSY = 5;
// <fcntl.h> on Darwin and the BSDs; Node does not export it.
const O_EXLOCK = 0x20;

// Node 22 flags node:sqlite experimental and prints a warning to stderr when
// it loads — the launcher's crash capture of every candidate otherwise. The
// daemon's other SQLite users run it in workers started without the warning;
// this one must hold its connection on the main thread.
let sqlite = null;
async function loadSqlite() {
  if (sqlite) return sqlite;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    sqlite = await import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
  return sqlite;
}

export function daemonOwnerLockPath(dataDir) {
  return join(dataDir, 'daemon-owner.lock');
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
    /** False once the lock file was deleted or replaced at its path: a daemon
     *  starting now would lock (or name) a different one. */
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

async function acquireSqliteLock(lockPath) {
  const { DatabaseSync } = await loadSqlite();
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

const SECRET_RE = /^[0-9a-f]{64}$/;

/** The lock file's secret and identity, or null while it is missing or holds
 *  no valid secret (an empty file earlier builds left, a truncated copy). */
function readLockSecret(lockPath) {
  let fd = null;
  try {
    fd = openSync(lockPath, 'r');
    const secret = readFileSync(fd, 'utf8');
    return SECRET_RE.test(secret) ? { secret, identity: fstatSync(fd, { bigint: true }) } : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The lock file's secret, creating or replacing it when needed. A valid
 * secret is never rewritten, so a daemon that read one agrees with every
 * other. Creating or replacing one happens only under the init lock — an
 * exclusive SQLite transaction on a side file, waited for — and re-reads
 * first, so racing daemons all end up with the one secret published. The
 * secret is written whole to a draft, then linked (absent) or renamed (an
 * invalid file) into place: no reader ever sees a partial one. (The init
 * lock is an fcntl lock other descriptors could drop, but it is held only for
 * these few milliseconds of boot, before any tool runs.)
 */
async function lockSecret(lockPath) {
  const current = readLockSecret(lockPath);
  if (current) return current;
  const { DatabaseSync } = await loadSqlite();
  const init = new DatabaseSync(`${lockPath}.init`);
  try {
    init.exec('PRAGMA busy_timeout = 10000; BEGIN EXCLUSIVE;');
    const settled = readLockSecret(lockPath);
    if (settled) return settled;
    const draft = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(draft, randomBytes(32).toString('hex'), { mode: 0o600 });
    try {
      if (statSync(lockPath, { throwIfNoEntry: false })) renameSync(draft, lockPath);
      else linkSync(draft, lockPath);
    } finally {
      rmSync(draft, { force: true });
    }
    const published = readLockSecret(lockPath);
    if (!published) throw new Error(`owner lock secret ${lockPath} did not publish`);
    return published;
  } finally {
    init.close();
  }
}

/** The abstract name: this user, this data dir (its canonical path, so every
 *  spelling of it agrees), this secret. Another data dir — or another user,
 *  or a copied lock file elsewhere — never shares it. */
function abstractLockName(lockPath, secret) {
  const canonical = join(realpathSync(dirname(lockPath)), basename(lockPath));
  const identity = `${process.getuid?.() ?? ''}\0${canonical}\0${secret}`;
  return `\0mixdog-daemon-owner-${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
}

async function acquireAbstractSocketLock(lockPath) {
  const { secret, identity } = await lockSecret(lockPath);
  const name = abstractLockName(lockPath, secret);
  // Nothing is served: a connection is the probe of a curious process.
  const server = net.createServer((socket) => socket.destroy());
  const bound = await new Promise((resolve, reject) => {
    server.once('error', (error) => (error?.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
    server.listen(name, () => resolve(true));
  });
  if (!bound) return { held: false };
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
 * Takes the lock without waiting: `{ held: false }` while another live process
 * holds it, else the holder's handle. Any other failure (an unwritable data
 * dir) is thrown. The handle must stay referenced for as long as the lock is
 * meant to be held: a collected connection or server is closed.
 */
export async function acquireDaemonOwnerLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (process.platform === 'win32') return acquireSqliteLock(lockPath);
  if (process.platform === 'linux' || process.platform === 'android') return acquireAbstractSocketLock(lockPath);
  return acquireFlockLock(lockPath);
}
