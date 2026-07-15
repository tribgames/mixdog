const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

/**
 * supervisor-pg — PG child process lifecycle wired into the mixdog supervisor.
 *
 * Public API:
 *   ensurePgInstance(dataDir) → Promise<{ host, port, runtimeDir, pgdataDir }>
 *   stopPgForShutdown()       → Promise<void>  — call from server-main.mjs shutdown()
 *
 * Depends on Track A's pg-process.mjs for startPg / stopPg / healthcheckPg.
 * Lazy-imported so this module loads cleanly before Track A lands.
 *
 * active-instance.json additions:
 *   pg_port?        number  — TCP port PG is listening on
 *   pg_started_at?  number  — epoch ms when PG was last started
 *   pg_pgdata?      string  — absolute path to the pgdata directory
 *   pg_runtime_dir? string  — absolute path to the pg runtime binaries dir
 */

import { createServer }                       from 'node:net';
import {
  unlinkSync, readFileSync, writeFileSync,
  renameSync, statSync, mkdirSync,
}                                             from 'node:fs';
import { join, resolve }                      from 'node:path';
import { tmpdir }                             from 'node:os';
import {
  discoveryPath as _pgDiscoveryPath,
  readServiceAdvert as _readPgServiceAdvert,
  writeServiceAdvert as _writePgServiceAdvert,
} from '../../../shared/service-discovery.mjs';
import { withFileLockSync } from '../../../shared/atomic-file.mjs';

// ── pg-process interface (Track A) ───────────────────────────────────────────
// Dynamic import so this module loads even before Track A's file exists.
let _pgProc = null;
async function _getPgProc() {
  if (_pgProc) return _pgProc;
  // import.meta.url is in src/memory/lib/pg/ — process.mjs lives alongside.
  const mod = await import('./process.mjs');
  _pgProc = {
    startPg:          mod.startPg,
    stopPg:           mod.stopPg,
    healthcheckPg:    mod.healthcheckPg,
    reconcileConfV2:  mod.reconcileConfV2,
    stopPgSync:       mod.stopPgSync,
  };
  return _pgProc;
}

// ── In-process state ─────────────────────────────────────────────────────────
/** @type {{ port: number, pgdata: string, runtimeDir: string, proc: unknown } | null} */
let _live = null;
/** Dedup: one ensure coroutine at a time. */
let _ensureInFlight = null;
/** Per-process flag — postgresql.conf reconcile attempted once per supervisor. */
let _v2ReconcileTried = false;

