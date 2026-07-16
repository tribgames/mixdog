// bash_session — persistent shell with state preserved across calls.
//
// Companion to the stateless `bash` tool. The default `bash` spawns a fresh
// subshell every call: cwd, exports, `source`d virtualenvs, shell functions
// all vanish between invocations. That's the safe default but it's clumsy
// for the common "cd into a project → activate venv → run three commands"
// workflow; each step has to reconstruct the prior shell context by hand.
//
// bash_session keeps a long-lived `bash` child process per session_id. The
// caller writes commands to stdin; we frame each command with a sentinel
// so we know when the command has finished and what its exit code was.
// State carried automatically: $PWD, exports, shell vars, readline history
// (not that we use it), aliases, function defs, `source`d files.
//
// Session lifecycle:
//   - session_id omitted         → mint a fresh id, spawn child, run command
//   - session_id matches pool    → reuse existing child
//   - session_id misses pool     → spawn child for that id (pool empty after
//                                  orchestrator restart or idle eviction)
//   - close:true                 → terminate child after command returns
//   - idle > IDLE_TIMEOUT_MS     → reaper removes & kills the child
//   - pool > MAX_SESSIONS        → oldest-idle evicted at spawn time
//
// Output protocol:
//   write:  <command>\necho "__MIXDOG_END__:$?"\n
//   read:   everything on stdout up to (not including) the marker line
//   exit:   the N in __MIXDOG_END__:N
//   stderr: captured in parallel; sentinel not echoed there, so we flush
//           whatever arrived up to the command's completion. Small
//           quiescence window (STDERR_DRAIN_MS) after the stdout marker
//           so trailing writes on stderr don't get cut off.
//
// Safety: same BLOCKED_PATTERNS as the `bash` tool. The session holds state
// so a dangerous command can't hide in an earlier turn (we scan per call).
// Same ANSI strip + smart middle-truncate applied to stdout/stderr.
//
// This tool takes a command, not a file path — no path-safety check applies.

import { spawn } from 'node:child_process';
import * as nodeUtil from 'node:util';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { invalidateBuiltinResultCache, analyzeShellCommandEffects } from './builtin.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from './code-graph-state.mjs';
import { maybeRewriteWmicProcessCommand } from './shell-policy.mjs';
import { _maybeEncodePowerShellCommand } from './shell-command.mjs';
import { _captureTrackedMtimes, _trackedDriftNoteAfter, getDedupedDestructiveWarnings } from './builtin/bash-tool.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from './env-scrub.mjs';
import { checkExecPolicyMessage } from './bash-policy-scan.mjs';
import { startChildGuardian } from '../../../shared/child-guardian.mjs';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';

globalThis.__mixdogBashSessionRuntimeLoaded = true;

