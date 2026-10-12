// Background shell budget.
//
// A promoted (auto-backgrounded, timed-out or interrupted) shell job holds NO
// foreground admission lease: promotion returns the lease to the process-wide
// ResourceAdmissionController, so long-lived servers and watchers can never
// fill the foreground shell lane (maxShells) or the high-load lane that shell
// and agent work share (maxHighLoad). Background jobs therefore do NOT count
// toward high-load admission — agents are never starved by idle servers.
//
// Background jobs are governed here instead, by a per-runtime SOFT cap
// (MIXDOG_MAX_BACKGROUND_SHELLS, default 32). Promoting a job past the cap
// never fails the new call: exited jobs leave the budget first (they hold
// nothing), then the least-recently-active unprotected job is stopped and its
// owner learns why through the shell completion notification
// (backgroundShellEvictionReason). The PROTECT_RECENT newest promotions and
// jobs started with an explicit timeout_ms (the caller already bounded their
// lifetime) are never evicted, so the cap is exceeded when only protected jobs
// remain. Activity = new output on the job's capture, or a task read/wait.
import { statSync } from 'node:fs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { cancelNativeTask, getNativeTask, subscribeNativeTask } from '../lib/native-spawn-client.mjs';

const DEFAULT_MAX_BACKGROUND_SHELLS = 32;
const PROTECT_RECENT = 4;
const EVICTION_REASON_LIMIT = 256;

const jobs = new Map();
const evictionReasons = new Map();
let sequence = 0;

export function backgroundShellBudgetLimits(env = process.env) {
  return {
    maxJobs: positiveInt(env.MIXDOG_MAX_BACKGROUND_SHELLS, DEFAULT_MAX_BACKGROUND_SHELLS),
    protectRecent: PROTECT_RECENT,
  };
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

/** Stop tracking one job (it exited, or shutdown already killed it). */
export function forgetBackgroundShellJob(jobId) {
  const key = String(jobId || '');
  const entry = jobs.get(key);
  if (!entry) return;
  jobs.delete(key);
  try {
    entry.unsubscribe();
  } catch {}
}

export function clearBackgroundShellBudget() {
  for (const jobId of [...jobs.keys()]) forgetBackgroundShellJob(jobId);
}

/** The owner looked at the job (task read/wait): it is in use. */
export function touchBackgroundShellJob(jobId, now = Date.now()) {
  const entry = jobs.get(String(jobId || ''));
  if (entry) entry.lastActivityAt = now;
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

function evict(entry, { now, liveCount, maxJobs }) {
  const idleSec = Math.max(0, Math.round((now - entry.lastActivityAt) / 1000));
  const reason =
    `evicted by the background shell budget: ${liveCount} background shell jobs exceeded this runtime's cap of ` +
    `${maxJobs} (MIXDOG_MAX_BACKGROUND_SHELLS) and this was the least-recently-active one (idle ${idleSec}s). ` +
    'Re-run it if it is still needed; pass timeout_ms to keep a long-lived server from eviction, and stop ' +
    'servers/watchers with task cancel when done.';
  entry.evicting = true;
  rememberEviction(entry.jobId, reason);
  try {
    cancelNativeTask(entry.jobId);
  } catch {}
  return { jobId: entry.jobId, ownerSessionId: entry.ownerSessionId, command: entry.command, reason };
}

function enforceBackgroundShellBudget(now) {
  const { maxJobs, protectRecent } = backgroundShellBudgetLimits();
  // Exited jobs hold nothing: they leave the budget before anything is evicted.
  for (const entry of [...jobs.values()]) {
    if (getNativeTask(entry.jobId)?.status !== 'running') forgetBackgroundShellJob(entry.jobId);
  }
  const live = [...jobs.values()].filter((entry) => !entry.evicting);
  let excess = live.length - maxJobs;
  if (excess <= 0) return [];
  const recent = new Set(
    [...live]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, protectRecent)
      .map((entry) => entry.jobId)
  );
  for (const entry of live) sampleActivity(entry, now);
  const candidates = live
    .filter((entry) => !entry.explicitTimeout && !recent.has(entry.jobId))
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.seq - b.seq);
  const evicted = [];
  for (const entry of candidates) {
    if (excess <= 0) break;
    evicted.push(evict(entry, { now, liveCount: live.length, maxJobs }));
    excess -= 1;
  }
  return evicted;
}

/**
 * Track a freshly promoted background job and enforce the soft cap. Returns
 * the jobs evicted to make room (never the new one).
 */
export function registerBackgroundShellJob(
  jobId,
  { ownerSessionId = null, command = '', explicitTimeout = false, now = Date.now() } = {}
) {
  const key = String(jobId || '').trim();
  if (!key || jobs.has(key) || getNativeTask(key)?.status !== 'running') return [];
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
    unsubscribe: () => {},
  };
  jobs.set(key, entry);
  entry.unsubscribe = subscribeNativeTask(key, (task) => {
    if (task?.status !== 'running') forgetBackgroundShellJob(key);
    else sampleActivity(entry, Date.now());
  });
  return enforceBackgroundShellBudget(now);
}

export function backgroundShellBudgetSnapshot(now = Date.now()) {
  return {
    limits: backgroundShellBudgetLimits(),
    jobs: [...jobs.values()].map((entry) => ({
      jobId: entry.jobId,
      ownerSessionId: entry.ownerSessionId,
      command: entry.command,
      explicitTimeout: entry.explicitTimeout,
      evicting: entry.evicting,
      ageMs: Math.max(0, now - entry.promotedAt),
      idleMs: Math.max(0, now - entry.lastActivityAt),
    })),
  };
}
