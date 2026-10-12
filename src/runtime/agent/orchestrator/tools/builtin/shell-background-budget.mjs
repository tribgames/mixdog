// Background shell budget.
//
// A promoted (auto-backgrounded, timed-out or interrupted) shell job normally
// holds NO foreground admission lease: promotion returns the lease to the
// process-wide ResourceAdmissionController, so long-lived servers and watchers
// cannot fill the foreground shell lane (maxShells).
//
// Background jobs live under a HARD per-runtime cap instead
// (MIXDOG_MAX_BACKGROUND_SHELLS, default 32). A job is counted from admission
// until its termination is CONFIRMED by the native runner, so total shell work
// stays bounded by maxShells (foreground) + the cap (background).
//
// Promotion at the cap never exceeds it. The new job is promoted (task_id,
// task control) but stays PENDING: it keeps holding its foreground lease until
// a background slot frees, and the call tells the model which of its own jobs
// it can cancel. To free a slot the least-recently-active ELIGIBLE job is
// evicted. Protection only decides which job that is; it never raises the cap.
// A job is not eligible while any of these holds:
//   - it is one of the PROTECT_RECENT newest promotions;
//   - it was started with an explicit timeout_ms (its life is already bounded);
//   - a task read/wait or other live consumer is using it right now (pinned);
//   - it produced output or was read within the minimum idle window
//     (MIXDOG_BACKGROUND_SHELL_MIN_IDLE_MS, default 10 min).
// The evicted job's owner learns the reason through the shell completion
// notification (backgroundShellEvictionReason). An eviction whose cancel is
// not delivered keeps the job counted, is retried, and is reported (log +
// owner notification through the failure handler shell-jobs installs).
//
// High-load accounting: a counted background job holds no maxHighLoad share.
// maxHighLoad bounds work this runtime is actively driving (agents and
// foreground shells that the model is waiting on). Background jobs are mostly
// idle servers/watchers, run at below-normal OS priority (shell-jobs
// demoteBackgroundShellPriority), and their memory lives in their own
// processes, not in the daemon heap that maxRssMb samples. Counting them —
// even partially — let idle dev servers starve agents; the hard cap above is
// what bounds their CPU/memory instead. A PENDING job still holds its
// foreground lease, so it counts toward maxShells and maxHighLoad in full.
import { statSync } from 'node:fs';
import { nonNegativeInt, positiveInt } from '../../../../shared/numbers.mjs';
import { cancelNativeTask, getNativeTask, subscribeNativeTask } from '../lib/native-spawn-client.mjs';

const DEFAULT_MAX_BACKGROUND_SHELLS = 32;
const DEFAULT_MIN_IDLE_MS = 10 * 60_000;
const PROTECT_RECENT = 4;
const EVICTION_REASON_LIMIT = 256;
// Maintenance cadence while jobs wait for a slot or an eviction is
// unconfirmed: re-check eligibility and re-issue undelivered/unconfirmed cancels.
const MAINTENANCE_MS = 30_000;

// Counted against the cap: running, or evicted but not yet confirmed gone.
const jobs = new Map();
// Promoted, waiting for a slot; each still holds its foreground lease.
const pending = new Map();
const pins = new Map();
const evictionReasons = new Map();
let sequence = 0;
let maintenanceTimer = null;
let evictionFailureHandler = null;

export function backgroundShellBudgetLimits(env = process.env) {
  return {
    maxJobs: positiveInt(env.MIXDOG_MAX_BACKGROUND_SHELLS, DEFAULT_MAX_BACKGROUND_SHELLS),
    minIdleMs: nonNegativeInt(env.MIXDOG_BACKGROUND_SHELL_MIN_IDLE_MS, DEFAULT_MIN_IDLE_MS),
    protectRecent: PROTECT_RECENT,
  };
}

/** shell-jobs routes undelivered-eviction reports to the job's owner. */
export function setBackgroundShellEvictionFailureHandler(handler) {
  evictionFailureHandler = typeof handler === 'function' ? handler : null;
}