// Claude Code parity (refs/claude-code src/utils/timeouts.ts): default 120 s
// (2 min), max 600 s (10 min), BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS
// env overrides (max floored at default). Matches the one-shot bash tool
// (builtin/bash-tool.mjs): an omitted `timeout` uses the 120 s default bounded
// by MAX_TIMEOUT_MS; an explicit per-call `timeout` is honored uncapped, clamped
// only by TIMER_MAX_MS so JS/PS 32-bit timers stay valid.
const _envDefaultTimeout = parseInt(process.env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
const DEFAULT_TIMEOUT_MS = _envDefaultTimeout > 0 ? _envDefaultTimeout : 120_000;
const _envMaxTimeout = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
const MAX_TIMEOUT_MS = Math.max(_envMaxTimeout > 0 ? _envMaxTimeout : 600_000, DEFAULT_TIMEOUT_MS);
// JS setTimeout / PS WaitForExit(ms) are 32-bit: a delay above 2^31-1 wraps and
// fires immediately. Hard ceiling (~24.8 days) for an uncapped explicit timeout.
const TIMER_MAX_MS = 2_147_483_647;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_SESSIONS = 10;
const STDERR_DRAIN_MS = 25;
const STDERR_DRAIN_MAX_MS = 250;
const STDERR_QUIESCENT_MS = 25;
// SHELL_OUTPUT_MAX_CHARS — output preview cap, matches the `bash` tool.
// Duplicated here so bash-session stays decoupled from builtin.mjs private constants.
// STREAM_BUF_BYTE_CAP — hard byte cap per in-memory stream buffer. Past the
// cap data is dropped and a truncation marker injected so a runaway command
// (e.g. `cat /dev/urandom`) can't OOM the orchestrator.
const STREAM_BUF_BYTE_CAP = 4 * 1024 * 1024; // 4 MB per stream
const STREAM_TRUNC_MARKER = '\n... [TRUNCATED — stream cap reached] ...\n';
// Output truncation runtime envelope: 400 lines / 30 KB total;
// head=80 + tail=80 lines preserved on middle-truncation.
const SMART_BASH_MAX_LINES = 400;
const SMART_BASH_MAX_BYTES = 30 * 1024;
const SMART_BASH_HEAD_LINES = 80;
const SMART_BASH_TAIL_LINES = 80;

// Marker prefix for per-command sentinels. A random suffix is added on each
// command so user output that happens to contain the static prefix does not
// terminate the command early.
const MARKER_PREFIX = '__MIXDOG_END__';

// --- ANSI strip (self-contained; mirrors builtin.mjs's implementation) ---
const _ANSI_REGEX = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\|\u009C))/g;
const _stripAnsi = typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => s.replace(_ANSI_REGEX, () => '');
function stripAnsi(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    return _stripAnsi(s);
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Smart middle-truncate (shared with bash tool) ---
function smartMiddleTruncate(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= SMART_BASH_MAX_BYTES) {
        const fastLines = s.split('\n');
        if (fastLines.length <= SMART_BASH_MAX_LINES) return s;
        const head = fastLines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
        const tail = fastLines.slice(-SMART_BASH_TAIL_LINES).join('\n');
        const middle = fastLines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
        return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${fastLines.length} lines. Rerun with tighter filters for more] ...\n\n${tail}`;
    }
    const lines = s.split('\n');
    if (lines.length <= SMART_BASH_MAX_LINES) {
        const head = s.slice(0, SMART_BASH_MAX_BYTES);
        return `${head}\n\n... [TRUNCATED — output exceeded ${Math.round(SMART_BASH_MAX_BYTES / 1024)} KB on a single line] ...`;
    }
    const head = lines.slice(0, SMART_BASH_HEAD_LINES).join('\n');
    const tail = lines.slice(-SMART_BASH_TAIL_LINES).join('\n');
    const middle = lines.length - SMART_BASH_HEAD_LINES - SMART_BASH_TAIL_LINES;
    const totalKb = Math.round(s.length / 1024);
    return `${head}\n\n... [TRUNCATED — ${middle} lines middle elided; total ${lines.length} lines / ${totalKb} KB. Rerun with tighter filters for more] ...\n\n${tail}`;
}

function _prependDestructiveWarning(command, text) {
    const warnings = getDedupedDestructiveWarnings(command);
    if (!warnings.length) return text;
    return `${warnings.map((w) => `⚠️ ${w}`).join('\n')}\n${text}`;
}

// Blocked command check delegated to shell-policy.mjs (shared with
// builtin.mjs). See that module for the full pattern set and rationale.
// Locate a usable bash binary on POSIX. Windows intentionally does not
// support persistent shell sessions; one-shot commands use PowerShell
// through builtin/bash-tool.mjs. We deliberately pin bash (not sh) since
// the feature set depended on by the sentinel echo and `$?` is bash-shaped.
function resolveBash() {
    if (process.platform === 'win32') {
        throw new Error('persistent shell sessions are not supported on Windows; use one-shot PowerShell commands');
    }
    if (existsSync('/bin/bash')) return '/bin/bash';
    if (existsSync('/usr/bin/bash')) return '/usr/bin/bash';
    return '/bin/sh'; // fallback; `$?` + echo still work
}

// --- Session pool ---
// Map<id, { proc, lastUsed, stdoutBuf, stderrBuf, busy }>
const _sessions = new Map();
let _reaperTimer = null;
// R17 parent-exit hook installed exactly once at first _spawnSession. Without
// it, persistent bash shells orphan on server-main death (the async
// 'process-exit' path at the bottom of this module never gets to run its
// awaits when the host dies abruptly). Sync iteration of _sessions + direct
// _killProcessTree (sync taskkill on win, sync process.kill on posix).
let _parentExitInstalled = false;
function _installParentExitHook() {
    if (_parentExitInstalled) return;
    _parentExitInstalled = true;
    const sweep = () => {
        for (const [, s] of _sessions) {
            try { _killProcessTree(s.proc); } catch { /* ignore */ }
        }
    };
    try { process.on('exit', sweep); } catch { /* ignore */ }
    // For terminating signals, sweep children then restore default POSIX
    // termination. A sweep-only handler swallows the signal and leaves the
    // process alive, so after sweeping we remove our handler and re-raise the
    // same signal to the default disposition (exit code 128+signum).
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const onSignal = () => {
            sweep();
            try { process.removeListener(sig, onSignal); } catch { /* ignore */ }
            // Only re-raise (restoring default POSIX termination) when we are
            // the last handler. If other listeners remain — graceful-shutdown
            // handlers or peer sweep-only handlers — let them own termination;
            // forcing exit here would preempt their cleanup.
            try {
                if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
            } catch { /* ignore */ }
        };
        try { process.on(sig, onSignal); } catch { /* ignore */ }
    }
}

function _startReaper() {
    if (_reaperTimer) return;
    _reaperTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of _sessions) {
            if (!s.busy && now - s.lastUsed > IDLE_TIMEOUT_MS) {
                _killSession(id, 'idle-timeout');
            }
        }
        _clearReaperIfIdle();
    }, 30_000);
    // Don't keep the event loop alive just for the reaper.
    if (typeof _reaperTimer.unref === 'function') _reaperTimer.unref();
}

function _clearReaperIfIdle() {
    if (_sessions.size !== 0 || !_reaperTimer) return;
    clearInterval(_reaperTimer);
    _reaperTimer = null;
}

// Kill a spawned shell along with any child processes it forked. Posix path
// signals the process group (pgid == pid because we spawn with detached:true),
// so `sleep 1000 &` or a node server started inside the session is reaped
// instead of being left orphaned holding pipes open. Windows uses taskkill
// /T /F to walk the process tree. SIGTERM is sent first so well-behaved
// children can shut down cleanly; a SIGKILL escalation timer (3 s) forces the
// issue if they don't. Safe to call multiple times — all errors swallowed.
function _killProcessTree(proc) {
    // proc.killed flips to true the moment a signal is *sent*, NOT when the
    // child actually exits — escalation off `proc.killed` was a no-op. We
    // instead track the real exit/close state via a flag and only escalate
    // when neither has fired by the timer deadline.
    if (!proc) return;
    const pid = proc.pid;
    if (!pid) return;
    let exited = false;
    const onDone = () => { exited = true; };
    try { proc.once('exit', onDone); } catch {}
    try { proc.once('close', onDone); } catch {}
    // Already dead from a prior call? Skip the SIGTERM but still let the
    // listener wiring above clean up if a future exit/close arrives.
    if (proc.exitCode !== null && proc.exitCode !== undefined) {
        exited = true;
    } else if (proc.signalCode) {
        exited = true;
    }
    try {
        if (process.platform === 'win32') {
            // /T walks the tree, /F forces — no graceful SIGTERM on win.
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        } else if (!exited) {
            try { process.kill(-pid, 'SIGTERM'); }
            catch { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
        }
    } catch { /* ignore */ }
    // Escalate to SIGKILL if the child hasn't actually exited by the
    // deadline. Windows taskkill /F is already forceful, so only posix
    // needs the escalation timer.
    if (process.platform !== 'win32') {
        const esc = setTimeout(() => {
            if (exited) return;
            try { process.kill(-pid, 'SIGKILL'); }
            catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
        }, 3000);
        if (typeof esc.unref === 'function') esc.unref();
    }
}

async function _killSession(id, _reason) {
    const s = _sessions.get(id);
    if (!s) return;
    _sessions.delete(id);
    const exited = new Promise((resolve) => {
        s.proc.once('exit', resolve);
        s.proc.once('close', resolve);
    });
    try { s.proc.stdin?.end(); } catch { /* ignore */ }
    _killProcessTree(s.proc);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    _clearReaperIfIdle();
}

function _killSessionNow(id, _reason) {
    const s = _sessions.get(id);
    if (!s) return false;
    _sessions.delete(id);
    try { s.proc.stdin?.end(); } catch { /* ignore */ }
    _killProcessTree(s.proc);
    _clearReaperIfIdle();
    return true;
}

function shellQuoteSingle(s) {
    return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

function _hostPathToShellPath(p) {
    let s = String(p || '').replace(/\\/g, '/');
    return s;
}

function _shellPwdToHostPath(p) {
    return String(p || '').trim();
}

function _cwdKey(p) {
    let s = _hostPathToShellPath(p).replace(/\/+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s || '/';
}

async function _ensureSessionCwd(entry, targetCwd, timeoutMs) {
    if (!targetCwd || _cwdKey(entry.cwd) === _cwdKey(targetCwd)) return null;
    const cdTarget = _hostPathToShellPath(targetCwd);
    const result = await _runCommand(entry, `cd ${shellQuoteSingle(cdTarget)}`, Math.min(timeoutMs, 5000));
    if (result?.exit_code !== 0) {
        const stderr = stripAnsi(result?.stderr || '').trim();
        return `Error: failed to set persistent cwd: ${targetCwd}${stderr ? `\n\n[stderr]\n${stderr}` : ''}`;
    }
    entry.cwd = targetCwd;
    return null;
}

function _evictOldestIfFull() {
    if (_sessions.size < MAX_SESSIONS) return;
    // Prefer an idle session. If all are busy we can't evict safely; throw.
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, s] of _sessions) {
        if (s.busy) continue;
        if (s.lastUsed < oldestTs) {
            oldestTs = s.lastUsed;
            oldestId = id;
        }
    }
    if (oldestId) {
        _killSession(oldestId, 'pool-full');
        return;
    }
    throw new Error(`bash_session pool full (${MAX_SESSIONS} concurrent sessions, all busy)`);
}

// Build the env handed to the child bash. This path is POSIX-only; Windows
// one-shot commands use PowerShell and persistent shell sessions are disabled.
function buildBashEnv() {
    const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
    // R5 secret scrub — strip provider/cloud tokens before handing env to
    // the persistent shell. The stateless `bash` tool applies this same
    // sweep in builtin/bash-tool.mjs; the persistent shell's env is
    // constructed here and returns before that site runs, so it must be
    // done independently. Shared with shell-jobs and shell-snapshot via
    // env-scrub.mjs so the prefix/suffix lists never drift.
    scrubProviderSecrets(env);
    // R11 loader/execution scrub (NODE_OPTIONS, LD_PRELOAD, DYLD_*, …).
    scrubLoaderVars(env);
    return env;
}

function _spawnSession(id, initialCwd = process.cwd(), resourceLease = null) {
    _installParentExitHook();
    _evictOldestIfFull();
    const shell = resolveBash();
    const proc = spawn(shell, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildBashEnv(),
        cwd: initialCwd,
        windowsHide: true,
        // detached:true on posix gives the child its own process group so
        // _killProcessTree can signal the whole group (catches `sleep 1000 &`
        // and similar backgrounded children). Skipped on win32 where
        // detached has different semantics (no console attached, used for
        // daemonization — unwanted here).
        detached: process.platform !== 'win32',
    });
    startChildGuardian({
        childPid: proc.pid,
        childGroupPid: proc.pid,
        label: 'bash-session',
    });
    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    const entry = {
        proc,
        lastUsed: Date.now(),
        cwd: initialCwd,
        stdoutBuf: '',
        stderrBuf: '',
        busy: false,
        dead: false,
        exitInfo: null,
        resourceLease,
    };
    const releaseResourceLease = () => {
        if (!entry.resourceLease) return;
        try { entry.resourceLease.release(); } catch {}
        entry.resourceLease = null;
    };
    // Hard-capped concat: past STREAM_BUF_BYTE_CAP we drop further
    // chunks and stamp a truncation marker once. Without this a runaway
    // command (e.g. `cat /dev/urandom`) blocks until OOM long before any
    // smartMiddleTruncate downstream gets a chance to trim.
    entry.stdoutCapped = false;
    entry.stderrCapped = false;
    proc.stdout.on('data', (chunk) => {
        if (entry.stdoutCapped) return;
        entry.stdoutBuf += chunk;
        if (entry.stdoutBuf.length >= STREAM_BUF_BYTE_CAP) {
            entry.stdoutBuf = entry.stdoutBuf.slice(0, STREAM_BUF_BYTE_CAP) + STREAM_TRUNC_MARKER;
            entry.stdoutCapped = true;
        }
    });
    proc.stderr.on('data', (chunk) => {
        if (entry.stderrCapped) return;
        entry.stderrBuf += chunk;
        if (entry.stderrBuf.length >= STREAM_BUF_BYTE_CAP) {
            entry.stderrBuf = entry.stderrBuf.slice(0, STREAM_BUF_BYTE_CAP) + STREAM_TRUNC_MARKER;
            entry.stderrCapped = true;
        }
    });
    proc.on('error', (err) => {
        entry.dead = true;
        entry.exitInfo = { error: err?.message || String(err) };
        // An error event is not proof of process exit. Keep admission until
        // exit/close confirms termination, and force the failed tree down.
        _killProcessTree(proc);
    });
    proc.on('exit', (code, signal) => {
        entry.dead = true;
        entry.exitInfo = { code, signal };
        _sessions.delete(id);
        releaseResourceLease();
    });
    proc.on('close', () => {
        entry.dead = true;
        _sessions.delete(id);
        releaseResourceLease();
    });
    _sessions.set(id, entry);
    _startReaper();
    return entry;
}

async function _getOrCreate(sessionId, initialCwd = process.cwd(), opts = {}) {
    const explicit = typeof sessionId === 'string' && sessionId.length > 0;
    const id = explicit ? sessionId : `sess_${randomUUID()}`;
    let entry = _sessions.get(id);
    if (entry && entry.dead) {
        _sessions.delete(id);
        entry = null;
    }
    if (!entry) {
        if (explicit && opts.create !== true) {
            return { error: `Error: unknown session_id "${id}" (pass create:true to start a new persistent session)` };
        }
        const admission = opts.resourceAdmission || resourceAdmission;
        const lease = await admission.acquire('shell', {
            signal: opts.signal || null,
            label: `persistent:${id}`,
            dependency: 'detached',
        });
        try {
            entry = _sessions.get(id);
            if (!entry || entry.dead) entry = _spawnSession(id, initialCwd, lease);
            else await lease.release();
        } catch (error) {
            await lease.release();
            throw error;
        }
    }
    return { id, entry };
}

// Core command-run: frame with sentinel, wait for marker on stdout, flush
// stderr with a small drain window, return { stdout, stderr, exit_code }.
function _runCommand(entry, command, timeoutMs, abortSignal = null) {
    return new Promise((resolve, reject) => {
        entry.busy = true;
        // Reset buffers for this command. Anything left from a prior run is
        // unexpected (we only return after the marker), but be defensive.
        entry.stdoutBuf = '';
        entry.stderrBuf = '';

        let finished = false;
        let timeoutHandle = null;
        let abortHandler = null;
        const marker = `${MARKER_PREFIX}:${randomUUID()}`;
        const markerRe = new RegExp(`^${escapeRegex(marker)}:(-?\\d+)\\s*$`, 'm');

        const onExit = () => {
            if (finished) return;
            fail(new Error('bash_session: shell exited before command completed'));
        };

        const cleanup = () => {
            finished = true;
            entry.busy = false;
            entry.lastUsed = Date.now();
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (abortSignal && abortHandler) {
                try { abortSignal.removeEventListener('abort', abortHandler); } catch {}
            }
            entry.proc.stdout.removeListener('data', onStdout);
            entry.proc.removeListener('exit', onExit);
        };

        const settle = (result) => {
            if (finished) return;
            cleanup();
            resolve(result);
        };

        const fail = (err) => {
            if (finished) return;
            cleanup();
            reject(err);
        };

        const onStdout = () => {
            const m = markerRe.exec(entry.stdoutBuf);
            if (!m) return;
            const exitCode = Number(m[1]);
            // Everything before the marker line is the real stdout.
            const before = entry.stdoutBuf.slice(0, m.index);
            // Drain pending stderr writes adaptively. The fixed 25 ms
            // window dropped late stderr from forked children that
            // flushed slightly after the parent shell exited. Loop
            // instead: poll the stderr buffer length and finish only
            // once it's been quiescent for STDERR_QUIESCENT_MS, the
            // child closed stderr, or we hit the absolute ceiling.
            const drainStart = Date.now();
            let lastLen = entry.stderrBuf.length;
            let lastChange = drainStart;
            let stderrClosed = false;
            const onStderrEnd = () => { stderrClosed = true; };
            try { entry.proc.stderr.once('end', onStderrEnd); } catch {}
            const finish = () => {
                try { entry.proc.stderr.removeListener('end', onStderrEnd); } catch {}
                const stderr = entry.stderrBuf;
                entry.stdoutBuf = '';
                entry.stderrBuf = '';
                settle({ stdout: before, stderr, exit_code: exitCode });
            };
            const tick = () => {
                if (finished) { try { entry.proc.stderr.removeListener('end', onStderrEnd); } catch {} return; }
                const now = Date.now();
                const curLen = entry.stderrBuf.length;
                if (curLen !== lastLen) {
                    lastLen = curLen;
                    lastChange = now;
                }
                if (stderrClosed) return finish();
                if (now - drainStart >= STDERR_DRAIN_MAX_MS) return finish();
                if (now - lastChange >= STDERR_QUIESCENT_MS) return finish();
                setTimeout(tick, 10);
            };
            setTimeout(tick, STDERR_DRAIN_MS);
        };

        // Caller-driven abort (ESC / new prompt / session close). Kill the
        // shell immediately and resolve with an aborted marker so the agent
        // sees the cancellation rather than waiting for timeoutMs.
        if (abortSignal) {
            const fireAbort = () => {
                if (finished) return;
                const partialOut = entry.stdoutBuf || '';
                const partialErr = entry.stderrBuf || '';
                entry.stdoutBuf = '';
                entry.stderrBuf = '';
                _killProcessTree(entry.proc);
                // Mark dead and remove from pool immediately so the next call
                // doesn't pick up a killed shell entry.
                entry.dead = true;
                for (const [sid, s] of _sessions) { if (s === entry) { _sessions.delete(sid); break; } }
                cleanup();
                resolve({
                    stdout: partialOut,
                    stderr: partialErr,
                    exit_code: null,
                    signal: 'SIGTERM',
                    aborted: true,
                });
            };
            if (abortSignal.aborted) { fireAbort(); return; }
            abortHandler = fireAbort;
            abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        entry.proc.stdout.on('data', onStdout);
        // Check the buffer in case the marker already arrived (tiny commands).
        onStdout();

        entry.proc.on('exit', onExit);

        timeoutHandle = setTimeout(() => {
            // Timeout: surface what we have but don't leave the shell in a
            // half-run state. Killing the process is the only reliable way
            // to interrupt a stuck command; the caller can mint a new session.
            const partialOut = entry.stdoutBuf;
            const partialErr = entry.stderrBuf;
            entry.stdoutBuf = '';
            entry.stderrBuf = '';
            // Remove the session from the pool immediately: the POSIX kill
            // escalates SIGTERM->SIGKILL asynchronously, so a still-registered
            // entry could be reused as a dying shell before it exits.
            entry.dead = true;
            for (const [sid, s] of _sessions) { if (s === entry) { _sessions.delete(sid); break; } }
            _killProcessTree(entry.proc);
            cleanup();
            // Return a structured result (not a reject) so the caller
            // renders a proper exit/stderr block instead of a bare Error.
            resolve({
                stdout: partialOut,
                stderr: partialErr,
                exit_code: null,
                signal: 'SIGTERM',
                timed_out: true,
                timeout_ms: timeoutMs,
            });
        }, timeoutMs);

        // Write the command + sentinel. Newline before `echo` in case the
        // command didn't end with one. `$?` captures the final pipeline's
        // exit status as of bash semantics.
        const _preEncodePolicy = checkExecPolicyMessage(command);
        if (_preEncodePolicy) {
            fail(new Error(_preEncodePolicy.replace(/^Error: /, '')));
            return;
        }
        const encoded = _maybeEncodePowerShellCommand(command);
        const payload = `${encoded}\necho "${marker}:$?"\n`;
        try {
            entry.proc.stdin.write(payload, 'utf-8');
        } catch (err) {
            fail(err);
        }
    });
}

async function _syncSessionCwd(entry, timeoutMs) {
    try {
        const result = await _runCommand(entry, 'pwd', Math.min(timeoutMs, 2000));
        if (result?.exit_code !== 0) return;
        const stdout = stripAnsi(result.stdout || '').trim();
        if (!stdout) return;
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) entry.cwd = _shellPwdToHostPath(lines[lines.length - 1]);
    } catch (err) {
        entry.syncError = `[bash-session] persistent-session cwd sync failed: ${err.message}`;
    }
}

async function bash_session(args, cwd = process.cwd(), opts = {}) {
    if (process.platform === 'win32') {
        return 'Error: persistent shell sessions are not supported on Windows; use one-shot PowerShell commands without persistent/session_id.';
    }
    const abortSignal = opts && opts.abortSignal ? opts.abortSignal : null;
    let command = typeof args?.command === 'string' ? args.command : '';
    const close = args?.close === true;
    const implicitSessionId = args?.persistent === true && typeof opts?.sessionId === 'string'
        ? `__default__${opts.sessionId}`
        : '';
    const requestedSessionId = typeof args?.session_id === 'string' ? args.session_id : implicitSessionId;
    if (!command && close) {
        if (!requestedSessionId) return 'Error: command is required';
        const existing = _sessions.get(requestedSessionId);
        if (existing?.busy) return `Error: session "${requestedSessionId}" is busy executing a prior command`;
        if (existing) await _killSession(requestedSessionId, 'close-requested');
        return `[session: ${requestedSessionId}]\n[closed]\n\n${existing ? '(no output)' : '(no active session)'}`;
    }
    if (!command) return 'Error: command is required';
    const wmicRewrite = maybeRewriteWmicProcessCommand(command);
    if (wmicRewrite?.error) return `Error: ${wmicRewrite.error}`;
    if (wmicRewrite?.command) command = wmicRewrite.command;
    // R5-③: match the stateless one-shot path's full sweep so callers that
    // reach bash_session directly (via session_id without going through
    // executeBashTool) still get stripQuotedAndHeredoc + extractShellCInner
    // + unquote-span coverage. Persistent:true callers funnel through
    // executeBashTool which now pre-sweeps, but bash_session is also reached
    // by close:true session reuse and by direct tool dispatch.
    const _bsPolicy = checkExecPolicyMessage(command);
    if (_bsPolicy) return _bsPolicy;
    const explicitCwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0;
    const requestedCwd = cwd || process.cwd();
    const baseCwd = (() => {
        if (explicitCwd) return requestedCwd;
        if (requestedSessionId) {
            const existing = _sessions.get(requestedSessionId);
            if (existing?.cwd) return existing.cwd;
        }
        return requestedCwd;
    })();
    const hasExplicitTimeout = typeof args?.timeout === 'number' && args.timeout > 0;
    const timeoutMs = hasExplicitTimeout ? args.timeout : DEFAULT_TIMEOUT_MS;
    // Explicit per-call timeout uncapped (only the wmic-rewrite ceiling or the
    // 32-bit TIMER_MAX_MS still bound it); omitted default keeps MAX_TIMEOUT_MS.
    const effectiveTimeout = hasExplicitTimeout
        ? Math.min(Math.max(timeoutMs, 1), wmicRewrite?.timeoutMs || TIMER_MAX_MS)
        : Math.min(Math.max(timeoutMs, 1), wmicRewrite?.timeoutMs || MAX_TIMEOUT_MS);
    let resolved;
    try {
        resolved = await _getOrCreate(requestedSessionId || args?.session_id, baseCwd, {
            create: args?.create === true,
            resourceAdmission: opts?.resourceAdmission || resourceAdmission,
            signal: abortSignal,
        });
    } catch (error) {
        return `Error: ${error?.message || String(error)}`;
    }
    if (resolved.error) return resolved.error;
    const { id, entry } = resolved;
    if (entry.syncError) {
        const msg = entry.syncError;
        delete entry.syncError;
        throw new Error(msg);
    }
    if (entry.busy) {
        return `Error: session "${id}" is busy executing a prior command`;
    }
    if (explicitCwd) {
        const cwdErr = await _ensureSessionCwd(entry, requestedCwd, effectiveTimeout);
        if (cwdErr) return cwdErr;
    }

    let shellEffects;
    try {
        shellEffects = await analyzeShellCommandEffects(command, entry.cwd || baseCwd);
    } catch (err) {
        return `Error: ${err?.message || String(err)}`;
    }

    const _bsScope = opts?.readStateScope ?? opts?.sessionId ?? null;
    const _bsPreDrift = _captureTrackedMtimes(_bsScope);
    let result;
    try {
        result = await _runCommand(entry, command, effectiveTimeout, abortSignal);
    } catch (err) {
        return `Error: ${err?.message || String(err)}`;
    }
    if (result.exit_code === 0 && shellEffects.finalCwd) {
        entry.cwd = shellEffects.finalCwd;
    }
    // Skip cwd sync on abort: the shell was already killed, so issuing
    // another `pwd` would either hang on a dead pipe or spawn a fresh
    // session against caller intent. Mark dead so the next call mints a
    // new shell rather than reusing this one. Same logic for timeouts.
    if (result.aborted) {
        entry.dead = true;
    } else if (!close && !result.timed_out) {
        await _syncSessionCwd(entry, effectiveTimeout);
    }
    if (shellEffects.mutationMode === 'paths') {
        invalidateBuiltinResultCache(shellEffects.paths);
        markCodeGraphDirtyPaths(shellEffects.paths);
    } else if (shellEffects.mutationMode === 'global') {
        invalidateBuiltinResultCache();
        drainCodeGraphCache();
    }
    const _bsDriftNote = _trackedDriftNoteAfter(_bsScope, _bsPreDrift);

    if (close) {
        await _killSession(id, 'close-requested');
    }

    const stdoutClean = stripAnsi(result.stdout || '');
    const stderrClean = stripAnsi(result.stderr || '');
    const stdoutT = smartMiddleTruncate(stdoutClean);
    const stderrT = stderrClean ? smartMiddleTruncate(stderrClean) : '';

    // Structured header so the agent can parse session_id + exit_code out
    // of the text response without bespoke JSON. Keeps parity with the
    // `bash` tool's free-form `[exit code: N]` marker but additive.
    const headerLines = [`[session: ${id}]`];
    if (wmicRewrite?.note) headerLines.push(wmicRewrite.note);
    if (result.aborted) {
        headerLines.push(`[aborted: caller cancelled — session killed]`);
    } else if (result.timed_out) {
        headerLines.push(`[timeout: ${result.timeout_ms} ms — session killed]`);
    } else if (result.exit_code !== 0 && result.exit_code !== null) {
        headerLines.push(`[exit code: ${result.exit_code}]`);
    }
    if (close) headerLines.push(`[closed]`);
    const header = headerLines.join('\n');

    const body = stdoutT || (stderrT ? '' : '(no output)');
    const stderrBlock = stderrT ? `\n\n[stderr]\n${stderrT}` : '';
    return _prependDestructiveWarning(command, `${header}\n\n${body}${stderrBlock}${_bsDriftNote}`);
}

// BASH_SESSION_TOOL_DEFS removed in 0.1.126: the `bash` tool's
// `persistent:true` option absorbed every use case; the dedicated
// `bash_session` schema only added prompt bytes and triggered LLM
// hallucinations of the legacy name. Implementation (executeBashSessionTool,
// closeBashSession) stays — `bash` with persistent:true routes here.
export async function executeBashSessionTool(name, args, _cwd, opts = {}) {
    switch (name) {
        case 'bash_session':
            return bash_session(args || {}, _cwd || process.cwd(), opts);
        default:
            throw new Error(`Unknown bash-session tool: ${name}`);
    }
}

export function closeBashSession(sessionId, reason = 'external-close') {
    if (!sessionId || !_sessions.has(sessionId)) return false;
    _killSession(sessionId, reason);
    return true;
}

export async function shutdownBashSessions(reason = 'runtime-close') {
    const ids = [..._sessions.keys()];
    await Promise.allSettled(ids.map((id) => _killSession(id, reason)));
    _clearReaperIfIdle();
    return { closed: ids.length };
}

// Best-effort cleanup on process exit so orphan bash children don't linger
// when the plugin host shuts down. Self-registered exit drain; bare 'exit' hook stays as idempotent backup.
export function drainBashSessions(reason = 'process-exit') {
    let closed = 0;
    for (const id of [..._sessions.keys()]) {
        if (_killSessionNow(id, reason)) closed += 1;
    }
    return { closed };
}
if (typeof process?.on === 'function') {
    process.on('exit', drainBashSessions);
}