// ── Constants ────────────────────────────────────────────────────────────────
const PG_PORT_MIN      = 55432;
const PG_PORT_MAX      = 55632;
const PG_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SPAWN_LOCK_NAME  = 'pg-spawn.lock';
const LOCK_WAIT_MS     = 30_000;
const LOCK_POLL_MS     = 100;
const LOCK_WARN_MS     = 5_000;
const LOCK_WAIT_CODES  = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function envFlagEnabled(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

function attachOnlyMode() {
  return envFlagEnabled('MIXDOG_PG_ATTACH_ONLY') || envFlagEnabled('MIXDOG_MEMORY_SECONDARY');
}

// ── File lock (O_EXCL pattern from dispatch-persist.mjs / run-mcp.mjs) ───────

/**
 * Acquire `${dataDir}/pg-spawn.lock`.
 * Returns the lock-file path on success, or null on timeout (caller proceeds
 * best-effort — worst case: two supervisors race initdb on the same pgdata,
 * but the second will fail pg_ctl start gracefully and healthcheck will
 * converge on the first's port).
 */
async function acquireSpawnLock(dataDir, blockedProbe = null) {
  const lp       = join(dataDir, SPAWN_LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const body     = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  let warned = false;
  for (;;) {
    try {
      // 'wx' = O_CREAT | O_EXCL — atomic, fails with EEXIST if held.
      writeFileSync(lp, body, { flag: 'wx' });
      return { lockPath: lp, reuse: null };
    } catch (err) {
      if (!LOCK_WAIT_CODES.has(err?.code)) {
        __mixdogMemoryLog(`[supervisor-pg] spawn lock error: ${err?.code || err?.message}\n`);
        return { lockPath: null, reuse: null };
      }
      if (blockedProbe) {
        try {
          const reuse = await blockedProbe();
          if (reuse) return { lockPath: null, reuse };
        } catch {}
      }
      // Dead-holder detection: same as run-mcp.mjs acquireLock().
      try {
        const holder = JSON.parse(readFileSync(lp, 'utf8'));
        if (holder?.pid) {
          try { process.kill(holder.pid, 0); }
          catch (ke) {
            if (ke.code === 'ESRCH') {
              try { unlinkSync(lp); } catch {}
              continue; // retry immediately after removing stale lock
            }
          }
        }
        const ageMs = Date.now() - Number(holder?.startedAt || 0);
        if (!warned && ageMs >= LOCK_WARN_MS) {
          warned = true;
          __mixdogMemoryLog(`[supervisor-pg] waiting for spawn lock holder pid=${holder?.pid || 'unknown'} ageMs=${ageMs}\n`);
        }
      } catch { /* unreadable — fall through and wait */ }
      if (Date.now() >= deadline) {
        if (blockedProbe) {
          try {
            const reuse = await blockedProbe();
            if (reuse) return { lockPath: null, reuse };
          } catch {}
        }
        throw new Error(`[supervisor-pg] spawn-lock acquire timeout (concurrent supervisor risk)`);
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }
  }
}

function releaseSpawnLock(lp) {
  if (!lp) return;
  try { unlinkSync(lp); } catch {}
}

// ── Port allocation ──────────────────────────────────────────────────────────

function _probePort(port) {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function allocatePort() {
  for (let p = PG_PORT_MIN; p <= PG_PORT_MAX; p++) {
    if (await _probePort(p)) return p;
  }
  throw new Error(`[supervisor-pg] no free TCP port in range ${PG_PORT_MIN}–${PG_PORT_MAX}`);
}

// ── Log rotation ─────────────────────────────────────────────────────────────
// Keep at most 1 archive (pg.log.1). Rotate at PG_LOG_MAX_BYTES.

function rotateLogIfNeeded(logPath) {
  try {
    const st = statSync(logPath);
    if (st.size > PG_LOG_MAX_BYTES) {
      const archive = logPath + '.1';
      try { unlinkSync(archive); } catch {}
      renameSync(logPath, archive);
    }
  } catch { /* log does not exist yet — nothing to rotate */ }
}

// ── active-instance.json patch ───────────────────────────────────────────────
// Atomic read-modify-write using the same tmp+rename pattern as server.mjs.
// Lives in MIXDOG_RUNTIME_ROOT or os.tmpdir()/mixdog/
// (see src/channels/lib/runtime-paths.mjs).

const _RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : join(tmpdir(), 'mixdog');
const _ACTIVE_FILE = join(_RUNTIME_ROOT, 'active-instance.json');
// Single-writer PG advert. Port discovery (pg_port et al.) moved OUT of the
// shared, lock-guarded active-instance.json into discovery/pg.json, written by
// this supervisor via a plain atomic rename (NO .lock) so it can never be
// starved by active-instance lock contention.
const _PG_DISCOVERY = 'pg';

// Read the PG advert, preferring the single-writer discovery file
// (discovery/pg.json) and falling back to the legacy active-instance.json pg_*
// fields for cross-version compat. Field names are identical in both sources.
function _readPgAdvert() {
  const advert = _readPgServiceAdvert(_PG_DISCOVERY);
  if (advert && Number(advert.pg_port) > 0) return advert;
  try {
    const ai = JSON.parse(readFileSync(_ACTIVE_FILE, 'utf8'));
    if (ai && Number(ai.pg_port) > 0) return ai;
  } catch {}
  return advert ?? null;
}

// Transient write-contention codes. ELOCK* survive from the old locked path;
// EPERM/EBUSY/EACCES cover Windows atomic-rename hiccups on the plain-rename
// discovery write so it backs off and retries rather than dropping the advert.
const _LOCK_CONTENTION_CODES = new Set(['ELOCKTIMEOUT', 'ELOCKCONTENDED', 'EPERM', 'EBUSY', 'EACCES']);

// Is the current on-disk advert owned by a DIFFERENT, still-live supervisor?
// A clear (pg_port → null) must never unlink a NEWER supervisor's fresh advert:
// re-read under the lock and, if pg_owner_pid names another live process, leave
// it. Our own pid, a dead owner, or a missing/legacy owner → safe to unlink.
function _pgAdvertIsForeignLive(adv) {
  const owner = Number(adv?.pg_owner_pid);
  if (!Number.isInteger(owner) || owner <= 0) return false;
  if (owner === process.pid) return false;
  return isPidAlive(owner);
}

function _applyActiveInstancePatch(fields, timeoutMs) {
  // pg.json is NOT single-writer: start/attach/stop paths write it across
  // separate supervisor processes, so the unlocked read-merge-write raced and
  // lost cross-process updates. Guard it with pg.json's OWN private lock —
  // supervisor-only contention, so it never recreates the shared
  // active-instance.json bottleneck (memory.json stays lock-free).
  const file = _pgDiscoveryPath(_PG_DISCOVERY);
  withFileLockSync(`${file}.lock`, () => {
    const cur = _readPgServiceAdvert(_PG_DISCOVERY) ?? {};
    // Drop stale fields (pid/startedAt/updatedAt) written by older versions.
    const { pid: _legacyPid, startedAt: _legacyStartedAt, updatedAt: _prevUpdatedAt, ...merged } = cur;
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) delete merged[k];
      else merged[k] = v;
    }
    const port = Number(merged.pg_port);
    if (!Number.isInteger(port) || port <= 0) {
      // No live port left → drop the advert (clean pg shutdown). But a late
      // clear from an old shutdown/recovery path must NOT delete a fresh advert
      // a newer supervisor just published — unlink only when it is ours or a
      // dead corpse, never another live owner's.
      if (_pgAdvertIsForeignLive(cur)) return;
      try { unlinkSync(file); } catch {}
      return;
    }
    // Stamp our supervisor pid so a later clear can prove advert ownership.
    merged.pg_owner_pid = process.pid;
    _writePgServiceAdvert(_PG_DISCOVERY, merged);
  }, { timeoutMs });
}

// Re-stamp advert ownership on REUSE without clobbering a concurrently-updated
// advert. Unlike patchActiveInstance (which blindly overwrites pg_port/pg_pgdata
// /pg_runtime_dir from the reuse-time snapshot — already stale by the time the
// lock is acquired, so a restart or a different live owner that landed meanwhile
// gets clobbered), this RE-READS under the lock and only stamps our pid when the
// advert STILL describes the same instance we reused (same pgdata + port) and no
// DIFFERENT live owner has since taken it. It touches only pg_owner_pid — never
// rewriting other fields from the stale snapshot.
function _restampReuseOwner({ pgdata, port }) {
  const file = _pgDiscoveryPath(_PG_DISCOVERY);
  try {
    withFileLockSync(`${file}.lock`, () => {
      const cur = _readPgServiceAdvert(_PG_DISCOVERY);
      if (!cur) return;                                   // advert gone — nothing to re-stamp
      if (Number(cur.pg_port) !== Number(port)) return;   // restarted on a new port
      if (!cur.pg_pgdata || resolve(cur.pg_pgdata) !== resolve(pgdata)) return; // different instance
      if (_pgAdvertIsForeignLive(cur)) return;            // a different live owner holds it
      if (Number(cur.pg_owner_pid) === process.pid) return; // already ours
      const { pid: _legacyPid, startedAt: _legacyStartedAt, updatedAt: _prevUpdatedAt, ...merged } = cur;
      merged.pg_owner_pid = process.pid;                  // minimal: owner pid only (updatedAt re-stamped on write)
      _writePgServiceAdvert(_PG_DISCOVERY, merged);
    }, { timeoutMs: 1000 });
  } catch { /* best-effort: lock contention → skip re-stamp (guard reverts to prior owner) */ }
}

// Single module-level background-retry slot: a delayed retry must NEVER replay
// stale `fields` over newer state (e.g. a stale clear deleting a fresh pg_port,
// or a stale start resurrecting pg_port after shutdown). Every patch bumps the
// generation and cancels any pending chain, so only the newest fields replay.
let _patchGeneration = 0;
let _pendingPatchRetry = null; // { timer, generation }

function _cancelPendingPatchRetry() {
  if (_pendingPatchRetry) {
    try { clearTimeout(_pendingPatchRetry.timer); } catch {}
    _pendingPatchRetry = null;
  }
}

function _tryPatchInBackground(fields, timeoutMs, generation, attempt) {
  // A newer patch has superseded this chain — abandon (last write wins).
  if (generation !== _patchGeneration) return;
  try {
    _applyActiveInstancePatch(fields, timeoutMs);
    if (_pendingPatchRetry?.generation === generation) _pendingPatchRetry = null;
  } catch (e) {
    if (_LOCK_CONTENTION_CODES.has(e?.code) && attempt < 5) {
      const delay = Math.min(2000, 100 * 2 ** attempt);
      const timer = setTimeout(
        () => _tryPatchInBackground(fields, timeoutMs, generation, attempt + 1),
        delay,
      );
      timer.unref?.();
      _pendingPatchRetry = { timer, generation };
      return;
    }
    if (_pendingPatchRetry?.generation === generation) _pendingPatchRetry = null;
    __mixdogMemoryLog(`[supervisor-pg] patchActiveInstance failed: ${e?.message}\n`);
  }
}

// Boot-path advertise writes (pg_port et al.) must never serially block init on
// the 8s default lock wait. Callers pass { timeoutMs, background, syncRetries }:
//   background:true  — short lock timeout; on contention schedule unref'd,
//                      backed-off, bounded bg retries of the NEWEST fields only.
//   background:false — synchronous best-effort with `syncRetries` extra sync
//                      attempts on lock timeout (shutdown clear path).
function patchActiveInstance(fields, opts = {}) {
  const { timeoutMs = 8000, background = false, syncRetries = 0 } = opts;
  // Supersede any in-flight background retry: last write wins per process.
  _patchGeneration++;
  _cancelPendingPatchRetry();
  if (background) {
    _tryPatchInBackground(fields, timeoutMs, _patchGeneration, 0);
    return;
  }
  for (let i = 0; ; i++) {
    try { _applyActiveInstancePatch(fields, timeoutMs); return; }
    catch (e) {
      if (_LOCK_CONTENTION_CODES.has(e?.code) && i < syncRetries) continue;
      __mixdogMemoryLog(`[supervisor-pg] patchActiveInstance failed: ${e?.message}\n`);
      return;
    }
  }
}

// ── postmaster.pid helpers ───────────────────────────────────────────────────

function readPostmasterPid(pgdata) {
  return readPostmasterInfo(pgdata).pid;
}

function readPostmasterInfo(pgdata) {
  try {
    const raw = readFileSync(join(pgdata, 'postmaster.pid'), 'utf8');
    const lines = raw.split('\n');
    const pid = parseInt(lines[0], 10);
    const port = parseInt(lines[3], 10);
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      port: Number.isFinite(port) && port > 0 ? port : null,
    };
  } catch { return { pid: null, port: null }; }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // EPERM: process exists but we lack permission → alive.
    // ESRCH: no such process → dead.
    return e.code === 'EPERM';
  }
}