function outputBytes(jobId) {
  const task = getNativeTask(jobId);
  let total = (task?.stdoutBytes || 0) + (task?.stderrBytes || 0);
  for (const path of [task?.stdoutPath, task?.stderrPath]) {
    if (!path) continue;
    try {
      total += statSync(path).size;
    } catch {}
  }
  return total;
}

function sampleActivity(entry, now) {
  const bytes = outputBytes(entry.jobId);
  if (bytes === entry.outputBytes) return;
  entry.outputBytes = bytes;
  entry.lastActivityAt = now;
}

function releaseLease(entry) {
  const lease = entry.lease;
  entry.lease = null;
  if (!lease) return;
  Promise.resolve()
    .then(() => lease.release())
    .catch((error) => {
      try {
        process.stderr.write(`[shell-budget] lease release failed for ${entry.jobId}: ${error?.message || error}\n`);
      } catch {}
    });
}

function syncMaintenance() {
  const needed = pending.size > 0 || [...jobs.values()].some((entry) => entry.evicting);
  if (needed && !maintenanceTimer) {
    maintenanceTimer = setInterval(() => runBackgroundShellMaintenance(), MAINTENANCE_MS);
    maintenanceTimer.unref?.();
  } else if (!needed && maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

// Move waiting jobs into freed slots, oldest first; each returns its lease.
function admitPending() {
  const { maxJobs } = backgroundShellBudgetLimits();
  for (const entry of [...pending.values()].sort((a, b) => a.seq - b.seq)) {
    if (jobs.size >= maxJobs) break;
    pending.delete(entry.jobId);
    jobs.set(entry.jobId, entry);
    releaseLease(entry);
    entry.admitted.resolve(true);
  }
}

/** Stop tracking one job: it exited, or shutdown already killed it. */
export function forgetBackgroundShellJob(jobId) {
  const key = String(jobId || '');
  const entry = jobs.get(key) || pending.get(key);
  if (!entry) return;
  jobs.delete(key);
  pending.delete(key);
  try {
    entry.unsubscribe();
  } catch {}
  // A job that ended while waiting gives its foreground slot back.
  releaseLease(entry);
  entry.admitted.resolve(false);
  admitPending();
  syncMaintenance();
}

export function clearBackgroundShellBudget() {
  for (const jobId of [...pending.keys()]) forgetBackgroundShellJob(jobId);
  for (const jobId of [...jobs.keys()]) forgetBackgroundShellJob(jobId);
}

/** The owner looked at the job (task read/wait): it is in use. */
export function touchBackgroundShellJob(jobId, now = Date.now()) {
  const key = String(jobId || '');
  const entry = jobs.get(key) || pending.get(key);
  if (entry) entry.lastActivityAt = Math.max(entry.lastActivityAt, now);
}

/**
 * Mark a job in use for the duration of a live consumer (task read/wait):
 * it can never be evicted until the returned release runs.
 */
export function pinBackgroundShellJob(jobId) {
  const key = String(jobId || '');
  if (!key) return () => {};
  pins.set(key, (pins.get(key) || 0) + 1);
  touchBackgroundShellJob(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (pins.get(key) || 1) - 1;
    if (count > 0) pins.set(key, count);
    else pins.delete(key);
    touchBackgroundShellJob(key);
  };
}

function rememberEviction(jobId, reason) {
  if (!evictionReasons.has(jobId) && evictionReasons.size >= EVICTION_REASON_LIMIT) {
    evictionReasons.delete(evictionReasons.keys().next().value);
  }
  evictionReasons.set(jobId, reason);
}

/** Why the budget stopped this job, or null when it was not evicted. */
export function backgroundShellEvictionReason(jobId) {
  return evictionReasons.get(String(jobId || '')) || null;
}

function attemptCancel(entry, now) {
  entry.evictAttemptAt = now;
  let delivered = false;
  let error = null;
  try {
    delivered = Boolean(cancelNativeTask(entry.jobId));
  } catch (err) {
    error = err;
  }
  if (delivered) {
    entry.evictFailure = null;
    return;
  }
  entry.evictFailure = error?.message || 'cancellation was not delivered (no live spawn-server link)';
  try {
    process.stderr.write(
      `[shell-budget] eviction of ${entry.jobId} failed: ${entry.evictFailure}; it stays counted and is retried\n`
    );
  } catch {}
  if (entry.failureReported) return;
  entry.failureReported = true;
  try {
    evictionFailureHandler?.({
      jobId: entry.jobId,
      ownerSessionId: entry.ownerSessionId,
      command: entry.command,
      reason: entry.evictFailure,
    });
  } catch {}
}

function evict(entry, { now, counted, maxJobs }) {
  const idleSec = Math.max(0, Math.round((now - entry.lastActivityAt) / 1000));
  const reason =
    `evicted by the background shell budget: this runtime's cap of ${maxJobs} background shell jobs ` +
    `(MIXDOG_MAX_BACKGROUND_SHELLS) was reached (${counted} counted, newer work waiting) and this was the ` +
    `least-recently-active one (idle ${idleSec}s). Re-run it if it is still needed; pass timeout_ms to keep a ` +
    'long-lived server from eviction, and stop servers/watchers with task cancel when done.';
  entry.evicting = true;
  rememberEviction(entry.jobId, reason);
  attemptCancel(entry, now);
  return { jobId: entry.jobId, ownerSessionId: entry.ownerSessionId, command: entry.command, reason };
}

function protectionOf(entry, recent, { now, minIdleMs }) {
  if (entry.evicting) return 'stopping';
  if (pins.has(entry.jobId)) return 'in use';
  if (entry.explicitTimeout) return 'explicit timeout';
  if (recent.has(entry.jobId)) return 'recent';
  if (now - entry.lastActivityAt < minIdleMs) return 'active';
  return null;
}

function recentIds() {
  return new Set(
    [...jobs.values(), ...pending.values()]
      .filter((entry) => !entry.evicting)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, PROTECT_RECENT)
      .map((entry) => entry.jobId)
  );
}

function enforce(now) {
  const limits = backgroundShellBudgetLimits();
  for (const entry of [...jobs.values(), ...pending.values()]) {
    if (getNativeTask(entry.jobId)?.status !== 'running') forgetBackgroundShellJob(entry.jobId);
  }
  // Undelivered cancels retry now; delivered ones that never exited are
  // re-issued after a maintenance interval.
  for (const entry of jobs.values()) {
    if (entry.evicting && (entry.evictFailure || now - entry.evictAttemptAt >= MAINTENANCE_MS)) {
      attemptCancel(entry, now);
    }
  }
  const stopping = [...jobs.values()].filter((entry) => entry.evicting).length;
  let needed = jobs.size + pending.size - limits.maxJobs - stopping;
  if (needed <= 0) return [];
  for (const entry of jobs.values()) sampleActivity(entry, now);
  const recent = recentIds();
  const candidates = [...jobs.values()]
    .filter((entry) => !protectionOf(entry, recent, { now, minIdleMs: limits.minIdleMs }))
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.seq - b.seq);
  const evicted = [];
  for (const entry of candidates) {
    if (needed <= 0) break;
    evicted.push(evict(entry, { now, counted: jobs.size, maxJobs: limits.maxJobs }));
    needed -= 1;
  }
  return evicted;
}

