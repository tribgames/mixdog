/**
 * src/runtime/shared/statusline/statusline-segments.mjs — filesystem-backed L2 segment sources.
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
import { positiveInt } from '../numbers.mjs';
import { isPidAlive } from '../pid-liveness.mjs';

const DEFAULT_MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const DEFAULT_STANDALONE_DATA_DIR = join(DEFAULT_MIXDOG_HOME, 'data');
const SHELL_JOBS_SEGMENT_CACHE_MS = 1000;

// Session buckets ride along with the owner-wide totals: one host process can
// own many sessions (the desktop pools every pane's engine), so a pane must be
// able to ask for ITS OWN jobs instead of the process aggregate.
const FINISHED_SHELL_JOB_TTL_MS = 30 * 60 * 1000;
const EMPTY_SHELL_JOBS_SESSION = Object.freeze({
  count: 0,
  elapsedLabel: '',
  jobs: Object.freeze([]),
  finished: Object.freeze([]),
});
const EMPTY_SHELL_JOBS = Object.freeze({
  count: 0,
  elapsedLabel: '',
  jobs: Object.freeze([]),
  sessions: Object.freeze({}),
});

// One entry per owner pid: a desktop host polls under whichever session frame
// arrived last, so the owner can alternate between processes. A single shared
// slot answered every switch with "no jobs" and made the job list flicker.
const _shellJobsSegmentCache = new Map();
const _shellJobsRefreshInFlight = new Set();
const SHELL_JOBS_OWNER_CACHE_TTL_MS = 60_000;

function rememberShellJobs(ownerPid, value) {
  const at = Date.now();
  for (const [pid, entry] of _shellJobsSegmentCache) {
    if (at - entry.at > SHELL_JOBS_OWNER_CACHE_TTL_MS) _shellJobsSegmentCache.delete(pid);
  }
  _shellJobsSegmentCache.set(ownerPid, { at, value });
}

function dataDir() {
  return process.env.MIXDOG_DATA_DIR || DEFAULT_STANDALONE_DATA_DIR;
}

// Render-path entry point: synchronous, cache-only. Never blocks on fs.
// Without `sessionId` this reports the owner process aggregate (CLI statusline,
// keep-awake); with one it reports only that session's own jobs.
export function shellJobsStatus({ clientHostPid, sessionId } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  // Asking for a scope is what matters, not whether that scope is non-empty:
  // an explicit blank id (a desktop pane with no session yet) owns nothing,
  // while an OMITTED id means "the whole owner process".
  const scoped = sessionId !== undefined && sessionId !== null;
  const scope = String(sessionId ?? '').trim();
  if (!ownerPid) return scoped ? EMPTY_SHELL_JOBS_SESSION : EMPTY_SHELL_JOBS;
  const now = Date.now();
  const cached = _shellJobsSegmentCache.get(ownerPid);
  const fresh = cached && now - cached.at < SHELL_JOBS_SEGMENT_CACHE_MS;
  if (!fresh && !_shellJobsRefreshInFlight.has(ownerPid)) {
    _shellJobsRefreshInFlight.add(ownerPid);
    refreshShellJobsStatus(ownerPid).finally(() => {
      _shellJobsRefreshInFlight.delete(ownerPid);
    });
  }
  const own = cached?.value || EMPTY_SHELL_JOBS;
  // Session buckets are not pid-scoped, so they come from the freshest scan of
  // ANY owner. Reading them from this owner's own slot made the list follow
  // that slot's age: an owner polled again after its entry was evicted (or
  // went stale) answered with "no sessions", and the finished shells vanished
  // until the next poll brought them back.
  const sessions = freshestShellJobsSessions() ?? own.sessions;
  if (!scoped) return sessions === own.sessions ? own : { ...own, sessions };
  return (scope && sessions?.[scope]) || EMPTY_SHELL_JOBS_SESSION;
}

// Awaited fresh scan for pollers that own their cadence (desktop): the result
// reflects the disk at call time instead of the previous poll. The CLI render
// path keeps using the cache-only shellJobsStatus.
export async function shellJobsStatusFresh({ clientHostPid } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  if (!ownerPid) return EMPTY_SHELL_JOBS;
  return refreshShellJobsStatus(ownerPid);
}

function freshestShellJobsSessions() {
  let freshest = null;
  for (const entry of _shellJobsSegmentCache.values()) {
    if (!freshest || entry.at >= freshest.at) freshest = entry;
  }
  return freshest?.value.sessions;
}

// Memory cycle L2 segment source. The daemon-hosted memory runtime writes
// data/memory-cycle-state.json on every cycle start/finish through the
// cycle-scheduler health ledger — no HTTP call from the statusline path. Cached at
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
    refreshMemoryCycleStatus().finally(() => {
      _memoryCycleRefreshInFlight = false;
    });
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
      const ownerAlive = !Number(running?.pid) || isPidAlive(Number(running.pid));
      if (fresh && ownerAlive && running?.cycle === 'cycle1' && Number(running.started_at) > 0) {
        value = { kind: 'running', startedAt: Number(running.started_at) };
      } else if (fresh) {
        const pending = Number(backlog?.unchunked) || 0;
        if (pending > MEMORY_CYCLE_BACKLOG_WARN) value = { kind: 'backlog', pending };
      }
    }
  } catch {
    value = null;
  }
  _memoryCycleSegmentCache = { at: Date.now(), value };
}

async function refreshShellJobsStatus(ownerPid) {
  let value = EMPTY_SHELL_JOBS;
  try {
    const dir = join(dataDir(), 'shell-jobs');
    let names;
    try {
      names = await readdir(dir);
    } catch {
      rememberShellJobs(ownerPid, value);
      return value;
    }
    const { ids, ownerByJob, doneIds } = listOpenShellJobs(names);
    let count = 0;
    let oldestMs = Infinity;
    const jobs = [];
    // sessionId -> { count, oldestMs, jobs }. Jobs with no session stamp (legacy
    // records, plain CLI runs) still count toward the owner total but belong to
    // no pane, so they never light up a session's indicator.
    const bySession = new Map();
    for (const id of ids) {
      const p = join(dir, `${id}.json`);
      let detail;
      try {
        detail = JSON.parse(await readFile(p, 'utf-8'));
      } catch {
        continue;
      }
      if (!(await isShellJobAlive(detail, p, dir, id))) continue;
      // A foreground command is awaited in its own tool card; listing it here
      // made every short command flash in and out of the shell list. Only
      // backgrounded jobs (including promoted ones) are background work.
      if (detail?.foreground === true) continue;
      // Owner-wide totals stay this process's own; session buckets take every
      // live job regardless of which host published it.
      const ownedByThisHost = ownerByJob.get(id) === ownerPid;
      if (ownedByThisHost) count++;
      let jobMs = Infinity;
      try {
        const st = await stat(p);
        jobMs = st.mtimeMs;
        if (ownedByThisHost && st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
      const owner = String(detail?.ownerSessionId ?? '').trim();
      const job = {
        taskId: id,
        command: String(detail?.command || '').trim(),
        cwd: String(detail?.cwd || '').trim(),
        startedAt: detail?.startedAt || (Number.isFinite(jobMs) ? jobMs : null),
      };
      if (ownedByThisHost) jobs.push(job);
      if (!owner) continue;
      const bucket = bySession.get(owner) || { count: 0, oldestMs: Infinity, jobs: [], finished: [] };
      bucket.count += 1;
      if (jobMs < bucket.oldestMs) bucket.oldestMs = jobMs;
      bucket.jobs.push(job);
      bySession.set(owner, bucket);
    }
    // Recently finished background jobs ride in their session bucket only;
    // they never touch the running counts.
    const finishedCutoff = Date.now() - FINISHED_SHELL_JOB_TTL_MS;
    for (const id of doneIds) {
      let detail;
      try {
        detail = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf-8'));
      } catch {
        continue;
      }
      if (detail?.foreground === true) continue;
      const owner = String(detail?.ownerSessionId ?? '').trim();
      if (!owner) continue;
      const finishedMs = Date.parse(detail?.finishedAt || detail?.recordedAt || '');
      if (Number.isFinite(finishedMs) && finishedMs < finishedCutoff) continue;
      const bucket = bySession.get(owner) || { count: 0, oldestMs: Infinity, jobs: [], finished: [] };
      bucket.finished.push({
        taskId: id,
        command: String(detail?.command || '').trim(),
        cwd: String(detail?.cwd || '').trim(),
        startedAt: detail?.startedAt || null,
        status: String(detail?.status || ''),
        exitCode: Number.isInteger(detail?.exitCode) ? detail.exitCode : null,
        finishedAt: detail?.finishedAt || detail?.recordedAt || null,
      });
      bySession.set(owner, bucket);
    }
    // A desktop pane's job lands in a session bucket while the owner-wide
    // count stays 0 (its publisher is a shard, not this host), so an empty
    // aggregate must NOT discard the session buckets.
    if (count || bySession.size) value = summarizeShellJobs({ count, oldestMs, jobs, bySession });
  } catch {
    value = EMPTY_SHELL_JOBS;
  }
  rememberShellJobs(ownerPid, value);
  return value;
}

// Newest-first, capped ids of job records with no `.done` marker, plus the
// `.owner-<pid>` marker map.
function listOpenShellJobs(names) {
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
    // Session buckets are NOT pid-scoped. A desktop pane's background shell
    // is published by the session SHARD that ran it, so the record's
    // `.owner-<pid>` marker carries the shard pid while the desktop poller
    // asks with its own host pid. The two never intersect, so every desktop
    // background shell was missing from the agent+shell chip even though its
    // record was on disk and correctly stamped with ownerSessionId. Session
    // ids are globally unique (sess_daemon_<ts>_<uuid>), so bucketing by
    // session needs no pid axis at all. The owner-wide aggregate still
    // honours the pid, keeping the CLI statusline and keep-awake counting
    // only their own process.
    .filter((id) => !done.has(id))
    .sort((a, b) => jobStampMs(b) - jobStampMs(a))
    // Scanning both scopes from one list doubles the worst-case window, so
    // the per-refresh cap doubles with it; a live (non-.done) record set is
    // a handful in practice and terminal ones age out on their own.
    .slice(0, 60);
  const doneIds = [...done]
    .filter((id) => names.includes(`${id}.json`))
    .sort((a, b) => jobStampMs(b) - jobStampMs(a))
    .slice(0, 30);
  return { ids, ownerByJob, doneIds };
}

function summarizeShellJobs({ count, oldestMs, jobs, bySession }) {
  const now = Date.now();
  const elapsedLabel = Number.isFinite(oldestMs) ? formatElapsed(now - oldestMs) : '';
  const sessions = {};
  for (const [owner, bucket] of bySession) {
    sessions[owner] = {
      count: bucket.count,
      elapsedLabel: Number.isFinite(bucket.oldestMs) ? formatElapsed(now - bucket.oldestMs) : '',
      jobs: bucket.jobs,
      finished: bucket.finished,
    };
  }
  return { count, elapsedLabel, jobs, sessions };
}

async function isShellJobAlive(detail, detailPath, dir, id) {
  const pid = positiveInt(detail?.pid);
  if (!pid) return false;
  try {
    const st = await stat(detailPath);
    const timeoutMs = Number(detail?.timeoutMs);
    const enforced =
      detail?.timeoutEnforced === true ||
      (await stat(join(dir, `${id}.enforced`)).then(
        () => true,
        () => false
      ));
    if (enforced && Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - st.mtimeMs > timeoutMs + 30 * 60_000) {
      return false;
    }
  } catch {
    return false;
  }
  return isPidAlive(pid);
}

function jobStampMs(id) {
  const m = /^job_(\d+)/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}
