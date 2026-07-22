// Background shell-job spawn implementation, extracted from shell-jobs.mjs.
import { spawn } from 'child_process';
import { existsSync, readFileSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from 'fs';
import { basename } from 'path';
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
import {
    attachJobInsights,
    looksLikeInteractivePrompt,
    readPromptTail,
    shellJobOutputBytes,
    shellJobPublicTaskResult,
    SHELL_JOB_OUTPUT_DISK_CAP,
} from './lib/shell-job-insights.mjs';
import {
    sleep,
    awaitSpawnReady,
    adoptSpawnErrorHandler,
    discardSpawnErrorGuard,
    rollbackSpawnedChild,
    shellQuoteSingle,
    psSingleQuote,
    isPowerShellShell,
} from './lib/shell-spawn-helpers.mjs';

// Facade re-exports: path/detail helpers and the job-not-found message moved
// to sibling modules; keep existing importers of shell-jobs.mjs resolving.

globalThis.__mixdogShellJobsRuntimeLoaded = true;


// Poll cadence for the adopted-job output-cap self-tick (mirrors the
// foreground sizeWatchdog in shell-command.mjs).

import { refreshShellJob, trackChildUntilConfirmedExit, releaseShellJobOwnershipWhenQuiescent } from './shell-jobs.mjs';

export async function _startBackgroundShellJobImpl({
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
        discardSpawnErrorGuard(child);
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

export async function startBackgroundPowerShellJob({
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
        discardSpawnErrorGuard(child);
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
