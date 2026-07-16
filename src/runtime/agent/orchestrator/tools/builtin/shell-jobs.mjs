import { spawn } from 'child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'fs';
import { basename } from 'path';
import { stripAnsi } from '../shell-command.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from '../env-scrub.mjs';
import {
    normalizeToolNotifyContext,
    notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
import {
    renderShellCompletionEnvelope,
    shellCompletionInstruction,
    renderShellPromptStallEnvelope,
    shellPromptStallInstruction,
} from '../../../../shared/task-notification-envelope.mjs';
import {
    completeBackgroundTask,
    notifyBackgroundTaskProgress,
    getBackgroundTask,
} from '../../../../shared/background-tasks.mjs';
import { startChildGuardian } from '../../../../shared/child-guardian.mjs';
import { detachedSpawnOpts } from '../../../../shared/spawn-flags.mjs';
import {
    getShellJobsDir,
    shellJobStdoutPath,
    shellJobStderrPath,
    shellJobExitPath,
    shellJobDonePath,
    shellJobEnforcedPath,
    resolveJobOwnerHostPid,
    trimShellJobSpill,
    writeShellJobDetail,
    readShellJobDetail,
} from './shell-job-paths.mjs';
import {
    isPidAlive,
    trackProcessTreeQuiescence,
    killProcessTree,
    _unregisterLiveJobPid,
    _installShellJobsExitHook,
    _registerLiveJobPid,
    _liveJobPids,
    _liveJobIdsByPid,
    _killLiveJobPid,
} from './shell-job-process.mjs';

// Facade re-exports: path/detail helpers and the job-not-found message moved
// to sibling modules; keep existing importers of shell-jobs.mjs resolving.
export { buildJobNotFoundMessage } from './shell-job-paths.mjs';

globalThis.__mixdogShellJobsRuntimeLoaded = true;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const SPAWN_ERROR_GUARD = Symbol('mixdog.spawnErrorGuard');
function awaitSpawnReady(child, label) {
    return new Promise((resolve, reject) => {
        if (!child || typeof child.once !== 'function') {
            reject(new Error(`${label} spawn returned no child process`));
            return;
        }
        let spawned = false;
        let bufferedError = null;
        const cleanup = () => child.removeListener('spawn', onSpawn);
        const onError = (error) => {
            if (spawned) {
                bufferedError = bufferedError || error;
                return;
            }
            cleanup();
            child.removeListener('error', onError);
            reject(error);
        };
        const onSpawn = () => {
            cleanup();
            spawned = true;
            const pid = Number(child.pid);
            if (!Number.isFinite(pid) || pid <= 0) {
                child.removeListener('error', onError);
                reject(new Error(`${label} spawn returned no pid`));
                return;
            }
            child[SPAWN_ERROR_GUARD] = {
                adopt(handler) {
                    child.on('error', handler);
                    child.removeListener('error', onError);
                    if (bufferedError) handler(bufferedError);
                    delete child[SPAWN_ERROR_GUARD];
                },
                discard() {
                    child.removeListener('error', onError);
                    delete child[SPAWN_ERROR_GUARD];
                },
            };
            resolve(child);
        };
        child.once('error', onError);
        child.once('spawn', onSpawn);
    });
}

function adoptSpawnErrorHandler(child, handler) {
    const guard = child?.[SPAWN_ERROR_GUARD];
    if (guard) guard.adopt(handler);
    else child?.on?.('error', handler);
}

async function rollbackSpawnedChild(child, { timeoutMs = 5000 } = {}) {
    if (!child || child.exitCode != null || child.signalCode != null) {
        return { confirmed: true, errors: [] };
    }
    const errors = [];
    let timer = null;
    let settled = false;
    const outcome = await new Promise((resolve) => {
        const finish = (confirmed) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.removeListener('exit', onExit);
            child.removeListener('close', onExit);
            child.removeListener('error', onError);
            resolve({ confirmed, errors });
        };
        const onExit = () => finish(true);
        const onError = (error) => { errors.push(error); };
        child.on('error', onError);
        child.once('exit', onExit);
        child.once('close', onExit);
        timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 5000));
        try { killProcessTree(child.pid, 'SIGKILL'); } catch (error) { errors.push(error); }
        try { child.kill?.('SIGKILL'); } catch (error) { errors.push(error); }
    });
    return outcome;
}

const JOB_STATUS_PREVIEW_MAX_BYTES = 4096;
const JOB_STATUS_PREVIEW_MAX_LINES = 20;
const JOB_STATUS_PREVIEW_MAX_CHARS = 1200;
// Hard ceiling on a background job's on-disk stdout+stderr. Mirrors the
// foreground SHELL_OUTPUT_DISK_CAP (shell-command.mjs) so a runaway
// background loop is killed and flagged instead of filling the filesystem.
const SHELL_JOB_OUTPUT_DISK_CAP = 100 * 1024 * 1024;
// Poll cadence for the adopted-job output-cap self-tick (mirrors the
// foreground sizeWatchdog in shell-command.mjs).
const ADOPTED_JOB_CAP_POLL_MS = 1_000;

// Combined byte size of a job's spilled stdout/stderr files, or 0 if
// unreadable. mergeStderr collapses both onto stdoutPath, so count it once.
function shellJobOutputBytes(detail) {
    let total = 0;
    const seen = new Set();
    for (const p of [detail?.stdoutPath, detail?.stderrPath]) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        try {
            if (existsSync(p)) total += statSync(p).size;
        } catch { /* ignore */ }
    }
    return total;
}

function shellQuoteSingle(s) {
    return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function psSingleQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

function isPowerShellShell(shell, shellType) {
    if (shellType === 'powershell') return true;
    const stem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    return stem === 'pwsh' || stem === 'powershell';
}

function readTailPreviewSync(filePath, { maxBytes = JOB_STATUS_PREVIEW_MAX_BYTES, maxLines = JOB_STATUS_PREVIEW_MAX_LINES, maxChars = JOB_STATUS_PREVIEW_MAX_CHARS } = {}) {
    try {
        if (!filePath || !existsSync(filePath)) return null;
        const st = statSync(filePath);
        if (!st.isFile()) return null;
        const size = st.size;
        if (size <= 0) return { bytes: 0, preview: '' };
        const readBytes = Math.min(size, maxBytes);
        const fd = openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            readSync(fd, buf, 0, readBytes, size - readBytes);
            let text = buf.toString('utf8');
            if (size > readBytes) {
                const nl = text.indexOf('\n');
                if (nl !== -1) text = text.slice(nl + 1);
            }
            let lines = text.split(/\r?\n/);
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
            let truncated = size > readBytes;
            if (lines.length > maxLines) {
                lines = lines.slice(-maxLines);
                truncated = true;
            }
            let preview = lines.join('\n');
            if (preview.length > maxChars) {
                preview = preview.slice(preview.length - maxChars);
                const nl = preview.indexOf('\n');
                if (nl !== -1) preview = preview.slice(nl + 1);
                truncated = true;
            }
            return {
                bytes: size,
                preview,
                truncated,
            };
        } finally {
            try { closeSync(fd); } catch { /* ignore */ }
        }
    } catch {
        return null;
    }
}

function attachJobPreview(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const withPreview = { ...detail };
    const stdoutInfo = readTailPreviewSync(detail.stdoutPath);
    if (stdoutInfo) {
        withPreview.stdoutBytes = stdoutInfo.bytes;
        if (stdoutInfo.preview) withPreview.stdoutPreview = stdoutInfo.preview;
        if (stdoutInfo.truncated) withPreview.stdoutPreviewTruncated = true;
    }
    if (detail.mergeStderr !== true) {
        const stderrInfo = readTailPreviewSync(detail.stderrPath);
        if (stderrInfo) {
            withPreview.stderrBytes = stderrInfo.bytes;
            if (stderrInfo.preview) withPreview.stderrPreview = stderrInfo.preview;
            if (stderrInfo.truncated) withPreview.stderrPreviewTruncated = true;
        }
    }
    return withPreview;
}

