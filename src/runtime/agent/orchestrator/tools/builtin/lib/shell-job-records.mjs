/**
 * Cross-process sidecar records for running background shell jobs.
 *
 * The native spawn server keeps live tasks in ONE process's memory, while every
 * shell-count reader runs somewhere else (desktop panes poll from the Electron
 * main process, the CLI statusline renders in the terminal process). Each
 * running job therefore publishes two tiny files another process can scan:
 *
 *   <data>/shell-jobs/<jobId>.json        detail (pid, command, cwd, owner)
 *   <data>/shell-jobs/<jobId>.owner-<pid> owning host-process marker
 *
 * The owner marker disappears when the job settles and a `.done` marker keeps
 * the terminal JSON out of live counters. Terminal metadata remains available
 * for a bounded manual-recovery window.
 *
 * Ordering: a promoted job keeps its foreground id, so the foreground marker's
 * retire and the promoted job's publish address the same files. Every publish,
 * complete and retire for one jobId therefore runs on a per-job chain, strictly
 * in call order and never overlapping. A record is written atomically (temp
 * file + rename) and always before its owner marker, so a reader never sees a
 * partial `.json`, and a marker never exists without its `.json`.
 */
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { holdsNoData, writeJsonAtomicAsync } from '../../../../../shared/atomic-file.mjs';
import { isPidAlive } from '../../../../../shared/pid-liveness.mjs';
import { displayShellCommand } from '../../../../../shared/shell-display.mjs';
import { tryAdmitWorkspaceActivity } from '../../../../../shared/worktrees/activity-gate.mjs';
import { worktreeError } from '../../../../../shared/worktrees/contract.mjs';
import { workspaceSees } from '../../../../../shared/worktrees/workspace-visibility.mjs';

const workspaceLeases = new Map();

/** Transfer a foreground reader to a surviving-descendant task without a lease gap. */
export function adoptShellWorkspaceAdmission(jobId, leave) {
  const prior = workspaceLeases.get(jobId);
  workspaceLeases.set(
    jobId,
    prior
      ? () => {
          prior();
          leave();
        }
      : leave
  );
}

// A record whose owner process is gone is garbage. Age alone never deletes a
// live owner's job, so an unlimited long-running shell keeps its record.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const COMPLETED_SHELL_JOB_TTL_MS = 30 * 60 * 1000;

const chains = new Map();
const paths = new Map();
const records = new Map();
// jobId -> token of the live terminal record. Every publish/retire clears it and
// every completion replaces it, so a TTL timer armed for an older incarnation
// can tell its files are no longer the ones it was armed for.
const incarnations = new Map();
let incarnationSeq = 0;
let sweepStarted = false;

/** Run `operation` after every earlier operation for `jobId` has finished. */
function enqueue(jobId, operation) {
  const run = (chains.get(jobId) || Promise.resolve()).then(operation);
  const tail = run.catch(() => {});
  chains.set(jobId, tail);
  void tail.then(() => {
    if (chains.get(jobId) === tail) chains.delete(jobId);
  });
  return run;
}

