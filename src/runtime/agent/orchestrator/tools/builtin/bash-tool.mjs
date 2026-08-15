import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { accessSync, constants as fsConstants, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { delimiter as pathDelimiter } from 'node:path';
import { join as pathJoin } from 'node:path';
import { isLegitimateShellExit } from '../../session/result-classification.mjs';
import { makeToolEnvelope } from '../../session/tool-envelope.mjs';
import { execShellCommand, stripAnsi } from '../shell-command.mjs';
import { wrapCommandWithSnapshot } from '../shell-snapshot.mjs';
import { getDestructiveCommandWarning } from '../destructive-warning.mjs';
import { maybeRewriteWmicProcessCommand } from '../shell-policy.mjs';
import { buildBashPolicyScanTargets, checkExecPolicyMessage } from '../bash-policy-scan.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from '../code-graph-state.mjs';
import {
    buildJobNotFoundMessage,
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
    buildPowerShellFilterTeePlan,
    consumeFilterTeeCapture,
    extractShellApplyPatchInvocation,
    hasPowerShellOnlySyntax,
    planInlineScriptHoist,
    preflightPowerShellHygiene,
    shellSplitSegments,
    shellSplitPipelineSegments,
    shellTokenize,
    stripShellProbeWrappers,
} from './shell-analysis.mjs';
import {
    completeBackgroundTask,
    getBackgroundTask,
    registerBackgroundTask,
    renderBackgroundTask,
    renderBackgroundTaskList,
} from '../../../../shared/background-tasks.mjs';
import { resolveShellFor } from './shell-runtime.mjs';
import {
    recordShellCaptureTelemetry,
    renderBackgroundPartialOutput,
} from './shell-output.mjs';
import {
    compactShellOutputLosslessly,
    renderLosslessRecoveryHint,
} from './shell-lossless-compact.mjs';
import { normalizeOutputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { applyShellEgressPolicy, scrubLoaderVars, scrubProviderSecrets, scrubRuntimeRootVars } from '../env-scrub.mjs';
import {
    findPathExecutable,
    SHELL_RUNTIME_CANDIDATES,
} from './runtime-capabilities.mjs';
import { planDirectExeSpawn } from './shell-direct-exe.mjs';

// Commands start in the foreground. Only work still running after the
// 15 s coordination budget is promoted to a tracked background task.
// Raised from 10 s (2026-08-15): repo verification units (node --test +
// tool-smoke) cluster at 10.7-11.2 s, so every routine check crossed the
// budget by a hair and cost a notification round-trip.
export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = 15_000;

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
// Uses AbortSignal.any when available; falls back to a manual controller.
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

// A completed non-zero process exit keeps its `[exit code: N]` marker but is
// not a TOOL failure. The explicit-success envelope preserves that structural
// distinction even when command output itself looks like an error.
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
                : (exitCode !== 0 && exitCode !== null ? `[exit code: ${exitCode}]${_exitClassDiagnostic(exitCode, result.stderr)}` : '')));
    return { signal, exitCode, shellToolFailed, statusDetail };
}

