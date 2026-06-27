import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, watch as fsWatch, writeFileSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { basename, join } from 'path';
import { getPluginData } from '../../config.mjs';
import { stripAnsi } from '../shell-command.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from '../env-scrub.mjs';
import {
    normalizeToolNotifyContext,
    notifyToolCompletion,
} from '../../../../shared/tool-execution-contract.mjs';
import {
    completeBackgroundTask,
    notifyBackgroundTaskProgress,
} from '../../../../shared/background-tasks.mjs';
import { startChildGuardian } from '../../../../shared/child-guardian.mjs';

globalThis.__mixdogShellJobsRuntimeLoaded = true;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One-shot sweep of stale shell-job artefacts. Each backgrounded `bash`
// emits five files (.json/.done/.exit/.stdout.log/.stderr.log); the .done
// flag is written when the job exits, so a .done file older than
// SHELL_JOB_STALE_MS is the invariant proof its sibling files are also
// safe to remove. Active and recently-completed jobs are kept so
// `task` status/read/wait readers still find them. Runs once per mcp child
// lifetime on first getShellJobsDir() call. Async dirent walk + parallel
// stat/unlink keeps the main event loop free; fire-and-forget so the
// synchronous caller receives `dir` immediately.
const SHELL_JOB_STALE_MS = 24 * 60 * 60 * 1000;
let shellJobsSwept = false;
async function sweepStaleShellJobs(dir) {
    if (shellJobsSwept) return;
    shellJobsSwept = true;
    const cutoff = Date.now() - SHELL_JOB_STALE_MS;
    let names;
    try { names = await fsPromises.readdir(dir); } catch { return; }
    const expired = [];
    await Promise.all(names.map(async (name) => {
        if (!name.endsWith('.done')) return;
        const p = join(dir, name);
        try {
            const st = await fsPromises.stat(p);
            if (st.mtimeMs < cutoff) expired.push(name.slice(0, -5));
        } catch {}
    }));
    // Orphan reclaim: a crashed wrapper leaves <id>.json with no .done —
    // forever. Invariant proofs of death (either suffices, both gated on the
    // stale cutoff so a young orphan can't race its own spawn):
    //   a) deadline: the wrapper enforces timeoutMs, so an entry older than
    //      timeoutMs + grace cannot still be running — pid-reuse-proof. Only
    //      trusted on runtime proof: detail.timeoutEnforced:true (PS wrapper,
    //      unconditional) or the <id>.enforced marker the posix wrapper
    //      touches when its `timeout` branch actually runs.
    //   b) ESRCH: the recorded pid no longer exists. Alone this misses pids
    //      recycled by unrelated live processes, hence (a).
    const ORPHAN_DEADLINE_GRACE_MS = 30 * 60_000;
    const doneSet = new Set(names.filter(n => n.endsWith('.done')).map(n => n.slice(0, -5)));
    await Promise.all(names.map(async (name) => {
        if (!name.endsWith('.json')) return;
        const jobId = name.slice(0, -5);
        if (doneSet.has(jobId)) return;
        const p = join(dir, name);
        try {
            const st = await fsPromises.stat(p);
            if (st.mtimeMs >= cutoff) return;
            const detail = JSON.parse(await fsPromises.readFile(p, 'utf-8'));
            const tmo = Number(detail?.timeoutMs);
            const enforced = detail?.timeoutEnforced === true
                || existsSync(join(dir, `${jobId}.enforced`));
            const deadlinePassed = enforced
                && Number.isFinite(tmo) && tmo > 0
                && (Date.now() - st.mtimeMs) > tmo + ORPHAN_DEADLINE_GRACE_MS;
            if (!deadlinePassed) {
                const pid = Number(detail?.pid);
                if (Number.isFinite(pid) && pid > 0) {
                    try { process.kill(pid, 0); return; } // alive (or EPERM → treated dead only via ESRCH below)
                    catch (e) { if (e?.code !== 'ESRCH') return; }
                }
            }
            expired.push(jobId);
        } catch {}
    }));
    // Owner sidecar markers carry a dynamic `.owner-<pid>` suffix, so they
    // can't sit in the fixed-extension list — map each expired jobId to the
    // marker name(s) actually present in this listing and unlink those too.
    const expiredSet = new Set(expired);
    const ownerMarkers = names.filter((n) => {
        const i = n.lastIndexOf('.owner-');
        return i > 0 && expiredSet.has(n.slice(0, i));
    });
    await Promise.all([
        ...expired.flatMap((jobId) =>
            ['.json', '.done', '.exit', '.enforced', '.exit.cmd.sh', '.exit.cmd.ps1', '.stdout.log', '.stderr.log'].map((ext) =>
                fsPromises.unlink(join(dir, jobId + ext)).catch(() => {}),
            ),
        ),
        ...ownerMarkers.map((n) => fsPromises.unlink(join(dir, n)).catch(() => {})),
    ]);
}