function dataDir() {
  return process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

function jobsDir() {
  return join(dataDir(), 'shell-jobs');
}

function validJobId(jobId) {
  const value = String(jobId || '').trim();
  return /^job_[A-Za-z0-9_-]+$/.test(value) ? value : '';
}

function terminalRecord(base, detail) {
  const finishedAt = detail?.finishedAt || new Date().toISOString();
  return {
    ...(base || {}),
    jobId: String(detail?.jobId || base?.jobId || ''),
    kind: 'bash',
    status: String(detail?.status || 'failed'),
    command: displayShellCommand(detail?.command || base?.command || ''),
    cwd: String(detail?.cwd || base?.cwd || ''),
    pid: Number(detail?.pid || base?.pid) || null,
    ownerHostPid: Number(detail?.clientHostPid || base?.ownerHostPid) || null,
    ownerSessionId: detail?.ownerSessionId || base?.ownerSessionId || null,
    startedAt: detail?.startedAt || base?.startedAt || null,
    finishedAt,
    exitCode: Number.isInteger(detail?.exitCode) ? detail.exitCode : null,
    signal: detail?.signal || null,
    error: detail?.error || null,
    summary: detail?.summary || null,
    stdoutPreview: detail?.stdoutPreview || '',
    stderrPreview: detail?.stderrPreview || '',
    stdoutPath: detail?.stdoutPath || null,
    stderrPath: detail?.stderrPath || null,
    recordedAt: new Date().toISOString(),
  };
}

async function removePaths(list) {
  await Promise.all((list || []).map((path) => rm(path, { force: true }).catch(() => {})));
}

/** One-shot per process: drop records left behind by dead owners. */
async function sweepOrphanRecords(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const ownerByJob = new Map();
  for (const name of names) {
    const index = name.lastIndexOf('.owner-');
    if (index > 0) ownerByJob.set(name.slice(0, index), Number(name.slice(index + 7)) || 0);
  }
  // Owner markers whose detail JSON is already gone (a terminal record aged
  // out past its TTL) are unreachable garbage: this sweep walks .json files,
  // so nothing would ever revisit them. Clear the strays before the walk.
  const jsonJobIds = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)));
  const strayMarkers = names.filter((name) => {
    const index = name.lastIndexOf('.owner-');
    return index > 0 && !jsonJobIds.has(name.slice(0, index));
  });
  if (strayMarkers.length) {
    await removePaths(strayMarkers.map((name) => join(dir, name)));
  }
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const terminalCutoff = Date.now() - COMPLETED_SHELL_JOB_TTL_MS;
  const done = new Set(names.filter((name) => name.endsWith('.done')).map((name) => name.slice(0, -5)));
  // The detail JSON plus every `<jobId>.*` marker beside it.
  const removeJobFiles = (name, jobId) =>
    removePaths(
      names
        .filter((sibling) => sibling === name || sibling.startsWith(`${jobId}.`))
        .map((sibling) => join(dir, sibling))
    );
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.slice(0, -5);
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(join(dir, name))).mtimeMs;
    } catch {
      continue;
    }
    if (done.has(jobId)) {
      if (mtimeMs >= terminalCutoff) continue;
      await removeJobFiles(name, jobId);
      continue;
    }
    if (isPidAlive(ownerByJob.get(jobId) || 0)) continue;
    // A brand-new record whose owner marker has not landed yet is not an
    // orphan; only settled-and-abandoned records are swept.
    if (mtimeMs >= cutoff) continue;
    await removeJobFiles(name, jobId);
  }
}

/** Publish the record for a job that has just started or been promoted. */
export function publishShellJobRecord(
  task,
  {
    ownerSessionId = null,
    clientHostPid = null,
    startedAtMs = 0,
    foreground = false,
    terminationUnconfirmed = false,
  } = {}
) {
  const jobId = String(task?.jobId || '').trim();
  if (!jobId) return;
  if (task?.cwd) {
    const leave = tryAdmitWorkspaceActivity(ownerSessionId || jobId, task.cwd, {
      pid: Number(task.pid) || process.pid,
      kind: 'command',
    });
    if (!leave) throw worktreeError('WORKTREE_BUSY_JOBS', 'The command folder is being managed.');
    // A descendant handoff can reuse the job id with a different live pid.
    // Acquire its reader before releasing any predecessor's admission.
    adoptShellWorkspaceAdmission(jobId, leave);
  }
  const ownerPid = Number(clientHostPid ?? task?.clientHostPid) || process.pid;
  const dir = jobsDir();
  const jsonPath = join(dir, `${jobId}.json`);
  const ownerPath = join(dir, `${jobId}.owner-${ownerPid}`);
  paths.set(jobId, [jsonPath, ownerPath]);
  void enqueue(jobId, async () => {
    try {
      await mkdir(dir, { recursive: true });
      if (!sweepStarted) {
        sweepStarted = true;
        await sweepOrphanRecords(dir);
      }
      const record = {
        jobId,
        kind: 'bash',
        status: 'running',
        command: displayShellCommand(task?.command || ''),
        cwd: String(task?.cwd || ''),
        pid: Number(task?.pid) || null,
        shellType: task?.shellType || null,
        ownerHostPid: ownerPid,
        ownerSessionId: ownerSessionId ? String(ownerSessionId) : task?.ownerSessionId || null,
        // The caller's start moment wins: a warm-standby shell reports
        // when its process was created, not when this command was fed
        // to it.
        startedAt:
          Number(startedAtMs) > 0
            ? new Date(Math.floor(Number(startedAtMs))).toISOString()
            : task?.startedAt || new Date().toISOString(),
        // Foreground records exist only while the command runs and are
        // removed on settle. Restart recovery skips them: there is no
        // task id to report and no waiter to notify.
        ...(foreground ? { foreground: true } : {}),
        // A killed command whose processes are not confirmed gone: its
        // result is reported, but the readouts keep listing it.
        ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}),
        // Its owner session closed: any session that sees the folder lists
        // (and may release) it.
        ...(closedOwnerSessions.has(String(ownerSessionId || '')) ? { ownerSessionClosed: true } : {}),
      };
      records.set(jobId, record);
      incarnations.delete(jobId);
      // The record lands whole before the marker that advertises it.
      await writeJsonAtomicAsync(jsonPath, record, { fsync: false });
      await writeFile(ownerPath, '', 'utf8');
    } catch {
      /* the record is presentation only; never fail a job for it */
    }
  });
}