function summarizeJobPreviewText(text, maxChars = 160) {
    if (typeof text !== 'string' || !text.trim()) return '';
    const lines = text
        .split(/\r?\n/)
        .map((line) => stripAnsi(line).replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (lines.length === 0) return '';
    let summary = lines[lines.length - 1];
    if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
    return summary;
}

const SHELL_JOB_PROMPT_STALL_MS = 45_000;
const SHELL_JOB_PROMPT_TAIL_BYTES = 1024;
const SHELL_JOB_PROMPT_TAIL_LINES = 16;
const SHELL_JOB_PROMPT_TAIL_CHARS = 1024;
const SHELL_JOB_PROMPT_PATTERNS = [
    /\((?:y|yes)\/(?:n|no)\)\s*[:?]?\s*$/i,
    /\[(?:y|yes)\/(?:n|no)\]\s*[:?]?\s*$/i,
    /\b(?:continue|proceed|confirm|overwrite|replace)\b[^\n]*[?:]\s*$/i,
    /\bpress\s+(?:enter|return)\b[^\n]*$/i,
    /\bdo you (?:want|wish|agree|accept)\b[^\n]*\?\s*$/i,
    /\b(?:password|passphrase|otp|verification code)\b[^\n]*[:?]\s*$/i,
];

function looksLikeInteractivePrompt(text) {
    const tail = stripAnsi(String(text || '')).trim();
    if (!tail) return false;
    const last = tail.split(/\r?\n/).slice(-4).join('\n').trim();
    return SHELL_JOB_PROMPT_PATTERNS.some((pattern) => pattern.test(last));
}

function readPromptTail(detail) {
    if (!detail || typeof detail !== 'object') return { bytes: 0, text: '' };
    const stdoutInfo = readTailPreviewSync(detail.stdoutPath, {
        maxBytes: SHELL_JOB_PROMPT_TAIL_BYTES,
        maxLines: SHELL_JOB_PROMPT_TAIL_LINES,
        maxChars: SHELL_JOB_PROMPT_TAIL_CHARS,
    });
    const stderrInfo = detail.mergeStderr === true ? null : readTailPreviewSync(detail.stderrPath, {
        maxBytes: SHELL_JOB_PROMPT_TAIL_BYTES,
        maxLines: SHELL_JOB_PROMPT_TAIL_LINES,
        maxChars: SHELL_JOB_PROMPT_TAIL_CHARS,
    });
    const bytes = (stdoutInfo?.bytes || 0) + (stderrInfo?.bytes || 0);
    const parts = [
        stdoutInfo?.preview ? `[stdout tail]\n${stdoutInfo.preview}` : '',
        stderrInfo?.preview ? `[stderr tail]\n${stderrInfo.preview}` : '',
    ].filter(Boolean);
    return { bytes, text: parts.join('\n\n') };
}

function attachJobInsights(detail) {
    const withPreview = attachJobPreview(detail);
    if (!withPreview || typeof withPreview !== 'object') return withPreview;
    let summary = '';
    let summarySource = '';
    if (withPreview.status === 'completed') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    } else if (withPreview.status === 'failed') {
        summary = summarizeJobPreviewText(withPreview.stderrPreview)
            || summarizeJobPreviewText(withPreview.stdoutPreview)
            || String(withPreview.error || '').trim();
        summarySource = summary ? (withPreview.stderrPreview ? 'stderr' : (withPreview.stdoutPreview ? 'stdout' : 'status')) : '';
    } else if (withPreview.status === 'cancelled') {
        summary = 'cancelled before completion';
        summarySource = 'status';
    } else if (withPreview.status === 'running') {
        summary = summarizeJobPreviewText(withPreview.stdoutPreview)
            || summarizeJobPreviewText(withPreview.stderrPreview);
        summarySource = summary ? (withPreview.stdoutPreview ? 'stdout' : 'stderr') : '';
    }
    if (summary) {
        withPreview.summary = summary;
        withPreview.summarySource = summarySource;
    }
    return withPreview;
}

export function shellJobPublicTaskResult(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    const result = {
        task_id: detail.jobId || detail.task_id || null,
        shell: detail.shellType || null,
        status: detail.status || null,
        cwd: detail.cwd || null,
        pid: detail.pid || null,
        exit_code: (typeof detail.exitCode === 'number') ? detail.exitCode : null,
        signal: detail.signal || null,
        timed_out: detail.timedOut === true ? true : null,
        killed: detail.killed === true ? true : null,
        stdout_bytes: (typeof detail.stdoutBytes === 'number') ? detail.stdoutBytes : null,
        stderr_bytes: (typeof detail.stderrBytes === 'number') ? detail.stderrBytes : null,
        stdout_preview: detail.stdoutPreview || null,
        stderr_preview: detail.stderrPreview || null,
        summary: detail.summary || null,
        summary_source: detail.summarySource || null,
        waited_ms: (typeof detail.waitedMs === 'number') ? detail.waitedMs : null,
        wait_timed_out: detail.waitTimedOut === true ? true : null,
        started_at: detail.startedAt || null,
        finished_at: detail.finishedAt || null,
        error: detail.error || null,
    };
    for (const [key, value] of Object.entries(result)) {
        if (value == null || value === '') delete result[key];
    }
    return result;
}

export async function waitForShellJob(jobId, { timeoutMs = 30_000, pollMs = 250 } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, timeoutMs);
    let detail = refreshShellJob(jobId);
    if (!detail) return null;
    while (detail && detail.status === 'running' && Date.now() < deadline) {
        await sleep(Math.max(25, pollMs));
        detail = refreshShellJob(jobId);
    }
    const withInsights = attachJobInsights(detail);
    if (!withInsights) return null;
    withInsights.waitedMs = Date.now() - started;
    if (withInsights.status === 'running') withInsights.waitTimedOut = true;
    return withInsights;
}

// Non-blocking peek at a background task (CC BashOutput analogue): refresh its
// status and return current stdout/stderr tail preview WITHOUT waiting for
// completion. Returns null if the job id is unknown.
export function peekShellJob(jobId) {
    const detail = refreshShellJob(jobId);
    if (!detail) return null;
    return attachJobInsights(detail);
}

// Terminate a running background task (CC KillShell analogue): kill the process
// tree and mark the job failed/137. Returns null if unknown; a detail with
// killed:false if it had already finished.
export function killShellJob(jobId) {
    const detail = readShellJobDetail(jobId);
    if (!detail) return null;
    if (detail.status !== 'running') {
        if (detail.terminationPending === true) {
            killProcessTree(detail.pid, 'SIGKILL');
            return { ...detail, killed: true, note: 'termination still awaiting confirmed process exit' };
        }
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
        return { ...detail, killed: false, note: `task already ${detail.status}` };
    }
    killProcessTree(detail.pid, 'SIGTERM');
    detail.status = 'failed';
    detail.exitCode = 137;
    detail.error = 'killed by user (KillShell)';
    detail.finishedAt = new Date().toISOString();
    trimShellJobSpill(detail);
    detail.terminationPending = true;
    writeShellJobDetail(detail);
    releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
        onConfirmed: () => {
            detail.terminationPending = false;
            try { writeShellJobDetail(detail); } catch {}
        },
    });
    return { ...attachJobInsights(detail), killed: true };
}

