import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { execShellCommand, stripAnsi } from '../shell-command.mjs';
import { wrapCommandWithSnapshot } from '../shell-snapshot.mjs';
import { getDestructiveCommandWarning } from '../destructive-warning.mjs';
import { maybeRewriteWmicProcessCommand } from '../shell-policy.mjs';
import { buildBashPolicyScanTargets, checkExecPolicyMessage } from '../bash-policy-scan.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from '../code-graph-state.mjs';
import {
    buildJobNotFoundMessage,
    startBackgroundShellJob,
    waitForShellJob,
    peekShellJob,
    killShellJob,
    watchBackgroundShellJob,
    cancelBackgroundShellJobWatch,
    beginShellJobWait,
    endShellJobWait,
    clearShellJobNotifyCtx,
    shellJobPublicTaskResult,
} from './shell-jobs.mjs';
import {
    analyzeShellCommandEffects,
    foregroundLongCommandHint,
} from './shell-analysis.mjs';
import {
    cancelBackgroundTask,
    completeBackgroundTask,
    getBackgroundTask,
    registerBackgroundTask,
    renderBackgroundTask,
    renderBackgroundTaskList,
    resolveExecutionMode,
} from '../../../../shared/background-tasks.mjs';
import { resolveShellFor } from './shell-runtime.mjs';
import { smartMiddleTruncate } from './shell-output.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { resolveOptionalCwd } from './cwd-utils.mjs';
import { scrubLoaderVars, scrubProviderSecrets } from '../env-scrub.mjs';
import { resolveSessionCwd, stateFilePath, wrapPowerShellWithCwdProbe, wrapBashWithCwdProbe } from '../shell-state.mjs';

// Post-exec drift detection. After a foreground shell command, compare the
// live mtime+size of files mixdog has already read this session against their
// pre-command state (captured just before exec). Files this command changed
// surface as ONE compact reminder so the model re-reads before editing —
// closing the "external write -> stale old_string -> code 8" gap when shell is
// routed through this tool. Bounded to the tracked-read set (capped) so cost
// stays off the whole-cwd path; emits nothing when no read file changed.
export function _captureTrackedMtimes(_scope) {
    return new Map();
}
export function _trackedDriftNoteAfter(_scope, _pre) {
    return '';
}

// Combine an existing session abort signal with an externally-supplied
// AbortSignal (e.g. the MCP/request signal threaded through options.abortSignal).
// Returns null when neither is present so existing session-only behavior is
// preserved unchanged. Uses AbortSignal.any when available; falls back to a
// manual controller + listener path otherwise. The returned signal aborts as
// soon as either input signal aborts, which propagates to execShellCommand /
// executeBashSessionTool and triggers the same child-kill path the session
// signal already drives.
function _combineAbortSignals(sessionSignal, externalSignal) {
    const a = sessionSignal || null;
    const b = externalSignal || null;
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    if (a === b) return a;
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        try { return AbortSignal.any([a, b]); } catch { /* fall through */ }
    }
    const ctl = new AbortController();
    const onAbort = (sig) => {
        if (ctl.signal.aborted) return;
        try { ctl.abort(sig?.reason); } catch { try { ctl.abort(); } catch {} }
    };
    if (a.aborted) { onAbort(a); return ctl.signal; }
    if (b.aborted) { onAbort(b); return ctl.signal; }
    try { a.addEventListener('abort', () => onAbort(a), { once: true }); } catch {}
    try { b.addEventListener('abort', () => onAbort(b), { once: true }); } catch {}
    return ctl.signal;
}

function _prefixPowerShellUtf8(command) {
    const prefix = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;';
    const text = String(command || '');
    return text.trimStart().startsWith(prefix) ? text : `${prefix}\n${text}`;
}

export function getDedupedDestructiveWarnings(command) {
    const seenMsg = new Set();
    const warnings = [];
    for (const t of buildBashPolicyScanTargets(command)) {
        const w = getDestructiveCommandWarning(t);
        if (w && !seenMsg.has(w)) {
            seenMsg.add(w);
            warnings.push(w);
        }
    }
    return warnings;
}

function _prependDestructiveWarning(command, text) {
    const warnings = getDedupedDestructiveWarnings(command);
    if (!warnings.length) return text;
    return `${warnings.map((w) => `⚠️ ${w}`).join('\n')}\n${text}`;
}