/** Preserve a bounded terminal snapshot for manual recovery after restart. */
// jobId -> { ownerSessionId, release } for every job whose result is reported
// but whose processes are not confirmed gone. The hold is dropped by the
// termination watch on confirmation, or by an explicit user force-release —
// never by a timer.
const terminationHolds = new Map();
// Owner sessions that closed in this runtime: their holds have no owner left
// to release them, so any session that sees the workspace may.
const closedOwnerSessions = new Set();

export function registerTerminationHold(jobId, { ownerSessionId = null, cwd = null, release }) {
  const key = String(jobId || '').trim();
  if (key && typeof release === 'function') terminationHolds.set(key, { ownerSessionId, cwd, release });
}

export function clearTerminationHold(jobId) {
  terminationHolds.delete(String(jobId || '').trim());
}

/** The owner session closed: its live records are flagged so every surface
 *  can list them for the sessions that see their folder. */
export function noteShellOwnerSessionClosed(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  closedOwnerSessions.add(id);
  for (const [jobId, record] of records) {
    if (record?.ownerSessionId === id) void patchRunningShellJobRecord(jobId, { ownerSessionClosed: true });
  }
}

const releaseRequestPath = (key) => join(jobsDir(), `${key}.release-requested`);

async function requestRemoteRelease(key, caller) {
  const id = validJobId(key);
  const record = id ? JSON.parse(await readFile(join(jobsDir(), `${id}.json`), 'utf8')) : null;
  if (record?.status !== 'running' || record.terminationUnconfirmed !== true) throw new Error('not held');
  const hold = { ownerSessionId: record.ownerSessionId || null, cwd: record.cwd };
  if (!mayRelease(hold, { ...caller, ownerClosed: record.ownerSessionClosed === true })) {
    throw new Error('not permitted');
  }
  await writeFile(releaseRequestPath(id), '', 'utf8');
  return { released: true, deferred: true };
}

/** Consume a cross-process release request for `jobId`; true when one existed. */
export function takeReleaseRequest(jobId) {
  const key = validJobId(jobId);
  if (!key) return false;
  try {
    unlinkSync(releaseRequestPath(key));
    return true;
  } catch {
    return false;
  }
}

function mayRelease(hold, { callerSessionId, callerCwd, ownerClosed = closedOwnerSessions.has(hold.ownerSessionId) }) {
  if (!hold.ownerSessionId || hold.ownerSessionId === callerSessionId) return true;
  return ownerClosed && workspaceSees(hold.cwd, callerCwd);
}

/** Explicit user action ("Release anyway"): drop the workspace hold of a job
 *  whose termination is unconfirmed. The surface asks for confirmation first.
 *  The owning session may release it; once that session has closed, any
 *  session whose workspace (`callerCwd`) sees the hold's folder may. */
