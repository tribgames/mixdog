/**
 * src/ui/statusline-segments.mjs — filesystem-backed L2 segment sources.
 *
 * The shell-jobs segment (owner-scoped job scan + liveness) and the
 * memory-cycle segment (daemon state file) each keep a 1s process-local
 * cache. Render calls (`shellJobsStatus`/`memoryCycleStatus`) are pure cache
 * reads and NEVER touch the filesystem synchronously: on cache expiry they
 * return the last known value immediately and kick a background
 * fs/promises refresh (guarded against overlap) that updates the cache for
 * the next render tick. This keeps the 500ms render tick off sync fs I/O.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatElapsed } from './statusline-format.mjs';

const DEFAULT_MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const DEFAULT_STANDALONE_DATA_DIR = join(DEFAULT_MIXDOG_HOME, 'data');
const SHELL_JOBS_SEGMENT_CACHE_MS = 1000;

let _shellJobsSegmentCache = { ownerPid: 0, at: 0, value: { count: 0, elapsedLabel: '' } };
let _shellJobsRefreshInFlight = false;

function dataDir() {
  return process.env.MIXDOG_DATA_DIR || DEFAULT_STANDALONE_DATA_DIR;
}

// Render-path entry point: synchronous, cache-only. Never blocks on fs.
export function shellJobsStatus({ clientHostPid } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  const empty = { count: 0, elapsedLabel: '' };
  if (!ownerPid) return empty;
  const now = Date.now();
  const sameOwner = _shellJobsSegmentCache.ownerPid === ownerPid;
  const fresh = sameOwner && now - _shellJobsSegmentCache.at < SHELL_JOBS_SEGMENT_CACHE_MS;
  if (!fresh && !_shellJobsRefreshInFlight) {
    _shellJobsRefreshInFlight = true;
    refreshShellJobsStatus(ownerPid).finally(() => { _shellJobsRefreshInFlight = false; });
  }
  return sameOwner ? (_shellJobsSegmentCache.value || empty) : empty;
}

// Memory cycle L2 segment source. The memory daemon writes
// data/memory-cycle-state.json on every cycle start/finish (index.mjs
// _writeCycleStateFile) — no HTTP call from the statusline path. Cached at
// the same 1s cadence as the shell segment. Shows a single unified "Memory"
// segment: running (spinner + elapsed) or backlog warning (yellow count).
let _memoryCycleSegmentCache = { at: 0, value: null };
let _memoryCycleRefreshInFlight = false;
const MEMORY_CYCLE_SEGMENT_CACHE_MS = 1000;
const MEMORY_CYCLE_BACKLOG_WARN = 500;

// Render-path entry point: synchronous, cache-only. Never blocks on fs.
export function memoryCycleStatus() {
  const now = Date.now();
  if (now - _memoryCycleSegmentCache.at >= MEMORY_CYCLE_SEGMENT_CACHE_MS && !_memoryCycleRefreshInFlight) {
    _memoryCycleRefreshInFlight = true;
    refreshMemoryCycleStatus().finally(() => { _memoryCycleRefreshInFlight = false; });
  }
  return _memoryCycleSegmentCache.value;
}

async function refreshMemoryCycleStatus() {
  let value = null;
  try {
    const p = join(dataDir(), 'memory-cycle-state.json');
    const raw = await readFile(p, 'utf-8').catch(() => null);
    if (raw != null) {
      const state = JSON.parse(raw);
      const running = state?.running || null;
      const backlog = state?.backlog || {};
      // Stale-file guard: a daemon that died mid-run leaves running set —
      // ignore anything not refreshed in the last 10 minutes.
      const fresh = Number(state?.updatedAt) > Date.now() - 10 * 60_000;
      // Precise guard: running carries the daemon pid (cycle-scheduler
      // markCycleRunning) — if that pid is gone, the run died with it, so
      // drop the spinner immediately instead of waiting out the 10-minute
      // window. Pid-less markers (older daemons) keep the time-based guard.
      const ownerAlive = !Number(running?.pid) || pidAlive(Number(running.pid));
      if (fresh && ownerAlive && running?.cycle && Number(running.started_at) > 0) {
        value = { kind: 'running', startedAt: Number(running.started_at) };
      } else if (fresh) {
        const pending = Math.max(Number(backlog?.unchunked) || 0, Number(backlog?.cycle2_pending) || 0);
        if (pending > MEMORY_CYCLE_BACKLOG_WARN) value = { kind: 'backlog', pending };
      }
    }
  } catch { value = null; }
  _memoryCycleSegmentCache = { at: Date.now(), value };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; } // EPERM = alive, no permission
}

async function refreshShellJobsStatus(ownerPid) {
  const empty = { count: 0, elapsedLabel: '' };
  let value = empty;
  try {
    const dir = join(dataDir(), 'shell-jobs');
    let names;
    try {
      names = await readdir(dir);
    } catch {
      _shellJobsSegmentCache = { ownerPid, at: Date.now(), value };
      return;
    }
    const done = new Set(names.filter((n) => n.endsWith('.done')).map((n) => n.slice(0, -5)));
    const ownerByJob = new Map();
    for (const n of names) {
      const i = n.lastIndexOf('.owner-');
      if (i > 0) {
        const pid = positiveInt(n.slice(i + 7));
        if (pid) ownerByJob.set(n.slice(0, i), pid);
      }
    }
    const ids = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => !done.has(id) && ownerByJob.get(id) === ownerPid)
      .sort((a, b) => jobStampMs(b) - jobStampMs(a))
      .slice(0, 30);
    let count = 0;
    let oldestMs = Infinity;
    for (const id of ids) {
      const p = join(dir, `${id}.json`);
      let detail;
      try { detail = JSON.parse(await readFile(p, 'utf-8')); } catch { continue; }
      if (!(await isShellJobAlive(detail, p, dir, id))) continue;
      count++;
      try {
        const st = await stat(p);
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
    }
    if (count) {
      const elapsedLabel = Number.isFinite(oldestMs) ? formatElapsed(Date.now() - oldestMs) : '';
      value = { count, elapsedLabel };
    }
  } catch {
    value = empty;
  }
  _shellJobsSegmentCache = { ownerPid, at: Date.now(), value };
}

async function isShellJobAlive(detail, detailPath, dir, id) {
  const pid = positiveInt(detail?.pid);
  if (!pid) return false;
  try {
    const st = await stat(detailPath);
    const timeoutMs = Number(detail?.timeoutMs);
    const enforced = detail?.timeoutEnforced === true
      || await stat(join(dir, `${id}.enforced`)).then(() => true, () => false);
    if (enforced && Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - st.mtimeMs > timeoutMs + 30 * 60_000) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function jobStampMs(id) {
  const m = /^job_(\d+)/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