function refreshShellJob(jobId) {
    const detail = readShellJobDetail(jobId);
    if (!detail) return null;
    if (detail.status !== 'running') return detail;
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    // Gate completion on donePath existence. The wrapper writes the
    // exit-code file FIRST and `touch donePath` strictly AFTER, so a
    // visible donePath proves the exit file is fully flushed. Reading
    // exit before donePath landed produced empty-string -> NaN ->
    // exitCode=null -> spurious 'failed' status for processes that
    // actually exited 0.
    if (existsSync(donePath)) {
        let exitCode = null;
        try {
            const raw = readFileSync(exitPath, 'utf-8').trim();
            const parsed = parseInt(raw, 10);
            exitCode = Number.isFinite(parsed) ? parsed : null;
        } catch { /* ignore */ }
        let finishedAt = new Date().toISOString();
        try {
            finishedAt = new Date(statSync(donePath).mtimeMs).toISOString();
        } catch { /* ignore */ }
        detail.status = exitCode === 0 ? 'completed' : 'failed';
        detail.exitCode = exitCode;
        detail.finishedAt = finishedAt;
        // Job finished: cap its spill to a bounded tail so a flooding
        // producer can't leave a 100MB stdout/stderr log behind.
        trimShellJobSpill(detail);
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
        return detail;
    }
    const timeoutMs = Number(detail.timeoutMs || 0);
    const startedAtMs = Date.parse(detail.startedAt || '');
    if (timeoutMs > 0 && Number.isFinite(startedAtMs) && Date.now() - startedAtMs > timeoutMs) {
        killProcessTree(detail.pid, 'SIGTERM');
        detail.status = 'failed';
        detail.exitCode = 124;
        detail.finishedAt = new Date().toISOString();
        detail.error = `timed out after ${timeoutMs} ms`;
        trimShellJobSpill(detail);
        detail.terminationPending = true;
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
            onConfirmed: () => {
                detail.terminationPending = false;
                try { writeShellJobDetail(detail); } catch {}
            },
        });
        return detail;
    }
    // Output size watchdog: cap the job's spilled stdout/stderr at the same
    // ceiling as foreground runs. Past it, SIGKILL the tree and flag the job
    // so a runaway producer cannot fill the filesystem.
    if (shellJobOutputBytes(detail) > SHELL_JOB_OUTPUT_DISK_CAP) {
        killProcessTree(detail.pid, 'SIGKILL');
        detail.status = 'failed';
        detail.exitCode = 137;
        detail.finishedAt = new Date().toISOString();
        detail.error = `output exceeded ${SHELL_JOB_OUTPUT_DISK_CAP} byte cap`;
        trimShellJobSpill(detail);
        detail.terminationPending = true;
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
            onConfirmed: () => {
                detail.terminationPending = false;
                try { writeShellJobDetail(detail); } catch {}
            },
        });
        return detail;
    }
    if (detail.pid && !isPidAlive(detail.pid)) {
        detail.status = 'failed';
        detail.finishedAt = new Date().toISOString();
        detail.error = 'process exited without completion marker';
        writeShellJobDetail(detail);
        releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid);
    }
    return detail;
}

export async function startBackgroundShellJob(options) {
    return _startBackgroundShellJobImpl(options || {});
}

