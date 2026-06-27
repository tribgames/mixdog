import { spawn, execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startChildGuardian } from '../../../../shared/child-guardian.mjs';

const execFileAsync = promisify(execFile);

let _rgExecutableResolved = null;

async function _resolveRgExecutable() {
    const isWin = process.platform === 'win32';
    try {
        const cmd = isWin ? 'where' : 'which';
        const { stdout: out } = await execFileAsync(cmd, ['rg'], { encoding: 'utf8', windowsHide: true });
        const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        if (first && existsSync(first)) return first;
    } catch { /* fall through to PATH scan */ }
    const pathSep = isWin ? ';' : ':';
    const dirs = String(process.env.PATH || '').split(pathSep).filter(Boolean);
    const pathext = isWin
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
        : [''];
    const names = isWin ? ['rg.exe', 'rg'] : ['rg'];
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = join(dir, name);
            if (!existsSync(candidate)) continue;
            if (isWin) {
                const ext = candidate.slice(candidate.lastIndexOf('.')).toLowerCase();
                if (ext && !pathext.includes(ext)) continue;
            }
            return candidate;
        }
    }
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
let _rgResolvePromise = null;
async function ensureRgResolved() {
    if (_rgExecutableResolved !== null) return _rgExecutableResolved;
    if (!_rgResolvePromise) {
        _rgResolvePromise = _resolveRgExecutable().then((resolved) => {
            _rgExecutableResolved = resolved;
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
    if (_rgFallbackUsable === true) return true;
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
    return new Promise((resolve, reject) => {
        const proc = spawn(rgExecutable(), argsList, {
            cwd: execOptions?.cwd,
            env: execOptions?.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        startChildGuardian({ childPid: proc.pid, label: 'rg-runner' });
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
    });
}

export async function runRg(argsList, execOptions = {}) {
    await assertRgAvailable();
    try {
        return await spawnRg(argsList, execOptions);
    } catch (err) {
        const msg = String(err?.message || err?.stderr || '');
        if (/EAGAIN/i.test(msg) && !argsList.includes('-j')) {
            return spawnRg(['-j', '1', ...argsList], execOptions);
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
    return new Promise((resolve, reject) => {
        const proc = spawn(rgExecutable(), argsList, {
            cwd: execOptions?.cwd,
            env: execOptions?.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        startChildGuardian({ childPid: proc.pid, label: 'rg-runner-windowed' });
        let buffer = '';
        let stderr = '';
        let skipped = 0;
        let seenAfterOffset = 0;
        let stoppedEarly = false;
        let timedOut = false;
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
                return resolve({ lines, complete: false, totalSeen: seenAfterOffset });
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
    });
}

export async function runRgWindowedLines(argsList, execOptions = {}, opts = {}) {
    await assertRgAvailable();
    try {
        return await spawnRgWindowedLines(argsList, execOptions, opts);
    } catch (err) {
        const msg = String(err?.message || err?.stderr || '');
        if (/EAGAIN/i.test(msg) && !argsList.includes('-j')) {
            return spawnRgWindowedLines(['-j', '1', ...argsList], execOptions, opts);
        }
        throw err;
    }
}
