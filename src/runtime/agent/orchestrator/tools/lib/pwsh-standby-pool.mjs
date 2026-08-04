'use strict';
// Warm standby pwsh pool (Windows only). Every one-shot shell call pays the
// pwsh.exe startup cost (~300ms measured). This pool keeps a few pre-spawned
// pwsh processes blocked on stdin; execShellCommand adopts one and feeds the
// command via stdin, cutting call latency roughly in half (measured
// ~330ms → ~155ms end-to-end).
//
// Semantics parity (validated empirically against `pwsh -Command <script>`
// on exit codes, streams, unicode, multi-line scripts, explicit `exit N`,
// native failures, Write-Error, parse errors):
//  - the bootstrap reads RAW stdin bytes and decodes UTF-8 explicitly
//    ([Console]::In uses the ANSI codepage for redirected stdin — Korean/emoji
//    would mojibake otherwise);
//  - the 0/1 exit mapping (`if ($?) { exit 0 } else { exit 1 }`) is APPENDED
//    INTO the script text so `$?` reflects the user script's LAST statement,
//    exactly what pwsh -Command does implicitly; explicit `exit N` and
//    terminating errors bypass it with identical codes;
//  - cwd is applied in-script (Set-Location + [Environment]::CurrentDirectory)
//    since the standby was spawned before the call's cwd was known.
//
// Adoption rules keep this pool NARROW: win32 + pwsh (never Windows
// PowerShell 5.1, whose `$?` native semantics differ) + the standard
// -NoLogo/-NoProfile/-NonInteractive/-Command argv + an env whose signature
// matches the standby's spawn env. Everything else falls back to the classic
// cold spawn path unchanged. Kill-switch: MIXDOG_PWSH_STANDBY_POOL=0.
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { killProcessTree, windowsPidHasDescendants } from '../builtin/shell-job-process.mjs';

function _poolTarget() {
    const n = Math.floor(Number(process.env.MIXDOG_PWSH_STANDBY_POOL));
    if (Number.isFinite(n) && n >= 0) return Math.min(8, n);
    return 2;
}
const POOL_TARGET = _poolTarget();
// Only standbys older than this are handed out: a younger one is still paying
// pwsh startup, so adopting it would just relocate the cold cost. Callers get
// null (classic spawn) while the pool warms.
const STANDBY_READY_AGE_MS = 400;
const EXPECTED_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);