export async function forceReleaseTerminationHold(jobId, { callerSessionId = null, callerCwd = null } = {}) {
  const key = String(jobId || '').trim();
  const refused = { released: false, error: `no unconfirmed termination hold: ${key}` };
  const hold = terminationHolds.get(key);
  // The hold lives in another runtime process (a desktop pane's session shard):
  // its own observation loop honours the request at its next pass.
  if (!hold) return requestRemoteRelease(key, { callerSessionId, callerCwd }).catch(() => refused);
  if (!mayRelease(hold, { callerSessionId, callerCwd })) return refused;
  try {
    await hold.release();
  } catch (error) {
    return { released: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (terminationHolds.get(key) === hold) terminationHolds.delete(key);
  return { released: true };
}

/** Release the workspace admission adopted under `jobId` without a record of
 *  its own (survivors a finished foreground command left behind), once they
 *  are confirmed gone. */
export function releaseShellJobWorkspace(jobId) {
  const key = String(jobId || '').trim();
  const leave = workspaceLeases.get(key);
  if (!leave) return;
  leave();
  if (workspaceLeases.get(key) === leave) workspaceLeases.delete(key);
}

/** Flag a still-open job record as "termination unconfirmed" for the readouts. */
export function markShellJobTerminationUnconfirmed(jobId) {
  return patchRunningShellJobRecord(jobId, { terminationUnconfirmed: true });
}

/** Keep the bot-chain hop of the turn that launched a running job on its record,
 *  so a completion recovered after a restart returns at it (bot-hops.mjs). */
export function recordShellJobHop(jobId, hop) {
  return patchRunningShellJobRecord(jobId, { hop });
}

function patchRunningShellJobRecord(jobId, patch) {
  const key = validJobId(jobId);
  if (!key) return Promise.resolve(false);
  const jsonPath = join(jobsDir(), `${key}.json`);
  return enqueue(key, async () => {
    const record = records.get(key);
    if (record?.status !== 'running') return false;
    const next = { ...record, ...patch };
    records.set(key, next);
    await writeJsonAtomicAsync(jsonPath, next, { fsync: false });
    return true;
  }).catch(() => false);
}

export function completeShellJobRecord(jobId, detail) {
  const key = validJobId(jobId);
  if (!key) return Promise.resolve(false);
  const leaveWorkspace = workspaceLeases.get(key);
  const dir = jobsDir();
  const jsonPath = join(dir, `${key}.json`);
  const donePath = join(dir, `${key}.done`);
  const list = paths.get(key) || [jsonPath];
  const ownerPaths = list.filter((path) => path.includes('.owner-'));
  return enqueue(key, async () => {
    try {
      await mkdir(dir, { recursive: true });
      let base = records.get(key) || null;
      if (!base) {
        try {
          base = JSON.parse(await readFile(jsonPath, 'utf8'));
        } catch {}
      }
      const record = terminalRecord(base, { ...detail, jobId: key });
      records.set(key, record);
      await writeJsonAtomicAsync(jsonPath, record, { fsync: false });
      await writeFile(donePath, '', 'utf8');
    } finally {
      // Callers complete a record only once its processes are confirmed gone
      // (or explicitly released): the workspace admission follows that, not
      // the record write, so a failed write cannot strand it with no handle.
      leaveWorkspace?.();
      if (workspaceLeases.get(key) === leaveWorkspace) workspaceLeases.delete(key);
    }
    await removePaths(ownerPaths);
    paths.set(key, [jsonPath, donePath]);
    const incarnation = ++incarnationSeq;
    incarnations.set(key, incarnation);
    const timer = setTimeout(() => {
      // Expire through the job's queue and only if no publish, retire or newer
      // completion has replaced the files this timer was armed for.
      void enqueue(key, async () => {
        if (incarnations.get(key) !== incarnation) return;
        incarnations.delete(key);
        records.delete(key);
        paths.delete(key);
        await removePaths([jsonPath, donePath]);
      });
    }, COMPLETED_SHELL_JOB_TTL_MS);
    timer.unref?.();
    return true;
  }).catch(() => false);
}

/** Test support: settles once every record write queued so far for `jobId`
 *  has finished, so a test waits on the write itself, not on elapsed turns. */
export function _shellJobRecordWritesSettledForTest(jobId) {
  return chains.get(String(jobId || '').trim()) || Promise.resolve();
}

export async function readShellJobRecord(jobId, { strict = false } = {}) {
  const key = validJobId(jobId);
  if (!key) return null;
  const dir = jobsDir();
  const jsonPath = join(dir, `${key}.json`);
  try {
    const text = await readFile(jsonPath, 'utf8');
    // A crash left no data (fsync is off for these records): nothing to inspect,
    // the same as no record, even for a strict reader.
    if (holdsNoData(text)) return null;
    const record = JSON.parse(text);
    if (
      strict &&
      (!record ||
        !['running', 'completed', 'failed', 'cancelled'].includes(record.status) ||
        (record.status === 'running' && !record.cwd))
    )
      throw new Error(`Cannot inspect shell job ${key}.`);
    const done = await access(join(dir, `${key}.done`)).then(
      () => true,
      (error) => {
        if (strict && error?.code !== 'ENOENT') throw error;
        return false;
      }
    );
    return { ...record, recovered: true, terminal: done || record?.status !== 'running' };
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function listShellJobRecords({ strict = false } = {}) {
  const dir = jobsDir();
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return [];
  }
  const rows = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readShellJobRecord(name.slice(0, -5), { strict }))
  );
  const cutoff = Date.now() - COMPLETED_SHELL_JOB_TTL_MS;
  return rows.filter((record) => {
    if (!record) return false;
    if (!record.terminal) return true;
    const recordedAt = Date.parse(record.recordedAt || record.finishedAt || '');
    return !Number.isFinite(recordedAt) || recordedAt >= cutoff;
  });
}

/** Retire the record once the job is no longer running. */
export function retireShellJobRecord(jobId) {
  const key = String(jobId || '').trim();
  if (!key) return;
  const leaveWorkspace = workspaceLeases.get(key);
  workspaceLeases.delete(key);
  const list = paths.get(key);
  paths.delete(key);
  // Queued behind every earlier publish and ahead of any later one: a promoted
  // job publishing after this call is written only once this removal is done.
  void enqueue(key, async () => {
    records.delete(key);
    incarnations.delete(key);
    await removePaths(list);
    leaveWorkspace?.();
  });
}
