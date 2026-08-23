import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { accessSync, constants as fsConstants, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { delimiter as pathDelimiter } from 'node:path';
import { join as pathJoin } from 'node:path';
import { makeToolEnvelope } from '../../session/tool-envelope.mjs';
import {
    execShellCommand,
    stripAnsi,
} from '../shell-command.mjs';
import {
    killShellDescendants,
    waitForShellDescendants,
} from '../lib/shell-descendants.mjs';
import { wrapCommandWithSnapshot } from '../shell-snapshot.mjs';
import { getDestructiveCommandWarning } from '../destructive-warning.mjs';
import { maybeRewriteWmicProcessCommand } from '../shell-policy.mjs';
import { buildBashPolicyScanTargets, checkExecPolicyMessage } from '../bash-policy-scan.mjs';
import { markCodeGraphDirtyPaths, drainCodeGraphCache } from '../code-graph-state.mjs';
import {
    isShellJobRunning,
    killShellJob,
    subscribeShellJobSettled,
    watchBackgroundShellJob,
} from './shell-jobs.mjs';

// A command that detaches work is never detected from its text — the text is
// not read at all. After the shell exits, the runner observes whether the
// command's process group / process tree still holds live processes and hands
// them over as a tracked task, so nothing runs without a task_id.
export const SURVIVING_DESCENDANTS_WARNING =
    '⚠️ the command finished but left descendants running: they are tracked as the task below, and `task cancel` terminates them.';
// Same observation, but the survivors can no longer be addressed by pid:
// Windows keeps a dangling parent id when an intermediate process exits, so a
// process re-parented that way is visible but not signalable from here.
export const SURVIVING_DESCENDANTS_UNREACHABLE_WARNING =
    '⚠️ the command finished but left a descendant running that this process can no longer signal (its parent exited and Windows keeps no live link to it). It stays tracked as the task below and its completion is reported, but `task cancel` may not be able to terminate it.';

/** Register the survivors a finished command left behind as a normal tracked
 *  task. It uses the SAME task registry every other background shell task
 *  uses, so task list/read/cancel need no special case: `run` settles the task
 *  when the last observed survivor exits, `cancel` terminates them. */
export function _trackSurvivingDescendants(handle, { command, cwd, options, startedAtMs } = {}) {
    if (!handle?.taskId) return null;
    try {
        return startBackgroundTask({
            taskId: handle.taskId,
            startedAtMs: startedAtMs || Date.now(),
            surface: 'shell',
            operation: 'shell',
            label: String(command).replace(/\s+/g, ' ').slice(0, 120),
            input: { command, cwd },
            context: {
                notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
                callerSessionId: options?.callerSessionId || options?.sessionId || null,
                routingSessionId: options?.routingSessionId || options?.sessionId || null,
                clientHostPid: options?.clientHostPid,
            },
            meta: {
                task_id: handle.taskId,
                stdout: null,
                stderr: null,
                cwd,
                timeoutMs: 0,
            },
            resultType: 'shell_task_result',
            run: async () => {
                await waitForShellDescendants(handle, { pollMs: 1_000 });
                return {
                    task_id: handle.taskId,
                    status: 'completed',
                    detail: 'every process the command left running has exited',
                };
            },
            cancel: () => { void killShellDescendants(handle); },
        });
    } catch {
        return null;
    }
}
/** Result lines for a command that leaves through the BACKGROUND path. The
 *  untracked-operator warning renders here too: every path a command can leave
 *  through carries it, not just the normal-completion block. */
export function _backgroundResultLines({
    warning = null,
    taskBlock = null,
    message = '',
    partialOutput = '',
} = {}) {
    return [
        warning || null,
        taskBlock,
        '',
        message,
        partialOutput ? `\n${partialOutput}` : '',
    ].filter((line) => line !== null && line !== '');
}

import {
    analyzeShellCommandEffects,
    buildPowerShellFilterTeePlan,
    consumeFilterTeeCapture,
    extractShellApplyPatchInvocation,
    planInlineScriptHoist,
    planLongInlineScriptFileTransport,
    planLongShellScriptFileTransport,
    preflightPowerShellHygiene,
    shellSplitSegments,
    shellSplitPipelineSegments,
    shellTokenize,
    stripShellProbeWrappers,
} from './shell-analysis.mjs';
import {
    registerBackgroundTask,
    renderBackgroundTask,
    startBackgroundTask,
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
// 10 s coordination budget is promoted to a tracked background task.
// Short commands therefore complete in the original tool turn, while longer
// work returns partial output plus task_id and finishes by notification.
export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = 10_000;

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

export function _placeDestructiveWarningsAfterStatus(command, text) {
    const warnings = getDedupedDestructiveWarnings(command);
    if (!warnings.length) return text;
    const warningBlock = warnings.map((w) => `⚠️ ${w}`).join('\n');
    const firstBreak = text.indexOf('\n');
    if (firstBreak < 0) return `${text}\n${warningBlock}`;
    return `${text.slice(0, firstBreak)}\n${warningBlock}${text.slice(firstBreak)}`;
}

export function formatShellToolFailure(message) {
    const text = String(message ?? '').replace(/^Error:\s*/i, '').trim() || 'shell tool failed';
    return `Error: [shell-tool-failed] ${text}`;
}

// Every observed process completion keeps its `[exit code: N]` marker and is
// not a TOOL failure. The explicit-success envelope preserves that structural
// distinction even when command output itself starts with "Error:".
function _finalizeShellResult(completedExit, text) {
    return completedExit ? makeToolEnvelope(text, [], { explicitSuccess: true }) : text;
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
                : (Number.isInteger(exitCode)
                    ? `[exit code: ${exitCode}]${exitCode !== 0 ? _exitClassDiagnostic(exitCode, result.stderr) : ''}`
                    : '[missing exit status]')));
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

// Per-command transport artifacts (hoisted inline script, PowerShell filter-tee
// capture) stay in use by a command that was promoted to a background task, so
// they are removed when that TASK SETTLES. A fixed 10 s timer deleted the
// hoisted script out from under a still-running command; the ceiling below only
// covers a job whose settlement event never arrives, and the exit hook prevents
// one-shot CLI/test leftovers.
// Rules:
//   - a promoted command still USES its artifacts, so removal waits for the
//     task to settle (a fixed timer deleted the script under a live command);
//   - the fallback timer never deletes under a task that is still running: a
//     missed settlement event and a live job are not the same thing, so it
//     re-arms instead;
//   - a failed removal is retried rather than abandoned — Windows keeps the
//     file locked while a process that survived an unconfirmed kill holds it —
//     with the process-exit hook as the last resort.
const ARTIFACT_SETTLE_CEILING_MS = 30 * 60_000;
const UNTRACKED_ARTIFACT_CLEANUP_MS = 10_000;
const ARTIFACT_RETRY_MS = 30_000;
const ARTIFACT_RETRY_ATTEMPTS = 10;
const PENDING_ARTIFACT_PATHS = new Set();
let artifactExitHookInstalled = false;

function removeTransportFile(file) {
    try {
        unlinkSync(file);
        return true;
    } catch (err) {
        return err?.code === 'ENOENT';
    }
}
function consumeTeeArtifact(file) {
    try { consumeFilterTeeCapture(file); } catch { /* best-effort */ }
    return removeTransportFile(file);
}
function registerTransportArtifact(file) {
    PENDING_ARTIFACT_PATHS.add(file);
    if (artifactExitHookInstalled) return;
    artifactExitHookInstalled = true;
    process.once('exit', () => {
        for (const pending of PENDING_ARTIFACT_PATHS) {
            try { unlinkSync(pending); } catch {}
        }
        PENDING_ARTIFACT_PATHS.clear();
    });
}
function finishTransportArtifact(file, remove, attempt = 0) {
    if (!PENDING_ARTIFACT_PATHS.has(file)) return;
    let removed = false;
    try { removed = remove(file) !== false; } catch { removed = false; }
    if (removed) {
        PENDING_ARTIFACT_PATHS.delete(file);
        return;
    }
    if (attempt >= ARTIFACT_RETRY_ATTEMPTS) return;
    const retry = setTimeout(() => finishTransportArtifact(file, remove, attempt + 1), ARTIFACT_RETRY_MS);
    retry.unref?.();
}
function removeTransportFileNow(file) {
    if (!file) return;
    registerTransportArtifact(file);
    finishTransportArtifact(file, removeTransportFile);
}
function cleanupArtifactOnTaskSettled(file, jobId, remove = removeTransportFile) {
    if (!file) return;
    registerTransportArtifact(file);
    let finished = false;
    let unsubscribe = null;
    const done = () => {
        if (finished) return;
        finished = true;
        try { unsubscribe?.(); } catch { /* best-effort */ }
        unsubscribe = null;
        finishTransportArtifact(file, remove);
    };
    unsubscribe = jobId ? subscribeShellJobSettled(jobId, done) : null;
    const armFallback = () => {
        const timer = setTimeout(() => {
            if (finished) return;
            if (jobId && isShellJobRunning(jobId)) {
                armFallback();
                return;
            }
            done();
        }, unsubscribe ? ARTIFACT_SETTLE_CEILING_MS : UNTRACKED_ARTIFACT_CLEANUP_MS);
        timer.unref?.();
    };
    armFallback();
}

export async function executeBashTool(args, workDir, options = {}) {
    // Every call starts from the current Project root. A command-local `cd`
    // never creates a second session cwd authority beside the dedicated cwd tool.
    const bashWorkDir = workDir;
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
    const resolvedSpec = resolveShellFor('default');
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
    // A bash-shaped command on a PowerShell host stays a hard block carrying
    // PowerShell-native hints, so the caller retries in the announced shell.
    // Re-running it in Git Bash instead would contradict a fact the session
    // already stated (shell=pwsh.exe) without saying so, leaving every later
    // command reasoned about under the wrong interpreter — path form, quoting,
    // and exit-code semantics all differ. The blocked filter pipelines
    // (grep/sed/awk/tail) are also exactly what the grep/read tools own.
    if (psHygiene.block) return formatShellToolFailure(psHygiene.block);
    command = psHygiene.command;

    const _execPolicyBlock = checkExecPolicyMessage(command);
    if (_execPolicyBlock) {
        return formatShellToolFailure(_execPolicyBlock);
    }
    // Inline-script hoisting. The body is written verbatim and the invocation becomes a
    // file run, so the host shell never has to carry the script through its
    // quoting layer. planInlineScriptHoist refuses every case where file
    // semantics would differ, so this is a transport change only.
    // A trailing `&` (or anything else the shell treats as an operator) is
    // NEVER detected, stripped or rewritten: the command reaches the shell
    // byte for byte. Work that detaches is caught after the fact, from the
    // process group / process tree the run leaves behind.
    const _analysisCommand = command;
    let _inlineHoistPath = null;
    let _inlineHoistBackgrounded = false;
    let _backgroundJobId = null;
    const hoist = planInlineScriptHoist(command)
        || planLongInlineScriptFileTransport(command, {
            platform: process.platform,
            shellType: resolvedSpec.shellType,
        })
        || planLongShellScriptFileTransport(command, {
            platform: process.platform,
            shellType: resolvedSpec.shellType,
        });
    if (hoist) {
        try {
            const file = pathJoin(
                tmpdir(),
                `mixdog-inline-${process.pid}-${Date.now().toString(36)}${hoist.extension}`,
            );
            // Windows PowerShell 5.1 interprets UTF-8 without BOM as the
            // active ANSI codepage. Preserve non-ASCII command text when the
            // transport changes a long command into a .ps1 file.
            const fileBody = hoist.extension === '.ps1' ? `\uFEFF${hoist.body}` : hoist.body;
            writeFileSync(file, fileBody, 'utf8');
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
        shellEffects = await analyzeShellCommandEffects(_analysisCommand, bashWorkDir);
    } catch (err) {
        return formatShellToolFailure(normalizeErrorMessage(err instanceof Error ? err.message : String(err)));
    }
    // timeout_ms is a caller-requested HARD total deadline, not a foreground
    // wait budget. Omitted/0 means no deadline: the command starts foreground,
    // then the 10 s coordination budget promotes it without shortening its
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
    // A rewrite-supplied cap (wmic → Get-CimInstance, 30 s) is a HARD deadline
    // exactly like an explicit caller timeout. With an omitted timeout_ms the
    // cap used to collapse to 0 = unlimited, so the command the rewrite note
    // advertises as capped could run forever.
    const wmicCapMs = Math.max(0, Math.floor(Number(wmicRewrite?.timeoutMs) || 0));
    const hasHardDeadline = hasExplicitTimeout || wmicCapMs > 0;
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
        ? wmicCapMs
        : Math.min(timeoutMs, wmicCapMs || (hasExplicitTimeout ? TIMER_MAX_MS : MAX_BASH_TIMEOUT_MS));
    const timeout = hasHardDeadline && backgroundOnTimeout
        ? Math.min(totalTimeout, MAX_BASH_TIMEOUT_MS)
        : totalTimeout;
    const promotedTimeoutMs = hasHardDeadline && backgroundOnTimeout
        ? Math.max(0, totalTimeout - timeout)
        : 0;
    // Background safety net. An omitted timeout_ms means "no caller deadline",
    // which is right for a build or an intentional server, but it also lets a
    // forgotten task outlive whatever spawned it: shell-job RECORDS age out,
    // a live job never does. MIXDOG_SHELL_BACKGROUND_MAX_MS bounds only that
    // omitted case. An explicit caller timeout is never shortened, and the
    // default 0 preserves today's unlimited behaviour, so capping stays a
    // deliberate choice rather than a surprise kill of a long build or watcher.
    const _bgMaxEnvMs = Number(process.env.MIXDOG_SHELL_BACKGROUND_MAX_MS);
    const backgroundMaxMs = Number.isFinite(_bgMaxEnvMs) && _bgMaxEnvMs > 0
        ? Math.min(Math.floor(_bgMaxEnvMs), TIMER_MAX_MS)
        : 0;
    const execTimeoutMs = timeout;
    // A caller deadline at or below the foreground window has no remaining
    // budget to transfer. Let execShellCommand enforce that timeout instead of
    // promoting the child with timeoutMs=0, which means unlimited to shell-jobs.
    const promoteAtTimeout = backgroundOnTimeout
        && (!hasHardDeadline || promotedTimeoutMs > 0);
    // Main-agent blocking budget. A timeout is the command's total deadline,
    // not permission to hold the conversation open for that whole duration:
    // after 10 s a still-running command becomes a tracked background task and
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
        if (process.platform === 'win32') {
            if (spawnEnv.PYTHONUTF8 === undefined) spawnEnv.PYTHONUTF8 = '1';
            if (spawnEnv.PYTHONIOENCODING === undefined) spawnEnv.PYTHONIOENCODING = 'utf-8';
        }
        // R5/R11: same scrub as background/persistent spawn sites (env-scrub.mjs).
        scrubProviderSecrets(spawnEnv);
        scrubLoaderVars(spawnEnv);
        scrubRuntimeRootVars(spawnEnv);
        applyShellEgressPolicy(spawnEnv);
        let wrappedCommand;
        let execScript = null;
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
            // Deliver the script through the environment, not argv. `bash -c
            // '<script>'` publishes the entire command text in the child's
            // /proc/<pid>/cmdline, so any `-f` (full-cmdline) process matcher
            // built from that same text matches the wrapper running it.
            // Measured: `pkill -f "sshd -D"` SIGTERM'd its own shell 7 ms in,
            // and `while pgrep -f install_rstan.R; do sleep 15; done` could
            // never exit because pgrep kept finding the loop's own wrapper —
            // a silent infinite wait, not an error.
            //
            // `eval` is the same parser on the same shell: quoting, heredocs,
            // `set -e`, traps, exit status and stdin all behave as under -c.
            // Only the argv exposure changes. `?` (not `:?`) fires solely when
            // the variable never arrived, so an empty command stays the no-op
            // it is today instead of turning into an error.
            spawnEnv.MIXDOG_SHELL_SCRIPT = wrappedCommand;
            execScript = 'eval "${MIXDOG_SHELL_SCRIPT?mixdog: shell script was not delivered to the child}"';
        } else {
            wrappedCommand = command;
        }
        let bashAbortSignal = null;
        try { bashAbortSignal = (await getAbortSignalForSession(options?.sessionId)) || null; }
        catch { bashAbortSignal = null; }
        combinedBashAbort = _combineAbortSignals(bashAbortSignal, options?.abortSignal || null);
        // Promote-at-timeout. When a
        // foreground one-shot hits its timeout and is still running, promote it
        // as a background job (task_id + notify) instead of tree-killing it.
        // The truthy MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS env restores the old
        // foreground-only behavior.
        const foregroundStartedAtMs = Date.now();
        const result = await execShellCommand({
            shell: execShell, shellArg: execShellArg, shellArgs: execShellArgs,
            command: wrappedCommand,
            execScript,
            directArgv,
            env: spawnEnv,
            cwd: bashWorkDir,
            timeoutMs: execTimeoutMs,
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
            backgroundDeadlineMs: hasHardDeadline ? totalTimeout : backgroundMaxMs,
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
        _inlineHoistBackgrounded = result.backgrounded === true;
        _backgroundJobId = result.backgrounded === true ? (result.jobId || null) : null;
        const stdout = stripAnsi(result.stdout || '');
        const stderr = stripAnsi(result.stderr || '');
        recordShellCaptureTelemetry(options?.resultTelemetry, result, stdout, stderr);
        // Auto-backgrounded: the command outlived autoBackgroundMs and is
        // still running, now promoted as a tracked shell-job. Surface the
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
                            // Both streams render as one body, so the task
                            // record carries the stdout path only.
                            stderr: null,
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
            // The promoted producer is still writing into the tee file, so it
            // cannot be consumed here — but it must not survive the command
            // either. Consume (and delete) it when the task settles.
            if (_teePlan) {
                cleanupArtifactOnTaskSettled(_teePlan.teePath, result.jobId, consumeTeeArtifact);
            }
            const partialOutput = renderBackgroundPartialOutput(
                stdout,
                stderr,
            );
            const lines = _backgroundResultLines({
                taskBlock: task ? renderBackgroundTask(task) : (result.jobId ? `[task_id: ${result.jobId}]` : null),
                message: result.backgroundMessage || 'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.',
                partialOutput,
            });
            return _prependDestructiveWarning(command, lines.join('\n'));
        }
        const failureStatus = _shellFailureStatus(result, timeout);
        const { signal, exitCode, shellToolFailed } = failureStatus;
        // Every integer exit status is an observed process completion.
        // stdout/stderr wording never overrides that fact: even an exit-0
        // payload beginning with "Error:" remains an explicit success.
        const completedExit = !shellToolFailed
            && !signal
            && !result.timedOut
            && Number.isInteger(exitCode);
        const benignExit = completedExit
            && _isBenignSearchExitOne(_analysisCommand, exitCode, signal, result.stderr);
        const shellRunFailed = !shellToolFailed
            && (!!signal || result.timedOut || !Number.isInteger(exitCode));
        const isReallyErrored = shellToolFailed || shellRunFailed;
        // Filter-swallow rescue: the tee file is ALWAYS consumed (deleted)
        // here; its tail is attached only when the run failed with an empty
        // visible capture — the exact `(no output)` shape that previously
        // cost the model extra diagnostic turns.
        let _rescueNote = '';
        if (_teePlan) {
            const _rescueTail = consumeFilterTeeCapture(_teePlan.teePath);
            // consumeFilterTeeCapture unlinks best-effort and swallows the
            // failure; on Windows a process that survived an unconfirmed kill
            // still holds the file. Route it through the same retry + exit-hook
            // path the settlement branch uses instead of abandoning it.
            removeTransportFileNow(_teePlan.teePath);
            const commandExitedNonzero = completedExit && exitCode !== 0 && !benignExit;
            if ((isReallyErrored || commandExitedNonzero) && _rescueTail && !stdout.trim() && !stderr.trim()) {
                _rescueNote = `\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\n${_rescueTail}`;
            }
        }
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
            : (shellRunFailed ? `[shell-run-failed] ${statusDetail}` : (completedExit ? statusDetail : ''));
        const errorPrefix = isReallyErrored ? 'Error: ' : '';
        // Three outcomes: TOOL/control-plane failure, interrupted execution,
        // and a process that completed (zero or non-zero). Completed non-zero
        // exits keep their code but never carry Error:/shell-run-failed.
        const completionNote = completedExit && exitCode !== 0
            ? '\n[completed: shell executed the command; its non-zero exit code and output are command results, not a tool failure]'
            : '';
        const outcomeNote = benignExit ? '\n[outcome: no-match]' : '';
        // No spill-path block: a truncated stream already carries its own
        // "full output at <path>" marker from the head+tail renderer, an
        // untruncated one is inline in full, and a capture error is reported
        // by the status marker itself. Repeating any of it only added lines.
        // The shell process is gone, but the runner observed live processes
        // still in its process group / tree. Hand them to the task registry so
        // the caller leaves with a task_id that reads, completes on its own
        // when the last survivor exits, and cancels the whole set — instead of
        // work running with no handle at all.
        const _descendantTask = result.descendants
            ? _trackSurvivingDescendants(result.descendants, {
                command,
                cwd: bashWorkDir,
                options,
                startedAtMs: foregroundStartedAtMs,
            })
            : null;
        const warningBlock = [
            _descendantTask
                ? [
                    result.descendants?.reachable
                        ? SURVIVING_DESCENDANTS_WARNING
                        : SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
                    renderBackgroundTask(_descendantTask),
                ].join('\n')
                : '',
            wmicRewrite?.note || '',
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
        // stdout and stderr are captured on separate fds and pasted as one
        // body. Without a boundary a stdout tail with no trailing newline
        // glued itself onto the first stderr line and corrupted both.
        const streamGap = visibleStdout && visibleStderr && !visibleStdout.endsWith('\n') ? '\n' : '';
        const body = `${visibleStdout}${streamGap}${visibleStderr}` || '(no output)';
        const compactBlock = compactHint ? `\n\n${compactHint}` : '';
        const payload = `${body}${compactBlock}${_rescueNote}`;
        // warningBlock states that the text which RAN is not the text the
        // caller sent (wmic → Get-CimInstance). It reached neither shape while
        // the merged branch short-circuited above, so it now rides both.
        if (statusMarker) return _finalizeShellResult(completedExit, _placeDestructiveWarningsAfterStatus(command, _composeShellFailure(`${statusMarker}${outcomeNote}${completionNote}`, errorPrefix, warningBlock, payload)));
        return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
    }
    finally {
        combinedBashAbort?.cleanup?.();
        if (_inlineHoistPath) {
            if (_inlineHoistBackgrounded) cleanupArtifactOnTaskSettled(_inlineHoistPath, _backgroundJobId);
            // Foreground: delete now, but an unconfirmed kill can leave the
            // file locked by a process that outlived the call — retry instead
            // of abandoning it.
            else removeTransportFileNow(_inlineHoistPath);
        }
        const invalidateMutationCaches = () => {
            if (shellEffects.mutationMode === 'paths') {
                invalidateBuiltinResultCache(shellEffects.paths);
                markCodeGraphDirtyPaths(shellEffects.paths);
            } else if (shellEffects.mutationMode === 'global') {
                invalidateBuiltinResultCache();
                drainCodeGraphCache();
            }
        };
        invalidateMutationCaches();
        // A promoted command has barely started: invalidating only at
        // promotion return lets every later read recache PRE-command state and
        // never re-invalidate. Repeat it when the task actually settles.
        if (_backgroundJobId && shellEffects.mutationMode !== 'none') {
            subscribeShellJobSettled(_backgroundJobId, invalidateMutationCaches);
        }
    }
}

export { executeTaskTool } from './task-tool.mjs';
