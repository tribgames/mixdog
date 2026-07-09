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
 *   - tool     (`recall` / `search` / `explore`)
 *   - queries  (for the abort message)
 *   - createdAt
 *
 * On add: write through to disk. On complete/error: remove entry.
 * On bootstrap: read file, emit one abort Noti per surviving entry, clear.
 *
 * Best-effort everywhere — never let persist IO break the caller.
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
export function drainDispatchPersist() {
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
    } catch { /* best-effort */ }
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
const LOCK_WAIT_MS  = 8_000;
const LOCK_POLL_MS  = 50;
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
      try { fs.writeSync(fd, `${process.pid} ${Date.now()}\n`, 0, 'utf8'); } catch { /* best-effort */ }
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
          try { fs.unlinkSync(lp); } catch { /* another process won */ }
          continue;
        }
      } catch { /* stat race; retry */ }
      if (Date.now() >= deadline) {
        process.stderr.write(`[dispatch-persist] lock timeout after ${LOCK_WAIT_MS}ms — skipping this best-effort persist\n`);
        return null;
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS)));
    }
  }
}

function releaseFileLock(lp) {
  if (!lp) return;
  try { fs.unlinkSync(lp); } catch { /* best-effort */ }
}

// ───────────────────────────────────────────────────────────────────────────

function pathFor(dataDir) {
  return join(dataDir, FILE_NAME);
}