/** One maintenance pass: retry evictions, evict newly eligible jobs, admit waiters. */
export function runBackgroundShellMaintenance(now = Date.now()) {
  const evicted = enforce(now);
  admitPending();
  syncMaintenance();
  return evicted;
}

/**
 * Track a freshly promoted background job. Under the cap it is admitted and
 * the caller releases its foreground lease. At the cap it waits PENDING and
 * the budget keeps `lease` until a slot frees (then releases it itself).
 * Returns { admitted, evicted, whenAdmitted }.
 */
export function registerBackgroundShellJob(
  jobId,
  { ownerSessionId = null, command = '', explicitTimeout = false, lease = null, now = Date.now() } = {}
) {
  const key = String(jobId || '').trim();
  if (!key || jobs.has(key) || pending.has(key) || getNativeTask(key)?.status !== 'running') {
    return { admitted: true, evicted: [], whenAdmitted: Promise.resolve(true) };
  }
  const admitted = Promise.withResolvers();
  const entry = {
    jobId: key,
    seq: ++sequence,
    ownerSessionId: ownerSessionId ? String(ownerSessionId) : null,
    command: String(command || '').replace(/\s+/g, ' ').slice(0, 120),
    explicitTimeout: explicitTimeout === true,
    promotedAt: now,
    lastActivityAt: now,
    outputBytes: outputBytes(key),
    evicting: false,
    evictAttemptAt: 0,
    evictFailure: null,
    failureReported: false,
    lease: null,
    admitted,
    unsubscribe: () => {},
  };
  entry.unsubscribe = subscribeNativeTask(key, (task) => {
    if (task?.status !== 'running') forgetBackgroundShellJob(key);
    else sampleActivity(entry, Date.now());
  });
  const { maxJobs } = backgroundShellBudgetLimits();
  if (jobs.size < maxJobs && pending.size === 0) {
    jobs.set(key, entry);
    admitted.resolve(true);
    return { admitted: true, evicted: [], whenAdmitted: admitted.promise };
  }
  entry.lease = lease;
  pending.set(key, entry);
  const evicted = runBackgroundShellMaintenance(now);
  return { admitted: !pending.has(key), evicted, whenAdmitted: admitted.promise };
}