/**
 * Best-effort process-name check: confirms the pid's comm name contains 'postgres'.
 * Falls back to true (alive) when the name cannot be determined.
 */
async function isPostgresPid(pid) {
  try {
    if (process.platform === 'linux') {
      const { readFileSync: rfs } = await import('node:fs');
      const comm = rfs(`/proc/${pid}/comm`, 'utf8').trim();
      return comm.includes('postgres');
    }
    if (process.platform === 'darwin') {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) return (r.stdout || '').trim().includes('postgres');
      return true;
    }
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) return (r.stdout || '').toLowerCase().includes('postgres');
      return true;
    }
  } catch { /* cannot read — fall back to alive */ }
  return true;
}

async function isPostmasterAlive(pid) {
  if (!isPidAlive(pid)) return false;
  return isPostgresPid(pid);
}

async function waitForPostmasterReady({ pid, port, healthcheckPg, timeoutMs = 30_000 }) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (isPidAlive(pid)) {
    try {
      if (await healthcheckPg({ port })) return 'ready';
    } catch {}
    if (Date.now() >= deadline) return 'alive-not-ready';
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return 'dead';
}

// ── Internal: spawn a fresh PG instance ─────────────────────────────────────

async function _startFresh(dataDir, pgdata, port, runtimeDir) {
  const { startPg } = await _getPgProc();
  const logPath = join(dataDir, 'pg.log');
  rotateLogIfNeeded(logPath);
  mkdirSync(pgdata, { recursive: true });
  // Track A's startPg handles initdb (if needed) then pg_ctl start.
  // stdout/stderr are directed to logPath by Track A's implementation.
  const pgdataDir = pgdata;
  const proc = await startPg({ runtimeDir, pgdataDir, port, logPath });
  const actualPort = proc?.port ?? port;
  _live = { port: actualPort, pgdata, runtimeDir, proc };
  patchActiveInstance({
    pg_port: actualPort, pg_started_at: Date.now(),
    pg_pgdata: pgdata, pg_runtime_dir: runtimeDir,
  }, { timeoutMs: 1000, background: true });
  __mixdogMemoryLog(`[supervisor-pg] ${proc?.attached ? 'attached to' : 'started'} PG port=${actualPort} pgdata=${pgdata}\n`);
  return { host: '127.0.0.1', port: actualPort, runtimeDir, pgdataDir };
}

