/**
 * dispatch-persist — crash / restart recovery for async dispatch handles.
 *
 * Async dispatch workers can restart while a request is in flight. Any dispatch
 * whose merge callback had not yet
 * run would otherwise be orphaned silently — handle issued, no result, no
 * abort notification.
 *
 * This module persists the minimum needed to recover:
 *   - handle   (`dispatch_<tool>_...`)
 *   - tool     (`recall` / `search`)
 *   - queries  (for the abort message)
 *   - createdAt
 *
 * Remaining public surface: hasPending() probes the spool so the scheduler
 * treats an in-flight dispatch as active. Expired entries are pruned on that
 * read. Writes are best-effort — never let persist IO break the caller.
 */

import fs from 'fs';
import path, { join } from 'path';
import { writeJsonAtomicSync } from '../../shared/atomic-file.mjs';

const TTL_MS = 30 * 60_000;
const FILE_NAME = 'pending-dispatches.json';
// File mode for the on-disk pending-dispatches.json. Matches config/snapshot
// data-at-rest posture: owner-only read/write. The file holds only dispatch
// metadata (handle / tool / queries / createdAt) used to emit a crash-recovery
// Aborted notice — no result bodies are ever persisted.
const PERSIST_FILE_MODE = 0o600;

// Per-dataDir Promise tails — different dataDirs run in parallel.
// Keyed by normalized absolute dataDir path (path.resolve); value is the
// current tail Promise.  Normalization ensures '/data/x/' and '/data/x' route
// to the same tail entry.
const _writeTails = new Map();

// Last successfully written payload per dataDir for exit-drain sync flush.
const _lastPayload = new Map();

// In-progress desired state captured at writeAll entry (before the async write
// completes).  exitDrain prefers this over _lastPayload because it is newer —
// it reflects mutations that queued after the last completed writeAll but
// before process exit.  Cleared once writeAll succeeds.
const _pendingPayload = new Map();

function getTail(dataDir) {
  return _writeTails.get(path.resolve(dataDir)) ?? Promise.resolve();
}

function setTail(dataDir, p) {
  _writeTails.set(path.resolve(dataDir), p);
}

// ── Exit drain: sync-flush in-flight tails on process exit ─────────────────
// Cannot await on exit; use sync writeFileSync to flush the last known payload.
//
// Risk (KEEP): this sync flush bypasses the async cross-process file lock.
// A concurrent writer from another process may race on the same file during
// the drain window.  The window is bounded (process is exiting) and eliminating
// it requires a fundamentally different design (e.g. a dedicated lock-owner
// process).  Best-effort is the correct trade-off here.
function drainDispatchPersist() {
  // Prefer _pendingPayload (desired state captured at writeAll entry) over
  // _lastPayload (last successfully written state).  Pending is strictly
  // newer when a writeAll is still in-flight or queued at process exit.
  const dirs = new Set([..._pendingPayload.keys(), ..._lastPayload.keys()]);
  for (const dataDir of dirs) {
    const payload = _pendingPayload.get(dataDir) ?? _lastPayload.get(dataDir);
    if (!payload) continue;
    try {
      const p = pathFor(dataDir);
      // fsync:false — see writeAll. This file is a best-effort restart-recovery
      // spool; the page cache survives a plugin process restart (the only
      // failure it guards), so we skip the synchronous disk-flush stall. KEEP
      // lock:true: the exit-drain window can still race other processes.
      writeJsonAtomicSync(p, payload, { compact: true, lock: true, mode: PERSIST_FILE_MODE, fsync: false });
    } catch {
      /* best-effort */
    }
  }
}

// Self-registered exit drain; bare 'exit' hook stays as idempotent backup.
process.once('exit', drainDispatchPersist);

// ── Cross-process file lock ─────────────────────────────────────────────────
// Uses O_EXCL (wx flag) on a sibling .lock file so concurrent writers from
// different processes serialize around the same R/M/W on pending-dispatches.json.
// Wait briefly with jittered polling; stale lock files are cleared so a crashed
// writer cannot make every later dispatch persist best-effort-only.
const LOCK_FILE_NAME = 'pending-dispatches.json.lock';
const LOCK_WAIT_MS = 8_000;
const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function lockPath(dataDir) {
  return join(dataDir, LOCK_FILE_NAME);
}