export function isBackgroundShellJobPending(jobId) {
  return pending.has(String(jobId || ''));
}

/**
 * Model-facing explanation for a job left pending. Only the caller's own jobs
 * are named; other sessions' jobs are counted, never described.
 */
export function backgroundShellPendingNotice(jobId, ownerSessionId, now = Date.now()) {
  const limits = backgroundShellBudgetLimits();
  const owner = String(ownerSessionId || '');
  const recent = recentIds();
  const own = [];
  let others = 0;
  for (const entry of jobs.values()) {
    if (!owner || entry.ownerSessionId !== owner) {
      others += 1;
      continue;
    }
    const protection = protectionOf(entry, recent, { now, minIdleMs: limits.minIdleMs });
    const idle = Math.round(Math.max(0, now - entry.lastActivityAt) / 1000);
    own.push({ entry, text: `[task_id: ${entry.jobId}] ${entry.command} (idle ${idle}s${protection ? `, ${protection}` : ''})` });
  }
  const stopping = [...jobs.values()].filter((entry) => entry.evicting).length;
  const parts = [
    `background shell budget full (${jobs.size}/${limits.maxJobs}${stopping ? `, ${stopping} stopping` : ''}): ` +
      `task ${jobId} keeps its foreground execution slot until a background slot frees, then continues in the background.`,
  ];
  if (own.length) parts.push(`Your background jobs: ${own.map((row) => row.text).join(' | ')}.`);
  const cancels = own.filter((row) => !row.entry.evicting).map((row) => `task cancel task_id=${row.entry.jobId}`);
  if (cancels.length) parts.push(`Free a slot when one is no longer needed: ${cancels.join('; ')}.`);
  if (others) parts.push(`${others} background job(s) belong to other sessions of this runtime.`);
  parts.push(
    `Jobs become evictable after ${Math.round(limits.minIdleMs / 60_000)} min without output or task reads ` +
      'unless recent, started with timeout_ms, or in use.'
  );
  return parts.join(' ');
}

export function backgroundShellBudgetSnapshot(now = Date.now()) {
  const row = (entry) => ({
    jobId: entry.jobId,
    ownerSessionId: entry.ownerSessionId,
    command: entry.command,
    explicitTimeout: entry.explicitTimeout,
    pinned: pins.has(entry.jobId),
    evicting: entry.evicting,
    evictFailure: entry.evictFailure,
    ageMs: Math.max(0, now - entry.promotedAt),
    idleMs: Math.max(0, now - entry.lastActivityAt),
  });
  return {
    limits: backgroundShellBudgetLimits(),
    jobs: [...jobs.values()].map(row),
    pending: [...pending.values()].map(row),
  };
}
