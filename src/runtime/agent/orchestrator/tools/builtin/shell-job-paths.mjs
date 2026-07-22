import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { basename, join } from 'path';
import { getPluginData } from '../../config.mjs';

// Bounded tail kept for a job's spilled stdout/stderr. A flooding job could
// otherwise leave a 100MB+ .stdout.log/.stderr.log sitting for up to the 24h
// stale TTL. Trimming to a few-MB tail preserves the most recent output
// (where the final error/exit context lives) while capping on-disk growth.
const SHELL_JOB_SPILL_MAX_BYTES = 4 * 1024 * 1024;
const SHELL_JOB_SPILL_KEEP_BYTES = 4 * 1024 * 1024;

// Tail-trim a single spill log in place: if it exceeds maxBytes, rewrite it
// keeping only the last keepBytes. Sync, best-effort, no-op on a missing file.
// Mirrors rotateBoundedLog in src/lib/mixdog-debug.cjs. Returns true if trimmed.
function trimShellJobSpillFile(filePath, maxBytes = SHELL_JOB_SPILL_MAX_BYTES, keepBytes = SHELL_JOB_SPILL_KEEP_BYTES) {
    try {
        const st = statSync(filePath);
        if (st.size <= maxBytes) return false;
        const buf = readFileSync(filePath);
        writeFileSync(filePath, buf.subarray(Math.max(0, buf.length - keepBytes)));
        return true;
    } catch { return false; }
}

// Trim a completed job's stdout+stderr spill files to a bounded tail. Called on
// every terminal transition so a completed flooding job can never leave a
// 100MB spill behind for the sweep to reclaim a day later. Uses the detail's
// recorded paths — adopted foreground jobs spill to shell-output/, not the
// shell-jobs dir — and dedupes when mergeStderr collapses both onto stdoutPath.
export function trimShellJobSpill(detail) {
    if (!detail) return;
    const stdoutPath = detail.stdoutPath || shellJobStdoutPath(detail.jobId);
    const stderrPath = detail.stderrPath || shellJobStderrPath(detail.jobId);
    trimShellJobSpillFile(stdoutPath);
    if (stderrPath && stderrPath !== stdoutPath) trimShellJobSpillFile(stderrPath);
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
            ['.json', '.done', '.exit', '.enforced', '.exit.cmd.sh', '.exit.cmd.ps1', '.exit.user.ps1', '.stdout.log', '.stderr.log'].map((ext) =>
                fsPromises.unlink(join(dir, jobId + ext)).catch(() => {}),
            ),
        ),
        ...ownerMarkers.map((n) => fsPromises.unlink(join(dir, n)).catch(() => {})),
    ]);
    // Size enforcement for survivors: a completed flooding job whose .done is
    // still younger than the stale cutoff isn't expired above, yet its spill
    // can hold 100MB+ for up to a day. Proof-of-death is the .done marker (NOT
    // mtime): mtime gating both truncated LIVE-but-quiet jobs whose writer
    // handle is still open — sparse-regrow corruption — AND waited a full day
    // to trim completed floods. Gating on doneSet means we only rewrite a file
    // whose producer has provably exited, which also retries kill-path trims
    // that failed silently while the killed child still held the redirect
    // handle on Windows (trimShellJobSpillFile swallows the lock error).
    await Promise.all(names.map(async (name) => {
        const isStdout = name.endsWith('.stdout.log');
        if (!isStdout && !name.endsWith('.stderr.log')) return;
        const jobId = name.slice(0, -11); // both suffixes are 11 chars
        if (expiredSet.has(jobId)) return; // already unlinked above
        if (!doneSet.has(jobId)) return;   // no completion marker → maybe live, never touch
        const p = join(dir, name);
        try {
            const st = await fsPromises.stat(p);
            if (st.size <= SHELL_JOB_SPILL_MAX_BYTES) return;
            const buf = await fsPromises.readFile(p);
            await fsPromises.writeFile(p, buf.subarray(Math.max(0, buf.length - SHELL_JOB_SPILL_KEEP_BYTES)));
        } catch {}
    }));
    sweepStaleShellOutput(dir, names);
}