// Marker-loop bootstrap: the standby serves MANY commands over its lifetime.
// Protocol per command (all lines UTF-8 over stdin):
//   <script lines...>
//   <<<MIXDOG_RUN_<nonce>>>>
// The loop resets env + location to the spawn baseline, executes the script
// with the same `$?`→0/1 exit mapping pwsh -Command applies implicitly, then
// emits `<<<MIXDOG_DONE_<nonce>:<code>>>>` on stdout and
// `<<<MIXDOG_DONE_<nonce>>>>` on stderr (both streams provably drained).
// Each command renders through Out-String -Stream and writes lines straight
// to [Console]::Out: host-side Out-Default table rendering proved ASYNC in
// long-lived standbys — formatted object output could flush AFTER the done
// sentinel (whole tables lost from the capture, then surfacing as stale
// bytes at the head of the NEXT command's capture). Rendering inside the
// pipeline and emitting via the SAME Console writer as the sentinel makes
// the ordering structural: every success-stream byte is on stdout before the
// sentinel line. Verified empirically: table shape/blank lines, long lines
// (no 120-col wrap), Write-Error rendering, and the `$?` exit mapping all
// match one-shot `pwsh -Command`.
// stdin EOF exits the process with the LAST command's code — that is exactly
// what background-promotion relies on for its exit-file. A user script that
// calls `exit N` terminates the whole process with N (identical code to the
// one-shot path); the caller settles via 'close' and the entry is discarded.
function _standbyBootScript(nonce) {
    const runPrefix = `<<<MIXDOG_RUN_${nonce}:`;
    const donePrefix = `<<<MIXDOG_DONE_${nonce}`;
    return [
        '$null = & {0}',
        "[Console]::Out.Write('')",
        "[Console]::Error.Write('')",
        '$__sr = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))',
        '$__baseEnv = @{}',
        'Get-ChildItem env: | ForEach-Object { $__baseEnv[$_.Name] = $_.Value }',
        '$__baseLoc = (Get-Location).ProviderPath',
        // Session-isolation baselines: env+cwd alone leaked GLOBAL functions,
        // aliases, variables, modules, and preference values across commands
        // (the pool is daemon-global, so across SESSIONS too). Only global
        // scope can leak — a scriptblock's local defs die with `& $__sc`.
        '$__baseFn = @{}',
        'Get-ChildItem function: | ForEach-Object { $__baseFn[$_.Name] = $true }',
        '$__baseAlias = @{}',
        'Get-ChildItem alias: | ForEach-Object { $__baseAlias[$_.Name] = $_.Definition }',
        '$__baseVar = @{}',
        'Get-Variable -Scope Global -ErrorAction SilentlyContinue | ForEach-Object { $__baseVar[$_.Name] = $true }',
        '$__baseMod = @{}',
        'Get-Module | ForEach-Object { $__baseMod[$_.Name] = $true }',
        '$__basePref = @{}',
        "foreach ($__p in @('ErrorActionPreference','ProgressPreference','VerbosePreference','WarningPreference','InformationPreference','DebugPreference','ConfirmPreference')) { $__basePref[$__p] = Get-Variable -Name $__p -ValueOnly -Scope Global -ErrorAction SilentlyContinue }",
        '$__code = 0',
        'while ($true) {',
        '  $__buf = New-Object System.Text.StringBuilder',
        "  $__tok = ''",
        '  while ($true) {',
        '    $__line = $__sr.ReadLine()',
        '    if ($null -eq $__line) { exit $__code }',
        // Per-COMMAND token: the RUN line carries a fresh token minted at
        // take() time; DONE markers echo it back. A stale DONE from an
        // earlier command on this entry can therefore NEVER match the
        // current command's marker prefix (same-nonce offset hardening).
        `    if ($__line.StartsWith('${runPrefix}') -and $__line.EndsWith('>>>')) { $__tok = $__line.Substring(${runPrefix.length}, $__line.Length - ${runPrefix.length} - 3); break }`,
        '    [void]$__buf.AppendLine($__line)',
        '  }',
        '  foreach ($__n in @(Get-ChildItem env: | ForEach-Object Name)) { if (-not $__baseEnv.ContainsKey($__n)) { Remove-Item ("env:$__n") -ErrorAction SilentlyContinue } }',
        '  foreach ($__k in $__baseEnv.Keys) { Set-Item ("env:$__k") $__baseEnv[$__k] }',
        // Strip global state the previous command left behind; restore
        // overwritten alias definitions and preference values. `__*` variable
        // names are the loop's own internals (created after baseline) and are
        // never removed.
        '  foreach ($__n in @(Get-ChildItem function: | ForEach-Object Name)) { if (-not $__baseFn.ContainsKey($__n)) { Remove-Item ("function:$__n") -Force -ErrorAction SilentlyContinue } }',
        '  foreach ($__a in @(Get-ChildItem alias:)) { if (-not $__baseAlias.ContainsKey($__a.Name)) { Remove-Item ("alias:$($__a.Name)") -Force -ErrorAction SilentlyContinue } elseif ($__a.Definition -ne $__baseAlias[$__a.Name]) { Set-Alias -Name $__a.Name -Value $__baseAlias[$__a.Name] -Scope Global -Force -ErrorAction SilentlyContinue } }',
        '  foreach ($__n in @(Get-Variable -Scope Global -ErrorAction SilentlyContinue | ForEach-Object Name)) { if ($__n -notlike "__*" -and -not $__baseVar.ContainsKey($__n)) { Remove-Variable -Name $__n -Scope Global -Force -ErrorAction SilentlyContinue } }',
        '  foreach ($__n in @(Get-Module | ForEach-Object Name)) { if (-not $__baseMod.ContainsKey($__n)) { Remove-Module -Name $__n -Force -ErrorAction SilentlyContinue } }',
        '  foreach ($__n in @($__basePref.Keys)) { Set-Variable -Name $__n -Value $__basePref[$__n] -Scope Global -Force -ErrorAction SilentlyContinue }',
        '  Set-Location -LiteralPath $__baseLoc',
        '  $global:LASTEXITCODE = 0',
        '  $global:__MIXDOG_RC = 1',
        '  try {',
        "    $__sc = [ScriptBlock]::Create($__buf.ToString() + [Environment]::NewLine + 'if ($?) { $global:__MIXDOG_RC = 0 } else { $global:__MIXDOG_RC = 1 }')",
'    & $__sc | Microsoft.PowerShell.Utility\\Out-String -Stream | Microsoft.PowerShell.Core\\ForEach-Object { [Console]::Out.WriteLine($_) }',
        '  } catch {',
        '    $global:__MIXDOG_RC = 1',
        "    [Console]::Error.WriteLine('Exception: ' + $_.Exception.Message)",
        '  }',
        '  $__code = $global:__MIXDOG_RC',
        '  [Console]::Out.Flush()',
        '  [Console]::Error.Flush()',
        `  [Console]::Out.WriteLine('${donePrefix}:' + $__tok + ':' + $__code + '>>>')`,
        `  [Console]::Error.WriteLine('${donePrefix}:' + $__tok + '>>>')`,
        '}',
    ].join('\n');
}