// In-process completion watcher. After a background shell task is spawned the
// Lead session has no way to learn the task finished (no polling tool is
// auto-driven), so this registers an fs.watch on the shell-jobs dir filtered
// to `<jobId>.done` plus a ~2s polling fallback (fs.watch misses on some
// network / overlay filesystems) and a hard stop at timeoutMs + grace. When
// the job completes it reads the finished detail and delivers a shared async
// execution notification with type 'shell_task_result'.
//
// CLI-owned by design. If the CLI/runtime process exits, no notification is
// replayed or recovered later; shutdown cancels live jobs instead of handing
// them to a daemon.
//
// All timers are unref()'d and fs.watch is closed on completion/stop, so the
// watcher never keeps the host process alive.
const SHELL_JOB_WATCH_POLL_MS = 2000;
const SHELL_JOB_WATCH_GRACE_MS = 5000;
// 32-bit timer ceiling: setTimeout delays above 2^31-1 wrap to a tiny value
// and fire immediately. The resolved timeout is already clamped at parse time
// (bash-tool.mjs TIMER_MAX_MS), but sites that add grace to it can still exceed
// the ceiling, so clamp the summed delay here too.
const TIMER_MAX_MS = 2_147_483_647;
// Registry of armed background-job watchers keyed by jobId. task wait
// and `kill` actions already hold the completed outcome, so they cancel the
// armed watcher here to prevent a double-notify when its next poll fires.
const backgroundShellJobWatchers = new Map();
// Registry-level safety net keyed by jobId. It is intentionally independent of
// the fs.watch watcher below: if the watcher is cancelled, misses an event, or
// cannot be armed because the direct notifyFn is unavailable, this poller still
// reconciles the shell job into the shared background-task row.
const shellTaskSafetyPollers = new Map();
const shellJobResourceLeases = new Map();
const unpersistedTerminalJobs = new Set();
const shellJobQuiescenceTrackers = new Map();
function releaseShellJobResourceLease(jobId) {
    const lease = shellJobResourceLeases.get(jobId);
    if (!lease) return false;
    shellJobResourceLeases.delete(jobId);
    try { Promise.resolve(lease.release()).catch(() => {}); } catch { /* admission cleanup must not mask job state */ }
    return true;
}
export function attachShellJobResourceLease(jobId, lease, { allowUnpersisted = false } = {}) {
    if (!jobId || !lease || typeof lease.release !== 'function') return false;
    if (allowUnpersisted && unpersistedTerminalJobs.delete(jobId)) {
        try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
        return false;
    }
    const detail = readShellJobDetail(jobId);
    if ((!detail && !allowUnpersisted) || (detail && detail.status !== 'running')) {
        try { Promise.resolve(lease.release()).catch(() => {}); } catch {}
        return false;
    }
    releaseShellJobResourceLease(jobId);
    shellJobResourceLeases.set(jobId, lease);
    return true;
}
function releaseShellJobOwnershipWhenQuiescent(jobId, pid, {
    onConfirmed = null,
    allowLateLease = false,
    deferUntilRootExit = false,
} = {}) {
    const numericPid = Number(pid);
    if (!jobId || !Number.isFinite(numericPid) || numericPid <= 0) return false;
    const existing = shellJobQuiescenceTrackers.get(jobId);
    if (existing) {
        if (onConfirmed) existing.callbacks.add(onConfirmed);
        if (allowLateLease) existing.allowLateLease = true;
        if (!deferUntilRootExit) existing.tracker?.rootExited?.();
        return true;
    }
    const entry = {
        callbacks: new Set(onConfirmed ? [onConfirmed] : []),
        allowLateLease,
        tracker: null,
    };
    shellJobQuiescenceTrackers.set(jobId, entry);
    entry.tracker = trackProcessTreeQuiescence(numericPid, () => {
        shellJobQuiescenceTrackers.delete(jobId);
        _unregisterLiveJobPid(numericPid);
        for (const callback of entry.callbacks) {
            try { callback(); } catch {}
        }
        if (!releaseShellJobResourceLease(jobId) && entry.allowLateLease) {
            unpersistedTerminalJobs.add(jobId);
        }
    }, { waitForRootExit: deferUntilRootExit });
    return true;
}
function trackChildUntilConfirmedExit(child, jobId, onConfirmed = null) {
    const pid = Number(child?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    _installShellJobsExitHook();
    _registerLiveJobPid(pid, jobId);
    let settled = false;
    const onError = () => {};
    const finish = () => {
        if (settled) return;
        settled = true;
        child.removeListener('exit', finish);
        child.removeListener('close', finish);
        child.removeListener('error', onError);
        releaseShellJobOwnershipWhenQuiescent(jobId, pid, {
            onConfirmed,
            allowLateLease: true,
        });
    };
    child.on('error', onError);
    child.once('exit', finish);
    child.once('close', finish);
    return true;
}
// Persistent notify ctx per jobId, set at FIRST arm and surviving cancel — so a
// re-arm after a task wait timeout can reconstruct the notify wiring without the
// caller threading the ctx back in. Deleted only in the watcher's cleanup() on
// settle (and explicitly in the kill path) so it cannot leak for entries that
// never complete.
const jobNotifyCtxByJobId = new Map();
// Live task waiter count per jobId. While >0 a synchronous caller is
// consuming the outcome, so the watcher must stay cancelled; the last waiter to
// leave (count===0) owns the decision to re-arm a still-running job.
const jobWaitWaiterCountByJobId = new Map();
const SHELL_TASK_SAFETY_POLL_MS = 5_000;
function shellJobTaskStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    return 'failed';
}
function buildShellCompletion(jobId, detail, reason) {
    const startedAtMs = Date.parse(detail?.startedAt || '');
    const finishedAtMs = Date.parse(detail?.finishedAt || '') || Date.now();
    const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null;
    const exitCode = (typeof detail?.exitCode === 'number') ? detail.exitCode : null;
    const status = detail?.status || (reason === 'timeout' ? 'running' : 'unknown');
    const body = renderShellCompletionEnvelope({
        jobId,
        status,
        exitCode,
        elapsedMs,
        command: detail?.command,
        summary: detail?.summary,
        stdoutPreview: detail?.stdoutPreview,
        stderrPreview: detail?.stderrPreview,
        mergeStderr: detail?.mergeStderr,
    });
    const taskStatus = shellJobTaskStatus(status);
    return {
        status,
        taskStatus,
        exitCode,
        body,
        instruction: shellCompletionInstruction({ jobId, status, exitCode }),
        result: shellJobPublicTaskResult(detail),
        error: taskStatus === 'failed'
            ? (detail?.error || (status === 'running' ? 'background shell watcher deadline reached' : null))
            : null,
    };
}
function clearShellTaskSafetyNet(jobId) {
    const timer = shellTaskSafetyPollers.get(jobId);
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    shellTaskSafetyPollers.delete(jobId);
}
function armShellTaskSafetyNet(jobId) {
    if (!jobId || shellTaskSafetyPollers.has(jobId)) return;
    const tick = () => {
        try {
            const task = getBackgroundTask(jobId);
            if (!task || task.status !== 'running') {
                clearShellTaskSafetyNet(jobId);
                return;
            }
            const detail = attachJobInsights(refreshShellJob(jobId)) || readShellJobDetail(jobId);
            if (!detail) {
                completeBackgroundTask(jobId, {
                    status: 'failed',
                    error: 'shell job detail missing during safety reconciliation',
                    resultType: 'shell_task_result',
                    terminalReason: 'shell-safety-missing-detail',
                });
                clearShellTaskSafetyNet(jobId);
                return;
            }
            if (detail.status === 'running') return;
            // While a manual `task wait` caller is consuming the result
            // synchronously, do not send the async completion. The wait path
            // marks the task terminal with notify:false, and this poller will
            // stop on its next tick.
            if ((jobWaitWaiterCountByJobId.get(jobId) || 0) > 0) return;
            const completion = buildShellCompletion(jobId, detail, 'safety');
            completeBackgroundTask(jobId, {
                status: completion.taskStatus,
                result: completion.result,
                resultText: completion.body,
                error: completion.error,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                terminalReason: 'shell-safety-reconcile',
            });
            clearShellTaskSafetyNet(jobId);
        } catch (err) {
            try { process.stderr.write(`[shell-jobs] shell task safety poll failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
        }
    };
    const timer = setInterval(tick, SHELL_TASK_SAFETY_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    shellTaskSafetyPollers.set(jobId, timer);
}
function markShellJobCancelledByShutdown(jobId, reason = 'shutdown') {
    const detail = readShellJobDetail(jobId);
    if (!detail || detail.status !== 'running') return false;
    detail.status = 'cancelled';
    detail.exitCode = 137;
    detail.killed = true;
    detail.error = `cancelled by runtime shutdown (${reason})`;
    detail.finishedAt = new Date().toISOString();
    try { writeFileSync(detail.exitPath || shellJobExitPath(jobId), '137'); } catch { /* ignore */ }
    try { writeFileSync(detail.donePath || shellJobDonePath(jobId), ''); } catch { /* ignore */ }
    detail.terminationPending = true;
    writeShellJobDetail(detail);
    releaseShellJobOwnershipWhenQuiescent(jobId, detail.pid, {
        onConfirmed: () => {
            detail.terminationPending = false;
            try { writeShellJobDetail(detail); } catch {}
        },
    });
    return true;
}
// Register a synchronous task waiter. Paired with endShellJobWait in a
// finally so the count can't leak on throw.
export function beginShellJobWait(jobId) {
    jobWaitWaiterCountByJobId.set(jobId, (jobWaitWaiterCountByJobId.get(jobId) || 0) + 1);
}
// Deregister a synchronous task waiter; returns the POST-decrement count so
// the last leaver (0) can decide whether to re-arm.
export function endShellJobWait(jobId) {
    const next = (jobWaitWaiterCountByJobId.get(jobId) || 0) - 1;
    if (next <= 0) { jobWaitWaiterCountByJobId.delete(jobId); return 0; }
    jobWaitWaiterCountByJobId.set(jobId, next);
    return next;
}
// Drop the persistent notify ctx for a jobId. Called from the kill path after
// cancel so a killed-but-never-fired entry can't leak its ctx.
export function clearShellJobNotifyCtx(jobId) {
    jobNotifyCtxByJobId.delete(jobId);
}
export function shutdownShellJobs(reason = 'runtime-close', { sync = false } = {}) {
    const livePids = [..._liveJobPids];
    const jobIds = new Set([..._liveJobIdsByPid.values()].filter(Boolean));
    const watcherJobIds = [...backgroundShellJobWatchers.keys()];
    for (const jobId of watcherJobIds) {
        jobIds.add(jobId);
        try { cancelBackgroundShellJobWatch(jobId); } catch { /* ignore */ }
    }
    for (const pid of livePids) _killLiveJobPid(pid, { sync });
    let marked = 0;
    for (const jobId of jobIds) {
        try { if (markShellJobCancelledByShutdown(jobId, reason)) marked += 1; } catch { /* ignore */ }
    }
    unpersistedTerminalJobs.clear();
    backgroundShellJobWatchers.clear();
    for (const jobId of [...shellTaskSafetyPollers.keys()]) clearShellTaskSafetyNet(jobId);
    jobNotifyCtxByJobId.clear();
    jobWaitWaiterCountByJobId.clear();
    return { killed: livePids.length, cancelledJobs: marked, cancelledWatchers: watcherJobIds.length };
}
// Cancel (and unregister) an armed watcher without notifying. Idempotent: a
// no-op when no watcher is armed, and the per-watcher cancel respects the
// `settled` guard so it cannot race a real completion notify. The persistent
// notify ctx survives cancel (see jobNotifyCtxByJobId) so a re-arm can recover
// it; return value is no longer relied upon by callers.
export function cancelBackgroundShellJobWatch(jobId) {
    const entry = backgroundShellJobWatchers.get(jobId);
    if (!entry) return null;
    if (typeof entry.cancel === 'function') entry.cancel();
    return entry.notifyCtx || null;
}
// notifyCtx may be omitted on RE-ARM — it then falls back to the persistent
// ctx captured at first arm (jobNotifyCtxByJobId).
export function watchBackgroundShellJob(jobId, notifyCtx) {
    armShellTaskSafetyNet(jobId);
    const ctx = (notifyCtx && typeof notifyCtx.notifyFn === 'function')
        ? normalizeToolNotifyContext(notifyCtx)
        : (jobId ? jobNotifyCtxByJobId.get(jobId) : null);
    if (!jobId || !ctx || typeof ctx.notifyFn !== 'function') {
        // Direct/non-dispatch callers have no push target; the task still runs
        // and remains pollable via task control, so this is not a failure.
        return;
    }
    // Idempotent arm: if a watcher is already registered for this jobId, leave
    // it in place. Lets task wait's re-arm-after-timeout path call this
    // unconditionally without stacking duplicate watchers.
    if (backgroundShellJobWatchers.has(jobId)) return;
    // Persist the notify ctx on FIRST arm so a later re-arm can recover it even
    // after cancel cleared the live watcher entry.
    jobNotifyCtxByJobId.set(jobId, ctx);
    let settled = false;
    // Distinguishes a bare cancel (keep ctx for re-arm) from a real settle
    // (fire/timeout/hard-stop → drop ctx). cleanup() reads this.
    let cancelled = false;
    let watcher = null;
    let pollTimer = null;
    let hardStopTimer = null;
    let lastOutputBytes = null;
    let lastOutputAtMs = Date.now();
    let promptStallNotified = false;
    const cleanup = () => {
        if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
        if (pollTimer) { try { clearInterval(pollTimer); } catch { /* ignore */ } pollTimer = null; }
        if (hardStopTimer) { try { clearTimeout(hardStopTimer); } catch { /* ignore */ } hardStopTimer = null; }
        backgroundShellJobWatchers.delete(jobId);
        // Drop the persistent ctx only on a real settle (fire/timeout/hard-stop)
        // — NOT on a bare cancel, which keeps it for a possible re-arm.
        if (settled && !cancelled) jobNotifyCtxByJobId.delete(jobId);
    };
    // Cancel without notifying — used by task wait/cancel paths, which
    // already hold the completed outcome. Idempotent via the `settled` guard
    // so it can never race or double-fire against a real completion notify.
    const cancel = () => {
        if (settled) return;
        settled = true;
        cancelled = true;
        cleanup();
    };
    backgroundShellJobWatchers.set(jobId, { cancel, notifyCtx: ctx });
    const fire = (reason) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
            const detail = attachJobInsights(refreshShellJob(jobId)) || readShellJobDetail(jobId);
            if (!detail) return;
            const completion = buildShellCompletion(jobId, detail, reason);
            const completedTask = completeBackgroundTask(jobId, {
                status: completion.taskStatus,
                result: completion.result,
                resultText: completion.body,
                error: completion.error,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                terminalReason: `shell-watcher-${reason || 'done'}`,
            });
            clearShellTaskSafetyNet(jobId);
            if (completedTask) return;
            notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: completion.taskStatus,
                text: completion.body,
                resultType: 'shell_task_result',
                instruction: completion.instruction,
                context: ctx,
                logPrefix: 'shell-jobs',
            });
        } catch (err) {
            try { process.stderr.write(`[shell-jobs] watchBackgroundShellJob fire failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
        }
    };
    const maybeNotifyPromptStall = (detail) => {
        if (settled || promptStallNotified || !detail || detail.status !== 'running') return;
        const tail = readPromptTail(detail);
        const now = Date.now();
        if (lastOutputBytes === null || tail.bytes !== lastOutputBytes) {
            lastOutputBytes = tail.bytes;
            lastOutputAtMs = now;
            return;
        }
        if (now - lastOutputAtMs < SHELL_JOB_PROMPT_STALL_MS) return;
        if (!looksLikeInteractivePrompt(tail.text)) return;
        const elapsedMs = now - (Date.parse(detail.startedAt || '') || now);
        const body = renderShellPromptStallEnvelope({
            jobId,
            stalledMs: now - lastOutputAtMs,
            elapsedMs,
            command: detail.command,
            tailText: tail.text,
        });
        const instruction = shellPromptStallInstruction({ jobId });
        // Prefer the progress-notify path when a background task row exists.
        // Its once-key ('interactive-prompt-stall') dedupe returns false after
        // a re-arm even though the row is present — do NOT fall back to
        // notifyToolCompletion in that case (it would fire a duplicate). Only
        // use the completion fallback when the task row is absent (progress
        // path unavailable).
        const sent = getBackgroundTask(jobId)
            ? notifyBackgroundTaskProgress(jobId, {
                text: body,
                resultType: 'shell_task_progress',
                instruction,
                key: 'interactive-prompt-stall',
                status: null,
            })
            : notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: null,
                text: body,
                resultType: 'shell_task_progress',
                instruction,
                context: ctx,
                logPrefix: 'shell-jobs',
            });
        if (sent) promptStallNotified = true;
    };
    const checkDone = (reason) => {
        if (settled) return;
        const detail = refreshShellJob(jobId);
        // refreshShellJob flips status off 'running' once donePath/exit/timeout
        // is observed; only fire once the job is no longer running.
        if (!detail || detail.status !== 'running') fire(reason);
        else maybeNotifyPromptStall(detail);
    };
    try {
        const donePath = shellJobDonePath(jobId);
        // Already finished between spawn and watcher arm — fire immediately.
        if (existsSync(donePath)) { fire('already-done'); return; }
        const dir = getShellJobsDir();
        const doneName = `${jobId}.done`;
        try {
            watcher = fsWatch(dir, (_event, filename) => {
                if (!filename) { checkDone('watch'); return; }
                if (String(filename) === doneName) checkDone('watch');
            });
            // Don't let the FSWatcher pin the event loop — the poll fallback
            // and hard-stop timer are already unref()'d, so the watcher must
            // be too or the host process can't exit until the job completes.
            if (watcher && typeof watcher.unref === 'function') watcher.unref();
            // A watcher error (e.g. dir removed) must not crash the host; rely
            // on the poll fallback instead.
            if (watcher && typeof watcher.on === 'function') {
                watcher.on('error', () => { try { watcher.close(); } catch { /* ignore */ } watcher = null; });
            }
        } catch { watcher = null; }
        pollTimer = setInterval(() => checkDone('poll'), SHELL_JOB_WATCH_POLL_MS);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
        const timeoutMs = Number(readShellJobDetail(jobId)?.timeoutMs || 0);
        // Only arm the hard-stop when a timeout is enforced. timeoutMs<=0 means
        // unlimited: arming it would fire ~grace ms after arm and mark the job
        // failed. fs.watch + poll remain the completion paths for such jobs.
        if (timeoutMs > 0) {
            const startedAtMs = Date.parse(readShellJobDetail(jobId)?.startedAt || '') || Date.now();
            const hardStopMs = Math.min(TIMER_MAX_MS, Math.max(0, (startedAtMs + timeoutMs + SHELL_JOB_WATCH_GRACE_MS) - Date.now()));
            hardStopTimer = setTimeout(() => fire('timeout'), hardStopMs);
            if (typeof hardStopTimer.unref === 'function') hardStopTimer.unref();
        }
    } catch (err) {
        cleanup();
        try { process.stderr.write(`[shell-jobs] watchBackgroundShellJob arm failed: jobId=${jobId} err=${err?.message ?? String(err)}\n`); } catch { /* ignore */ }
    }
}