async function readAll(dataDir) {
  try {
    const p = pathFor(dataDir);
    try {
      await fs.promises.access(p);
    } catch {
      return {};
    }
    const raw = await fs.promises.readFile(p, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function readAllSync(dataDir) {
  try {
    const p = pathFor(dataDir);
    try {
      fs.accessSync(p);
    } catch {
      return {};
    }
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
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
  } catch { /* best-effort */ }
}

/**
 * Prune expired entries. Returns `{ map, changed }` so callers can decide
 * whether to write the pruned state back to disk. `changed === true` iff
 * at least one entry was deleted (or was present but falsy). addPending
 * always writes regardless, so it does not need the flag; hasPending /
 * recoverPending / removePending use it to persist the pruned map instead
 * of letting expired entries accumulate in pending-dispatches.json across
 * restarts.
 */
function gc(map) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (!v || (now - (v.createdAt || 0)) > TTL_MS) {
      delete map[k];
      changed = true;
    }
  }
  return { map, changed };
}

function normalizeClientHostPid(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function addPending(dataDir, handle, tool, queries, callerSessionId, clientHostPid) {
  if (!dataDir || !handle) return;
  const tail = getTail(dataDir).then(async () => {
    try {
      const lp = await acquireFileLock(dataDir);
      if (!lp) return;
      try {
        const { map } = gc(await readAll(dataDir));
        // Preserve any prior fields (createdAt / caller scoping) so a re-add
        // for the same handle does not reset its recovery metadata.
        const prior = map[handle] && typeof map[handle] === 'object' ? map[handle] : {};
        const sid = callerSessionId != null && String(callerSessionId)
          ? String(callerSessionId)
          : prior.callerSessionId;
        const hostPid = normalizeClientHostPid(clientHostPid) ?? normalizeClientHostPid(prior.clientHostPid);
        map[handle] = {
          ...prior,
          tool,
          queries: Array.isArray(queries) ? queries : [String(queries)],
          createdAt: prior.createdAt || Date.now(),
          ...(sid ? { callerSessionId: sid } : {}),
          ...(hostPid ? { clientHostPid: hostPid } : {}),
        };
        await writeAll(dataDir, map);
        try {
          process.stderr.write(`[dispatch-persist] persist handle=${handle} tool=${tool} entries=${Object.keys(map).length}\n`);
        } catch { /* best-effort */ }
      } finally {
        releaseFileLock(lp);
      }
    } catch { /* best-effort */ }
  });
  setTail(dataDir, tail);
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
    try { raw = fs.readFileSync(p, 'utf8'); } catch { /* missing = empty */ }
    let parsed = {};
    try { if (raw.trim()) parsed = JSON.parse(raw); } catch { /* best-effort */ }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    const { map, changed } = gc(parsed);
    if (changed) {
      const tail = getTail(dataDir).then(async () => {
        const lp = await acquireFileLock(dataDir);
        if (!lp) return;
        try { await writeAll(dataDir, map); } finally { releaseFileLock(lp); }
      });
      setTail(dataDir, tail);
    }
    return Object.keys(map).length > 0;
  } catch {
    return false;
  }
}

export function removePending(dataDir, handle) {
  if (!dataDir || !handle) return;
  const tail = getTail(dataDir).then(async () => {
    try {
      const lp = await acquireFileLock(dataDir);
      if (!lp) return;
      try {
        const { map, changed } = gc(await readAll(dataDir));
        let mutated = changed;
        if (handle in map) {
          delete map[handle];
          mutated = true;
          try {
            process.stderr.write(`[dispatch-persist] ack-pop handle=${handle} entries=${Object.keys(map).length}\n`);
          } catch { /* best-effort */ }
        }
        if (mutated) await writeAll(dataDir, map);
      } finally {
        releaseFileLock(lp);
      }
    } catch { /* best-effort */ }
  });
  setTail(dataDir, tail);
}

/**
 * Called once at plugin bootstrap after the MCP transport is connected.
 * For every pending entry remaining from the previous process lifetime,
 * emit a single Aborted notification with `type: 'dispatch_result'` so the
 * Lead can close the loop on its next turn. Then clear the file.
 *
 * Recovery is chained onto the per-dataDir tail so it serializes with any
 * in-flight addPending / removePending mutations for the same dataDir.
 * Notifications fire asynchronously; the return value is the number of
 * handles queued for recovery (callers use it as bootstrap telemetry).
 */
export function recoverPending(dataDir, notifyFn, { sessionId, priorSessionId, clientHostPid } = {}) {
  if (!dataDir || typeof notifyFn !== 'function') return 0;
  const { map: snapshot } = gc(readAllSync(dataDir));
  const filterSid = sessionId != null && String(sessionId) ? String(sessionId) : null;
  const priorSid = priorSessionId != null && String(priorSessionId) ? String(priorSessionId) : null;
  const filterHostPid = normalizeClientHostPid(clientHostPid);
  const matchesScope = (entry) => {
    if (!filterSid && !filterHostPid) return true;
    const callerSessionId = entry?.callerSessionId;
    const cid = callerSessionId != null && String(callerSessionId) ? String(callerSessionId) : null;
    if (cid && (cid === filterSid || (priorSid != null && cid === priorSid))) return true;
    const entryHostPid = normalizeClientHostPid(entry?.clientHostPid);
    return filterHostPid != null && entryHostPid === filterHostPid;
  };
  const scoped = filterSid || filterHostPid;
  const queued = scoped
    ? Object.keys(snapshot).filter((h) => matchesScope(snapshot[h])).length
    : Object.keys(snapshot).length;
  const tail = getTail(dataDir).then(async () => {
    const lp = await acquireFileLock(dataDir);
    if (!lp) return;
    try {
      const { map, changed } = gc(await readAll(dataDir));
      const handles = Object.keys(map).filter((handle) => {
        return matchesScope(map[handle]);
      });
      if (handles.length === 0) {
        // No handles to recover for this scope. A gc() pass may still have
        // pruned expired entries — persist the pruned `map` (NOT `{}`): under a
        // session-scoped recovery `handles` is only the reconnecting session's
        // subset, so other sessions' still-live pending entries remain in `map`
        // and must survive. (Unscoped recovery reaches here only when `map` is
        // already empty, so writing `map` is equivalent to writing `{}` there.)
        if (changed) await writeAll(dataDir, map);
        return;
      }
      for (const handle of handles) {
        const entry = map[handle] || {};
        const tool = entry.tool || 'dispatch';
        const queries = Array.isArray(entry.queries) ? entry.queries : [];
        // Determine the true owner session for this entry. A scoped recovery
        // may have matched purely on clientHostPid (not on the owner session
        // id); in that case we must NOT stamp the reconnecting filter session's
        // id onto another session's abort — that injects an old-session abort
        // into the wrong resumed session. Deliver to the true owner session, or
        // leave the entry persisted when it carries no owner session to target.
        const cid = entry.callerSessionId != null && String(entry.callerSessionId)
          ? String(entry.callerSessionId)
          : null;
        const ownerMatch = cid != null && (cid === filterSid || (priorSid != null && cid === priorSid));
        if (scoped && !ownerMatch && cid == null) {
          // hostPid-only match with no owner session id — cannot target a
          // session safely. Leave persisted for a correctly-scoped recovery.
          continue;
        }
        // Owner match → prefer the reconnecting filter session id (the owner's
        // new session). When only priorSessionId matched and no current
        // sessionId was supplied, filterSid is null — keep the entry's known
        // owner `cid` for stamping/ack scoping rather than dropping it.
        // Non-owner matches (hostPid-only) always stamp the entry's true owner.
        const stampSid = (ownerMatch && filterSid) ? filterSid : cid;
        // Single recovery mode: the worker was in flight at restart. Emit the
        // Aborted boilerplate so the Lead can retry. Completed result bodies are
        // never persisted, so there is nothing to replay here.
        const qSuffix = queries.length === 1 ? '1 query' : `${queries.length} queries`;
        const content = `[${tool}] Aborted — plugin restart interrupted dispatch (${qSuffix}). Retry if still needed.`;
        const isError = true;
        const meta = {
          type: 'dispatch_result',
          dispatch_id: handle,
          tool,
          error: String(isError),
          ...(stampSid ? { caller_session_id: stampSid } : {}),
          ...(filterHostPid > 0
            ? { client_host_pid: String(filterHostPid) }
            : (entry.clientHostPid > 0 ? { client_host_pid: String(entry.clientHostPid) } : {})),
          instruction: `Earlier ${tool} dispatch (${handle}) was aborted by a plugin restart. Retry if the answer is still needed.`,
        };
        try { process.stderr.write(`[dispatch-persist] recover handle=${handle} tool=${tool} kind=abort\n`); } catch { /* best-effort */ }
        // Entry remains on disk until notifyFn settles as DELIVERED. Matching
        // notifyToolCompletion settlement semantics (tool-execution-contract),
        // only an explicit `false`/`0` resolve counts as undelivered and keeps
        // the entry for retry; any other resolve (including `undefined`/void
        // from a delivered notifyFn) removes it — otherwise it re-fires until
        // TTL. A crash between fire and ack is likewise safe: the entry survives
        // and recoverPending re-fires it on the next restart.
        try {
          Promise.resolve(notifyFn(content, meta)).then((ok) => {
            if (ok !== false && ok !== 0) removePending(dataDir, handle);
          }).catch(() => { /* best-effort — entry stays for next recoverPending */ });
        } catch { /* best-effort */ }
      }
      // Do NOT bulk-clear here.  Each handle is removed individually above,
      // only after its notifyFn acks.  If gc() pruned expired entries, write
      // back the pruned map (without expired keys) — live handles remain on
      // disk until their per-handle removePending calls land.
      if (changed) await writeAll(dataDir, map);
      try {
        process.stderr.write(`[dispatch-persist] recoverPending recovered=${handles.length} entries queued\n`);
      } catch { /* best-effort */ }
    } catch { /* best-effort */ }
    finally { releaseFileLock(lp); }
  });
  setTail(dataDir, tail);
  return queued;
}
