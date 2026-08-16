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
 * Both disappear the moment the job settles, so a scan sees exactly the jobs
 * that are still running. The layout is the one `src/ui/statusline-segments.mjs`
 * already reads; this module is only the writer side.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A record whose owner process is gone is garbage. Age alone never deletes a
// live owner's job, so an unlimited long-running shell keeps its record.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const publishing = new Map();
const paths = new Map();
const retired = new Set();
let sweepStarted = false;

function dataDir() {
    return process.env.MIXDOG_DATA_DIR
        || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; } // EPERM = alive, not ours
}

async function removePaths(list) {
    await Promise.all((list || []).map((path) => rm(path, { force: true }).catch(() => {})));
}

/** One-shot per process: drop records left behind by dead owners. */
async function sweepOrphanRecords(dir) {
    let names;
    try { names = await readdir(dir); } catch { return; }
    const ownerByJob = new Map();
    for (const name of names) {
        const index = name.lastIndexOf('.owner-');
        if (index > 0) ownerByJob.set(name.slice(0, index), Number(name.slice(index + 7)) || 0);
    }
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const jobId = name.slice(0, -5);
        if (pidAlive(ownerByJob.get(jobId) || 0)) continue;
        let mtimeMs = 0;
        try { mtimeMs = (await stat(join(dir, name))).mtimeMs; } catch { continue; }
        // A brand-new record whose owner marker has not landed yet is not an
        // orphan; only settled-and-abandoned records are swept.
        if (mtimeMs >= cutoff) continue;
        await removePaths(names
            .filter((sibling) => sibling === name || sibling.startsWith(`${jobId}.`))
            .map((sibling) => join(dir, sibling)));
    }
}

/** Publish the record for a job that has just started or been adopted. */
export function publishShellJobRecord(task, { ownerSessionId = null, clientHostPid = null } = {}) {
    const jobId = String(task?.jobId || '').trim();
    if (!jobId) return;
    const ownerPid = Number(clientHostPid ?? task?.clientHostPid) || process.pid;
    const dir = join(dataDir(), 'shell-jobs');
    const jsonPath = join(dir, `${jobId}.json`);
    const ownerPath = join(dir, `${jobId}.owner-${ownerPid}`);
    retired.delete(jobId);
    paths.set(jobId, [jsonPath, ownerPath]);
    const work = (async () => {
        try {
            await mkdir(dir, { recursive: true });
            if (!sweepStarted) {
                sweepStarted = true;
                await sweepOrphanRecords(dir);
            }
            await writeFile(jsonPath, `${JSON.stringify({
                jobId,
                kind: 'bash',
                status: 'running',
                command: String(task?.command || ''),
                cwd: String(task?.cwd || ''),
                pid: Number(task?.pid) || null,
                shellType: task?.shellType || null,
                ownerHostPid: ownerPid,
                ownerSessionId: ownerSessionId
                    ? String(ownerSessionId)
                    : (task?.ownerSessionId || null),
                startedAt: task?.startedAt || new Date().toISOString(),
            }, null, 2)}\n`, 'utf8');
            await writeFile(ownerPath, '', 'utf8');
        } catch { /* the record is presentation only; never fail a job for it */ }
        // A job that settled while the write was in flight must not leave a
        // record behind.
        if (retired.has(jobId)) await removePaths([jsonPath, ownerPath]);
    })();
    publishing.set(jobId, work);
    void work.finally(() => {
        if (publishing.get(jobId) === work) publishing.delete(jobId);
    });
}

/** Retire the record once the job is no longer running. */
export function retireShellJobRecord(jobId) {
    const key = String(jobId || '').trim();
    if (!key) return;
    retired.add(key);
    const list = paths.get(key);
    paths.delete(key);
    const pending = publishing.get(key);
    void (async () => {
        try { await pending; } catch { /* the publish path owns its failure */ }
        await removePaths(list);
        retired.delete(key);
    })();
}
