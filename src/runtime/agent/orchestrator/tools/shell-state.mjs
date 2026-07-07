'use strict';
// Shell state carry-over for the one-shot shell tool.
//
// No live shell process is kept. Instead, after each sync command we chain a
// trailing cwd probe that writes the final working directory to a per-session
// state file. The next shell call (without an explicit cwd arg) reads that file
// and starts there — mimicking a persistent terminal's cwd without a PTY.
//
// Style mirrors shell-snapshot.mjs: files live under getPluginData(), one file
// per session key, with a stale-file sweep on module init.

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { readdir as readdirAsync, stat as statAsync, unlink as unlinkAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPluginData } from '../config.mjs';

function _stateDir() {
    return join(getPluginData(), 'shell-state');
}

// One file per session key. Hash the key so arbitrary session ids (which may
// contain path-hostile chars) map to a safe, collision-resistant filename.
function _keyFor(sessionKey) {
    const raw = String(sessionKey == null || sessionKey === '' ? '__default__' : sessionKey);
    return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function _stateFileFor(sessionKey) {
    return join(_stateDir(), `cwd-${_keyFor(sessionKey)}.txt`);
}

// Stale-file sweep on module init. Mirrors shell-snapshot's _sweepStaleSnapshots:
// state files older than the cutoff belong to sessions that are long gone.
const STATE_STALE_MS = 24 * 60 * 60 * 1000;
async function _sweepStaleState() {
    const dir = _stateDir();
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - STATE_STALE_MS;
    let names;
    try { names = await readdirAsync(dir); } catch { return; }
    await Promise.all(names.map(async (name) => {
        if (!name.startsWith('cwd-') || !name.endsWith('.txt')) return;
        const p = join(dir, name);
        try {
            const st = await statAsync(p);
            if (st.mtimeMs < cutoff) {
                // Tolerate the stat→unlink race: a concurrent write may have
                // refreshed mtime, or another sweeper may have already removed
                // it. ENOENT and any transient error are non-fatal.
                try { await unlinkAsync(p); } catch (err) { if (err && err.code !== 'ENOENT') { /* swallow */ } }
            }
        } catch {}
    }));
}
_sweepStaleState();

// Resolve the effective cwd for a shell call. Explicit cwd always wins (the
// caller resolved/validated it already). Otherwise, if a stored cwd exists and
// still points at a live directory, use it; else fall back to defaultCwd.
export function resolveSessionCwd(sessionKey, explicitCwd, defaultCwd) {
    if (explicitCwd) return explicitCwd;
    // No nonblank session key → no carry-over (mirrors stateFilePath). Without a
    // real key every caller would share the `__default__` file and read each
    // other's cwd, so skip the store entirely and use the default.
    if (sessionKey == null || String(sessionKey).trim() === '') return defaultCwd;
    try {
        const file = _stateFileFor(sessionKey);
        if (!existsSync(file)) return defaultCwd;
        const stored = readFileSync(file, 'utf-8').trim();
        if (!stored) return defaultCwd;
        const st = statSync(stored);
        if (st.isDirectory()) return stored;
    } catch {}
    return defaultCwd;
}

// Path to the state file for this session (created lazily). Returned so the
// caller can embed it in the probe chain. Returns null if the dir can't be made
// OR when there is no nonblank session key — without a real key all callers
// would collapse onto a single shared `__default__` file and cross-contaminate
// each other's cwd, so we skip carry-over entirely in that case.
export function stateFilePath(sessionKey) {
    if (sessionKey == null || String(sessionKey).trim() === '') return null;
    const dir = _stateDir();
    try { mkdirSync(dir, { recursive: true }); } catch { return null; }
    const file = _stateFileFor(sessionKey);
    // Refresh mtime on every write so an old-but-live session file is not
    // reaped by the stale sweep mid-session. `touch`-equivalent: bump atime/
    // mtime to now if the file already exists; a fresh file gets its mtime on
    // first write by the probe redirection.
    try {
        if (existsSync(file)) {
            const now = new Date();
            utimesSync(file, now, now);
        }
    } catch {}
    return file;
}

// PowerShell single-quote escape ('' escapes a literal quote inside '...').
function _psQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

// POSIX single-quote escape.
function _shQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Append a trailing cwd probe so the final working directory is persisted after
// the user command runs. The probe is joined with `;` (statement separator, not
// `&&`) so it runs regardless of the command's exit status, and it does not
// touch the exit code the runtime reports: the runtime reads the child's exit
// code, and neither `Out-File` nor a redirection changes `$?`/`$LASTEXITCODE`
// semantics observed by the *process* exit — the shell's exit status is the
// last statement's, but see wrapWithCwdProbe callers which capture the code
// BEFORE the probe. For PowerShell we snapshot $LASTEXITCODE/$? and restore the
// process exit via `exit` so the probe cannot mask a non-zero command.
export function wrapPowerShellWithCwdProbe(command, stateFile) {
    if (!stateFile) return command;
    const qFile = _psQuote(stateFile);
    // $?-driven, bash-like exit semantics. $LASTEXITCODE persists the last
    // *native* process's code indefinitely, so a prologue reset cannot cover
    // intra-command staleness (`cmd /c exit 5; Write-Output ok` leaves the
    // trailing cmdlet succeeding but $LASTEXITCODE still 5). Instead we mirror
    // bash: the exit code is the LAST statement's success. $? immediately after
    // the command reflects that statement — false only when it failed, and for
    // a failing native call $LASTEXITCODE holds its real code (case3 → 7).
    //
    // The `if (-not $?)` check MUST be the first statement after the command;
    // any intervening statement resets $?. Terminating errors (`throw`,
    // `-ErrorAction Stop`, .NET exceptions) skip to catch → $__ec = 1. A
    // *caught* terminating error is NOT auto-written to the error stream, so
    // without re-emitting it the caller only sees `[exit code: 1] (no output)`.
    // Re-surface the ErrorRecord on stderr so the failure cause reaches the
    // result envelope. The cwd probe runs in finally regardless, and we exit
    // with $__ec so the probe never masks the observed code.
    return '$global:LASTEXITCODE = 0\n'
        + '$__ec = 0\n'
        + 'try {\n'
        + `${command}\n`
        + '  if (-not $?) { $__ec = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }\n'
        + '} catch { [Console]::Error.WriteLine(($_ | Out-String).Trim()); $__ec = 1 }\n'
        + `finally { (Get-Location).Path | Out-File -Encoding utf8 ${qFile} }\n`
        + 'exit $__ec';
}

export function wrapBashWithCwdProbe(command, stateFile) {
    if (!stateFile) return command;
    const qFile = _shQuote(stateFile);
    // Capture $? before the probe, run the probe unconditionally (`;`), then
    // re-exit with the saved status so `pwd`/redirection cannot mask it.
    return `${command}\n`
        + '__mixdog_ec=$?;\n'
        + `pwd -P >| ${qFile} 2>/dev/null || true;\n`
        + 'exit $__mixdog_ec';
}