const _idle = [];
let _envSig = null;
let _exitHookInstalled = false;

function _envSignature(env) {
    const h = createHash('sha1');
    for (const k of Object.keys(env).sort()) {
        h.update(k); h.update('='); h.update(String(env[k] ?? '')); h.update('\0');
    }
    return h.digest('base64');
}

function _killEntry(entry) {
    try { entry.child.kill(); } catch { /* already down */ }
}

function _discardIdle(entry) {
    const i = _idle.indexOf(entry);
    if (i !== -1) _idle.splice(i, 1);
}

function _installExitHook() {
    if (_exitHookInstalled) return;
    _exitHookInstalled = true;
    // Idle standbys block on stdin forever; never leave them behind.
    process.once('exit', () => {
        for (const entry of _idle.splice(0)) _killEntry(entry);
    });
}

function _spawnStandby(shell, env, sig) {
    let child;
    const nonce = randomBytes(8).toString('hex');
    try {
        child = spawn(shell, [...EXPECTED_ARGS, _standbyBootScript(nonce)], {
            env,
            cwd: process.env.SystemRoot || 'C:\\Windows',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
        });
    } catch { return; }
    const entry = { child, sig, nonce, spawnedAt: Date.now(), taken: false, consumed: false };
    child.on('error', () => { if (!entry.taken) { _discardIdle(entry); _killEntry(entry); } });
    child.on('exit', () => { if (!entry.taken) _discardIdle(entry); });
    // A dead standby's pending stdin write must never crash the daemon.
    child.stdin?.on?.('error', () => { /* swallow — entry is discarded via exit */ });
    // Idle standbys must not hold the event loop open (process handle AND
    // pipe handles each ref it). Re-ref'd on take.
    try {
        child.unref();
        child.stdin?.unref?.();
        child.stdout?.unref?.();
        child.stderr?.unref?.();
    } catch { /* best-effort */ }
    _idle.push(entry);
}

function _topUp(shell, env, sig) {
    while (_idle.length < POOL_TARGET) _spawnStandby(shell, env, sig);
}

/**
 * Adopt a warm standby for this call, or return null for the classic spawn
 * path. On success returns { child, feed(spawnCommand, cwd) }; the caller
 * wires its stdio/exit handlers FIRST and then calls feed() exactly once.
 */
