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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomicAsync } from '../../../../../shared/atomic-file.mjs';
import { isPidAlive } from '../../../../../shared/pid-liveness.mjs';
import { displayShellCommand } from '../../../../../shared/shell-display.mjs';

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
  { ownerSessionId = null, clientHostPid = null, startedAtMs = 0, foreground = false } = {}
) {
  const jobId = String(task?.jobId || '').trim();
  if (!jobId) return;
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
export function completeShellJobRecord(jobId, detail) {
  const key = validJobId(jobId);
  if (!key) return Promise.resolve(false);
  const dir = jobsDir();
  const jsonPath = join(dir, `${key}.json`);
  const donePath = join(dir, `${key}.done`);
  const list = paths.get(key) || [jsonPath];
  const ownerPaths = list.filter((path) => path.includes('.owner-'));
  return enqueue(key, async () => {
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

export async function readShellJobRecord(jobId) {
  const key = validJobId(jobId);
  if (!key) return null;
  const dir = jobsDir();
  const jsonPath = join(dir, `${key}.json`);
  try {
    const record = JSON.parse(await readFile(jsonPath, 'utf8'));
    const done = await access(join(dir, `${key}.done`)).then(
      () => true,
      () => false
    );
    return { ...record, recovered: true, terminal: done || record?.status !== 'running' };
  } catch {
    return null;
  }
}

export async function listShellJobRecords() {
  const dir = jobsDir();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readShellJobRecord(name.slice(0, -5)))
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
  const list = paths.get(key);
  paths.delete(key);
  // Queued behind every earlier publish and ahead of any later one: a promoted
  // job publishing after this call is written only once this removal is done.
  void enqueue(key, async () => {
    records.delete(key);
    incarnations.delete(key);
    await removePaths(list);
  });
}