async function tryReusePgInstance({ pgdata, runtimeDir, healthcheckPg, source = 'reuse' }) {
  let ai = null;
  let existingPort = null;
  let existingRtDir = runtimeDir;
  try {
    ai = _readPgAdvert();
    if (ai?.pg_port && ai?.pg_pgdata && resolve(ai.pg_pgdata) === resolve(pgdata)) {
      existingPort = ai.pg_port;
      existingRtDir = ai?.pg_runtime_dir ?? runtimeDir;
    }
  } catch {}

  if (existingPort) {
    try {
      if (await healthcheckPg({ port: existingPort })) {
        __mixdogMemoryLog(`[supervisor-pg] reusing PG on port ${existingPort} (${source}:active-instance)\n`);
        _live = { port: existingPort, pgdata, runtimeDir: existingRtDir, proc: null };
        // Re-stamp advert ownership: this process is now a live owner of the
        // reused postmaster. Without it the advert keeps the previous (possibly
        // dead) owner pid, and a later sync exit hook's _pgAdvertIsForeignLive
        // guard would judge it "not foreign-live" and wrongly sync-stop a
        // postmaster this reuser still uses. Use the revalidating re-stamp (not
        // patchActiveInstance) so a concurrent restart/owner change is not
        // clobbered by this reuse-time snapshot.
        _restampReuseOwner({ pgdata, port: existingPort });
        return { host: '127.0.0.1', port: existingPort, runtimeDir: existingRtDir, pgdataDir: pgdata };
      }
    } catch {}
  }

  const pm = readPostmasterInfo(pgdata);
  if (pm.pid && pm.port && await isPostmasterAlive(pm.pid)) {
    try {
      if (await healthcheckPg({ port: pm.port })) {
        __mixdogMemoryLog(`[supervisor-pg] attaching to PG pid=${pm.pid} port=${pm.port} (${source}:postmaster.pid)\n`);
        _live = { port: pm.port, pgdata, runtimeDir, proc: null };
        patchActiveInstance({
          pg_port: pm.port,
          pg_started_at: ai?.pg_started_at ?? Date.now(),
          pg_pgdata: pgdata,
          pg_runtime_dir: runtimeDir,
        }, { timeoutMs: 1000, background: true });
        return { host: '127.0.0.1', port: pm.port, runtimeDir, pgdataDir: pgdata };
      }
    } catch {}
  }

  return null;
}