function getShellJobsDir() {
    const dir = join(getPluginData(), 'shell-jobs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    sweepStaleShellJobs(dir);
    return dir;
}

function shellJobDetailPath(jobId) { return join(getShellJobsDir(), `${jobId}.json`); }
function shellJobStdoutPath(jobId) { return join(getShellJobsDir(), `${jobId}.stdout.log`); }
function shellJobStderrPath(jobId) { return join(getShellJobsDir(), `${jobId}.stderr.log`); }
function shellJobExitPath(jobId) { return join(getShellJobsDir(), `${jobId}.exit`); }
function shellJobDonePath(jobId) { return join(getShellJobsDir(), `${jobId}.done`); }
// Runtime proof that the posix wrapper's `timeout` branch actually ran: the
// wrapper touches this marker immediately before exec'ing `timeout`, so its
// existence is never optimistic (no spawn-time probe can guarantee the
// wrapper's own env/cwd resolution). PS jobs don't need it — their wrapper
// enforces unconditionally and records detail.timeoutEnforced:true.
function shellJobEnforcedPath(jobId) { return join(getShellJobsDir(), `${jobId}.enforced`); }
// Owner sidecar marker: a zero-byte file whose NAME encodes the owning CC host
// (claude.exe) pid — `<jobId>.owner-<pid>`. It lets the statusline owner-filter
// jobs from a SINGLE directory listing (no per-job JSON read) so the filter can
// precede its per-tick scan cap — otherwise other sessions' newer jobs evict
// this session's live jobs before filtering. Swept alongside the other
// artefacts.
function shellJobOwnerPath(jobId, pid) { return join(getShellJobsDir(), `${jobId}.owner-${pid}`); }

const JOB_STATUS_PREVIEW_MAX_BYTES = 4096;
const JOB_STATUS_PREVIEW_MAX_LINES = 20;
const JOB_STATUS_PREVIEW_MAX_CHARS = 1200;

// Resolve the CLI host pid that owns a freshly-spawned job. Standalone CLI
// execution is process-owned: background tasks are scoped to this CLI lifetime,
// and the pid stamp is only for statusline filtering / legacy sidecars.
function resolveJobOwnerHostPid(clientHostPid) {
    const explicit = Number(clientHostPid);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const envPid = Number(process.env.MIXDOG_OWNER_HOST_PID);
    if (Number.isInteger(envPid) && envPid > 0) return envPid;
    return null;
}

function writeShellJobDetail(detail) {
    // Session scope stamp: every job record is tagged with the CC host pid
    // that owns it (the claude.exe pid). This is the SAME physical pid the
    // statusline shim passes as --client-host-pid, so the statusline can count
    // only its own session's jobs by exact pid equality (no heuristic). The
    // spawn sites set detail.ownerHostPid from the per-request threaded
    // clientHostPid (resolveJobOwnerHostPid); this fallback only stamps the
    // single-client env value when no spawn-site pid was set, and NEVER
    // overwrites an existing stamp — so the field round-trips through disk on
    // refresh/kill and a correct per-terminal stamp is preserved across rewrites.
    if (detail && detail.ownerHostPid == null) {
        const hostPid = Number(process.env.MIXDOG_OWNER_HOST_PID);
        if (Number.isInteger(hostPid) && hostPid > 0) detail.ownerHostPid = hostPid;
    }
    writeFileSync(shellJobDetailPath(detail.jobId), JSON.stringify(detail, null, 2), 'utf-8');
    // Owner sidecar: encode the resolved owner pid in the marker filename so the
    // statusline can owner-filter from the directory listing alone (before its
    // scan cap). Idempotent zero-byte write — safe to repeat on refresh/kill
    // rewrites. Skipped when no owner is known (legacy/unattributed jobs).
    if (detail && Number.isInteger(detail.ownerHostPid) && detail.ownerHostPid > 0) {
        try { writeFileSync(shellJobOwnerPath(detail.jobId, detail.ownerHostPid), '', 'utf-8'); }
        catch { /* best-effort marker */ }
    }
}

function readShellJobDetail(jobId) {
    try {
        const p = shellJobDetailPath(jobId);
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

export function buildJobNotFoundMessage(jobId) {
    return `Error: task not found: ${jobId}`;
}

function isPidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killProcessTree(pid, signal = 'SIGTERM') {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else {
            try { process.kill(-pid, signal); }
            catch { process.kill(pid, signal); }
            // SIGKILL escalation: a background child that ignores SIGTERM must
            // not survive (foreground treeKill / persistent _killProcessTree
            // already do this). After a 3s grace, force-kill the group/pid.
            // unref so this backstop never holds the host process open.
            if (signal === 'SIGTERM') {
                const t = setTimeout(() => {
                    try { process.kill(-pid, 'SIGKILL'); }
                    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
                }, 3000);
                if (t.unref) t.unref();
            }
        }
        return true;
    } catch {
        return false;
    }
}

// Module-level tracking of live background-job pids so CLI shutdown can reap
// owned children. Async jobs are intentionally CLI-owned; no restart replay or
// daemon handoff is attempted.
const _liveJobPids = new Set();
const _liveJobIdsByPid = new Map();
let _shellJobsExitHookInstalled = false;
function _registerLiveJobPid(pid, jobId = null) {
    if (Number.isFinite(pid) && pid > 0) {
        _liveJobPids.add(pid);
        if (jobId) _liveJobIdsByPid.set(pid, jobId);
    }
}
function _unregisterLiveJobPid(pid) {
    if (Number.isFinite(pid) && pid > 0) {
        _liveJobPids.delete(pid);
        _liveJobIdsByPid.delete(pid);
    }
}
function _killLiveJobPid(pid, { sync = false } = {}) {
    try {
        if (process.platform === 'win32') {
            if (sync) {
                spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
                    windowsHide: true,
                    stdio: 'ignore',
                    timeout: 1500,
                });
            } else {
                spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            }
        } else {
            try { process.kill(-pid, 'SIGKILL'); }
            catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
        }
        return true;
    } catch {
        return false;
    }
}
function _sweepLiveJobsSync() {
    for (const pid of _liveJobPids) {
        _killLiveJobPid(pid, { sync: true });
    }
    _liveJobPids.clear();
    _liveJobIdsByPid.clear();
}
function _ensureProcessListenerHeadroom(events, extra = 1) {
    try {
        if (typeof process.getMaxListeners !== 'function' || typeof process.setMaxListeners !== 'function') return;
        const current = process.getMaxListeners();
        if (current === 0) return;
        let needed = current;
        for (const event of events) needed = Math.max(needed, process.listenerCount(event) + extra);
        if (needed > current) process.setMaxListeners(needed);
    } catch { /* ignore */ }
}
function _installShellJobsExitHook() {
    if (_shellJobsExitHookInstalled) return;
    _shellJobsExitHookInstalled = true;
    _ensureProcessListenerHeadroom(['exit', 'SIGTERM', 'SIGINT', 'SIGHUP'], 1);
    try { process.on('exit', _sweepLiveJobsSync); } catch { /* ignore */ }
    try { process.on('SIGTERM', _sweepLiveJobsSync); } catch { /* ignore */ }
    try { process.on('SIGINT', _sweepLiveJobsSync); } catch { /* ignore */ }
    try { process.on('SIGHUP', _sweepLiveJobsSync); } catch { /* ignore */ }
}

