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
 */
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { displayShellCommand } from '../../../../../shared/shell-display.mjs';

// A record whose owner process is gone is garbage. Age alone never deletes a
// live owner's job, so an unlimited long-running shell keeps its record.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
export const COMPLETED_SHELL_JOB_TTL_MS = 30 * 60 * 1000;

const publishing = new Map();
const paths = new Map();
const records = new Map();
const retired = new Set();
let sweepStarted = false;

function dataDir() {
    return process.env.MIXDOG_DATA_DIR
        || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

export function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; } // EPERM = alive, not ours
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
    try { names = await readdir(dir); } catch { return; }
    const ownerByJob = new Map();
    for (const name of names) {
        const index = name.lastIndexOf('.owner-');
        if (index > 0) ownerByJob.set(name.slice(0, index), Number(name.slice(index + 7)) || 0);
    }
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const terminalCutoff = Date.now() - COMPLETED_SHELL_JOB_TTL_MS;
    const done = new Set(names.filter((name) => name.endsWith('.done')).map((name) => name.slice(0, -5)));
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const jobId = name.slice(0, -5);
        let mtimeMs = 0;
        try { mtimeMs = (await stat(join(dir, name))).mtimeMs; } catch { continue; }
        if (done.has(jobId)) {
            if (mtimeMs >= terminalCutoff) continue;
            await removePaths(names
                .filter((sibling) => sibling === name || sibling.startsWith(`${jobId}.`))
                .map((sibling) => join(dir, sibling)));
            continue;
        }
        if (pidAlive(ownerByJob.get(jobId) || 0)) continue;
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
            const record = {
                jobId,
                kind: 'bash',
                status: 'running',
                command: displayShellCommand(task?.command || ''),
                cwd: String(task?.cwd || ''),
                pid: Number(task?.pid) || null,
                shellType: task?.shellType || null,
                ownerHostPid: ownerPid,
                ownerSessionId: ownerSessionId
                    ? String(ownerSessionId)
                    : (task?.ownerSessionId || null),
                startedAt: task?.startedAt || new Date().toISOString(),
            };
            records.set(jobId, record);
            await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
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

/** Preserve a bounded terminal snapshot for manual recovery after restart. */
export function completeShellJobRecord(jobId, detail) {
    const key = validJobId(jobId);
    if (!key) return Promise.resolve(false);
    const dir = join(dataDir(), 'shell-jobs');
    const jsonPath = join(dir, `${key}.json`);
    const donePath = join(dir, `${key}.done`);
    const list = paths.get(key) || [jsonPath];
    const ownerPaths = list.filter((path) => path.includes('.owner-'));
    const pending = publishing.get(key);
    const work = (async () => {
        try { await pending; } catch {}
        await mkdir(dir, { recursive: true });
        let base = records.get(key) || null;
        if (!base) {
            try { base = JSON.parse(await readFile(jsonPath, 'utf8')); } catch {}
        }
        const record = terminalRecord(base, { ...detail, jobId: key });
        records.set(key, record);
        await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        await writeFile(donePath, '', 'utf8');
        await removePaths(ownerPaths);
        paths.set(key, [jsonPath, donePath]);
        const timer = setTimeout(() => {
            records.delete(key);
            paths.delete(key);
            void removePaths([jsonPath, donePath]);
        }, COMPLETED_SHELL_JOB_TTL_MS);
        timer.unref?.();
        return true;
    })().catch(() => false);
    return work;
}

export async function readShellJobRecord(jobId) {
    const key = validJobId(jobId);
    if (!key) return null;
    const dir = join(dataDir(), 'shell-jobs');
    const jsonPath = join(dir, `${key}.json`);
    try {
        const record = JSON.parse(await readFile(jsonPath, 'utf8'));
        const done = await access(join(dir, `${key}.done`)).then(() => true, () => false);
        return { ...record, recovered: true, terminal: done || record?.status !== 'running' };
    } catch {
        return null;
    }
}

export async function listShellJobRecords() {
    const dir = join(dataDir(), 'shell-jobs');
    let names;
    try { names = await readdir(dir); } catch { return []; }
    const rows = await Promise.all(names
        .filter((name) => name.endsWith('.json'))
        .map((name) => readShellJobRecord(name.slice(0, -5))));
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
    retired.add(key);
    records.delete(key);
    const list = paths.get(key);
    paths.delete(key);
    const pending = publishing.get(key);
    void (async () => {
        try { await pending; } catch { /* the publish path owns its failure */ }
        await removePaths(list);
        retired.delete(key);
    })();
}