// ── Internal: full ensure logic (runs exclusively via _ensureInFlight) ────────

async function _doEnsure(dataDir) {
  const { healthcheckPg } = await _getPgProc();
  const pgdata = join(dataDir, 'pgdata');

  // Resolve runtimeDir via runtime-fetcher (cache-hits immediately when already downloaded).
  const { ensureRuntime } = await import('../runtime-fetcher.mjs');
  const { runtimeDir } = await ensureRuntime(dataDir);

  // One-shot v2 conf reconcile — idempotent. Covers attach paths (in-process
  // fast path / cross-process active-instance reuse) where startPg is never
  // re-invoked on already-running PG instances.
  if (!_v2ReconcileTried) {
    _v2ReconcileTried = true;
    try {
      const { reconcileConfV2 } = await _getPgProc();
      reconcileConfV2(runtimeDir, pgdata);
    } catch (e) {
      __mixdogMemoryLog(`[supervisor-pg] reconcileConfV2 error (non-fatal): ${e?.message}\n`);
    }
  }

  // ── Fast path: already live in this process ──────────────────────────────
  if (_live) {
    try {
      if (await healthcheckPg({ port: _live.port })) {
        return { host: '127.0.0.1', port: _live.port, runtimeDir: _live.runtimeDir, pgdataDir: _live.pgdata };
      }
    } catch {}
    // healthcheck failed — fall through to recovery under lock
    __mixdogMemoryLog(`[supervisor-pg] in-process PG failed healthcheck — recovering\n`);
    _live = null;
  }

  const prelockReuse = await tryReusePgInstance({
    pgdata,
    runtimeDir,
    healthcheckPg,
    source: 'prelock',
  });
  if (prelockReuse) return prelockReuse;
  if (attachOnlyMode()) {
    throw new Error('secondary memory runtime requires an existing PG instance')
  }

  // ── Acquire spawn lock to serialize initdb races ─────────────────────────
  const acquired = await acquireSpawnLock(dataDir, () => tryReusePgInstance({
    pgdata,
    runtimeDir,
    healthcheckPg,
    source: 'lock-wait',
  }));
  if (acquired?.reuse) return acquired.reuse;
  const lp = acquired?.lockPath ?? null;
  try {
    // ── Reuse path: another supervisor already started PG ─────────────────
    const lockedReuse = await tryReusePgInstance({
      pgdata,
      runtimeDir,
      healthcheckPg,
      source: 'locked',
    });
    if (lockedReuse) return lockedReuse;

    let existingPort = null;
    let ai = null;
    try {
      ai = _readPgAdvert();
      // Only reuse a recorded instance when it was started for THIS pgdata.
      // active-instance.json is process-global; without matching pg_pgdata a
      // healthy PG serving a different data directory would be reused, binding
      // this dataDir's memory to the wrong cluster. A missing/mismatched
      // pg_pgdata falls through to a fresh start for the requested pgdata.
      if (ai?.pg_port && ai?.pg_pgdata && resolve(ai.pg_pgdata) === resolve(pgdata)) {
        existingPort = ai.pg_port;
      }
    } catch {}

    if (existingPort) {
      try {
        if (await healthcheckPg({ port: existingPort })) {
          __mixdogMemoryLog(`[supervisor-pg] reusing PG on port ${existingPort}\n`);
          const existingRtDir = ai?.pg_runtime_dir ?? runtimeDir;
          _live = { port: existingPort, pgdata, runtimeDir: existingRtDir, proc: null };
          return { host: '127.0.0.1', port: existingPort, runtimeDir: existingRtDir, pgdataDir: pgdata };
        }
      } catch {}

      // ── Stale detection: pg_port recorded but healthcheck failing ─────────
      __mixdogMemoryLog(
        `[supervisor-pg] pg_port=${existingPort} recorded but healthcheck failed — recovering\n`,
      );
      // Clear stale pg fields before restart
      patchActiveInstance({ pg_port: null, pg_started_at: null, pg_pgdata: null }, { timeoutMs: 1000, background: true });
    }

    // postmaster.pid is the authoritative pgdata owner even when the discovery
    // advert is absent/stale. The old path checked it only inside the
    // `existingPort` branch, then allocated 55433 and tried to start the SAME
    // pgdata while a recovering/rejecting server still owned 55432. Give crash
    // recovery a bounded chance to finish and attach if it does. Never issue a
    // stop from an ensure path: an alive postmaster owns the data directory,
    // and interrupting recovery can turn a transient outage into a restart loop.
    const pm = readPostmasterInfo(pgdata);
    if (pm.pid && pm.port && await isPostmasterAlive(pm.pid)) {
      __mixdogMemoryLog(`[supervisor-pg] postmaster PID ${pm.pid} alive but not ready — awaiting recovery\n`);
      const state = await waitForPostmasterReady({
        pid: pm.pid,
        port: pm.port,
        healthcheckPg,
      });
      if (state === 'ready') {
        __mixdogMemoryLog(`[supervisor-pg] attaching to recovered PG pid=${pm.pid} port=${pm.port}\n`);
        _live = { port: pm.port, pgdata, runtimeDir, proc: null };
        patchActiveInstance({
          pg_port: pm.port,
          pg_started_at: ai?.pg_started_at ?? Date.now(),
          pg_pgdata: pgdata,
          pg_runtime_dir: runtimeDir,
        }, { timeoutMs: 1000, background: true });
        return { host: '127.0.0.1', port: pm.port, runtimeDir, pgdataDir: pgdata };
      }
      if (state === 'alive-not-ready') {
        throw new Error(
          `[supervisor-pg] existing postmaster PID ${pm.pid} remains alive but unhealthy; refusing concurrent start`,
        );
      }
    }
    if (pm.pid) {
      __mixdogMemoryLog(`[supervisor-pg] postmaster PID ${pm.pid} dead — removing stale postmaster.pid\n`);
      try { unlinkSync(join(pgdata, 'postmaster.pid')); } catch {}
    }

    // ── Allocate a fresh port and spawn ───────────────────────────────────
    const port = await allocatePort();
    return await _startFresh(dataDir, pgdata, port, runtimeDir);
  } finally {
    releaseSpawnLock(lp);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure a live PG instance exists for `dataDir`.
 * Lazy: does nothing until first call — sessions that never touch memory pay
 * zero cost.
 *
 * Concurrent calls are deduplicated — exactly one spawn/recover sequence runs
 * at a time; additional callers await the same promise.
 *
 * @param {string} dataDir  Mixdog data directory.
 * @returns {Promise<{ host: string, port: number, runtimeDir: string, pgdataDir: string }>}
 */
export function ensurePgInstance(dataDir) {
  if (!_ensureInFlight) {
    _ensureInFlight = _doEnsure(dataDir).finally(() => { _ensureInFlight = null; });
  }
  return _ensureInFlight;
}

/**
 * Graceful PG shutdown — call from server-main.mjs shutdown() after workers
 * have stopped.  Sends pg_ctl stop to the pgdata directory; clears pg_port
 * from active-instance.json.
 *
 * On the supervisor detached-killer path (run-mcp.mjs killChild → SIGTERM
 * with no time for graceful stop) this function is never called — that is
 * intentional.  The next ensurePgInstance call will detect the stale
 * postmaster.pid via isPidAlive() and recover automatically.
 */
export async function stopPgForShutdown() {
  if (!_live) {
    // _live may be null if PG was started by another process or adapter call.
    // Attempt graceful stop via active-instance.json.
    let ai = null;
    try { ai = _readPgAdvert(); } catch {}
    if (!ai?.pg_port || !ai?.pg_pgdata) return;
    const pgdataDir2  = ai.pg_pgdata;
    const runtimeDir2 = ai.pg_runtime_dir;
    if (!runtimeDir2) {
      __mixdogMemoryLog(`[supervisor-pg] stopPgForShutdown: pg_runtime_dir missing from active-instance.json — skipping\n`);
      return;
    }
    try {
      const { stopPg } = await _getPgProc();
      await stopPg({ runtimeDir: runtimeDir2, pgdataDir: pgdataDir2 });
      __mixdogMemoryLog(`[supervisor-pg] PG stopped (via active-instance.json) on shutdown\n`);
    } catch (e) {
      __mixdogMemoryLog(`[supervisor-pg] stopPg error on shutdown (no _live): ${e?.message}\n`);
    }
    // Bounded sync clear (<=4s: 2s + one 2s retry). A residual stale pg_port is
    // tolerated — readers healthcheck-verify the port before reuse.
    patchActiveInstance({ pg_port: null, pg_started_at: null, pg_pgdata: null, pg_runtime_dir: null }, { timeoutMs: 2000, syncRetries: 1 });
    return;
  }
  const snap = _live;
  _live = null;
  _ensureInFlight = null;
  try {
    const { stopPg } = await _getPgProc();
    await stopPg({ runtimeDir: snap.runtimeDir, pgdataDir: snap.pgdata });
    __mixdogMemoryLog(`[supervisor-pg] PG stopped gracefully on shutdown\n`);
  } catch (e) {
    __mixdogMemoryLog(`[supervisor-pg] stopPg error on shutdown: ${e?.message}\n`);
  }
  // Bounded sync clear (<=4s: 2s + one 2s retry). A residual stale pg_port is
  // tolerated — readers healthcheck-verify the port before reuse.
  patchActiveInstance({ pg_port: null, pg_started_at: null, pg_pgdata: null, pg_runtime_dir: null }, { timeoutMs: 2000, syncRetries: 1 });
}

/**
 * Synchronous last-ditch PG stop for a process 'exit' hook. Covers the paths
 * where the async stopPgForShutdown() above never runs/completes — a Windows
 * force-kill, or stop() hitting its exit timeout — which otherwise kill the
 * postmaster mid-write and force WAL crash recovery on next boot. No-op once
 * the async path has cleared _live + active-instance (its record is gone), so
 * a graceful shutdown is never double-stopped.
 */
export function stopPgForShutdownSync() {
  // Mirror the async clear's ownership guard (_pgAdvertIsForeignLive) and apply
  // it UNCONDITIONALLY — even when _live is set. Async shutdown or a
  // cross-process reuse may have handed this postmaster to a different, still-
  // live owner that re-stamped pg_owner_pid; that owner will stop it itself, so
  // the exit hook must never sync-stop it out from under them.
  let ai = null;
  try { ai = _readPgAdvert(); } catch {}
  if (_pgAdvertIsForeignLive(ai)) return;
  let runtimeDir = _live?.runtimeDir, pgdataDir = _live?.pgdata;
  if (!runtimeDir || !pgdataDir) {
    runtimeDir = ai?.pg_runtime_dir; pgdataDir = ai?.pg_pgdata;
  }
  if (!runtimeDir || !pgdataDir || !_pgProc?.stopPgSync) return;
  try { _pgProc.stopPgSync({ runtimeDir, pgdataDir }); } catch {}
}