function shellQuoteSingle(s) {
    return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function psSingleQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

function powerShellEncodedCommand(command) {
    return Buffer.from(String(command || ''), 'utf16le').toString('base64');
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
        return { ...detail, killed: false, note: `task already ${detail.status}` };
    }
    killProcessTree(detail.pid, 'SIGTERM');
    detail.status = 'failed';
    detail.exitCode = 137;
    detail.error = 'killed by user (KillShell)';
    detail.finishedAt = new Date().toISOString();
    writeShellJobDetail(detail);
    _unregisterLiveJobPid(detail.pid);
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
        writeShellJobDetail(detail);
        _unregisterLiveJobPid(detail.pid);
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
        writeShellJobDetail(detail);
        _unregisterLiveJobPid(detail.pid);
        return detail;
    }
    if (detail.pid && !isPidAlive(detail.pid)) {
        detail.status = 'failed';
        detail.finishedAt = new Date().toISOString();
        detail.error = 'process exited without completion marker';
        writeShellJobDetail(detail);
        _unregisterLiveJobPid(detail.pid);
    }
    return detail;
}

export function startBackgroundShellJob({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg, shellArgs, shellType, clientHostPid }) {
    return _startBackgroundShellJobImpl({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg, shellArgs, shellType, clientHostPid });
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
// Registry of armed background-job watchers keyed by jobId. task wait
// and `kill` actions already hold the completed outcome, so they cancel the
// armed watcher here to prevent a double-notify when its next poll fires.
const backgroundShellJobWatchers = new Map();
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
    writeShellJobDetail(detail);
    _unregisterLiveJobPid(detail.pid);
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
    _liveJobPids.clear();
    _liveJobIdsByPid.clear();
    let marked = 0;
    for (const jobId of jobIds) {
        try { if (markShellJobCancelledByShutdown(jobId, reason)) marked += 1; } catch { /* ignore */ }
    }
    backgroundShellJobWatchers.clear();
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
            const startedAtMs = Date.parse(detail.startedAt || '');
            const finishedAtMs = Date.parse(detail.finishedAt || '') || Date.now();
            const elapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, finishedAtMs - startedAtMs) : null;
            const exitCode = (typeof detail.exitCode === 'number') ? detail.exitCode : null;
            const status = detail.status || (reason === 'timeout' ? 'running' : 'unknown');
            const lines = [
                `[task_id: ${jobId}]`,
                `[status: ${status}]`,
                `[exit: ${exitCode === null ? 'n/a' : exitCode}]`,
                elapsedMs !== null ? `[elapsed: ${elapsedMs} ms]` : null,
                detail.command ? `[command: ${detail.command}]` : null,
                '',
                detail.summary ? `Summary: ${detail.summary}` : null,
                detail.stdoutPreview ? `\n[stdout preview]\n${detail.stdoutPreview}` : null,
                (detail.mergeStderr !== true && detail.stderrPreview) ? `\n[stderr preview]\n${detail.stderrPreview}` : null,
            ].filter((l) => l !== null && l !== '');
            const body = lines.join('\n');
            const taskStatus = status === 'completed'
                ? 'completed'
                : (status === 'cancelled' ? 'cancelled' : 'failed');
            const instruction = `The background shell task ${jobId} you started earlier has finished (${status}, exit ${exitCode === null ? 'n/a' : exitCode}) - review this result in your next step.`;
            const completedTask = completeBackgroundTask(jobId, {
                status: taskStatus,
                result: shellJobPublicTaskResult(detail),
                resultText: body,
                error: taskStatus === 'failed' ? (detail.error || (status === 'running' ? 'background shell watcher deadline reached' : null)) : null,
                resultType: 'shell_task_result',
                instruction,
            });
            if (completedTask) return;
            notifyToolCompletion({
                surface: 'shell',
                id: jobId,
                status: taskStatus,
                text: body,
                resultType: 'shell_task_result',
                instruction,
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
        const body = [
            `[task_id: ${jobId}]`,
            '[status: running]',
            `[stalled: no output growth for ${now - lastOutputAtMs} ms]`,
            elapsedMs >= 0 ? `[elapsed: ${elapsedMs} ms]` : null,
            detail.command ? `[command: ${detail.command}]` : null,
            '',
            'This background shell task appears to be waiting for interactive input. Background tasks cannot answer prompts automatically; cancel it or rerun with non-interactive flags/input.',
            tail.text ? `\n${tail.text}` : null,
        ].filter((line) => line !== null && line !== '').join('\n');
        const instruction = `The background shell task ${jobId} appears to be waiting for interactive input; inspect the prompt, then cancel or rerun it non-interactively.`;
        const sent = notifyBackgroundTaskProgress(jobId, {
            text: body,
            resultType: 'shell_task_progress',
            instruction,
            key: 'interactive-prompt-stall',
            status: null,
        }) || notifyToolCompletion({
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
        const startedAtMs = Date.parse(readShellJobDetail(jobId)?.startedAt || '') || Date.now();
        const timeoutMs = Number(readShellJobDetail(jobId)?.timeoutMs || 0);
        const hardStopMs = Math.max(0, (startedAtMs + timeoutMs + SHELL_JOB_WATCH_GRACE_MS) - Date.now());
        hardStopTimer = setTimeout(() => fire('timeout'), hardStopMs);
        if (typeof hardStopTimer.unref === 'function') hardStopTimer.unref();
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
    }
    return { ...detail, exitPath, donePath };
}

function _startBackgroundShellJobImpl({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, shellArg, shellArgs, shellType, clientHostPid }) {
    // Route ANY PowerShell shell to the PS wrapper, regardless of platform.
    // Gating on win32 sent shell:'powershell' on macOS/Linux down the POSIX
    // path below, which spawns `pwsh <wrapper>.sh` — pwsh then tries to run a
    // bash script. isPowerShellShell already matches pwsh/powershell by stem.
    if (isPowerShellShell(shell, shellType)) {
        return startBackgroundPowerShellJob({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, clientHostPid });
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
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
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
    const wrapped = `{ if command -v timeout >/dev/null 2>&1; then _to=timeout; elif command -v gtimeout >/dev/null 2>&1; then _to=gtimeout; else _to=; fi; if [ -n "$_to" ]; then touch ${shellQuoteSingle(enforcedPath)}; "$_to" ${timeoutSeconds} ${innerShellQ} ${innerArgsQ} ${userCmdQuoted}; else ${innerShellQ} ${innerArgsQ} ${userCmdQuoted}; fi; rc=$?; printf '%s' "$rc" > ${shellQuoteSingle(exitPath)}; touch ${shellQuoteSingle(donePath)}; rm -- "$0" 2>/dev/null; exit $rc; }`;
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
    const child = spawn(shell, [wrappedTempPath], {
        cwd: workDir,
        env: scrubLoaderVars(scrubProviderSecrets({ ...spawnEnv })),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    startChildGuardian({
        childPid: child.pid,
        childGroupPid: child.pid,
        label: 'shell-job',
    });
    _installShellJobsExitHook();
    _registerLiveJobPid(child.pid, jobId);
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
    writeShellJobDetail(detail);
    const timer = setTimeout(() => { refreshShellJob(jobId); }, timeoutMs + 25);
    if (typeof timer.unref === 'function') timer.unref();
    return detail;
}

function startBackgroundPowerShellJob({ command, timeoutMs, workDir, mergeStderr, spawnEnv, shell, clientHostPid }) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stdoutPath = shellJobStdoutPath(jobId);
    const rawStderrPath = shellJobStderrPath(jobId);
    const exitPath = shellJobExitPath(jobId);
    const donePath = shellJobDonePath(jobId);
    const wrappedTempPath = `${exitPath}.cmd.ps1`;
    const encodedCommand = powerShellEncodedCommand(command);
    const mergeLiteral = mergeStderr ? '$true' : '$false';
    const wrapper = [
        "$ErrorActionPreference = 'Continue'",
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
        '$OutputEncoding=[System.Text.Encoding]::UTF8',
        '$exe = (Get-Process -Id $PID).Path',
        `$encoded = ${psSingleQuote(encodedCommand)}`,
        `$stdoutPath = ${psSingleQuote(stdoutPath)}`,
        `$stderrPath = ${psSingleQuote(rawStderrPath)}`,
        `$exitPath = ${psSingleQuote(exitPath)}`,
        `$donePath = ${psSingleQuote(donePath)}`,
        `$mergeStderr = ${mergeLiteral}`,
        `$timeoutMs = ${Math.max(1, Math.floor(timeoutMs || 0))}`,
        '$code = 1',
        'try {',
        "    $argList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)",
        // -WindowStyle is a Windows-only Start-Process parameter; pwsh on
        // macOS/Linux throws "not supported on this platform". Add it only on win32.
        '    $spArgs = @{ FilePath = $exe; ArgumentList = $argList; RedirectStandardOutput = $stdoutPath; RedirectStandardError = $stderrPath; PassThru = $true }',
        '    if ($IsWindows -or $null -eq $IsWindows) { $spArgs[\'WindowStyle\'] = \'Hidden\' }',
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
        'try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue } catch {}',
        'exit $code',
        '',
    ].join('\n');
    try {
        writeFileSync(wrappedTempPath, wrapper, 'utf-8');
    } catch (e) {
        return { jobId, kind: 'bash', status: 'failed', error: `failed to stage PowerShell background task: ${e?.message || e}` };
    }

    const shellStem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    // `-WindowStyle Hidden` is a Windows-only CLI switch; pwsh on macOS/Linux
    // rejects it. `-ExecutionPolicy` likewise only applies to Windows
    // PowerShell. Build args per-platform so cross-OS pwsh background tasks run.
    const isWin = process.platform === 'win32';
    const wrapperArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (isWin) wrapperArgs.push('-WindowStyle', 'Hidden');
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
        child = spawn(shell, wrapperArgs, {
            cwd: workDir,
            env: scrubLoaderVars(scrubProviderSecrets({ ...spawnEnv })),
            detached: false,
            stdio: 'ignore',
            windowsHide: true,
        });
        startChildGuardian({
            childPid: child.pid,
            childGroupPid: child.pid,
            label: 'shell-job-powershell',
        });
    } catch (e) {
        return { jobId, kind: 'bash', status: 'failed', error: `failed to spawn PowerShell background task: ${e?.message || e}` };
    }
    const childPid = child.pid;
    if (!Number.isFinite(childPid) || childPid <= 0) {
        return { jobId, kind: 'bash', status: 'failed', error: 'PowerShell background task spawn returned no pid' };
    }
    _installShellJobsExitHook();
    _registerLiveJobPid(childPid, jobId);
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
        timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        stdoutPath,
        stderrPath: mergeStderr ? stdoutPath : rawStderrPath,
        exitPath,
        donePath,
        // The PS wrapper enforces timeoutMs unconditionally in-wrapper
        // (WaitForExit($timeoutMs) → Stop-Process → 124), so the deadline
        // invariant always holds for PowerShell jobs.
        timeoutEnforced: true,
        // Per-terminal session stamp (see resolveJobOwnerHostPid).
        ownerHostPid: resolveJobOwnerHostPid(clientHostPid),
        startedAt: new Date().toISOString(),
    };
    writeShellJobDetail(detail);
    const timer = setTimeout(() => { refreshShellJob(jobId); }, timeoutMs + 25);
    if (typeof timer.unref === 'function') timer.unref();
    return detail;
}