// Sibling GC for spill files under $PLUGIN_DATA/shell-output/. TaskOutput
// (shell-command.mjs) spills foreground stdout/stderr there as <taskId>.stdout
// /.stderr once past the inline cap; a KEPT foreground spill (child dead at
// settle) or an adopted job's leftover then sits at up to the 100MB disk cap
// with no sweep of its own. Proof-of-death required before touching a file
// (an open writer handle is the only corruption/ENOENT-to-a-reader risk): a
// file is skipped iff some shell-job with a live pid and no .done references
// it. pid-reuse false positives err toward NOT touching. Dead files past the
// stale TTL are removed; oversized dead files are trimmed to a bounded tail.
async function sweepStaleShellOutput(shellJobsDir, jobNames) {
    const outDir = join(getPluginData(), 'shell-output');
    let outNames;
    try { outNames = await fsPromises.readdir(outDir); } catch { return; }
    if (outNames.length === 0) return;
    const doneSet = new Set(jobNames.filter(n => n.endsWith('.done')).map(n => n.slice(0, -5)));
    const liveSpill = new Set();
    await Promise.all(jobNames.map(async (name) => {
        if (!name.endsWith('.json')) return;
        const jobId = name.slice(0, -5);
        if (doneSet.has(jobId)) return; // completed → its spill is provably dead
        try {
            const detail = JSON.parse(await fsPromises.readFile(join(shellJobsDir, name), 'utf-8'));
            const pid = Number(detail?.pid);
            let alive = true; // unknown/invalid pid → conservative: treat as live
            if (Number.isFinite(pid) && pid > 0) {
                try { process.kill(pid, 0); alive = true; }   // running (or EPERM)
                catch (e) { alive = e?.code !== 'ESRCH'; }     // ESRCH → dead
            }
            if (!alive) return;
            for (const key of ['stdoutPath', 'stderrPath']) {
                const p = detail?.[key];
                if (typeof p === 'string' && p) liveSpill.add(basename(p));
            }
        } catch {}
    }));
    const cutoff = Date.now() - SHELL_JOB_STALE_MS;
    await Promise.all(outNames.map(async (name) => {
        if (liveSpill.has(name)) return; // referenced by a live producer — never touch
        const p = join(outDir, name);
        try {
            const st = await fsPromises.stat(p);
            if (st.mtimeMs < cutoff) { await fsPromises.unlink(p).catch(() => {}); return; }
            if (st.size <= SHELL_JOB_SPILL_MAX_BYTES) return;
            const buf = await fsPromises.readFile(p);
            await fsPromises.writeFile(p, buf.subarray(Math.max(0, buf.length - SHELL_JOB_SPILL_KEEP_BYTES)));
        } catch {}
    }));
}

export function getShellJobsDir() {
    const dir = join(getPluginData(), 'shell-jobs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    sweepStaleShellJobs(dir);
    return dir;
}

export function shellJobDetailPath(jobId) { return join(getShellJobsDir(), `${jobId}.json`); }
export function shellJobStdoutPath(jobId) { return join(getShellJobsDir(), `${jobId}.stdout.log`); }
export function shellJobStderrPath(jobId) { return join(getShellJobsDir(), `${jobId}.stderr.log`); }
export function shellJobExitPath(jobId) { return join(getShellJobsDir(), `${jobId}.exit`); }
export function shellJobDonePath(jobId) { return join(getShellJobsDir(), `${jobId}.done`); }
// Runtime proof that the posix wrapper's `timeout` branch actually ran: the
// wrapper touches this marker immediately before exec'ing `timeout`, so its
// existence is never optimistic (no spawn-time probe can guarantee the
// wrapper's own env/cwd resolution). PS jobs don't need it — their wrapper
// enforces unconditionally and records detail.timeoutEnforced:true.
export function shellJobEnforcedPath(jobId) { return join(getShellJobsDir(), `${jobId}.enforced`); }
// Owner sidecar marker: a zero-byte file whose NAME encodes the owning CC host
// (claude.exe) pid — `<jobId>.owner-<pid>`. It lets the statusline owner-filter
// jobs from a SINGLE directory listing (no per-job JSON read) so the filter can
// precede its per-tick scan cap — otherwise other sessions' newer jobs evict
// this session's live jobs before filtering. Swept alongside the other
// artefacts.
function shellJobOwnerPath(jobId, pid) { return join(getShellJobsDir(), `${jobId}.owner-${pid}`); }

// Resolve the CLI host pid that owns a freshly-spawned job. Standalone CLI
// execution is process-owned: background tasks are scoped to this CLI lifetime,
// and the pid stamp is only for statusline filtering / legacy sidecars.
export function resolveJobOwnerHostPid(clientHostPid) {
    const explicit = Number(clientHostPid);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const envPid = Number(process.env.MIXDOG_OWNER_HOST_PID);
    if (Number.isInteger(envPid) && envPid > 0) return envPid;
    return null;
}

export function writeShellJobDetail(detail) {
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

export function readShellJobDetail(jobId) {
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
