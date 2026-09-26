// transcript-spill/spill-dir.mjs
// Where spilled transcript pages live: a per-process temp directory whose
// name carries the owner pid and a process nonce, an owner registry file that
// tells a PID-reuse successor the directory is not its own, a heartbeat that
// proves the owner is still running, and the sweep that reclaims directories
// of dead or long-silent owners.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 10_000;
const PROCESS_NONCE = randomUUID();
// Exactly the names create() makes: pid, process nonce (a UUID), mkdtemp
// suffix. Other `mixdog-transcript-*` directories (tests, caches, other
// features) are not spill directories and must never be swept.
const SPILL_DIR_NAME = /^mixdog-transcript-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^-]+$/i;

export function cleanupStaleTranscriptSpillDirs({ root = tmpdir(), now = Date.now(), staleMs = STALE_MS } = {}) {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const match = entry.isDirectory() ? SPILL_DIR_NAME.exec(entry.name) : null;
      if (!match) continue;
      const path = join(root, entry.name);
      try {
        const ownerPid = Number(match[1]);
        let pidAlive = false;
        if (ownerPid > 0) {
          try {
            process.kill(ownerPid, 0);
            pidAlive = true;
          } catch {}
        }
        if (!pidAlive) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        // A fresh heartbeat proves the owning process is running. A stale one
        // is ambiguous (suspended owner vs PID reuse), so retain it for the
        // generous staleMs grace period, then reclaim it even if that PID is
        // currently alive. This avoids both short suspension data loss and
        // immortal crash leftovers after PID reuse.
        let heartbeatAge;
        try {
          heartbeatAge = now - statSync(join(path, 'heartbeat')).mtimeMs;
        } catch {
          heartbeatAge = now - statSync(path).mtimeMs;
        }
        if (heartbeatAge <= staleMs) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

/** Publishes this process instance's nonce. Done BEFORE cleanup: if the OS
 *  reused our PID after a crash, the old directory's owner nonce now differs
 *  from the live registry and cannot be mistaken for this process. Throws on
 *  write failure; callers decide whether that is fatal. */
export function writeOwnerRegistry(root = tmpdir()) {
  writeFileSync(
    join(root, `mixdog-transcript-owner-${process.pid}.json`),
    JSON.stringify({ pid: process.pid, nonce: PROCESS_NONCE }),
    'utf8'
  );
}

export function createSpillDirectories() {
  const heartbeatTimers = new Map();

  /** A fresh spill directory with its owner marker and a running heartbeat. */
  function create() {
    const root = tmpdir();
    writeOwnerRegistry(root);
    const directory = mkdtempSync(join(root, `mixdog-transcript-${process.pid}-${PROCESS_NONCE}-`));
    writeFileSync(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: PROCESS_NONCE }), 'utf8');
    const heartbeat = join(directory, 'heartbeat');
    writeFileSync(heartbeat, String(Date.now()), 'utf8');
    const timer = setInterval(() => {
      try {
        writeFileSync(heartbeat, String(Date.now()), 'utf8');
      } catch {}
    }, HEARTBEAT_MS);
    timer.unref?.();
    heartbeatTimers.set(directory, timer);
    return directory;
  }

  /** Stops the heartbeat and removes the directory. */
  function release(directory) {
    if (!directory) return;
    const timer = heartbeatTimers.get(directory);
    if (timer) clearInterval(timer);
    heartbeatTimers.delete(directory);
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
  }

  function stopHeartbeats() {
    for (const timer of heartbeatTimers.values()) clearInterval(timer);
    heartbeatTimers.clear();
  }

  return { create, release, stopHeartbeats };
}