// Adopt a still-running FOREGROUND child into the shell-jobs registry. Used
// by execShellCommand's auto-background transition: the foreground one-shot
// path spawned a piped child whose stdout/stderr were already being captured
// to TaskOutput spill files. When the auto-background timer fires we do NOT
// re-spawn or wrap — the child keeps running as-is — we only publish a job
// detail so task control / refreshShellJob can track it to completion.
//
// The caller owns the child.on('close') lifecycle wiring (writing the exit
// file FIRST, donePath AFTER) so the ordering invariant refreshShellJob()
// depends on holds for adopted jobs exactly as it does for staged wrappers.
// This function only allocates the jobId/paths and writes the initial
// 'running' detail.
export function adoptForegroundShellJob({ command, cwd, pid, timeoutMs, mergeStderr, stdoutPath, stderrPath, clientHostPid }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const detail = {
        jobId,
        kind: 'bash',
        status: 'running',
        adopted: true,
        command,
        cwd,
        pid,
        mergeStderr: mergeStderr === true,
        timeoutMs: Number(timeoutMs) || 0,
        // Point the registry at the live TaskOutput spill files so
        // peek/wait previews read the same bytes the foreground capture is
        // still appending. mergeStderr collapses both onto stdoutPath.
        stdoutPath: stdoutPath || null,
        stderrPath: mergeStderr === true ? (stdoutPath || null) : (stderrPath || null),
        exitPath,
        donePath,
        // Per-terminal session stamp: the threaded clientHostPid is the
        // dispatching terminal's claude.exe pid (resolveJobOwnerHostPid falls
        // back to the single-client env only when unset).
        ownerHostPid: resolveJobOwnerHostPid(clientHostPid),
        startedAt: new Date().toISOString(),
    };
    writeShellJobDetail(detail);
    if (Number.isFinite(pid) && pid > 0) {
        _installShellJobsExitHook();
        _registerLiveJobPid(pid, jobId);
        // Adopted jobs have no staged wrapper timer and may have no active
        // task waiter, so nothing would call refreshShellJob() to enforce the
        // output cap / timeout. Drive a periodic tick until the job settles.
        _armAdoptedJobCapPoll(jobId);
    }
    return { ...detail, exitPath, donePath };
}