export async function executeBashTool(args, workDir, options = {}) {
    const requestedCwd = args.cwd ?? args.workdir;
    const cwdResult = resolveOptionalCwd(requestedCwd, workDir);
    if (cwdResult.error) return cwdResult.error;
    // Session cwd carry-over (no live shell): when the model
    // passes an explicit cwd it wins and updates the store on the next probe;
    // otherwise reuse the last stored cwd for this session if it still exists.
    const _hasExplicitCwd = typeof requestedCwd === 'string' && requestedCwd.trim() !== '';
    const _sessionCwdKey = options?.sessionId ?? options?.readStateScope ?? options?.callerSessionId ?? null;
    const bashWorkDir = resolveSessionCwd(_sessionCwdKey, _hasExplicitCwd ? cwdResult.cwd : null, cwdResult.cwd);
    const _readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
    const executionMode = resolveExecutionMode(args || {}, args?.run_in_background === true ? 'async' : 'sync');
    const runInBackground = executionMode === 'async';

    // Run hard-block policy BEFORE branching into the persistent-shell tool.
    // The persistent path used to bypass the one-shot block scan because the
    // normalization (stripQuotedAndHeredoc / extractShellCInner / unquoted
    // span sweep) lived only on the one-shot side. Centralised policy in
    // shell-policy.mjs already covers the literal scan + EncodedCommand
    // decode + rm token guard; calling it here applies the same allowlist
    // to both persistent and stateless paths.
    const _rawCmd = String(args && args.command != null ? args.command : '');
    if (_rawCmd) {
        // R5-③: persistent:true used to route into bash_session BEFORE the
        // stripQuotedAndHeredoc / extractShellCInner / unquote sweep ran
        // (that sweep lived only on the stateless one-shot path below at
        // ~:218). Result: `bash -c 'shutdown -h now'` / `sh -c 'mkfs ...'` /
        // dd payloads were rejected stateless but accepted with
        // persistent:true. Run the full sweep here so both paths share the
        // same blocklist before dispatch.
        const _policyBlock = checkExecPolicyMessage(_rawCmd);
        if (_policyBlock) return _policyBlock;
    }

    // An empty-string session_id is NOT a persistent-session request: `typeof
    // '' === 'string'` would otherwise route a stateless call into the
    // persistent path and (on Windows) hard-fail with the disabled-sessions
    // error, which models then retry in a loop. Require a non-blank id.
    if (args.persistent === true || (typeof args.session_id === 'string' && args.session_id.trim().length > 0)) {
        if (process.platform === 'win32') {
            return 'Error: persistent shell sessions are disabled on Windows native-shell mode; run one-shot PowerShell commands without persistent/session_id.';
        }
        const { executeBashSessionTool } = await import('../bash-session.mjs');
        let persistAbort = null;
        try { persistAbort = (await getAbortSignalForSession(options?.sessionId)) || null; }
        catch { persistAbort = null; }
        const combinedPersistAbort = _combineAbortSignals(persistAbort, options?.abortSignal || null);
        let effectiveArgs = (args.persistent === true && !args.session_id && options?.sessionId)
            ? { ...args, session_id: `__default__${options.sessionId}` }
            : (typeof args.session_id === 'string' && options?.sessionId)
            ? { ...args, session_id: `${options.sessionId}__${args.session_id}` }
            : args;
        const userProvidedSession = typeof args.session_id === 'string' && args.session_id.trim().length > 0;
        const shouldCreate = args.create === true || !userProvidedSession;
        effectiveArgs = { ...effectiveArgs, create: shouldCreate };
        return executeBashSessionTool('bash_session', effectiveArgs, bashWorkDir, { abortSignal: combinedPersistAbort, sessionId: options?.sessionId });
    }

    let command = args.command;
    if (!command) return 'Error: command is required';

    // Resolve the shell up front so shell-type-specific handling (PS-only wmic
    // rewrite, PS UTF-8 prefix) can gate on it. kind 'default' is byte-identical
    // to today's resolveShell(); kind 'bash' on Windows resolves Git Bash, and a
    // null spec means it is genuinely not installed — surface a clear error with
    // NO silent fallback to the other shell.
    const shellKind = args.shell === 'bash' || args.shell === 'powershell' ? args.shell : 'default';
    const resolvedSpec = resolveShellFor(shellKind);
    if (!resolvedSpec) {
        if (shellKind === 'bash') {
            return "Error: Git Bash not found — install Git for Windows or omit shell:'bash'.";
        }
        return "Error: pwsh (PowerShell) not found — install PowerShell or omit shell:'powershell'.";
    }

    // wmic→PowerShell rewrite is PowerShell-only; never mangle a command bound
    // for bash (gate on the resolved shell type).
    // Note: gating this to powershell did NOT change POSIX behavior — wmic is a
    // Windows-only tool, so the rewrite was already dead code on POSIX hosts;
    // the gate just makes that explicit.
    const wmicRewrite = resolvedSpec.shellType === 'powershell'
        ? maybeRewriteWmicProcessCommand(command)
        : null;
    if (wmicRewrite?.error) return `Error: ${wmicRewrite.error}`;
    if (wmicRewrite?.command) command = wmicRewrite.command;

    const _execPolicyBlock = checkExecPolicyMessage(command);
    if (_execPolicyBlock) {
        return _execPolicyBlock;
    }

    let shellEffects;
    try {
        shellEffects = await analyzeShellCommandEffects(command, bashWorkDir);
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    // Keep foreground commands on a long tool-owned timeout. The MCP dispatch
    // layer must not add a shorter fallback ceiling when timeout is omitted.
    // Claude Code parity (refs/claude-code src/utils/timeouts.ts): default
    // 120 s (2 min), max 600 s (10 min); BASH_DEFAULT_TIMEOUT_MS /
    // BASH_MAX_TIMEOUT_MS env overrides, max floored at default.
    const _envDefaultTimeout = parseInt(process.env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
    const DEFAULT_BASH_TIMEOUT_MS = _envDefaultTimeout > 0 ? _envDefaultTimeout : 120_000;
    const DEFAULT_BACKGROUND_BASH_TIMEOUT_MS = DEFAULT_BASH_TIMEOUT_MS;
    const _envMaxTimeout = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
    const MAX_BASH_TIMEOUT_MS = Math.max(_envMaxTimeout > 0 ? _envMaxTimeout : 600_000, DEFAULT_BASH_TIMEOUT_MS);
    const defaultTimeoutMs = runInBackground
        ? DEFAULT_BACKGROUND_BASH_TIMEOUT_MS
        : DEFAULT_BASH_TIMEOUT_MS;
    const rawTimeout = (typeof args.timeout === 'number' && args.timeout > 0)
        ? args.timeout : defaultTimeoutMs;
    const timeoutMs = rawTimeout;
    const timeout = Math.min(timeoutMs, wmicRewrite?.timeoutMs || MAX_BASH_TIMEOUT_MS);
    const mergeStderr = args.merge_stderr === true;
    const longForegroundHint = foregroundLongCommandHint(command, timeout, { ...args, run_in_background: runInBackground });
    if (longForegroundHint) return longForegroundHint;
    // Auto-background threshold (CC ASSISTANT_BLOCKING_BUDGET_MS analogue):
    // a foreground one-shot that is still running after this many ms is
    // detached into a tracked shell-job instead of blocking the tool call
    // indefinitely. Only the foreground one-shot path uses it — never
    // run_in_background (already detached) or persistent sessions (handled
    // far above). Capped below the hard timeout so the 600 s upper bound
    // stays a separate, later ceiling.
    // Soft config: reuse the sync task-wait budget (30 s, see waitForShellJob
    // default in executeTaskTool) as the default promotion threshold. Override
    // with MIXDOG_SHELL_AUTO_BACKGROUND_MS (positive ms). This is a soft hint,
    // not a hard cap — the value is clamped below `timeout` so the hard ceiling
    // stays a separate, later bound.
    const _autoBgEnvMs = Number(process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS);
    const DEFAULT_AUTO_BACKGROUND_MS = Number.isFinite(_autoBgEnvMs) && _autoBgEnvMs > 0
      ? Math.floor(_autoBgEnvMs)
      : 30_000;
    const autoBackgroundMs = runInBackground
      ? 0
      : Math.min(DEFAULT_AUTO_BACKGROUND_MS, timeout);

    try {
        const { shell, shellArg, shellArgs, shellType } = resolvedSpec;
        const spawnEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        // R5/R11: same scrub as background/persistent spawn sites (env-scrub.mjs).
        scrubProviderSecrets(spawnEnv);
        scrubLoaderVars(spawnEnv);
        let wrappedCommand;
        // PowerShell UTF-8 prefix is PS-only: the Windows Git Bash path
        // (shellType==='posix') must NOT receive it. Snapshot wrapper stays
        // POSIX-host-only for now — no snapshot for Windows Git Bash initially.
        if (process.platform === 'win32' && shellType === 'powershell') {
            wrappedCommand = _prefixPowerShellUtf8(command);
        } else if (process.platform !== 'win32' && (shell.includes('bash') || shell.includes('zsh'))) {
            try {
                wrappedCommand = await wrapCommandWithSnapshot(shell, command);
            } catch (wrapErr) {
                return `Error: shell snapshot wrapper failed — ${normalizeErrorMessage(wrapErr instanceof Error ? wrapErr.message : String(wrapErr))}`;
            }
        } else {
            wrappedCommand = command;
        }
        if (runInBackground) {
            const job = startBackgroundShellJob({
                command: wrappedCommand,
                timeoutMs: timeout,
                workDir: bashWorkDir,
                mergeStderr,
                spawnEnv,
                shell,
                shellArg,
                shellArgs,
                shellType,
                // Per-terminal session stamp: the dispatching terminal's
                // claude.exe pid (server-main threads callerSession.clientHostPid).
                clientHostPid: options?.clientHostPid,
            });
            if (job && job.error) return `Error: ${job.error}`;
            let task;
            try {
                task = registerBackgroundTask({
                    taskId: job.jobId,
                    surface: 'shell',
                    operation: 'shell',
                    label: String(command).replace(/\s+/g, ' ').slice(0, 120),
                    input: { command, cwd: bashWorkDir },
                    context: {
                        notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                        callerSessionId: options?.callerSessionId || options?.sessionId || null,
                        routingSessionId: options?.routingSessionId || options?.sessionId || null,
                        clientHostPid: options?.clientHostPid,
                    },
                    meta: {
                        task_id: job.jobId,
                        pid: job.pid,
                        stdout: normalizeOutputPath(job.stdoutPath),
                        stderr: mergeStderr ? null : normalizeOutputPath(job.stderrPath),
                        cwd: bashWorkDir,
                        timeoutMs: timeout,
                    },
                    resultType: 'shell_task_result',
                    cancel: () => killShellJob(job.jobId),
                });
            } catch (err) {
                try { killShellJob(job.jobId); } catch { /* best effort cleanup */ }
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }
            // Wire a one-shot completion push so the dispatching session learns
            // the background task finished (no polling tool is auto-driven). The
            // notify ctx is threaded down from the MCP dispatch frame
            // (server-main agentContext / _dispatchByModule) the same way the
            // agent/explore-style tools receive notifyFn/routingSessionId/clientHostPid.
            // Missing notifyFn (e.g. a non-MCP caller) degrades to a stderr
            // diagnostic inside watchBackgroundShellJob — never fails the spawn.
            try {
                watchBackgroundShellJob(job.jobId, {
                    notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                    callerSessionId: options?.callerSessionId || options?.sessionId,
                    routingSessionId: options?.routingSessionId,
                    clientHostPid: options?.clientHostPid,
                });
            } catch { /* watcher arm is best-effort; never blocks the spawn */ }
            return _prependDestructiveWarning(command, renderBackgroundTask(task));
        }

        let bashAbortSignal = null;
        try { bashAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
        catch { bashAbortSignal = null; }
        const combinedBashAbort = _combineAbortSignals(bashAbortSignal, options?.abortSignal || null);
        // Sync path only: chain a trailing cwd probe so the session's final
        // working directory persists to the next shell call. Async jobs run
        // detached and are intentionally excluded (they never reach here). The
        // probe captures the command's exit status first and re-exits with it,
        // so the exit code the model sees is unchanged.
        let syncCommand = wrappedCommand;
        try {
            const _stateFile = stateFilePath(_sessionCwdKey);
            if (_stateFile) {
                syncCommand = (process.platform === 'win32' && shellType === 'powershell')
                    ? wrapPowerShellWithCwdProbe(wrappedCommand, _stateFile)
                    : wrapBashWithCwdProbe(wrappedCommand, _stateFile);
            }
        } catch { syncCommand = wrappedCommand; }
        const result = await execShellCommand({
            shell, shellArg, shellArgs, command: syncCommand,
            env: spawnEnv,
            cwd: bashWorkDir,
            timeoutMs: timeout,
            abortSignal: combinedBashAbort,
            autoBackgroundMs,
            // Threaded so an auto-backgrounded foreground job is stamped with
            // the dispatching terminal's claude.exe pid (per-terminal scope).
            clientHostPid: options?.clientHostPid,
            // MCP live-progress reporter (null unless the client subscribed via
            // callTool onprogress). execShellCommand emits throttled "running
            // Ns" frames while the foreground command runs.
            onProgress: typeof options?.onProgress === 'function' ? options.onProgress : null,
        });
        // Auto-backgrounded: the command outlived autoBackgroundMs and is
        // still running, now adopted as a tracked shell-job. Surface the
        // task_id + partial output for manual task control instead of
        // keeping the tool call open until the hard timeout.
        if (result.backgrounded) {
            let task = null;
            if (result.jobId) {
                try {
                    task = registerBackgroundTask({
                        taskId: result.jobId,
                        surface: 'shell',
                        operation: 'shell',
                        label: String(command).replace(/\s+/g, ' ').slice(0, 120),
                        input: { command, cwd: bashWorkDir },
                        context: {
                            notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                            callerSessionId: options?.callerSessionId || options?.sessionId || null,
                            routingSessionId: options?.routingSessionId || options?.sessionId || null,
                            clientHostPid: options?.clientHostPid,
                        },
                        meta: {
                            task_id: result.jobId,
                            stdout: result.stdoutPath ? normalizeOutputPath(result.stdoutPath) : null,
                            stderr: (!mergeStderr && result.stderrPath) ? normalizeOutputPath(result.stderrPath) : null,
                            cwd: bashWorkDir,
                            timeoutMs: timeout,
                        },
                        resultType: 'shell_task_result',
                        cancel: () => killShellJob(result.jobId),
                    });
                } catch { task = null; }
                try {
                    watchBackgroundShellJob(result.jobId, {
                        notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                        callerSessionId: options?.callerSessionId || options?.sessionId,
                        routingSessionId: options?.routingSessionId || options?.sessionId,
                        clientHostPid: options?.clientHostPid,
                    });
                } catch { /* best effort */ }
            }
            const partialStdout = smartMiddleTruncate(stripAnsi(result.stdout || ''));
            const partialStderr = stripAnsi(result.stderr || '');
            const lines = [
                task ? renderBackgroundTask(task) : (result.jobId ? `[task_id: ${result.jobId}]` : null),
                '',
                result.backgroundMessage || 'auto-backgrounded; still running',
                partialStdout ? `\n[partial stdout]\n${partialStdout}` : '',
                (!mergeStderr && partialStderr) ? `\n[partial stderr]\n${partialStderr}` : '',
            ].filter((l) => l !== null && l !== '');
            return _prependDestructiveWarning(command, lines.join('\n'));
        }
        const stdout = stripAnsi(result.stdout || '');
        const stderr = stripAnsi(result.stderr || '');
        const signal = result.timedOut
            ? 'SIGTERM'
            : (result.killed ? 'SIGKILL' : (result.signal || null));
        const exitCode = signal ? null : result.exitCode;
        const isReallyErrored = !!signal || (exitCode !== 0 && exitCode !== null);
        const _driftNote = '';
        // Distinct timeout marker so callers see "killed by timeout after Nms"
        // vs an external signal (e.g. user Ctrl-C, OOM kill). result.timedOut
        // is the runtime's own timeout escalation (SIGTERM → SIGKILL via
        // treeKill on Windows taskkill), so report the timeout ceiling that
        // fired alongside the actual signal used to kill the tree.
        // Timeout marker carries an inline recovery hint so the caller can
        // act in one round (increase ceiling or detach) instead of repeating
        // the same command and hitting the same wall.
        const statusMarker = result.timedOut
            ? `[timeout: ${timeout}ms signal: ${signal || 'SIGTERM'}]`
            : (signal
                ? `[signal: ${signal}]`
                : (isReallyErrored ? `[exit code: ${exitCode}]` : ''));
        const errorPrefix = isReallyErrored ? 'Error: ' : '';
        if (mergeStderr) {
            // Post-exit concatenation. True chunk-level interleaving would
            // require shell-level `2>&1` redirection (bash) or `*>&1`
            // (PowerShell) inside wrappedCommand, or an in-process ordered
            // merged stream in shell-command.mjs. Current implementation
            // preserves stdout/stderr ordering within each stream but loses
            // cross-stream interleaving. Acceptable for most diagnostic
            // outputs; flag in shell-command if exact interleaving is required.
            const merged = stdout + stderr;
            if (statusMarker) return _prependDestructiveWarning(command, errorPrefix + smartMiddleTruncate(`${statusMarker}\n\n${merged || '(no output)'}`) + _driftNote);
            return _prependDestructiveWarning(command, smartMiddleTruncate(merged || '(no output)') + _driftNote);
        }
        const truncatedStdout = smartMiddleTruncate(stdout);
        const truncatedStderr = stderr ? smartMiddleTruncate(stderr) : '';
        const body = truncatedStdout || (truncatedStderr ? '' : '(no output)');
        const stderrBlock = truncatedStderr ? `\n\n[stderr]\n${truncatedStderr}` : '';
        let spillBlock = '';
        if (result.stdoutPath) {
            const sizeKb = Math.round((result.stdoutFileSize || 0) / 1024);
            spillBlock += `\n\n[stdout: ${normalizeOutputPath(result.stdoutPath)} (${sizeKb} KB)]`;
        }
        if (result.stderrPath && (result.stderrFileSize || 0) > 0) {
            const sizeKb = Math.round((result.stderrFileSize || 0) / 1024);
            spillBlock += `\n[stderr: ${normalizeOutputPath(result.stderrPath)} (${sizeKb} KB)]`;
        }
        const warningBlock = [
            wmicRewrite?.note || '',
        ].filter(Boolean).join('\n');
        const payload = `${body}${stderrBlock}${spillBlock}${_driftNote}`;
        if (statusMarker) return _prependDestructiveWarning(command, `${errorPrefix}${warningBlock ? `${warningBlock}\n` : ''}${statusMarker}\n\n${payload}`);
        return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
    }
    finally {
        if (shellEffects.mutationMode === 'paths') {
            invalidateBuiltinResultCache(shellEffects.paths);
            markCodeGraphDirtyPaths(shellEffects.paths);
        } else if (shellEffects.mutationMode === 'global') {
            invalidateBuiltinResultCache();
            drainCodeGraphCache();
        }
    }
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellJobToTaskStatus(status) {
    if (status === 'completed') return 'completed';
    if (status === 'cancelled') return 'cancelled';
    if (status === 'running') return 'running';
    return 'failed';
}

function refreshShellTask(taskId, { includeRunning = false } = {}) {
    const job = peekShellJob(taskId);
    if (!job) return null;
    const publicResult = shellJobPublicTaskResult(job);
    if (job.status !== 'running') {
        completeBackgroundTask(taskId, {
            status: shellJobToTaskStatus(job.status),
            result: publicResult,
            resultText: JSON.stringify(publicResult, null, 2),
            notify: false,
        });
    } else if (includeRunning) {
        const task = getBackgroundTask(taskId);
        if (task) {
            task.result = publicResult;
            task.resultText = JSON.stringify(publicResult, null, 2);
        }
    }
    return job;
}

async function waitForGenericTask(taskId, { timeoutMs = 30_000, pollMs = 250, context = {} } = {}) {
    const started = Date.now();
    const deadline = started + Math.max(0, Number(timeoutMs) || 0);
    let task = getBackgroundTask(taskId, { context });
    if (!task) return null;
    while (task && task.status === 'running' && Date.now() < deadline) {
        await sleep(Math.max(25, Number(pollMs) || 250));
        task = getBackgroundTask(taskId, { context });
    }
    return {
        task,
        waitedMs: Date.now() - started,
        waitTimedOut: Boolean(task && task.status === 'running'),
    };
}

export async function executeTaskTool(args, options = {}) {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : (args.task_id ? 'wait' : 'list');
    if (action === 'list') return renderBackgroundTaskList({ context: options });

    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) return 'Error: task_id is required';
    // sess_* values are agent/orchestrator session ids, not background shell
    // tasks. task only resolves `shell mode=async` tasks, so surface a
    // self-correcting hint instead of the bare "task not found" that otherwise
    // invites a wrong-tool retry loop.
    if (/^sess_/.test(taskId)) {
        return `Error: "${taskId}" is an agent/session id, not a background task_id. Agent tasks deliver completion notifications; use agent list/read only for manual recovery.`;
    }

    const task = getBackgroundTask(taskId, { context: options });
    if (!task) return `Error: task not found: ${taskId}`;
    const isShellTask = task.surface === 'shell';

    if (action === 'status' || action === 'read') {
        if (isShellTask) refreshShellTask(taskId, { includeRunning: action === 'read' });
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        return renderBackgroundTask(latest, { includeResult: action === 'read' });
    }

    if (action === 'cancel') {
        if (isShellTask) {
            const job = killShellJob(taskId);
            cancelBackgroundShellJobWatch(taskId);
            clearShellJobNotifyCtx(taskId);
            cancelBackgroundTask(taskId, 'cancelled by task control');
            return job ? renderBackgroundTask(getBackgroundTask(taskId, { context: options }) || task, { includeResult: true }) : buildJobNotFoundMessage(taskId);
        }
        cancelBackgroundTask(taskId, 'cancelled by task control');
        return renderBackgroundTask(getBackgroundTask(taskId, { context: options }) || task, { includeResult: true });
    }

    if (action !== 'wait') {
        return `Error: task action must be one of list|status|read|wait|cancel (got ${JSON.stringify(args.action)})`;
    }

    if (!isShellTask) {
        const waited = await waitForGenericTask(taskId, {
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
            pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
            context: options,
        });
        if (!waited?.task) return `Error: task not found: ${taskId}`;
        const rendered = renderBackgroundTask(waited.task, { includeResult: TERMINAL_TASK_STATUSES.has(waited.task.status) });
        return waited.waitTimedOut ? `${rendered}\nwait_timed_out: true\nwaited_ms: ${waited.waitedMs}` : rendered;
    }
    // Register as a synchronous waiter and cancel the armed watcher BEFORE
    // awaiting: the caller consumes the outcome via task wait, so no async
    // push is wanted, and cancelling up front closes the race where the armed
    // watcher (watch callback or 2s poll) fires during the await window. The
    // persistent notify ctx survives the cancel for a possible re-arm.
    beginShellJobWait(taskId);
    cancelBackgroundShellJobWatch(taskId);
    try {
        const job = await waitForShellJob(taskId, {
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000,
            pollMs: typeof args.poll_ms === 'number' ? args.poll_ms : 250,
        });
        if (!job) return buildJobNotFoundMessage(taskId);
        if (job.status !== 'running') {
            const publicResult = shellJobPublicTaskResult(job);
            completeBackgroundTask(taskId, {
                status: shellJobToTaskStatus(job.status),
                result: publicResult,
                resultText: JSON.stringify(publicResult, null, 2),
                notify: false,
            });
        }
        const latest = getBackgroundTask(taskId, { context: options }) || task;
        const rendered = renderBackgroundTask(latest, { includeResult: job.status !== 'running' });
        return job.status === 'running' ? `${rendered}\nwait_timed_out: true\nwaited_ms: ${job.waitedMs}` : rendered;
    } finally {
        // Only the LAST concurrent waiter (post-decrement count 0) may re-arm,
        // and only for a still-running job (timed-out wait). Re-arm with no ctx
        // arg — watchBackgroundShellJob falls back to the persistent ctx. This
        // prevents the concurrent-waiter double-deliver: while any other waiter
        // is still synchronously consuming the outcome, the watcher stays off.
        const remaining = endShellJobWait(taskId);
        if (remaining === 0) {
            const latest = peekShellJob(taskId);
            if (latest && latest.status === 'running') watchBackgroundShellJob(taskId);
            // LAST waiter out and the job already finished — the outcome was
            // consumed synchronously, so no re-arm. Drop the persisted ctx here
            // or it leaks (cleanup only runs on a real watcher settle, which
            // never happens for a never-re-armed entry).
            else clearShellJobNotifyCtx(taskId);
        }
    }
}
