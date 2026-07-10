import { spawn, execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import { acquire as acquireChildSpawnSlot } from '../../../../shared/child-spawn-gate.mjs';

const execFileAsync = promisify(execFile);

// ── rg orphan-reap policy (accepted risk) ────────────────────────────────
// The previous design started a 1:1 node child-guardian per rg spawn so a
// hard daemon kill (SIGKILL, no chance to run our own cleanup) could not leave
// an rg orphaned. That per-process guardian is exactly what over-saturated the
// box (each grep doubled the process count), so it has been REMOVED here and
// deliberately NOT replaced with another per-rg guardian.
//
// Accepted residual risk: on a hard daemon SIGKILL an in-flight rg can briefly
// outlive the daemon. This is judged acceptable because (a) on every NORMAL
// path rg is reaped by this module's own timeout → SIGTERM → grace → force-kill
// plus the force-settle backstop, so it is always collected when the daemon is
// alive to settle the promise; (b) rg is a short-lived, self-terminating
// (bounded by the 20s timeout) read-only process, not a long-running server; a
// stray instance exits on its own shortly after. A shared/OS-job-based reaper
// (one guardian for the whole daemon, or a Windows Job Object / POSIX process
// group kill on daemon teardown) is the right long-term fix but is out of scope
// for this change and intentionally not added per-spawn.

// ── rg --threads cap ─────────────────────────────────────────────────────
// Each rg process otherwise fans out across EVERY core; with several agents
// running grep at once the box over-saturates and the whole batch trips the
// 20s deadline together. Cap rg's worker threads to a fraction of the host so
// concurrent greps share the machine. Internal dynamic default; env override
// only — deliberately NOT exposed on any tool schema / parameter surface.
let _rgDefaultThreadCap = null;
export function _rgThreadCap() {
    const override = Number(process.env.MIXDOG_RG_THREADS);
    if (Number.isFinite(override) && override >= 1) return Math.floor(override);
    if (_rgDefaultThreadCap !== null) return _rgDefaultThreadCap;
    let cpus = 0;
    try { cpus = os.cpus()?.length || 0; } catch { cpus = 0; }
    _rgDefaultThreadCap = Math.max(2, Math.ceil((cpus || 4) / 4));
    return _rgDefaultThreadCap;
}

// Single source of truth for "did the caller already pin rg's thread count?".
// Detects every form rg accepts: separated (`-j`, `--threads`) where the count
// is the NEXT arg, short-attached (`-j8`), and long-attached (`--threads=8`).
// Used by both the _withRgThreads injection guard and the EAGAIN retry guard
// so the two never disagree.
function _hasRgThreadArg(argsList) {
    for (const a of argsList) {
        if (typeof a !== 'string') continue;
        if (a === '-j' || a === '--threads') return true;
        if (/^-j\d+$/.test(a)) return true;
        if (a.startsWith('--threads=')) return true;
    }
    return false;
}

// Inject `--threads N` unless the caller already pinned thread count
// (`-j`/`--threads`/`-jN`/`--threads=N`, e.g. the EAGAIN `-j 1` retry). Does
// not mutate; may return the ORIGINAL array unchanged when already
// thread-pinned (callers must not assume a fresh copy).
function _withRgThreads(argsList) {
    if (_hasRgThreadArg(argsList)) return argsList;
    return ['--threads', String(_rgThreadCap()), ...argsList];
}

// Build the EAGAIN single-thread retry args. If the caller already pinned a
// thread count we strip the existing flag(s) first, then prepend `-j 1`, so the
// retry is unambiguously single-threaded (never `-j 8 ... -j 1`). Drops both the
// separated form (`-j N` / `--threads N` → flag + following count) and the
// attached forms (`-jN` / `--threads=N`).
function _rgEagainRetryArgs(argsList) {
    const out = [];
    for (let i = 0; i < argsList.length; i++) {
        const a = argsList[i];
        if (a === '-j' || a === '--threads') { i++; continue; } // skip flag + its count
        if (typeof a === 'string' && (/^-j\d+$/.test(a) || a.startsWith('--threads='))) continue;
        out.push(a);
    }
    return ['-j', '1', ...out];
}

// True only when the args are ALREADY exactly single-threaded — i.e. an EAGAIN
// retry would change nothing. Matches the separated `-j 1` / `--threads 1` form
// and the attached `-j1` / `--threads=1` form. Any other thread pin (e.g. -j8)
// is NOT "single-thread pinned": the retry should still run and downshift it.
function _isRgSingleThreadPinned(argsList) {
    for (let i = 0; i < argsList.length; i++) {
        const a = argsList[i];
        if (typeof a !== 'string') continue;
        if ((a === '-j' || a === '--threads') && String(argsList[i + 1]).trim() === '1') return true;
        if (a === '-j1' || a === '--threads=1') return true;
    }
    return false;
}

let _rgExecutableResolved = null;
let _rgExecutableResolutionKey = null;
let _rgResolvePromise = null;
let _rgResolvePromiseKey = null;
let _rgResolutionGeneration = 0;

function _rgResolutionKey() {
    return [
        process.platform,
        process.cwd(),
        String(process.env.PATH || ''),
        String(process.env.PATHEXT || ''),
    ].join('\0');
}

function _usableRgCandidate(candidate, isWin = process.platform === 'win32') {
    try {
        const info = statSync(candidate);
        if (!info.isFile()) return false;
        if (isWin) {
            const ext = candidate.slice(candidate.lastIndexOf('.')).toLowerCase();
            return ext === '.exe' || ext === '.com';
        }
        accessSync(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export async function _resolveRgExecutable() {
    const isWin = process.platform === 'win32';
    const pathSep = isWin ? ';' : ':';
    const dirs = String(process.env.PATH || '').split(pathSep);
    // Avoid `where`/`which` on the normal path: on Windows it costs tens of
    // milliseconds before doing the same filesystem search. Windows command
    // lookup checks the current directory before PATH and applies PATHEXT in
    // order; POSIX lookup is just the PATH order.
    const searchDirs = isWin ? [process.cwd(), ...dirs] : dirs;
    const names = isWin
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
            .map((ext) => ext.trim().toLowerCase())
            .filter((ext) => ext === '.exe' || ext === '.com')
            .map((ext) => `rg${ext}`)
        : ['rg'];
    for (const dir of searchDirs) {
        for (const name of names) {
            const candidate = resolve(dir, name);
            if (existsSync(candidate) && _usableRgCandidate(candidate, isWin)) return candidate;
        }
    }
    try {
        const cmd = isWin ? 'where' : 'which';
        const { stdout: out } = await execFileAsync(cmd, ['rg'], { encoding: 'utf8', windowsHide: true });
        const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        const candidate = first ? resolve(first) : '';
        if (candidate && _usableRgCandidate(candidate, isWin)) return candidate;
    } catch { /* preserve bare-rg fallback */ }
    return 'rg';
}

// Synchronous accessor for the spawn call sites — only valid AFTER
// ensureRgResolved() has run (runRg/runRgWindowedLines await it first). Falls
// back to the bare 'rg' if somehow called before resolution.
function rgExecutable() {
    return _rgExecutableResolved ?? 'rg';
}

// Async resolver: the `where`/`which` lookup used to run via execFileSync,
// blocking the event loop ~90ms on the first grep/glob/find of a session
// (freezing the TUI). Resolve asynchronously and cache the result; subsequent
// calls return immediately.
export async function ensureRgResolved() {
    const key = _rgResolutionKey();
    const cachedUsable = _rgExecutableResolved !== null
        && _rgExecutableResolved !== 'rg'
        && _usableRgCandidate(_rgExecutableResolved);
    if (_rgExecutableResolutionKey === key && cachedUsable) return _rgExecutableResolved;
    if (_rgExecutableResolved !== null && (_rgExecutableResolutionKey !== key || !cachedUsable)) {
        _rgResolutionGeneration++;
        _rgExecutableResolved = null;
        _rgExecutableResolutionKey = null;
        _rgResolvePromise = null;
    }
    if (!_rgResolvePromise || _rgResolvePromiseKey !== key) {
        _rgResolvePromiseKey = key;
        _rgResolvePromise = _resolveRgExecutable().then((resolved) => {
            _rgExecutableResolved = resolved;
            _rgExecutableResolutionKey = key;
            return resolved;
        });
    }
    return _rgResolvePromise;
}

// When _resolveRgExecutable() exhausts `where`/`which` and the PATH scan and
// falls back to the bare 'rg', a later spawn would die with a raw ENOENT. Probe
// the fallback so we can surface a clear, actionable error instead. Success is
// cached permanently; failure is cached for only RG_FALLBACK_FAIL_TTL_MS so
// installing rg mid-session recovers without restarting the daemon.
const RG_FALLBACK_FAIL_TTL_MS = 30000;
let _rgFallbackUsable = null;
let _rgFallbackFailAt = 0;
async function rgFallbackUsable() {
    if (_rgFallbackUsable === false && (Date.now() - _rgFallbackFailAt) < RG_FALLBACK_FAIL_TTL_MS) {
        return false;
    }
    try {
        await execFileAsync('rg', ['--version'], { windowsHide: true, timeout: 3000 });
        _rgFallbackUsable = true;
    } catch {
        _rgFallbackUsable = false;
        _rgFallbackFailAt = Date.now();
    }
    return _rgFallbackUsable;
}

// Throws a clear error only when the bare 'rg' fallback was reached AND it is
// not actually runnable. A real resolved path short-circuits with no probe, so
// behavior is unchanged whenever rg exists. Async so the underlying lookups
// (`where`/`which`, `rg --version`) never block the event loop.
async function assertRgAvailable() {
    if (await ensureRgResolved() !== 'rg') return;
    if (await rgFallbackUsable()) return;
    const e = new Error('ripgrep (rg) not found on PATH — install ripgrep or add it to PATH');
    e.code = 'ERG_NOT_FOUND';
    throw e;
}

// ── PCRE2 capability detection ───────────────────────────────────────────
// ripgrep's default regex engine (Rust `regex` crate) intentionally rejects
// lookaround/backreferences ("look-around ... is not supported" /
// "backreferences ... not supported"). Some rg builds are compiled with the
// optional `pcre2` feature, which adds `-P`/`--pcre2` support for exactly
// those constructs. Detect capability once via `rg --pcre2-version`: it
// exits 0 and prints a version when PCRE2 is linked in, and exits non-zero
// ("PCRE2 is not available...") when it is not. Cached permanently on
// success; failure is cached briefly so a mid-session rg upgrade/reinstall
// is picked up without a daemon restart (mirrors rgFallbackUsable's TTL).
const RG_PCRE2_FAIL_TTL_MS = 30000;
let _rgPcre2Supported = null;
let _rgPcre2FailAt = 0;
export async function rgSupportsPcre2() {
    await ensureRgResolved();
    const cacheKey = `${_rgResolutionGeneration}:${rgExecutable()}`;
    if (rgSupportsPcre2._cacheKey !== cacheKey) {
        _rgPcre2Supported = null;
        _rgPcre2FailAt = 0;
        rgSupportsPcre2._cacheKey = cacheKey;
    }
    if (_rgPcre2Supported === true) return true;
    if (_rgPcre2Supported === false && (Date.now() - _rgPcre2FailAt) < RG_PCRE2_FAIL_TTL_MS) return false;
    try {
        await execFileAsync(rgExecutable(), ['--pcre2-version'], { windowsHide: true, timeout: 3000 });
        _rgPcre2Supported = true;
    } catch {
        _rgPcre2Supported = false;
        _rgPcre2FailAt = Date.now();
    }
    return _rgPcre2Supported;
}

// Cap rg stdout accumulation so a runaway producer (huge repo, accidental
// match-all) cannot balloon the JS string heap. Mirrors CC's ripgrep.ts cap.
const MAX_RG_STDOUT_BYTES = 20 * 1024 * 1024; // 20MB

// SIGTERM → grace → force kill; hard Promise settle if 'close' never fires
// (mirrors shell-command.mjs treeKill + _treeKillForceSettle timings).
const RG_KILL_GRACE_MS = 3000;
const RG_FORCE_SETTLE_SLACK_MS = 5000;

function _rgProcGone(proc) {
    return !proc || proc.exitCode != null || proc.signalCode != null;
}

function _escalateRgKill(proc) {
    if (_rgProcGone(proc)) return;
    const pid = proc.pid;
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
                windowsHide: true,
                stdio: 'ignore',
            });
        } else {
            try {
                proc.kill('SIGKILL');
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function _killRgProc(proc, timers) {
    if (_rgProcGone(proc)) return;
    try {
        proc.kill('SIGTERM');
    } catch { /* ignore */ }
    if (timers.killGrace) {
        clearTimeout(timers.killGrace);
        timers.killGrace = null;
    }
    timers.killGrace = setTimeout(() => {
        timers.killGrace = null;
        _escalateRgKill(proc);
    }, RG_KILL_GRACE_MS);
    if (timers.killGrace.unref) timers.killGrace.unref();
}

function _clearRgTimeoutOnly(timers) {
    if (timers.timeout) {
        clearTimeout(timers.timeout);
        timers.timeout = null;
    }
}

function _clearRgTimers(timers) {
    _clearRgTimeoutOnly(timers);
    if (timers.killGrace) {
        clearTimeout(timers.killGrace);
        timers.killGrace = null;
    }
    if (timers.forceSettle) {
        clearTimeout(timers.forceSettle);
        timers.forceSettle = null;
    }
}

function _boxPartialRgString(s, rgStderrText = '') {
    const boxed = new String(s);
    try {
        boxed.partial = true;
        boxed.timeout = true;
        boxed.rgStderr = rgStderrText;
    } catch { /* ignore */ }
    return boxed;
}

function _armRgForceSettle({ timeoutMs, isSettled, timers, proc, onForceSettle }) {
    if (timers.forceSettle) clearTimeout(timers.forceSettle);
    timers.forceSettle = setTimeout(() => {
        timers.forceSettle = null;
        if (isSettled()) return;
        // Hard deadline: escalate immediately — do not schedule grace then clear it.
        _escalateRgKill(proc);
        onForceSettle();
    }, timeoutMs + RG_FORCE_SETTLE_SLACK_MS);
    if (timers.forceSettle.unref) timers.forceSettle.unref();
}

// Ripgrep wrapper. Ripgrep occasionally fails with EAGAIN on Windows when
// thread/resource pressure spikes. On EAGAIN we retry once with `-j 1` to
// force single-threaded execution; rg exit code 1 is "no matches" and is
// surfaced as empty stdout so callers can render "(no matches)" uniformly.
function spawnRg(argsList, execOptions) {
    const timeoutMs = Number(execOptions?.timeout ?? 20000);
    const gateSignal = execOptions?.abortSignal || execOptions?.signal || null;
    // Gate the spawn (not the whole call) so over-saturation queues here while
    // the cap's worth of rg keep running. The rg timeout timer is armed AFTER
    // spawn below, so queue-wait time is excluded from the 20s deadline. No
    // node guardian is started: rg owns its full SIGTERM→grace→force-kill +
    // force-settle teardown, so the 1:1 guardian process was pure overhead.
    return acquireChildSpawnSlot(gateSignal).then((releaseSlot) => new Promise((resolve, reject) => {
        const proc = spawn(rgExecutable(), _withRgThreads(argsList), {
            cwd: execOptions?.cwd,
            env: execOptions?.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        /** @type {'timeout' | 'cap' | null} */
        let killReason = null;
        let settled = false;
        let stdoutBytes = 0;
        let stdoutTruncated = false;
        const timers = { timeout: null, killGrace: null, forceSettle: null };
        timers.timeout = setTimeout(() => {
            timedOut = true;
            killReason = 'timeout';
            _killRgProc(proc, timers);
        }, timeoutMs);
        if (timers.timeout.unref) timers.timeout.unref();
        _armRgForceSettle({
            timeoutMs,
            isSettled: () => settled,
            timers,
            proc,
            onForceSettle: () => {
                timedOut = true;
                killReason = 'timeout';
                const e = new Error(`rg timed out after ${timeoutMs} ms`);
                e.code = 'ETIMEDOUT';
                if (settled) return;
                settled = true;
                _clearRgTimers(timers);
                reject(e);
            },
        });
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (d) => {
            if (stdoutTruncated) return;
            // Account by UTF-8 byte length (d is a decoded string here), not by
            // string length, so non-ASCII output cannot overshoot the byte cap.
            const dBytes = Buffer.byteLength(d);
            const remaining = MAX_RG_STDOUT_BYTES - stdoutBytes;
            if (dBytes >= remaining) {
                // Slice by BYTES (not chars) and cut on a UTF-8 codepoint
                // boundary: a char-count slice overshoots on multibyte output,
                // and even a raw byte slice would let a split trailing codepoint
                // decode to U+FFFD (3 bytes) and exceed the cap. Back `end` over
                // continuation bytes (0b10xxxxxx) so the kept bytes are <= cap.
                const buf = Buffer.from(d, 'utf8');
                let end = Math.max(0, Math.min(remaining, buf.length));
                while (end > 0 && end < buf.length && (buf[end] & 0xC0) === 0x80) end--;
                stdout += buf.subarray(0, end).toString('utf8');
                stdoutBytes = MAX_RG_STDOUT_BYTES;
                stdoutTruncated = true;
                if (killReason !== 'timeout') killReason = 'cap';
                _clearRgTimeoutOnly(timers);
                _killRgProc(proc, timers);
                return;
            }
            stdout += d;
            stdoutBytes += dBytes;
        });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            _clearRgTimers(timers);
            reject(err);
        });
        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            _clearRgTimers(timers);
            if (timedOut && killReason === 'timeout') {
                if (stdout.length > 0) {
                    return resolve(_boxPartialRgString(stdout, stderr.trim()));
                }
                const e = new Error(`rg timed out after ${timeoutMs} ms`);
                e.code = 'ETIMEDOUT';
                return reject(e);
            }
            const wrap = (s) => {
                if (!stdoutTruncated) return s;
                const boxed = new String(s);
                try { boxed.truncated = true; } catch { /* ignore */ }
                return boxed;
            };
            const boxPartialStdout = (s, rgStderrText) => {
                const boxed = new String(s);
                try {
                    if (stdoutTruncated) boxed.truncated = true;
                    boxed.partial = true;
                    boxed.rgStderr = rgStderrText;
                } catch { /* ignore */ }
                return boxed;
            };
            if (code === 0) return resolve(wrap(stdout));
            if (code === 1) return resolve(wrap(''));
            // SIGTERM after our own truncation kill: surface accumulated stdout.
            if (stdoutTruncated) return resolve(wrap(stdout));
            // Exit 2 (e.g. permission denied on some paths) may still emit matches.
            if (code === 2 && stdout.length > 0) {
                return resolve(boxPartialStdout(stdout, stderr.trim()));
            }
            const e = new Error(`rg exited with code ${code}: ${stderr.trim()}`);
            e.code = code;
            e.stderr = stderr;
            reject(e);
        });
    // Release the gate slot exactly once on ANY settle path (resolve/reject:
    // close, error, or force-settle). releaseSlot is idempotent.
    }).finally(() => releaseSlot()));
}

export async function runRg(argsList, execOptions = {}) {
    await assertRgAvailable();
    try {
        return await spawnRg(argsList, execOptions);
    } catch (err) {
        const msg = String(err?.message || err?.stderr || '');
        // Retry single-threaded on EAGAIN. Skip only when the caller already
        // pinned threads AND that pin is already -j 1 (nothing to gain); any
        // other pin (-j8/--threads=N) is rewritten to a clean -j 1 by
        // _rgEagainRetryArgs so we never emit conflicting thread flags.
        if (/EAGAIN/i.test(msg) && !_isRgSingleThreadPinned(argsList)) {
            return spawnRg(_rgEagainRetryArgs(argsList), execOptions);
        }
        throw err;
    }
}

function spawnRgWindowedLines(argsList, execOptions, opts = {}) {
    const timeoutMs = Number(execOptions?.timeout ?? 20000);
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
    const lineLimit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(Number(opts.limit) || 0)) : Infinity;
    const summaryLimit = Math.max(0, Math.floor(Number(opts.summaryLimit) || 0));
    const collectLimit = lineLimit === Infinity ? Infinity : Math.max(lineLimit, summaryLimit);
    const gateSignal = execOptions?.abortSignal || execOptions?.signal || null;
    // Same gate + thread-cap + no-guardian treatment as spawnRg; queue-wait is
    // excluded from the rg timeout (armed after spawn). releaseSlot is fired
    // once via .finally on every settle path.
    return acquireChildSpawnSlot(gateSignal).then((releaseSlot) => new Promise((resolve, reject) => {
        const proc = spawn(rgExecutable(), _withRgThreads(argsList), {
            cwd: execOptions?.cwd,
            env: execOptions?.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let buffer = '';
        let stderr = '';
        let skipped = 0;
        let seenAfterOffset = 0;
        let stoppedEarly = false;
        let timedOut = false;
        let capExceeded = false;
        let bufferBytes = 0;
        /** @type {'timeout' | 'early' | null} */
        let killReason = null;
        let settled = false;
        const timers = { timeout: null, killGrace: null, forceSettle: null };
        const lines = [];
        timers.timeout = setTimeout(() => {
            timedOut = true;
            killReason = 'timeout';
            _killRgProc(proc, timers);
        }, timeoutMs);
        if (timers.timeout.unref) timers.timeout.unref();
        _armRgForceSettle({
            timeoutMs,
            isSettled: () => settled,
            timers,
            proc,
            onForceSettle: () => {
                timedOut = true;
                killReason = 'timeout';
                if (lines.length > 0) {
                    if (settled) return;
                    settled = true;
                    _clearRgTimers(timers);
                    resolve({
                        lines,
                        complete: false,
                        totalSeen: seenAfterOffset,
                        partial: true,
                        timeout: true,
                        rgStderr: stderr.trim(),
                    });
                    return;
                }
                const e = new Error(`rg timed out after ${timeoutMs} ms`);
                e.code = 'ETIMEDOUT';
                if (settled) return;
                settled = true;
                _clearRgTimers(timers);
                reject(e);
            },
        });
        const stopEarly = () => {
            if (stoppedEarly) return;
            stoppedEarly = true;
            buffer = '';
            if (killReason !== 'timeout') killReason = 'early';
            _clearRgTimeoutOnly(timers);
            _killRgProc(proc, timers);
        };
        const pushLine = (raw) => {
            if (stoppedEarly || raw.length === 0) return;
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (line.length === 0) return;
            if (skipped < offset) {
                skipped++;
                return;
            }
            seenAfterOffset++;
            if (seenAfterOffset <= collectLimit) {
                bufferBytes += Buffer.byteLength(line);
                if (bufferBytes > MAX_RG_STDOUT_BYTES) {
                    // Enforce the same 20MB ceiling runRg uses: a runaway
                    // producer must not balloon the retained-lines heap.
                    capExceeded = true;
                    stopEarly();
                    return;
                }
                lines.push(line);
                return;
            }
            stopEarly();
        };
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (chunk) => {
            if (stoppedEarly) return;
            buffer += chunk;
            // Guard against an unbounded single line (no newline): cap the
            // pending buffer at the same 20MB ceiling and stop early.
            if (buffer.length > MAX_RG_STDOUT_BYTES) {
                capExceeded = true;
                stopEarly();
                return;
            }
            let start = 0;
            let idx = buffer.indexOf('\n', start);
            while (!stoppedEarly && idx !== -1) {
                pushLine(buffer.slice(start, idx));
                start = idx + 1;
                idx = buffer.indexOf('\n', start);
            }
            buffer = stoppedEarly ? '' : buffer.slice(start);
        });
        proc.stderr.on('data', (d) => {
            if (stderr.length < 4096) stderr += d;
        });
        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            _clearRgTimers(timers);
            reject(err);
        });
        proc.on('close', (code) => {
            if (settled) return;
            settled = true;
            _clearRgTimers(timers);
            if (!stoppedEarly && buffer.length > 0) {
                pushLine(buffer);
                buffer = '';
            }
            if (timedOut && killReason === 'timeout') {
                if (lines.length > 0) {
                    return resolve({
                        lines,
                        complete: false,
                        totalSeen: seenAfterOffset,
                        partial: true,
                        timeout: true,
                        rgStderr: stderr.trim(),
                    });
                }
                const e = new Error(`rg timed out after ${timeoutMs} ms`);
                e.code = 'ETIMEDOUT';
                return reject(e);
            }
            if (stoppedEarly) {
                return resolve({
                    lines,
                    complete: false,
                    totalSeen: seenAfterOffset,
                    // Surface the 20MB byte-cap breach so the caller can flag
                    // truncation, mirroring runRg's stdoutTruncated.
                    ...(capExceeded ? { partial: true, truncated: true } : {}),
                });
            }
            if (code === 0 || code === 1) {
                return resolve({ lines, complete: true, totalSeen: seenAfterOffset });
            }
            if (code === 2 && lines.length > 0) {
                return resolve({
                    lines,
                    complete: false,
                    totalSeen: seenAfterOffset,
                    partial: true,
                    rgStderr: stderr.trim(),
                });
            }
            const e = new Error(`rg exited with code ${code}: ${stderr.trim()}`);
            e.code = code;
            e.stderr = stderr;
            reject(e);
        });
    }).finally(() => releaseSlot()));
}

export async function runRgWindowedLines(argsList, execOptions = {}, opts = {}) {
    await assertRgAvailable();
    try {
        return await spawnRgWindowedLines(argsList, execOptions, opts);
    } catch (err) {
        const msg = String(err?.message || err?.stderr || '');
        if (/EAGAIN/i.test(msg) && !_isRgSingleThreadPinned(argsList)) {
            return spawnRgWindowedLines(_rgEagainRetryArgs(argsList), execOptions, opts);
        }
        throw err;
    }
}
