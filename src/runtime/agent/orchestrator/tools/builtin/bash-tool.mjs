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
    attachShellJobResourceLease,
} from './shell-jobs.mjs';
import {
    analyzeShellCommandEffects,
    foregroundLongCommandHint,
    isAutobackgroundingAllowed,
    preflightPowerShellHygiene,
    shellSplitSegments,
    shellSplitPipelineSegments,
    shellTokenize,
    stripShellProbeWrappers,
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
import { resourceAdmission } from '../../../../shared/resource-admission.mjs';

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

// Search-style commands and `git diff --exit-code` use exit 1 as a SIGNAL
// (no match / has diff), not a failure. Benign ONLY when exitCode===1, no
// signal, stderr blank, AND the command is a SINGLE pipeline (no ;/&&/||, so
// exit 1's origin is unambiguous — a mixed chain stays Error). Quote/comment
// aware via the shared shell tokenizers, so quoted/commented `;` `|` `grep`
// can never masquerade as a connector/command and hide a real failure.
const _SEARCH_HEADS = new Set(['select-string', 'sls', 'grep', 'egrep', 'fgrep', 'findstr']);
const _GIT_GLOBAL_VALUE_OPTS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// Command/process/subshell substitution or a backslash/backtick-escaped pipe
// or connector can make the shared tokenizer mis-split the top level and hide
// the failing stage. If any such construct is present, refuse benign (Error).
const _AMBIGUOUS_SYNTAX = /\$\(|\$\{|<\(|>\(|`|\\\s*(?:\||&|;|\n)/;
function _stripShellComment(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) { out += ch; if (ch === quote) quote = null; continue; }
        if (ch === '\'' || ch === '"') { quote = ch; out += ch; continue; }
        if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
        out += ch;
    }
    return out;
}
function _normalizeHead(tok) {
    return String(tok || '').replace(/\.exe$/i, '').split(/[\\/]/).pop().toLowerCase();
}
export function _isBenignSearchExitOne(command, exitCode, signal, stderr) {
    if (signal || exitCode !== 1) return false;
    if (stderr && stderr.trim()) return false;
    const text = _stripShellComment(String(command || ''));
    if (_AMBIGUOUS_SYNTAX.test(text)) return false; // subshell/subst/escaped pipe → ambiguous
    const segments = shellSplitSegments(text);
    if (segments.length !== 1) return false; // ;/&&/|| chain → ambiguous, stay Error
    const stages = shellSplitPipelineSegments(segments[0]);
    const last = stages[stages.length - 1] || segments[0];
    const raw = shellTokenize(last);
    if (!raw) return false; // unbalanced quotes
    const tokens = stripShellProbeWrappers(raw);
    if (!tokens.length) return false;
    const head = _normalizeHead(tokens[0]);
    if (_SEARCH_HEADS.has(head)) return true;
    if (head !== 'git') return false;
    // `git [global-opts] diff ...` only — exact `diff` subcommand, never
    // diff-index/diff-files/difftool — with exit-code semantics.
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
        i += (_GIT_GLOBAL_VALUE_OPTS.has(tokens[i]) && !tokens[i].includes('=')) ? 2 : 1;
    }
    if (tokens[i] !== 'diff') return false;
    return tokens.slice(i + 1).some((t) => t === '--exit-code' || t === '--quiet' || t === '--check');
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
    if (!a && !b) return { signal: null, cleanup() {} };
    if (!a) return { signal: b, cleanup() {} };
    if (!b) return { signal: a, cleanup() {} };
    if (a === b) return { signal: a, cleanup() {} };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        try { return { signal: AbortSignal.any([a, b]), cleanup() {} }; } catch { /* fall through */ }
    }
    const ctl = new AbortController();
    const onAbort = (sig) => {
        if (ctl.signal.aborted) return;
        try { ctl.abort(sig?.reason); } catch { try { ctl.abort(); } catch {} }
    };
    if (a.aborted) { onAbort(a); return { signal: ctl.signal, cleanup() {} }; }
    if (b.aborted) { onAbort(b); return { signal: ctl.signal, cleanup() {} }; }
    const onAbortA = () => onAbort(a);
    const onAbortB = () => onAbort(b);
    try { a.addEventListener('abort', onAbortA, { once: true }); } catch {}
    try { b.addEventListener('abort', onAbortB, { once: true }); } catch {}
    return {
        signal: ctl.signal,
        cleanup() {
            try { a.removeEventListener('abort', onAbortA); } catch {}
            try { b.removeEventListener('abort', onAbortB); } catch {}
        },
    };
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

export function formatShellToolFailure(message) {
    const text = String(message ?? '').replace(/^Error:\s*/i, '').trim() || 'shell tool failed';
    return `Error: [shell-tool-failed] ${text}`;
}

export function _shellFailureStatus(result, timeout) {
    // Prefer the signal reported by the process. `killed` is only a fallback
    // for platforms (notably taskkill on Windows) that close without one.
    const signal = result.signal || (result.killed ? 'SIGKILL' : null);
    const exitCode = signal ? null : result.exitCode;
    const shellToolFailed = result.failurePhase === 'tool' || !!result.outputCaptureError;
    const killCause = result.killCause || null;
    const causeDetail = killCause ? ` cause: ${killCause}` : '';
    const signalDetail = signal ? ` signal: ${signal}` : '';
    const timeoutHint = result.timedOut
        ? ` — command killed after ${timeout} ms; if it legitimately needs longer, retry with a larger timeout`
        : '';
    const statusDetail = shellToolFailed
        ? `[${result.outputCaptureError ? 'output capture failed' : (result.failureReason || 'tool failed')}${causeDetail}${signalDetail}]`
        : (result.timedOut
            ? `[timeout: ${timeout}ms${signalDetail || ' signal: unknown'}${causeDetail}]${timeoutHint}`
            : (signal
                ? `[signal: ${signal}${causeDetail}]`
                : (exitCode !== 0 && exitCode !== null ? `[exit code: ${exitCode}]` : '')));
    return { signal, exitCode, shellToolFailed, statusDetail };
}

export function _composeShellFailure(statusMarker, errorPrefix, warningBlock, payload) {
    return `${errorPrefix}${statusMarker}${warningBlock ? `\n${warningBlock}` : ''}\n\n${payload}`;
}

export async function executeBashTool(args, workDir, options = {}) {
    const requestedCwd = args.cwd ?? args.workdir;
    const cwdResult = resolveOptionalCwd(requestedCwd, workDir);
    if (cwdResult.error) return formatShellToolFailure(cwdResult.error);
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
        if (_policyBlock) return formatShellToolFailure(_policyBlock);
    }

    // An empty-string session_id is NOT a persistent-session request: `typeof
    // '' === 'string'` would otherwise route a stateless call into the
    // persistent path and (on Windows) hard-fail with the disabled-sessions
    // error, which models then retry in a loop. Require a non-blank id.
    if (args.persistent === true || (typeof args.session_id === 'string' && args.session_id.trim().length > 0)) {
        if (process.platform === 'win32') {
            return formatShellToolFailure('persistent shell sessions are disabled on Windows native-shell mode; run one-shot PowerShell commands without persistent/session_id.');
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
        try {
            return await executeBashSessionTool('bash_session', effectiveArgs, bashWorkDir, {
                abortSignal: combinedPersistAbort.signal,
                sessionId: options?.sessionId,
                resourceAdmission: options?.resourceAdmission || resourceAdmission,
            });
        } finally {
            combinedPersistAbort.cleanup();
        }
    }

    let command = args.command;
    if (!command) return formatShellToolFailure('command is required');

    // Resolve the shell up front so shell-type-specific handling (PS-only wmic
    // rewrite, PS UTF-8 prefix) can gate on it. kind 'default' is byte-identical
    // to today's resolveShell(); kind 'bash' on Windows resolves Git Bash, and a
    // null spec means it is genuinely not installed — surface a clear error with
    // NO silent fallback to the other shell.
    const shellKind = args.shell === 'bash' || args.shell === 'powershell' ? args.shell : 'default';
    const resolvedSpec = resolveShellFor(shellKind);
    if (!resolvedSpec) {
        if (shellKind === 'bash') {
            return formatShellToolFailure("Git Bash not found — install Git for Windows or omit shell:'bash'.");
        }
        return formatShellToolFailure("pwsh (PowerShell) not found — install PowerShell or omit shell:'powershell'.");
    }

    // wmic→PowerShell rewrite is PowerShell-only; never mangle a command bound
    // for bash (gate on the resolved shell type).
    // Note: gating this to powershell did NOT change POSIX behavior — wmic is a
    // Windows-only tool, so the rewrite was already dead code on POSIX hosts;
    // the gate just makes that explicit.
    const wmicRewrite = resolvedSpec.shellType === 'powershell'
        ? maybeRewriteWmicProcessCommand(command)
        : null;
    if (wmicRewrite?.error) return formatShellToolFailure(wmicRewrite.error);
    if (wmicRewrite?.command) command = wmicRewrite.command;

    // PowerShell hygiene preflight (Windows PS-only; POSIX no-op): losslessly
    // rewrite MSYS `/x/…` drive paths, and hard-block bash-only syntax
    // (grep|tail|sed|awk pipeline stages, `$PID=` reassignment, `&&` on PS 5.1)
    // with PowerShell-native hints so the agent retries with valid syntax.
    const psHygiene = preflightPowerShellHygiene(command, {
        shellType: resolvedSpec.shellType,
        shellName: resolvedSpec.shell,
    });
    if (psHygiene.block) return formatShellToolFailure(psHygiene.block);
    command = psHygiene.command;

    const _execPolicyBlock = checkExecPolicyMessage(command);
    if (_execPolicyBlock) {
        return formatShellToolFailure(_execPolicyBlock);
    }

    let shellEffects;
    let combinedBashAbort = null;
    try {
        shellEffects = await analyzeShellCommandEffects(command, bashWorkDir);
    } catch (err) {
        return formatShellToolFailure(normalizeErrorMessage(err instanceof Error ? err.message : String(err)));
    }
    // Keep foreground commands on a long tool-owned timeout. The MCP dispatch
    // layer must not add a shorter fallback ceiling when timeout is omitted.
    // Reference-CLI parity (opencode/codex/claude-code): sync-first, no hard
    // upper ceiling on a caller-provided total timeout. Default 120 s (2 min)
    // when omitted; BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS env overrides
    // bound the blocking window when timeout promotion is available.
    const _envDefaultTimeout = parseInt(process.env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
    const DEFAULT_BASH_TIMEOUT_MS = _envDefaultTimeout > 0 ? _envDefaultTimeout : 120_000;
    // Background (async / run_in_background) jobs get NO omitted default: 0
    // means "unlimited" and flows unchanged through startBackgroundShellJob →
    // task meta (detail.timeoutMs 0). An explicit args.timeout is still honored
    // and enforced exactly as before. Sync path keeps the 120s omitted default.
    const DEFAULT_BACKGROUND_BASH_TIMEOUT_MS = 0;
    const _envMaxTimeout = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
    const MAX_BASH_TIMEOUT_MS = Math.max(_envMaxTimeout > 0 ? _envMaxTimeout : 600_000, DEFAULT_BASH_TIMEOUT_MS);
    const defaultTimeoutMs = runInBackground
        ? DEFAULT_BACKGROUND_BASH_TIMEOUT_MS
        : DEFAULT_BASH_TIMEOUT_MS;
    const hasExplicitTimeout = typeof args.timeout === 'number' && args.timeout > 0;
    const timeoutMs = hasExplicitTimeout ? args.timeout : defaultTimeoutMs;
    const _bgTasksDisabled = /^(1|true|yes|on)$/i.test(
        String(process.env.MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS || '').trim(),
    );
    const backgroundOnTimeout = !runInBackground
        && !_bgTasksDisabled
        && isAutobackgroundingAllowed(command, resolvedSpec.shellType);
    // Explicit caller timeout remains the total deadline. When promotion is
    // available, cap only its foreground blocking portion at MAX.
    // JS timers (setTimeout) and PS WaitForExit(ms) are 32-bit: a delay above
    // 2^31-1 wraps to a tiny/negative value and fires immediately. Clamp the
    // uncapped explicit timeout once here (~24.8 days ceiling) so every
    // downstream timer — foreground, background job, hard-stop watcher — stays
    // valid without per-site guards.
    const TIMER_MAX_MS = 2_147_483_647;
    // timeoutMs <= 0 (omitted background default) means unlimited: pass it
    // through untouched — the min() clamps below must not turn 0 into a bound.
    const totalTimeout = timeoutMs <= 0
        ? 0
        : Math.min(timeoutMs, wmicRewrite?.timeoutMs || (hasExplicitTimeout ? TIMER_MAX_MS : MAX_BASH_TIMEOUT_MS));
    const timeout = hasExplicitTimeout && backgroundOnTimeout
        ? Math.min(totalTimeout, MAX_BASH_TIMEOUT_MS)
        : totalTimeout;
    const promotedTimeoutMs = hasExplicitTimeout && backgroundOnTimeout
        ? Math.max(0, totalTimeout - timeout)
        : 0;
    const mergeStderr = args.merge_stderr === true;
    const longForegroundHint = foregroundLongCommandHint(
        command,
        timeout,
        { ...args, run_in_background: runInBackground },
        { backgroundTasksDisabled: _bgTasksDisabled },
    );
    if (longForegroundHint) return formatShellToolFailure(longForegroundHint);
    // Auto-background threshold. Reference-CLI parity: sync commands run to
    // their timeout without any default auto-promotion, so the default is 0
    // (disabled) for ALL callers. It is an explicit opt-in only: set
    // MIXDOG_SHELL_AUTO_BACKGROUND_MS (positive ms) to re-enable detaching a
    // still-running foreground one-shot into a tracked shell-job. When enabled,
    // the value stays a soft hint clamped below `timeout` so the hard ceiling
    // remains a separate, later bound. Never applies to run_in_background
    // (already detached) or persistent sessions (handled far above).
    const _autoBgEnvMs = Number(process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS);
    const DEFAULT_AUTO_BACKGROUND_MS = Number.isFinite(_autoBgEnvMs) && _autoBgEnvMs > 0
      ? Math.floor(_autoBgEnvMs)
      : 0;
    const autoBackgroundMs = (runInBackground || DEFAULT_AUTO_BACKGROUND_MS <= 0)
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
                return formatShellToolFailure(`shell snapshot wrapper failed — ${normalizeErrorMessage(wrapErr instanceof Error ? wrapErr.message : String(wrapErr))}`);
            }
        } else {
            wrappedCommand = command;
        }
        if (runInBackground) {
            let asyncAbortSignal = null;
            try { asyncAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
            catch { asyncAbortSignal = null; }
            const combinedAsyncAbort = _combineAbortSignals(asyncAbortSignal, options?.abortSignal || null);
            let asyncLease = null;
            let job;
            try {
                asyncLease = await (options?.resourceAdmission || resourceAdmission).acquire('shell', {
                    signal: combinedAsyncAbort.signal,
                    label: String(command).replace(/\s+/g, ' ').slice(0, 120),
                    dependency: 'detached',
                });
                if (combinedAsyncAbort.signal?.aborted) {
                    throw combinedAsyncAbort.signal.reason || new Error('shell background task cancelled before spawn');
                }
                job = await startBackgroundShellJob({
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
                    ...(options?.shellJobRuntime || {}),
                });
                if (job && job.error) {
                    if (job.rollbackPending && attachShellJobResourceLease(job.jobId, asyncLease, { allowUnpersisted: true })) {
                        asyncLease = null;
                    }
                    return formatShellToolFailure(job.error);
                }
                if (combinedAsyncAbort.signal?.aborted) {
                    try { killShellJob(job.jobId); } catch {}
                    throw combinedAsyncAbort.signal.reason || new Error('shell background task cancelled before registration');
                }
                if (job && !job.error && attachShellJobResourceLease(job.jobId, asyncLease)) {
                    asyncLease = null;
                }
                const task = registerBackgroundTask({
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
                if (combinedAsyncAbort.signal?.aborted) {
                    try { killShellJob(job.jobId); } catch {}
                    cancelBackgroundTask(job.jobId, 'cancelled before background registration completed');
                    throw combinedAsyncAbort.signal.reason || new Error('shell background task cancelled during registration');
                }
                // Wire a one-shot completion push so the dispatching session learns
                // the background task finished (no polling tool is auto-driven).
                try {
                    watchBackgroundShellJob(job.jobId, {
                        notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                        callerSessionId: options?.callerSessionId || options?.sessionId,
                        routingSessionId: options?.routingSessionId,
                        clientHostPid: options?.clientHostPid,
                    });
                } catch { /* watcher arm is best-effort; never blocks the spawn */ }
                return _prependDestructiveWarning(command, renderBackgroundTask(task));
            } catch (error) {
                if (job?.jobId && !job.error) {
                    try { killShellJob(job.jobId); } catch {}
                }
                return formatShellToolFailure(normalizeErrorMessage(error instanceof Error ? error.message : String(error)));
            } finally {
                combinedAsyncAbort.cleanup();
                try { await asyncLease?.release(); } catch {}
            }
        }

        let bashAbortSignal = null;
        try { bashAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
        catch { bashAbortSignal = null; }
        combinedBashAbort = _combineAbortSignals(bashAbortSignal, options?.abortSignal || null);
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
        // Promote-at-timeout (CC shouldAutoBackground parity). When a
        // foreground one-shot hits its timeout and is still running, adopt it
        // as a background job (task_id + notify) instead of tree-killing it.
        // Opt-outs restore the old kill behavior: (a) disallowed sleep-like
        // base commands (isAutobackgroundingAllowed), (b) the truthy
        // MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS env. Never applies to
        // run_in_background (already detached, handled above).
        const result = await execShellCommand({
            shell, shellArg, shellArgs, command: syncCommand,
            env: spawnEnv,
            cwd: bashWorkDir,
            timeoutMs: timeout,
            abortSignal: combinedBashAbort.signal,
            autoBackgroundMs,
            // On a foreground timeout, promote the still-running child to a
            // tracked background job (unlimited) instead of killing it.
            backgroundOnTimeout,
            promotedTimeoutMs,
            // Threaded so an auto-backgrounded foreground job is stamped with
            // the dispatching terminal's claude.exe pid (per-terminal scope).
            clientHostPid: options?.clientHostPid,
            // MCP live-progress reporter (null unless the client subscribed via
            // callTool onprogress). execShellCommand emits throttled "running
            // Ns" frames while the foreground command runs.
            onProgress: typeof options?.onProgress === 'function' ? options.onProgress : null,
            // In-process live-output tail (~1 s cadence) for transcript
            // consumers (desktop/TUI running tool cards). Distinct channel from
            // the MCP onProgress label stream.
            onOutputTail: typeof options?.onOutputTail === 'function' ? options.onOutputTail : null,
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
                            timeoutMs: result.backgroundTimeoutMs || 0,
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
                result.backgroundMessage || 'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
                partialStdout ? `\n[partial stdout]\n${partialStdout}` : '',
                (!mergeStderr && partialStderr) ? `\n[partial stderr]\n${partialStderr}` : '',
            ].filter((l) => l !== null && l !== '');
            return _prependDestructiveWarning(command, lines.join('\n'));
        }
        const stdout = stripAnsi(result.stdout || '');
        const stderr = stripAnsi(result.stderr || '');
        const failureStatus = _shellFailureStatus(result, timeout);
        const { signal, exitCode, shellToolFailed } = failureStatus;
        const benignExitOne = _isBenignSearchExitOne(command, exitCode, signal, stderr);
        const shellRunFailed = !shellToolFailed && (!!signal || (exitCode !== 0 && exitCode !== null && !benignExitOne));
        const isReallyErrored = shellToolFailed || shellRunFailed;
        const _driftNote = '';
        // Distinct timeout marker so callers see "killed by timeout after Nms"
        // vs an external signal (e.g. user Ctrl-C, OOM kill). result.timedOut
        // is the runtime's own timeout escalation (SIGTERM → SIGKILL via
        // treeKill on Windows taskkill), so report the timeout ceiling that
        // fired alongside the actual signal used to kill the tree.
        // Timeout marker carries an inline recovery hint so the caller can
        // act in one round (increase ceiling or detach) instead of repeating
        // the same command and hitting the same wall.
        const statusDetail = failureStatus.statusDetail;
        const statusMarker = shellToolFailed
            ? `[shell-tool-failed] ${statusDetail}`
            : (shellRunFailed ? `[shell-run-failed] ${statusDetail}` : '');
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
        if (result.outputCaptureError) {
            spillBlock += `\n[tool capture error: ${normalizeErrorMessage(result.outputCaptureError?.message || String(result.outputCaptureError))}]`;
        }
        const warningBlock = [
            wmicRewrite?.note || '',
        ].filter(Boolean).join('\n');
        const payload = `${body}${stderrBlock}${spillBlock}${_driftNote}`;
        if (statusMarker) return _prependDestructiveWarning(command, _composeShellFailure(statusMarker, errorPrefix, warningBlock, payload));
        return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
    }
    finally {
        combinedBashAbort?.cleanup?.();
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

function renderTaskCancelSuccess(taskId, task) {
    const surface = task?.surface || 'task';
    const operation = task?.operation || 'run';
    return [
        'status: completed',
        `task_id: ${taskId}`,
        `cancelled: ${surface}/${operation}`,
    ].join('\n');
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
            return job ? renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task) : buildJobNotFoundMessage(taskId);
        }
        cancelBackgroundTask(taskId, 'cancelled by task control');
        return renderTaskCancelSuccess(taskId, getBackgroundTask(taskId, { context: options }) || task);
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
