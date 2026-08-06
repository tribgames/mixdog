import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { isLegitimateShellExit } from '../../session/result-classification.mjs';
import { makeToolEnvelope } from '../../session/tool-envelope.mjs';
import { acquireShellLeaseBounded, execShellCommand, stripAnsi } from '../shell-command.mjs';
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
    buildPowerShellFilterTeePlan,
    consumeFilterTeeCapture,
    detectBlockedSleepPattern,
    detectLongForegroundReason,
    extractShellApplyPatchInvocation,
    foregroundLongCommandHint,
    hasPowerShellOnlySyntax,
    isAutobackgroundingAllowed,
    planInlineScriptHoist,
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
import { prewarmPwshStandbyPool } from '../lib/pwsh-standby-pool.mjs';
import { smartMiddleTruncate } from './shell-output.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { resolveOptionalCwd } from './cwd-utils.mjs';
import { scrubLoaderVars, scrubProviderSecrets, scrubRuntimeRootVars } from '../env-scrub.mjs';
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

/**
 * Boot prewarm: build the EXACT spawn env/spec a real shell call uses and warm
 * the pwsh standby pool with it, so the first shell call of a session skips
 * the pwsh startup cost. No-op off Windows / non-pwsh. Best-effort.
 */
export function prewarmShellStandbys() {
    try {
        const spec = resolveShellFor('default');
        if (!spec || spec.shellType !== 'powershell') return false;
        const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        scrubProviderSecrets(env);
        scrubLoaderVars(env);
        scrubRuntimeRootVars(env);
        return prewarmPwshStandbyPool({ shell: spec.shell, shellArgs: spec.shellArgs, env }) === true;
    } catch {
        return false;
    }
}
export function _trackedDriftNoteAfter(_scope, _pre) {
    return '';
}

// Search-style commands and `git diff --exit-code` use exit 1 as a SIGNAL
// (no match / has diff), not a failure. Benign ONLY when exitCode===1, no
// signal, stderr blank, AND the exit status provably comes from a search-style
// stage: the LAST segment of a `;`/`&&` chain (its status IS the chain's) whose
// last pipeline stage is a search head. `||` chains stay ambiguous (either
// branch can supply the status) and stay Error. Quote/comment aware via the
// shared shell tokenizers, so quoted/commented `;` `|` `grep` can never
// masquerade as a connector/command and hide a real failure.
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
    if (segments.length === 0) return false;
    if (segments.length > 1 && /\|\|/.test(text)) return false; // || → which branch exited 1?
    const lastSegment = segments[segments.length - 1];
    const stages = shellSplitPipelineSegments(lastSegment);
    const last = stages[stages.length - 1] || lastSegment;
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