// Periodic self-tick for adopted (auto-backgrounded) jobs: refreshShellJob
// runs the SHELL_JOB_OUTPUT_DISK_CAP + timeout watchdogs. Stops once the job
// leaves 'running'. unref()'d so it never pins the host process.
function _armAdoptedJobCapPoll(jobId) {
    const tick = setInterval(() => {
        let detail = null;
        try { detail = refreshShellJob(jobId); } catch { /* ignore */ }
        if (!detail || detail.status !== 'running') {
            clearInterval(tick);
        }
    }, ADOPTED_JOB_CAP_POLL_MS);
    if (typeof tick.unref === 'function') tick.unref();
    return tick;
}

async function _startBackgroundShellJobImpl({
    command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg, shellArgs,
    shellType, clientHostPid, spawnFn = spawn, writeDetailFn = writeShellJobDetail,
    rollbackTimeoutMs = 5000,
}) {
    // Route ANY PowerShell shell to the PS wrapper, regardless of platform.
    // Gating on win32 sent shell:'powershell' on macOS/Linux down the POSIX
    // path below, which spawns `pwsh <wrapper>.sh` — pwsh then tries to run a
    // bash script. isPowerShellShell already matches pwsh/powershell by stem.
    if (isPowerShellShell(shell, shellType)) {
        return startBackgroundPowerShellJob({
            command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, clientHostPid,
            spawnFn, writeDetailFn,
        });
    }

    // POSIX-shell wrapper path. On Windows this runs for shell:'bash' (Git
    // Bash): the previous hard rejection here was a policy choice, NOT a real
    // invariant — every piece of this path's plumbing is shell-neutral.
    // The wrapper uses `command -v timeout`, `if ... fi`, single-quote escape
    // and POSIX exit-code propagation, all of which Git Bash executes; output
    // and exit-code plumbing flows through the staged script's own
    // `exec > … 2> …` redirect plus `printf … > exitPath` / `touch donePath`
    // (filesystem ops, not shell features); and kill goes through
    // killProcessTree(), which on win32 uses `taskkill /pid /t /f` regardless
    // of which shell spawned the tree. So Git Bash background tasks cancel,
    // capture output, and report exit codes correctly.
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = shellJobStdoutPath(jobId);
    const stderrPath = shellJobStderrPath(jobId);
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    // timeoutMs <= 0 means unlimited (async omitted default): no kernel
    // `timeout` wrapper, no enforced marker — exec the inner shell directly.
    const enforceTimeout = Number(timeoutMs) > 0;
    const timeoutSeconds = enforceTimeout ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0;
    // P2 fix: wrap with POSIX `timeout` so the kernel terminates the process
    // at deadline even if the JS-side timer is interrupted. --preserve-status
    // keeps the user command's exit code on success; on timeout the wrapper
    // exits 124.
    // `timeout` ships with GNU coreutils on Linux. On macOS, Homebrew
    // coreutils installs it as `gtimeout` (the un-prefixed name is NOT created
    // by default), so the wrapper picks `timeout` if present else `gtimeout`.
    // When neither exists it falls through to the inner command (the parent
    // setTimeout still calls refreshShellJob to clean up).
    const userCmdQuoted = shellQuoteSingle(command);
    // P2 fix: invoke the resolved shell (not bash -c) so zsh / dash /
    // alternate shells run snapshot-aware commands correctly. Drop
    // --preserve-status so timeout returns 124 unambiguously, making
    // it trivial to distinguish a timeout (124) from a user-side
    // SIGTERM exit (143).
    const innerShellQ = shellQuoteSingle(shell);
    const innerArgs = Array.isArray(shellArgs) && shellArgs.length > 0 ? shellArgs : [shellArg];
    const innerArgsQ = innerArgs.filter((arg) => arg != null && String(arg).length > 0).map(shellQuoteSingle).join(' ');
    // Runtime enforcement proof: the wrapper touches <jobId>.enforced right
    // before exec'ing `timeout`, so the marker exists iff the timeout branch
    // actually ran under the wrapper's own env/cwd. A spawn-time probe can't
    // guarantee that (env is scrubbed, cwd differs) — see shellJobEnforcedPath.
    const enforcedPath = shellJobEnforcedPath(jobId);
    // Lifecycle ordering invariant: write the exit-code file FIRST and
    // `touch donePath` strictly AFTER. refreshShellJob() gates completion
    // on donePath existence and only then trusts the exit file — without
    // this strict ordering, readFileSync on a partially-flushed exit file
    // returned '' -> parseInt NaN -> exitCode null -> spurious 'failed'
    // status for processes that actually exited 0. `rm -- "$0"` removes
    // the staged wrapper .cmd.sh after donePath is published so a host
    // crash before this point still leaves the file for the sweep to GC.
    const _innerRun = `${innerShellQ} ${innerArgsQ} ${userCmdQuoted}`;
    const _execPart = enforceTimeout
        ? `if command -v timeout >/dev/null 2>&1; then _to=timeout; elif command -v gtimeout >/dev/null 2>&1; then _to=gtimeout; else _to=; fi; if [ -n "$_to" ]; then touch ${shellQuoteSingle(enforcedPath)}; "$_to" ${timeoutSeconds} ${_innerRun}; else ${_innerRun}; fi`
        : _innerRun;
    const wrapped = `{ ${_execPart}; rc=$?; printf '%s' "$rc" > ${shellQuoteSingle(exitPath)}; touch ${shellQuoteSingle(donePath)}; rm -- "$0" 2>/dev/null; exit $rc; }`;
    // Stage the wrapped command to a .sh and let the script open its own
    // output files via `exec > … 2> …`. The parent does NOT pass file
    // descriptors via stdio inheritance (`stdio: 'ignore'` for all three).
    //
    // Let the shell own redirects via `exec > ... 2> ...` inside the staged
    // script. The child remains referenced by this CLI process; detached here
    // is only used on POSIX to create a process group for tree-kill.
    const outRedirect = mergeStderr
        ? `> ${shellQuoteSingle(stdoutPath)} 2>&1`
        : `> ${shellQuoteSingle(stdoutPath)} 2> ${shellQuoteSingle(stderrPath)}`;
    const scriptBody = `#!/usr/bin/env bash\nexec ${outRedirect}\n${wrapped}\n`;
    const wrappedTempPath = `${exitPath}.cmd.sh`;
    try {
        writeFileSync(wrappedTempPath, scriptBody);
    } catch (e) {
        return { jobId, kind: 'bash', status: 'failed', error: `failed to stage shell background task: ${e?.message || e}` };
    }
    // R11: scrub loader/execution vars even though bash-tool.mjs already
    // scrubs upstream — defense-in-depth at the spawn site catches future
    // callers that build their own spawnEnv.
    let child;
    try {
        child = spawnFn(shell, [wrappedTempPath], {
            cwd: workDir,
            env: scrubLoaderVars(scrubProviderSecrets({ ...spawnEnv })),
            stdio: 'ignore',
            ...detachedSpawnOpts,
        });
        await awaitSpawnReady(child, 'POSIX background task');
    } catch (e) {
        try { unlinkSync(wrappedTempPath); } catch {}
        return { jobId, kind: 'bash', status: 'failed', error: `failed to spawn shell background task: ${e?.message || e}` };
    }
    const detail = {
        jobId,
        kind: 'bash',
        status: 'running',
        command,
        cwd: workDir,
        pid: child.pid,
        mergeStderr,
        timeoutMs,
        timeoutSeconds,
        stdoutPath,
        stderrPath: mergeStderr ? stdoutPath : stderrPath,
        exitPath,
        donePath,
        // Per-terminal session stamp (see resolveJobOwnerHostPid).
        ownerHostPid: resolveJobOwnerHostPid(clientHostPid),
        startedAt: new Date().toISOString(),
    };
    let terminal = false;
    let runtimeOwned = false;
    const onRuntimeError = (error) => {
        if (terminal) return;
        terminal = true;
        detail.status = 'failed';
        detail.terminationPending = true;
        detail.error = `shell background task process error: ${error?.message || error}`;
        detail.finishedAt = new Date().toISOString();
        try { writeDetailFn(detail); } catch {}
        if (runtimeOwned) void (async () => {
            const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
            if (rollback.confirmed) {
                releaseShellJobOwnershipWhenQuiescent(jobId, child.pid, {
                    onConfirmed: () => {
                        detail.terminationPending = false;
                        try { writeDetailFn(detail); } catch {}
                    },
                });
            } else {
                detail.error += `; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`;
                try { writeDetailFn(detail); } catch {}
                trackChildUntilConfirmedExit(child, jobId, () => {
                    detail.terminationPending = false;
                    try { writeDetailFn(detail); } catch {}
                });
            }
        })();
    };
    adoptSpawnErrorHandler(child, onRuntimeError);
    if (terminal) {
        const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
        detail.terminationPending = !rollback.confirmed;
        try { writeDetailFn(detail); } catch {}
        try { unlinkSync(wrappedTempPath); } catch {}
        return rollback.confirmed
            ? detail
            : {
                ...detail,
                rollbackPending: trackChildUntilConfirmedExit(child, jobId, () => {
                    detail.terminationPending = false;
                    try { writeDetailFn(detail); } catch {}
                }),
                error: `${detail.error}; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`,
            };
    }
    try {
        writeDetailFn(detail);
    } catch (e) {
        terminal = true;
        const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
        child.removeListener('error', onRuntimeError);
        child[SPAWN_ERROR_GUARD]?.discard?.();
        try { unlinkSync(wrappedTempPath); } catch {}
        const failure = { jobId, kind: 'bash', status: 'failed', error: `failed to persist shell background task: ${e?.message || e}` };
        if (!rollback.confirmed) {
            failure.rollbackPending = trackChildUntilConfirmedExit(child, jobId);
            failure.error += `; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`;
        }
        return failure;
    }
    startChildGuardian({
        childPid: child.pid,
        childGroupPid: child.pid,
        label: 'shell-job',
    });
    _installShellJobsExitHook();
    _registerLiveJobPid(child.pid, jobId);
    runtimeOwned = true;
    releaseShellJobOwnershipWhenQuiescent(jobId, child.pid, {
        allowLateLease: true,
        deferUntilRootExit: true,
    });
    // Deadline cleanup poke only when a timeout is enforced; an unlimited
    // (timeoutMs<=0) job has no deadline — completion is observed via the
    // fs.watch/poll watcher and refreshShellJob on task queries.
    if (enforceTimeout) {
        const timer = setTimeout(() => { refreshShellJob(jobId); }, Math.min(TIMER_MAX_MS, timeoutMs + 25));
        if (typeof timer.unref === 'function') timer.unref();
    }
    return detail;
}