/**
 * Acquire a cross-process file lock. Returns the lock-file path on success
 * so the caller can pass it to releaseFileLock. Returns null if the lock
 * could not be acquired within the timeout; callers then skip this
 * best-effort persist rather than writing unlocked over another process.
 */
async function acquireFileLock(dataDir) {
  const lp = lockPath(dataDir);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      // O_EXCL guarantees atomic create; fails with EEXIST if lock is held.
      const fd = fs.openSync(lp, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${Date.now()}\n`, 0, 'utf8');
      } catch {
        /* best-effort */
      }
      fs.closeSync(fd);
      return lp;
    } catch (err) {
      if (!LOCK_WAIT_CODES.has(err?.code)) {
        process.stderr.write(`[dispatch-persist] lock open error: ${err?.code || err?.message}\n`);
        return null;
      }
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            fs.unlinkSync(lp);
          } catch {
            /* another process won */
          }
          continue;
        }
      } catch {
        /* stat race; retry */
      }
      if (Date.now() >= deadline) {
        process.stderr.write(
          `[dispatch-persist] lock timeout after ${LOCK_WAIT_MS}ms — skipping this best-effort persist\n`
        );
        return null;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS)));
    }
  }
}

function releaseFileLock(lp) {
  if (!lp) return;
  try {
    fs.unlinkSync(lp);
  } catch {
    /* best-effort */
  }
}

// ───────────────────────────────────────────────────────────────────────────

function pathFor(dataDir) {
  return join(dataDir, FILE_NAME);
}

async function writeAll(dataDir, map) {
  try {
    const p = pathFor(dataDir);
    // Capture desired state BEFORE the async write so exitDrain can sync-flush
    // it even if this writeAll is still in-flight at process exit.
    _pendingPayload.set(dataDir, map);
    // fsync:false — pending-dispatches.json is a BEST-EFFORT restart-recovery
    // spool, not durable data. The only event it must survive is a plugin MCP
    // server restart, and the OS page cache already survives that (the bytes
    // are visible to the next process without an fsync). The fsync only buys
    // durability across an OS crash / power loss, which recovery does not rely
    // on — so we skip the synchronous fsyncSync stall on the dispatch hot path.
    // Atomic write-temp + rename ordering is unchanged; only the durability
    // barrier is dropped. Default fsync behaviour is untouched for every other
    // writeJsonAtomicSync caller (session saves, secrets, snapshots).
    writeJsonAtomicSync(p, map, { compact: true, mode: PERSIST_FILE_MODE, fsync: false });
    // Write completed — promote to last-written and clear pending (redundant now).
    _lastPayload.set(dataDir, map);
    _pendingPayload.delete(dataDir);
  } catch {
    /* best-effort */
  }
}

/**
 * Prune expired entries. Returns `{ map, changed }` so callers can decide
 * whether to write the pruned state back to disk. `changed === true` iff
 * at least one entry was deleted (or was present but falsy). hasPending uses
 * it to persist the pruned map so expired entries do not accumulate in
 * pending-dispatches.json across restarts.
 */
function gc(map) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (!v || now - (v.createdAt || 0) > TTL_MS) {
      delete map[k];
      changed = true;
    }
  }
  return { map, changed };
}

/**
 * Best-effort check: is there at least one non-expired in-flight dispatch
 * recorded for this dataDir? Used by the scheduler's idle-state probe so
 * background tasks stay suppressed while an agent dispatch is still
 * running. Never throws.
 */
export function hasPending(dataDir) {
  if (!dataDir) return false;
  try {
    // hasPending is a synchronous probe on the hot path; read without lock is
    // acceptable (observation only). If gc pruned entries, flush asynchronously
    // via per-dataDir tail so the write is still cross-process serialized.
    const p = pathFor(dataDir);
    let raw = '';
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      /* missing = empty */
    }
    let parsed = {};
    try {
      if (raw.trim()) parsed = JSON.parse(raw);
    } catch {
      /* best-effort */
    }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    const { map, changed } = gc(parsed);
    if (changed) {
      const tail = getTail(dataDir).then(async () => {
        const lp = await acquireFileLock(dataDir);
        if (!lp) return;
        try {
          await writeAll(dataDir, map);
        } finally {
          releaseFileLock(lp);
        }
      });
      setTail(dataDir, tail);
    }
    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}