// Deterministic POSIX exit-class facts only (127 not-found, 126 not
// executable, 128+N signal). Per-command meanings (grep 1 = no match, test
// runner 1 = failures) stay uninterpreted — that would need a per-command
// dictionary, which is banned steering. 127 additionally names verified
// same-prefix executables actually present on PATH (fact statement, no
// substitution suggestion) so the model skips the "then what exists?" probe.
const _SIGNAL_NAME_BY_NUMBER = new Map(
    Object.entries(osConstants.signals || {}).map(([name, num]) => [num, name]).reverse(),
);
function _missingCommandFrom(stderr) {
    const text = String(stderr || '');
    const m = /(?:^|\n)[^\n]*?(?:line \d+:\s*)?([A-Za-z0-9._+-]+):\s*(?:command )?not found/.exec(text)
        || /The term '([^']+)' is not recognized/.exec(text);
    return m ? m[1] : null;
}
function _pathPrefixExecutables(cmd, limit = 5) {
    const needle = String(cmd || '').toLowerCase();
    const hits = [];
    if (!needle) return hits;
    const seenDirs = new Set();
    for (const dir of String(process.env.PATH || '').split(pathDelimiter)) {
        if (!dir || seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        if (seenDirs.size > 64) break;
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
            if (ent.isDirectory()) continue;
            if (!ent.name.toLowerCase().startsWith(needle)) continue;
            if (process.platform !== 'win32') {
                try { accessSync(pathJoin(dir, ent.name), fsConstants.X_OK); } catch { continue; }
            }
            hits.push(`${ent.name} (${dir.replace(/\\/g, '/')})`);
            if (hits.length >= limit) return hits;
        }
    }
    return hits;
}
function _availableRuntimeExecutables(missing, limit = 5) {
    const omitted = String(missing || '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '');
    const found = [];
    for (const name of SHELL_RUNTIME_CANDIDATES) {
        if (name.toLowerCase() === omitted) continue;
        const hit = findPathExecutable(name);
        if (hit) found.push(hit);
        if (found.length >= limit) break;
    }
    return found;
}
export function _exitClassDiagnostic(exitCode, stderr) {
    // Not gated on 127: compound chains (`a && b; c`) and pipelines mask the
    // 127 into the chain's final code (observed as exit 1 in 6/28 bench
    // cases), so the stderr fact decides, not the exit code.
    {
        const cmd = _missingCommandFrom(stderr);
        if (cmd) {
            const hits = _pathPrefixExecutables(cmd);
            const runtimes = _availableRuntimeExecutables(cmd);
            const runtimeFact = runtimes.length
                ? `; available runtimes on PATH: ${runtimes.join(', ')}`
                : '';
            return (hits.length
                ? ` — '${cmd}' is not on PATH; PATH does have: ${hits.join(', ')}`
                : ` — '${cmd}' is not on PATH and no '${cmd}*' executable exists on PATH`)
                + runtimeFact;
        }
    }
    if (exitCode === 126) return ' — 126: command found but not executable (permission or format)';
    if (exitCode > 128 && exitCode < 165) {
        const name = _SIGNAL_NAME_BY_NUMBER.get(exitCode - 128);
        if (name) return ` — 128+${exitCode - 128}: terminated by ${name}`;
    }
    return '';
}

export function _composeShellFailure(statusMarker, errorPrefix, warningBlock, payload) {
    return `${errorPrefix}${statusMarker}${warningBlock ? `\n${warningBlock}` : ''}\n\n${payload}`;
}

const INLINE_HOIST_CLEANUP_PATHS = new Set();
let inlineHoistExitHookInstalled = false;
function scheduleInlineHoistCleanup(file) {
    if (!file) return;
    INLINE_HOIST_CLEANUP_PATHS.add(file);
    if (!inlineHoistExitHookInstalled) {
        inlineHoistExitHookInstalled = true;
        process.once('exit', () => {
            for (const pending of INLINE_HOIST_CLEANUP_PATHS) {
                try { unlinkSync(pending); } catch {}
            }
            INLINE_HOIST_CLEANUP_PATHS.clear();
        });
    }
    // A long-lived pwsh standby can emit its completion marker just before a
    // nested native process has opened the hoisted script. Keep the transport
    // file briefly past marker settlement; normal daemon lifetime cleans it
    // here, while the exit hook prevents one-shot CLI/test leftovers.
    const timer = setTimeout(() => {
        INLINE_HOIST_CLEANUP_PATHS.delete(file);
        try { unlinkSync(file); } catch {}
    }, 10_000);
    timer.unref?.();
}

export async function executeBashTool(args, workDir, options = {}) {
    // Every call starts from the current Project root. A command-local `cd`
    // never creates a second session cwd authority beside the dedicated cwd tool.
    const bashWorkDir = workDir;
    const _readStateScope = options?.readStateScope ?? options?.sessionId ?? null;
    // Run hard-block policy before any shell dispatch.
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
        const _policyBlock = checkExecPolicyMessage(_rawCmd);
        if (_policyBlock) return formatShellToolFailure(_policyBlock);
    }

    let command = args.command;
    if (!command) return formatShellToolFailure('command is required');

    // Resolve the configured default shell up front so shell-type-specific
    // handling (PS-only wmic rewrite, PS UTF-8 prefix) can gate on it.
    let resolvedSpec = resolveShellFor('default');
    if (!resolvedSpec) {
        return formatShellToolFailure('No supported system shell was found.');
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
        // PowerShell-specific violation stays a hard block.
        const bashSpec = psHygiene.bashOnly
            && !hasPowerShellOnlySyntax(psHygiene.original ?? command)
            ? resolveShellFor('bash')
            : null;
        if (!bashSpec) return formatShellToolFailure(psHygiene.block);
        // The MSYS rewrite targets PowerShell; bash gets the original text.
        command = psHygiene.original ?? command;
        resolvedSpec = bashSpec;
        shellRescueNote = 'note: bash-only syntax on a PowerShell host — ran it in Git Bash.';
    } else {
        command = psHygiene.command;
    }

    const _execPolicyBlock = checkExecPolicyMessage(command);
    if (_execPolicyBlock) {
        return formatShellToolFailure(_execPolicyBlock);
    }
    // Inline-script hoisting. The body is written verbatim and the invocation becomes a
    // file run, so the host shell never has to carry the script through its
    // quoting layer. planInlineScriptHoist refuses every case where file
    // semantics would differ, so this is a transport change only.
    let _inlineHoistPath = null;
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

    const _bgTasksDisabled = /^(1|true|yes|on)$/i.test(
        String(process.env.MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS || '').trim(),
    );

    let shellEffects;
    let combinedBashAbort = null;
    try {
        shellEffects = await analyzeShellCommandEffects(command, bashWorkDir);
    } catch (err) {
        return formatShellToolFailure(normalizeErrorMessage(err instanceof Error ? err.message : String(err)));
    }
    // timeout_ms is a caller-requested HARD total deadline, not a foreground
    // wait budget. Omitted/0 means no deadline: the command starts foreground,
    // then the 15 s coordination budget promotes it without shortening its
    // lifetime. This matches the public schema and avoids accidental kills
    // caused by callers guessing how long a build might take.
    const _envMaxTimeout = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
    // Foreground blocking cap when timeout promotion is available. 120s avoids
    // caller-supplied 10-15 min timeout hold the conversation synchronously
    // for its whole span (user: sync calls hanging 10-20 minutes); 120s (the
    // default cap keeps anything longer detached with the REMAINDER of the
    // explicit timeout as its background deadline (user decision: 2 minutes).
    const MAX_BASH_TIMEOUT_MS = _envMaxTimeout > 0 ? _envMaxTimeout : 120_000;
    const hasExplicitTimeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0;
    const timeoutMs = hasExplicitTimeout ? args.timeout_ms : 0;
    const backgroundOnTimeout = !_bgTasksDisabled;
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
    // A caller deadline at or below the foreground window has no remaining
    // budget to transfer. Let execShellCommand enforce that timeout instead of
    // adopting the child with timeoutMs=0, which means unlimited to shell-jobs.
    const promoteAtTimeout = backgroundOnTimeout
        && (!hasExplicitTimeout || promotedTimeoutMs > 0);
    const mergeStderr = true;
    // Main-agent blocking budget. A timeout is the command's total deadline,
    // not permission to hold the conversation open for that whole duration:
    // after 15 s a still-running command becomes a tracked background task and
    // completion is pushed to the owner. Explicit timeouts keep their remaining
    // deadline after promotion.
    // MIXDOG_SHELL_AUTO_BACKGROUND_MS overrides; an explicit 0 disables.
    const _autoBgEnvRaw = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
    const _autoBgEnvMs = Number(_autoBgEnvRaw);
    const DEFAULT_AUTO_BACKGROUND_MS = (_autoBgEnvRaw != null && String(_autoBgEnvRaw).trim() !== ''
      && Number.isFinite(_autoBgEnvMs) && _autoBgEnvMs >= 0)
      ? Math.floor(_autoBgEnvMs)
      : DEFAULT_SHELL_AUTO_BACKGROUND_MS;
    // Gate on backgroundOnTimeout so disabled background tasks remain foreground.
    const autoBackgroundMs = (!backgroundOnTimeout || DEFAULT_AUTO_BACKGROUND_MS <= 0)
      ? 0
      : (timeout > 0 ? Math.min(DEFAULT_AUTO_BACKGROUND_MS, timeout) : DEFAULT_AUTO_BACKGROUND_MS);

    try {
        const { shell, shellArg, shellArgs, shellType } = resolvedSpec;
        const spawnEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
        // R5/R11: same scrub as background/persistent spawn sites (env-scrub.mjs).
        scrubProviderSecrets(spawnEnv);
        scrubLoaderVars(spawnEnv);
        scrubRuntimeRootVars(spawnEnv);
        applyShellEgressPolicy(spawnEnv);
        let wrappedCommand;
        let _teePlan = null;
        let execShell = shell;
        let execShellArg = shellArg;
        let execShellArgs = shellArgs;
        let directArgv = null;
        const directPlan = planDirectExeSpawn(command, {
            shellType,
            cwd: bashWorkDir,
            pathValue: spawnEnv.PATH,
            env: spawnEnv,
        });
        // PowerShell UTF-8 prefix is PS-only: the Windows Git Bash path
        // (shellType==='posix') must NOT receive it. Snapshot wrapper stays
        // POSIX-host-only for now — no snapshot for Windows Git Bash initially.
        if (directPlan) {
            wrappedCommand = command;
            execShell = directPlan.exe;
            execShellArg = '';
            execShellArgs = [];
            directArgv = directPlan.argv;
        } else if (process.platform === 'win32' && shellType === 'powershell') {
            // Filter-swallow rescue: tee the unfiltered
            // producer stream of an exactly-recognized filter pipeline so a
            // failing run can attach the original output tail in THIS call
            // instead of returning `[exit code: N]` + `(no output)`. Any
            // ambiguity yields a null plan and the command runs untouched.
            try { _teePlan = buildPowerShellFilterTeePlan(command); } catch { _teePlan = null; }
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
        let bashAbortSignal = null;
        try { bashAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
        catch { bashAbortSignal = null; }
        combinedBashAbort = _combineAbortSignals(bashAbortSignal, options?.abortSignal || null);
        // Promote-at-timeout (CC shouldAutoBackground parity). When a
        // foreground one-shot hits its timeout and is still running, adopt it
        // as a background job (task_id + notify) instead of tree-killing it.
        // The truthy MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS env restores the old
        // foreground-only behavior.
        const foregroundStartedAtMs = Date.now();
        const result = await execShellCommand({
            shell: execShell, shellArg: execShellArg, shellArgs: execShellArgs,
            command: wrappedCommand,
            directArgv,
            env: spawnEnv,
            cwd: bashWorkDir,
            timeoutMs: timeout,
            abortSignal: combinedBashAbort.signal,
            autoBackgroundMs,
            // On a foreground timeout, promote the still-running child to a
            // tracked background job only when an explicit deadline has
            // remaining budget; omitted deadlines may stay unlimited.
            backgroundOnTimeout: promoteAtTimeout,
            promotedTimeoutMs,
            // Soft/interrupt promotion happens before the foreground cap.
            // Preserve an explicit total deadline by passing it separately;
            // omitted-timeout promotions retain the existing unlimited job.
            backgroundDeadlineMs: hasExplicitTimeout ? totalTimeout : 0,
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
        const stdout = stripAnsi(result.stdout || '');
        const stderr = stripAnsi(result.stderr || '');
        recordShellCaptureTelemetry(options?.resultTelemetry, result, stdout, stderr);
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
                        startedAtMs: foregroundStartedAtMs,
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
            const partialOutput = renderBackgroundPartialOutput(
                stdout,
                stderr,
            );
            const lines = [
                task ? renderBackgroundTask(task) : (result.jobId ? `[task_id: ${result.jobId}]` : null),
                '',
                result.backgroundMessage || 'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
                result.jobId ? 'You will be notified when it completes; do not poll.' : null,
                partialOutput ? `\n${partialOutput}` : '',
            ].filter((l) => l !== null && l !== '');
            return _prependDestructiveWarning(command, lines.join('\n'));
        }
        const failureStatus = _shellFailureStatus(result, timeout);
        const { signal, exitCode, shellToolFailed } = failureStatus;
        // The shell tool succeeded once it spawned and observed the process to
        // completion. A non-zero process exit is command data — regardless of
        // stderr or failure banners — and never a tool/control-plane failure.
        const legitExit = !shellToolFailed
            && isLegitimateShellExit({
                exitCode,
                signal,
                timedOut: result.timedOut,
                stdout,
                stderr,
            });
        const shellRunFailed = !shellToolFailed
            && (!!signal || result.timedOut);
        const isReallyErrored = shellToolFailed || shellRunFailed;
        // Filter-swallow rescue: the tee file is ALWAYS consumed (deleted)
        // here; its tail is attached only when the run failed with an empty
        // visible capture — the exact `(no output)` shape that previously
        // cost the model extra diagnostic turns.
        let _rescueNote = '';
        if (_teePlan) {
            const _rescueTail = consumeFilterTeeCapture(_teePlan.teePath);
            if (isReallyErrored && _rescueTail && !stdout.trim() && !stderr.trim()) {
                _rescueNote = `\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\n${_rescueTail}`;
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
        // Three outcomes: TOOL/control-plane failure, interrupted execution,
        // and a process that completed (zero or non-zero). Completed non-zero
        // exits keep their code but never carry Error:/shell-run-failed.
        const completionNote = legitExit
            ? '\n[completed: shell executed the command; its non-zero exit code and output are command results, not a tool failure]'
            : '';
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
        const losslessCompaction = compactShellOutputLosslessly({
            command,
            rawStdout: result.stdout || '',
            rawStderr: result.stderr || '',
            stdout,
            stderr,
            exitCode,
            signal,
            timedOut: result.timedOut,
            hasExistingRecovery: Boolean(result.stdoutPath || result.stderrPath),
            sessionId: options?.sessionId,
            toolCallId: options?.toolCallId,
        });
        const visibleStdout = losslessCompaction?.stdout ?? stdout;
        const visibleStderr = losslessCompaction?.stderr ?? stderr;
        const compactHint = renderLosslessRecoveryHint(losslessCompaction, normalizeOutputPath);
        if (mergeStderr) {
            const merged = visibleStdout + visibleStderr;
            const compactBlock = compactHint ? `\n\n${compactHint}` : '';
            if (statusMarker) return _finalizeShellResult(legitExit, _prependDestructiveWarning(command, errorPrefix + `${statusMarker}${completionNote}\n\n${merged || '(no output)'}` + compactBlock + _rescueNote + _driftNote));
            return _prependDestructiveWarning(command, (merged || '(no output)') + compactBlock + _driftNote);
        }
        const compactedStdout = visibleStdout;
        const compactedStderr = visibleStderr;
        const compactedBody = compactedStdout || (compactedStderr ? '' : '(no output)');
        const compactedStderrBlock = compactedStderr ? `\n\n[stderr]\n${compactedStderr}` : '';
        const compactBlock = compactHint ? `\n\n${compactHint}` : '';
        const payload = `${compactedBody}${compactedStderrBlock}${spillBlock}${compactBlock}${_rescueNote}${_driftNote}`;
        if (statusMarker) return _finalizeShellResult(legitExit, _prependDestructiveWarning(command, _composeShellFailure(`${statusMarker}${completionNote}`, errorPrefix, warningBlock, payload)));
        return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
    }
    finally {
        combinedBashAbort?.cleanup?.();
        if (_inlineHoistPath) {
            scheduleInlineHoistCleanup(_inlineHoistPath);
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