export function takePwshStandby({ shell, shellArgs, env }) {
    if (process.platform !== 'win32' || POOL_TARGET === 0) return null;
    const stem = basename(String(shell || '')).toLowerCase();
    if (stem !== 'pwsh' && stem !== 'pwsh.exe') return null;
    if (!Array.isArray(shellArgs)
        || shellArgs.length !== EXPECTED_ARGS.length
        || shellArgs.some((a, i) => a !== EXPECTED_ARGS[i])) return null;
    if (!env || typeof env !== 'object') return null;
    _installExitHook();
    const sig = _envSignature(env);
    if (sig !== _envSig) {
        // Env changed (secrets scrub set, locale, config reload): stale
        // standbys would run with the old env — drain and respawn.
        for (const entry of _idle.splice(0)) _killEntry(entry);
        _envSig = sig;
    }
    _topUp(shell, env, sig);
    const now = Date.now();
    let entry = null;
    for (let i = 0; i < _idle.length; i += 1) {
        const cand = _idle[i];
        if (now - cand.spawnedAt < STANDBY_READY_AGE_MS) continue;
        if (cand.child.exitCode !== null || cand.child.signalCode !== null) continue;
        if (!cand.child.stdin || cand.child.stdin.destroyed) continue;
        _idle.splice(i, 1);
        entry = cand;
        break;
    }
    if (!entry) return null;
    entry.taken = true;
    entry.consumed = false;
    try {
        entry.child.ref();
        entry.child.stdin?.ref?.();
        entry.child.stdout?.ref?.();
        entry.child.stderr?.ref?.();
    } catch { /* best-effort */ }
    _topUp(shell, env, sig);
    // Fresh token per command: DONE markers are only valid when they echo
    // this token, so any straggler marker from a previous command on the
    // same entry (same nonce) is inert for this capture.
    const runToken = randomBytes(6).toString('hex');
    return {
        child: entry.child,
        nonce: entry.nonce,
        runSentinel: `<<<MIXDOG_RUN_${entry.nonce}:${runToken}>>>`,
        doneMarkerPrefix: `<<<MIXDOG_DONE_${entry.nonce}:${runToken}`,
        // Entry-scoped prefix: lines matching this but NOT doneMarkerPrefix
        // are stale markers from an earlier command — the caller drops them
        // from the capture instead of surfacing sentinel noise.
        staleMarkerPrefix: `<<<MIXDOG_DONE_${entry.nonce}`,
        run(spawnCommand, cwdForRun) {
            const esc = String(cwdForRun || '').replace(/'/g, "''");
            const prelude = esc
                ? `Set-Location -LiteralPath '${esc}' -ErrorAction Stop\n[Environment]::CurrentDirectory = '${esc}'\n`
                : '';
            try {
                const body = prelude + String(spawnCommand ?? '');
                entry.child.stdin.write(body.endsWith('\n') ? body : `${body}\n`, 'utf8');
                entry.child.stdin.write(`<<<MIXDOG_RUN_${entry.nonce}:${runToken}>>>\n`, 'utf8');
                return true;
            } catch {
                // Feed failed (child died in the take→run window): kill so the
                // caller's close handler settles with an error result.
                _killEntry(entry);
                return false;
            }
        },
        // Background-promotion handoff: after the in-flight command completes,
        // the loop reads EOF and exits with that command's code — the adopted
        // job's close-wired exit file then records the REAL command exit.
        endStdin() {
            entry.consumed = true;
            try { entry.child.stdin.end(); } catch { /* already gone */ }
        },
        // Post-command recycle: return the standby to the pool ONLY when the
        // command left no descendant processes attached to its stdio (a live
        // grandchild would pollute the NEXT command's capture). Dirty, dead,
        // env-stale, or surplus standbys are tree-killed instead. Runs off the
        // result path; the caller releases its admission lease afterwards.
        async recycle() {
            if (entry.consumed) return false;
            entry.consumed = true;
            const c = entry.child;
            const alive = () => c.exitCode === null && c.signalCode === null;
            let dirty = true;
            if (alive() && c.stdin && !c.stdin.destroyed) {
                try { dirty = await windowsPidHasDescendants(c.pid); } catch { dirty = true; }
            }
            if (dirty || !alive() || !c.stdin || c.stdin.destroyed
                || _idle.length >= POOL_TARGET || _envSig !== entry.sig) {
                try { killProcessTree(c.pid, 'SIGKILL'); } catch { /* already down */ }
                _killEntry(entry);
                return false;
            }
            // Drain bytes a previous command left in the paused streams (late
            // flushes that raced past the caller's detach). Without this they
            // would surface at the HEAD of the next command's capture.
            // Diagnostic (2026-08-04, intermittent empty-capture reports in a
            // long-lived host): any stale byte seen here PROVES output escaped
            // a finished command's capture on this entry — the exact precursor
            // of a same-nonce marker offset corrupting the NEXT command. Rare
            // by construction, so the log is always-on and one line.
            let _staleBytes = 0;
            try { let b; while ((b = c.stdout.read()) !== null) { _staleBytes += b.length; } } catch { /* best-effort */ }
            try { let b; while ((b = c.stderr.read()) !== null) { _staleBytes += b.length; } } catch { /* best-effort */ }
            if (_staleBytes > 0) {
                try {
                    process.stderr.write(`[pwsh-standby] recycle drained ${_staleBytes}B stale output (pid=${c.pid}) — late flush escaped the previous command's capture\n`);
                } catch { /* diagnostics only */ }
            }
            entry.taken = false;
            entry.consumed = false;
            entry.spawnedAt = Date.now() - STANDBY_READY_AGE_MS;
            try {
                c.unref();
                c.stdin?.unref?.();
                c.stdout?.unref?.();
                c.stderr?.unref?.();
            } catch { /* best-effort */ }
            _idle.push(entry);
            return true;
        },
    };
}

/**
 * Boot-time warmup: spawn the standby processes NOW (same gates as take) so a
 * session's first shell call finds a warm pool instead of paying the pwsh
 * startup cost. Best-effort; returns true when standbys were ensured.
 */
export function prewarmPwshStandbyPool({ shell, shellArgs, env }) {
    if (process.platform !== 'win32' || POOL_TARGET === 0) return false;
    const stem = basename(String(shell || '')).toLowerCase();
    if (stem !== 'pwsh' && stem !== 'pwsh.exe') return false;
    if (!Array.isArray(shellArgs)
        || shellArgs.length !== EXPECTED_ARGS.length
        || shellArgs.some((a, i) => a !== EXPECTED_ARGS[i])) return false;
    if (!env || typeof env !== 'object') return false;
    _installExitHook();
    const sig = _envSignature(env);
    if (sig !== _envSig) {
        for (const entry of _idle.splice(0)) _killEntry(entry);
        _envSig = sig;
    }
    _topUp(shell, env, sig);
    return true;
}