async function startBackgroundPowerShellJob({
    command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, clientHostPid,
    spawnFn = spawn, writeDetailFn = writeShellJobDetail, rollbackTimeoutMs = 5000,
}) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = shellJobStdoutPath(jobId);
    const rawStderrPath = shellJobStderrPath(jobId);
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const wrappedTempPath = `${exitPath}.cmd.ps1`;
    // Stage the USER command as its own .ps1 and run it via `-File` instead of
    // `-EncodedCommand <base64>`: the base64 token landed on the grandchild's
    // visible command line, which is a prime Defender obfuscation signature
    // (same family as the PowhidSubExec false positive). A file path on the
    // command line carries no such signature, and the payload stays opaque to
    // outer-shell quoting exactly as base64 did. UTF-8 BOM so Windows
    // PowerShell 5.1 doesn't misread non-ASCII as ANSI.
    // Trailer mirrors -Command/-EncodedCommand exit semantics (-File alone
    // does NOT propagate the last native command's exit code).
    const innerTempPath = `${exitPath}.user.ps1`;
    const innerScript = `\ufeff${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n`;
    const mergeLiteral = mergeStderr ? '$true' : '$false';
    const wrapper = [
        "$ErrorActionPreference = 'Continue'",
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
        '$OutputEncoding=[System.Text.Encoding]::UTF8',
        '$exe = (Get-Process -Id $PID).Path',
        `$innerPath = ${psSingleQuote(innerTempPath)}`,
        `$stdoutPath = ${psSingleQuote(stdoutPath)}`,
        `$stderrPath = ${psSingleQuote(rawStderrPath)}`,
        `$exitPath = ${psSingleQuote(exitPath)}`,
        `$donePath = ${psSingleQuote(donePath)}`,
        `$mergeStderr = ${mergeLiteral}`,
        // 0 (or negative) = unlimited: the wrapper's `if ($timeoutMs -gt 0 ...`
        // guard falls through to a plain WaitForExit() with no deadline. Do NOT
        // floor to 1 — that would enforce a 1ms timeout on unlimited jobs.
        `$timeoutMs = ${Math.max(0, Math.floor(timeoutMs || 0))}`,
        '$code = 1',
        'try {',
        // -ExecutionPolicy Bypass: unlike -EncodedCommand, -File is subject to
        // the execution policy on Windows PowerShell; pwsh on macOS/Linux
        // accepts the parameter as a no-op, so it is safe unconditionally.
        "    $argList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $innerPath)",
        // Do not set WindowStyle: Hidden creates a separate transient conhost.
        // On Windows, explicitly reuse the wrapper's CREATE_NO_WINDOW console.
        // NoNewWindow is unavailable on non-Windows pwsh, so only add it for
        // Windows (where $IsWindows is absent/null in Windows PowerShell 5.1).
        '    $spArgs = @{ FilePath = $exe; ArgumentList = $argList; RedirectStandardOutput = $stdoutPath; RedirectStandardError = $stderrPath; PassThru = $true }',
        '    if ($IsWindows -or $null -eq $IsWindows) { $spArgs[\'NoNewWindow\'] = $true }',
        '    $p = Start-Process @spArgs',
        '    if ($timeoutMs -gt 0 -and -not $p.WaitForExit($timeoutMs)) {',
        // Kill the whole process TREE, not just the direct child: Start-Process
        // launches an intermediate pwsh that spawns the user command, so
        // Stop-Process on $p.Id alone orphans the grandchildren. On Windows use
        // `taskkill /T /F` (tree-terminate); on macOS/Linux pwsh, fall back to
        // Stop-Process (no taskkill there).
        '        try {',
        '            if ($IsWindows -or $null -eq $IsWindows) {',
        '                & taskkill.exe /pid $p.Id /t /f 2>$null | Out-Null',
        '            } else {',
        '                try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}',
        '            }',
        '        } catch {}',
        '        $code = 124',
        '    } else {',
        '        try { $p.WaitForExit() } catch {}',
        '        $code = if ($null -ne $p.ExitCode) { [int]$p.ExitCode } else { 0 }',
        '    }',
        '} catch {',
        '    try { Add-Content -LiteralPath $stderrPath -Value ($_ | Out-String) -Encoding utf8 } catch {}',
        '    $code = 1',
        '}',
        'if ($mergeStderr) {',
        '    try {',
        '        if (Test-Path -LiteralPath $stderrPath) {',
        '            $err = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue',
        '            if ($err) { Add-Content -LiteralPath $stdoutPath -Value $err -Encoding utf8 }',
        '            Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue',
        '        }',
        '    } catch {}',
        '}',
        'try { Set-Content -LiteralPath $exitPath -Value ([string]$code) -NoNewline -Encoding ascii } catch {}',
        'try { Set-Content -LiteralPath $donePath -Value "" -NoNewline -Encoding ascii } catch {}',
        'try { Remove-Item -LiteralPath $innerPath -Force -ErrorAction SilentlyContinue } catch {}',
        'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}',
        'exit $code',
        '',
    ].join('\n');
    try {
        writeFileSync(wrappedTempPath, wrapper, 'utf-8');
        writeFileSync(innerTempPath, innerScript, 'utf-8');
    } catch (e) {
        return { jobId, kind: 'bash', status: 'failed', error: `failed to stage PowerShell background task: ${e?.message || e}` };
    }

    const shellStem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    // No `-WindowStyle Hidden` CLI switch: windowsHide:true on the spawn below
    // already gives CREATE_NO_WINDOW, and the visible command-line token trips
    // Defender's hidden-PowerShell dropper signature (PowhidSubExec). The
    // in-wrapper Start-Process uses Windows-only NoNewWindow to reuse this
    // hidden console rather than creating a transient conhost window.
    // `-ExecutionPolicy` only applies to Windows PowerShell; build per-platform.
    const isWin = process.platform === 'win32';
    const wrapperArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (isWin && shellStem === 'powershell') wrapperArgs.push('-ExecutionPolicy', 'Bypass');
    wrapperArgs.push('-File', wrappedTempPath);
    // Spawn the staged wrapper directly. detached MUST be false on Windows:
    // a native pwsh launched with detached:true + stdio:'ignore' exits
    // immediately without running -File (verified — the detached child dies
    // even while the parent stays alive; the non-detached child runs to
    // completion). windowsHide:true gives CREATE_NO_WINDOW so no console
    // window flashes on screen. The wrapper owns its own stdout/stderr file
    // redirect (exec-equivalent Set-Content paths above), so stdio:'ignore'
    // drops no output. The child remains referenced so it is owned by the CLI
    // process; runtime.close()/exit hooks reap it instead of daemonizing it.
    let child;
    try {
        child = spawnFn(shell, wrapperArgs, {
            cwd: workDir,
            env: scrubLoaderVars(scrubProviderSecrets({ ...spawnEnv })),
            detached: false,
            stdio: 'ignore',
            windowsHide: true,
        });
        await awaitSpawnReady(child, 'PowerShell background task');
    } catch (e) {
        try { unlinkSync(wrappedTempPath); } catch {}
        try { unlinkSync(innerTempPath); } catch {}
        return { jobId, kind: 'bash', status: 'failed', error: `failed to spawn PowerShell background task: ${e?.message || e}` };
    }
    const childPid = child.pid;
    if (!Number.isFinite(childPid) || childPid <= 0) {
        return { jobId, kind: 'bash', status: 'failed', error: 'PowerShell background task spawn returned no pid' };
    }
    const detail = {
        jobId,
        kind: 'bash',
        shellType: 'powershell',
        status: 'running',
        command,
        cwd: workDir,
        pid: childPid,
        mergeStderr,
        timeoutMs,
        timeoutSeconds: Number(timeoutMs) > 0 ? Math.max(1, Math.ceil(timeoutMs / 1000)) : 0,
        stdoutPath,
        stderrPath: mergeStderr ? stdoutPath : rawStderrPath,
        exitPath,
        donePath,
        // The PS wrapper enforces the deadline (WaitForExit($timeoutMs) →
        // Stop-Process → 124) only when timeoutMs>0; an unlimited job waits
        // with no deadline, so don't falsely claim enforcement.
        timeoutEnforced: Number(timeoutMs) > 0,
        // Per-terminal session stamp (see resolveJobOwnerHostPid).
        ownerHostPid: resolveJobOwnerHostPid(clientHostPid),
        startedAt: new Date().toISOString(),
    };
    let terminal = false;
    let runtimeOwned = false;
    const onRuntimeError = (error) => {
        if (terminal) return;
        terminal = true;
        detail.status = 'failed';
        detail.terminationPending = true;
        detail.error = `PowerShell background task process error: ${error?.message || error}`;
        detail.finishedAt = new Date().toISOString();
        try { writeDetailFn(detail); } catch {}
        if (runtimeOwned) void (async () => {
            const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
            if (rollback.confirmed) {
                releaseShellJobOwnershipWhenQuiescent(jobId, childPid, {
                    onConfirmed: () => {
                        detail.terminationPending = false;
                        try { writeDetailFn(detail); } catch {}
                    },
                });
            } else {
                detail.error += `; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`;
                try { writeDetailFn(detail); } catch {}
                trackChildUntilConfirmedExit(child, jobId, () => {
                    detail.terminationPending = false;
                    try { writeDetailFn(detail); } catch {}
                });
            }
        })();
    };
    adoptSpawnErrorHandler(child, onRuntimeError);
    if (terminal) {
        const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
        detail.terminationPending = !rollback.confirmed;
        try { writeDetailFn(detail); } catch {}
        try { unlinkSync(wrappedTempPath); } catch {}
        try { unlinkSync(innerTempPath); } catch {}
        return rollback.confirmed
            ? detail
            : {
                ...detail,
                rollbackPending: trackChildUntilConfirmedExit(child, jobId, () => {
                    detail.terminationPending = false;
                    try { writeDetailFn(detail); } catch {}
                }),
                error: `${detail.error}; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`,
            };
    }
    try {
        writeDetailFn(detail);
    } catch (e) {
        terminal = true;
        const rollback = await rollbackSpawnedChild(child, { timeoutMs: rollbackTimeoutMs });
        child.removeListener('error', onRuntimeError);
        child[SPAWN_ERROR_GUARD]?.discard?.();
        try { unlinkSync(wrappedTempPath); } catch {}
        try { unlinkSync(innerTempPath); } catch {}
        const failure = { jobId, kind: 'bash', status: 'failed', error: `failed to persist PowerShell background task: ${e?.message || e}` };
        if (!rollback.confirmed) {
            failure.rollbackPending = trackChildUntilConfirmedExit(child, jobId);
            failure.error += `; termination unconfirmed after ${rollbackTimeoutMs}ms (process remains tracked)`;
        }
        return failure;
    }
    startChildGuardian({
        childPid,
        childGroupPid: childPid,
        label: 'shell-job-powershell',
    });
    _installShellJobsExitHook();
    _registerLiveJobPid(childPid, jobId);
    runtimeOwned = true;
    releaseShellJobOwnershipWhenQuiescent(jobId, childPid, {
        allowLateLease: true,
        deferUntilRootExit: true,
    });
    if (Number(timeoutMs) > 0) {
        const timer = setTimeout(() => { refreshShellJob(jobId); }, Math.min(TIMER_MAX_MS, timeoutMs + 25));
        if (typeof timer.unref === 'function') timer.unref();
    }
    return detail;
}