// A legitimate non-zero exit keeps its `[exit code: N]` marker but must not be
// CLASSIFIED as a failure downstream — the marker alone would read as an error
// to classifyResultKind. The explicit-success envelope is the documented
// channel for output that looks like an error and is not one.
function _finalizeShellResult(legitExit, text) {
    return legitExit ? makeToolEnvelope(text, [], { explicitSuccess: true }) : text;
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
    let runInBackground = executionMode === 'async';

    // Run hard-block policy BEFORE branching into the persistent-shell tool.
    // The persistent path used to bypass the one-shot block scan because the
    // normalization (stripQuotedAndHeredoc / extractShellCInner / unquoted
    // span sweep) lived only on the one-shot side. Centralised policy in
    // shell-policy.mjs already covers the literal scan + EncodedCommand
    // decode + rm token guard; calling it here applies the same allowlist
    // to both persistent and stateless paths.
    const _rawCmd = String(args && args.command != null ? args.command : '');
    // `apply_patch` typed into the shell (heredoc/argument/bare
    // patch forms) routes to the internal patch engine instead of failing as
    // an unknown binary. Runs BEFORE the exec-policy scan so patch BODY lines
    // (e.g. `+ rm -rf …`) are never misread as shell commands. Dynamic import
    // avoids a bash-tool <-> patch/orchestrator module cycle.
    if (_rawCmd) {
        const _apCall = extractShellApplyPatchInvocation(_rawCmd);
        if (_apCall?.error) {
            return formatShellToolFailure(`${_apCall.error}. Call the apply_patch tool with the patch string instead of the shell.`);
        }
        if (_apCall?.patch) {
            const { executePatchTool } = await import('../patch/orchestrator.mjs');
            return executePatchTool('apply_patch', { patch: _apCall.patch }, bashWorkDir, options);
        }
    }
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
    let resolvedSpec = resolveShellFor(shellKind);
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
    let shellRescueNote = '';
    if (psHygiene.block) {
        // Auto-rescue: the block fired ONLY because the command is written in
        // bash (unix filter heads, `&&`) and it carries no PowerShell-only
        // construct — running it in Git Bash is exactly what the caller meant,
        // byte-for-byte. A mixed command ($env:, cmdlets, `2>$null`) or a
        // PowerShell-specific violation stays a hard block, and an explicit
        // shell:'powershell' is never overridden.
        const bashSpec = psHygiene.bashOnly
            && shellKind === 'default'
            && !hasPowerShellOnlySyntax(psHygiene.original ?? command)
            ? resolveShellFor('bash')
            : null;
        if (!bashSpec) return formatShellToolFailure(psHygiene.block);
        // The MSYS rewrite targets PowerShell; bash gets the original text.
        command = psHygiene.original ?? command;
        resolvedSpec = bashSpec;
        shellRescueNote = "note: bash-only syntax on a PowerShell host — ran it in Git Bash (pass shell:'bash' to make that explicit).";
    } else {
        command = psHygiene.command;
    }

    const _execPolicyBlock = checkExecPolicyMessage(command);
    if (_execPolicyBlock) {
        return formatShellToolFailure(_execPolicyBlock);
    }
    // Inline-script hoisting (sync runs only — a background job would outlive
    // the temp file). The body is written verbatim and the invocation becomes a
    // file run, so the host shell never has to carry the script through its
    // quoting layer. planInlineScriptHoist refuses every case where file
    // semantics would differ, so this is a transport change only.
    let _inlineHoistPath = null;
    if (!runInBackground && args.persistent !== true) {
        const hoist = planInlineScriptHoist(command);
        if (hoist) {
            try {
                const file = pathJoin(
                    tmpdir(),
                    `mixdog-inline-${process.pid}-${Date.now().toString(36)}${hoist.extension}`,
                );
                writeFileSync(file, hoist.body, 'utf8');
                _inlineHoistPath = file;
                command = hoist.replace(file.replace(/\\/g, '/'));
            } catch { _inlineHoistPath = null; }
        }
    }

    // Sleep-chain auto-promotion: a leading `sleep N && …` / `Start-Sleep N; …`
    // used to be DENIED preflight (CC detectBlockedSleepPattern parity).
    // Measured over 10 days the deny fired 46× and every hit was a wasted
    // turn, so the command is promoted to a background task instead — the
    // exact remedy the deny message pointed at, without the failure. Only
    // possible while background tasks are enabled; with them disabled the
    // command runs foreground as before (the deny never fired there either).
    const _bgTasksDisabled = /^(1|true|yes|on)$/i.test(
        String(process.env.MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS || '').trim(),
    );
    let autoAsyncReason = '';
    if (!runInBackground && !_bgTasksDisabled) {
        // Long-foreground shapes (watch-like dev servers/watchers, 30s+ sleeps
        // anywhere in the chain) used to hard-fail via foregroundLongCommandHint
        // (~22 wasted turns/14d measured). Promote them to a background task —
        // the exact remedy the deny message pointed at — same as sleep chains.
        // Short (2-29s) leading sleep chains stay SYNC: a 5s settle before a
        // verification probe must not detach produce→verify into an async
        // notification round-trip — blocking a few seconds is strictly cheaper.
        const _blockedSleep = detectBlockedSleepPattern(command, 30) || detectLongForegroundReason(command);
        if (_blockedSleep) {
            runInBackground = true;
            autoAsyncReason = _blockedSleep;
        }
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
    // Reference-CLI parity: sync-first, no hard
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
    // Foreground blocking cap when timeout promotion is available. 600s let a
    // caller-supplied 10-15 min timeout hold the conversation synchronously
    // for its whole span (user: sync calls hanging 10-20 minutes); 120s (the
    // omitted-timeout default) keeps quick builds inline while anything longer
    // detaches as a tracked job with the REMAINDER of the explicit timeout as
    // its background deadline (user decision: 2 minutes).
    const MAX_BASH_TIMEOUT_MS = Math.max(_envMaxTimeout > 0 ? _envMaxTimeout : 120_000, DEFAULT_BASH_TIMEOUT_MS);
    const defaultTimeoutMs = runInBackground
        ? DEFAULT_BACKGROUND_BASH_TIMEOUT_MS
        : DEFAULT_BASH_TIMEOUT_MS;
    const hasExplicitTimeout = typeof args.timeout === 'number' && args.timeout > 0;
    const timeoutMs = hasExplicitTimeout ? args.timeout : defaultTimeoutMs;
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
    // Promotion threshold (Codex `yield_time_ms` / CC startBackgrounding
    // analogue). Previously 0 = OFF, so every long command held the turn open
    // to the full foreground timeout and, at the cap, produced a wasted wait.
    // 30 s keeps ordinary builds/tests inline (measured shell p90 ~ 18 s) while
    // detaching the long tail (measured: 111 calls/day above 30 s, 30 of them
    // burning the entire 120 s cap) as a tracked job with partial output.
    // MIXDOG_SHELL_AUTO_BACKGROUND_MS overrides; an explicit 0 disables.
    const _autoBgEnvRaw = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
    const _autoBgEnvMs = Number(_autoBgEnvRaw);
    const DEFAULT_AUTO_BACKGROUND_MS = (_autoBgEnvRaw != null && String(_autoBgEnvRaw).trim() !== ''
      && Number.isFinite(_autoBgEnvMs) && _autoBgEnvMs >= 0)
      ? Math.floor(_autoBgEnvMs)
      : 30_000;
    // Gate on backgroundOnTimeout rather than just `runInBackground`: it already
    // encodes "promotion is available for this command" (not detached, background
    // tasks enabled, command shape allows it), so the soft threshold can never
    // promote something the hard timeout would refuse to.
    // An EXPLICIT caller timeout is a deliberate "I intend to wait this long"
    // (a long build/test/install), so the soft threshold never overrides it —
    // the call stays inline until its own deadline, where backgroundOnTimeout
    // still promotes instead of killing. Auto-promotion therefore only applies
    // to the OMITTED-timeout default, which is exactly the case where nobody
    // declared how long the command should be allowed to hold the turn.
    const autoBackgroundMs = (!backgroundOnTimeout || hasExplicitTimeout || DEFAULT_AUTO_BACKGROUND_MS <= 0)
      ? 0
      : Math.min(DEFAULT_AUTO_BACKGROUND_MS, timeout);

    try {
        const { shell, shellArg, shellArgs, shellType } = resolvedSpec;
        const spawnEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        // R5/R11: same scrub as background/persistent spawn sites (env-scrub.mjs).
        scrubProviderSecrets(spawnEnv);
        scrubLoaderVars(spawnEnv);
        scrubRuntimeRootVars(spawnEnv);
        let wrappedCommand;
        let _teePlan = null;
        // PowerShell UTF-8 prefix is PS-only: the Windows Git Bash path
        // (shellType==='posix') must NOT receive it. Snapshot wrapper stays
        // POSIX-host-only for now — no snapshot for Windows Git Bash initially.
        if (process.platform === 'win32' && shellType === 'powershell') {
            // Filter-swallow rescue (sync path only): tee the unfiltered
            // producer stream of an exactly-recognized filter pipeline so a
            // failing run can attach the original output tail in THIS call
            // instead of returning `[exit code: N]` + `(no output)`. Any
            // ambiguity yields a null plan and the command runs untouched.
            if (!runInBackground) {
                try { _teePlan = buildPowerShellFilterTeePlan(command); } catch { _teePlan = null; }
            }
            wrappedCommand = _prefixPowerShellUtf8(_teePlan ? _teePlan.command : command);
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
                asyncLease = await acquireShellLeaseBounded(options?.resourceAdmission || resourceAdmission, {
                    abortSignal: combinedAsyncAbort.signal,
                    label: String(command).replace(/\s+/g, ' ').slice(0, 120),
                    dependency: 'detached',
                    ownerKey: options?.callerSessionId || options?.sessionId || null,
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
                    // Dispatching session: hosts that pool many sessions in one
                    // process (desktop) scope the job to its own pane with this.
                    ownerSessionId: options?.callerSessionId || options?.sessionId || null,
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
                const _autoAsyncNote = autoAsyncReason
                    ? `[auto-async] ${autoAsyncReason} — promoted to a background task; act on its completion notification instead of blocking (do not poll).\n`
                    : '';
                return _prependDestructiveWarning(command, _autoAsyncNote + renderBackgroundTask(task));
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
            const _stateFile = stateFilePath(
                _sessionCwdKey,
                options?.deferShellCwdCommit === true ? options?.toolCallId : null,
            );
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
            // …and with the dispatching session, for per-pane scoping.
            ownerSessionId: options?.callerSessionId || options?.sessionId || null,
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
        // Legitimate non-zero exit: the command printed its result and ended
        // with 1 without writing a single byte to stderr (probes, reports,
        // `git diff --exit-code`-shaped checks). It keeps its `[exit code: 1]`
        // marker so the caller sees the code, but it is NOT framed as a tool
        // error and NOT classified as a failure — measured as the dominant
        // shape among non-zero exits.
        const legitExit = !shellToolFailed
            && !benignExitOne
            && isLegitimateShellExit({ exitCode, signal, stdout, stderr });
        const shellRunFailed = !shellToolFailed
            && (!!signal || (exitCode !== 0 && exitCode !== null && !benignExitOne && !legitExit));
        const isReallyErrored = shellToolFailed || shellRunFailed;
        // Filter-swallow rescue: the tee file is ALWAYS consumed (deleted)
        // here; its tail is attached only when the run failed with an empty
        // visible capture — the exact `(no output)` shape that previously
        // cost the model extra diagnostic turns.
        let _rescueNote = '';
        if (_teePlan) {
            const _rescueTail = consumeFilterTeeCapture(_teePlan.teePath);
            if (isReallyErrored && _rescueTail && !stdout.trim() && !stderr.trim()) {
                _rescueNote = `\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\n${smartMiddleTruncate(_rescueTail)}`;
            }
        }
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
            : (shellRunFailed ? `[shell-run-failed] ${statusDetail}` : (legitExit ? statusDetail : ''));
        const errorPrefix = isReallyErrored ? 'Error: ' : '';
        // Three outcomes, three labels: a TOOL error (`[shell-tool-failed]`),
        // a command that RAN AND FAILED (`Error: [shell-run-failed]`), and a
        // command that RAN TO COMPLETION and merely ended non-zero. The last
        // one keeps its exit code but says so in words, so neither the model
        // nor the failure log treats a finished report as a failure.
        const completionNote = legitExit
            ? '\n[completed: the command finished and wrote nothing to stderr; the exit code is its own report, not a tool failure]'
            : '';
        if (mergeStderr) {
            // Post-exit concatenation. True chunk-level interleaving would
            // require shell-level `2>&1` redirection (bash) or `*>&1`
            // (PowerShell) inside wrappedCommand, or an in-process ordered
            // merged stream in shell-command.mjs. Current implementation
            // preserves stdout/stderr ordering within each stream but loses
            // cross-stream interleaving. Acceptable for most diagnostic
            // outputs; flag in shell-command if exact interleaving is required.
            const merged = stdout + stderr;
            if (statusMarker) return _finalizeShellResult(legitExit, _prependDestructiveWarning(command, errorPrefix + smartMiddleTruncate(`${statusMarker}${completionNote}\n\n${merged || '(no output)'}`) + _rescueNote + _driftNote));
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
            shellRescueNote,
        ].filter(Boolean).join('\n');
        const payload = `${body}${stderrBlock}${spillBlock}${_rescueNote}${_driftNote}`;
        if (statusMarker) return _finalizeShellResult(legitExit, _prependDestructiveWarning(command, _composeShellFailure(`${statusMarker}${completionNote}`, errorPrefix, warningBlock, payload)));
        return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
    }
    finally {
        combinedBashAbort?.cleanup?.();
        if (_inlineHoistPath) {
            try { unlinkSync(_inlineHoistPath); } catch { /* best-effort cleanup */ }
        }
        if (shellEffects.mutationMode === 'paths') {
            invalidateBuiltinResultCache(shellEffects.paths);
            markCodeGraphDirtyPaths(shellEffects.paths);
        } else if (shellEffects.mutationMode === 'global') {
            invalidateBuiltinResultCache();
            drainCodeGraphCache();
        }
    }
}

export { executeTaskTool } from './task-tool.mjs';
