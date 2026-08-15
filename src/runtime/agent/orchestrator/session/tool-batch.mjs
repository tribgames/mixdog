// Tool-call batch processor, extracted from agent-loop.mjs. Runs the whole
// per-assistant-turn tool phase: intra-turn duplicate pre-pass, the serial
// call loop (eager-result collection, cross-turn dedup, repeat-failure guard,
// cache read/write, lossless offload, hooks, envelope newMessages), the
// per-batch newMessages flush, PostToolBatch hook, and completion-first
// steering. Mutable counters (dedupStubTotal/editCount) are threaded in/out;
// crossTurnCalls/epoch/pending mutate by reference. Behavior identical.
import { resolve as resolvePath, isAbsolute } from 'path';
import { canonicalizeBuiltinToolName, isBuiltinTool } from '../tools/builtin.mjs';
import { takeApplyPatchUiDiff } from '../tools/patch.mjs';
import {
    appendAgentTrace,
    traceAgentShellOutput,
    traceAgentTool,
    traceAgentToolFailure,
    traceAgentToolOutput,
} from '../agent-trace.mjs';
import { markSessionToolCall, updateSessionStage } from './manager.mjs';
import { resolveToolSelfDeadlineMs } from '../agent-runtime/agent-progress-watchdog.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { isOffloadedToolResultText, maybeOffloadToolResultBatch } from './tool-result-offload.mjs';
import {
    tryReadCached, setReadCached, invalidatePathForSession,
    clearReadDedupSession, extractTouchedPathsFromPatch,
    tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession,
    clearScopedToolsForSessionPaths, invalidatePrefetchCache,
} from './read-dedup.mjs';
import { isInvalidToolArgsMarker, formatInvalidToolArgsResult } from '../providers/openai-compat-stream.mjs';
import {
    _stripMcpPrefix, _isReadTool, _isMutationTool, _isScopedCacheableTool,
    _isShellTool, _intraTurnSig, _argShapeSig, _isToolArgShapeFailure,
} from './loop/tool-classify.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { crossTurnSignature, crossTurnDedupStub, isEditProgressTool } from './loop/completion-guards.mjs';
import {
    getToolKind,
    isEagerDispatchable,
    isParallelDispatchable,
    isToolCallDedupEligible,
    parseNativeToolSearchPayload,
} from './loop/tool-helpers.mjs';
import { restoreToolCallBodyForId } from './loop/stored-tool-args.mjs';

function classifyToolReturn(value) {
    const normalized = normalizeToolEnvelope(value);
    return classifyResultKind(normalized.result, normalized.explicitSuccess);
}

// Tools that publish the per-call mutation UI diff side channel (see
// takeApplyPatchUiDiff): apply_patch plus the edit dialect and its foreign
// str-replace aliases adapted by external-tool-adapters.
const _MUTATION_UI_DIFF_TOOLS = new Set([
    'apply_patch', 'edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace',
]);

export async function processToolBatch(ctx) {
    const {
        calls, messages, tools, cwd, sessionId, sessionRef, signal, opts,
        iterations, assistantTurnMsg, pending, epoch, startEagerRun,
        crossTurnCalls, crossTurnCap, sessionAgent,
        pushToolResultMessage, throwIfAborted, repeatFailLimit,
    } = ctx;
    const executeToolFn = typeof ctx.executeToolFn === 'function' ? ctx.executeToolFn : executeTool;
    let dedupStubTotal = ctx.dedupStubTotal;
    let editCount = ctx.editCount;
    const turnModel = assistantTurnMsg?.meta?.transcript?.model || sessionRef?.model || null;
        // Execute each tool and append results.
        //
        // Intra-turn duplicate suppression: when an LLM emits two tool_use
        // blocks with identical (name, args) inside the SAME assistant turn,
                // re-executing wastes tokens. Restricted to tools with
                // `readOnlyHint:true` plus result-dedup eligibility — loader calls
                // are read-only-dispatchable but must execute to report state.
        // Pre-pass identifies duplicates BEFORE startEagerRun so eager
        // dispatch also skips them, not just the for-body.
        const _duplicateCallIds = new Set();
        const _dupFirstId = new Map();
        {
            const _firstIdBySig = new Map();
            for (const c of calls) {
                if (!c?.id) continue;
                if (!isToolCallDedupEligible(c.name, tools)) {
                    _firstIdBySig.clear();
                    continue;
                }
                const sig = _intraTurnSig(c.name, c.arguments);
                const first = _firstIdBySig.get(sig);
                if (first === undefined) {
                    _firstIdBySig.set(sig, c.id);
                } else {
                    _duplicateCallIds.add(c.id);
                    _dupFirstId.set(c.id, first);
                }
            }
        }
        // One-shot sequential occupation for same-anchor edit batches: when
        // one assistant turn issues N `edit` calls with the SAME
        // file_path+old_string (replace_all=false) and N DISTINCT new_strings,
        // the batch as a whole is unambiguous — deterministic intent is
        // "k-th call → k-th occurrence in document order", the same contract
        // apply_patch hunks already have. Members are serialized by the eager
        // editBarrier; the serial body below re-executes an ambiguity-rejected
        // member with the remaining-occurrence count and the str-replace
        // adapter consumes the FIRST remaining occurrence. A single ambiguous
        // call (no batch siblings) keeps the strict reject.
        const _editSeqGroups = new Map();
        {
            const _counts = new Map();
            for (const c of calls) {
                if (!isBuiltinTool(c?.name) || canonicalizeBuiltinToolName(c.name) !== 'edit') continue;
                const a = c?.arguments;
                if (!a || typeof a.file_path !== 'string' || typeof a.old_string !== 'string') continue;
                const _replaceAll = a.replace_all === true || String(a.replace_all || '').toLowerCase() === 'true';
                if (!a.old_string || _replaceAll) continue;
                const key = `${a.file_path}\u0000${a.old_string}`;
                const group = _counts.get(key) || { total: 0, newStrings: new Set() };
                group.total += 1;
                group.newStrings.add(String(a.new_string ?? ''));
                _counts.set(key, group);
            }
            for (const [key, group] of _counts) {
                if (group.total >= 2 && group.newStrings.size === group.total) {
                    _editSeqGroups.set(key, { total: group.total, applied: 0 });
                }
            }
        }
        const _editSeqGroupFor = (c) => {
            if (_editSeqGroups.size === 0 || c?.name !== 'edit') return null;
            const a = c?.arguments;
            if (!a || typeof a.file_path !== 'string' || typeof a.old_string !== 'string') return null;
            return _editSeqGroups.get(`${a.file_path}\u0000${a.old_string}`) || null;
        };
        // R15: per-turn scalar read-count Map. Lifetime = this turn's tool-call batch.
        // Declared between the duplicate-detection block and the for-loop so it resets
        // Per-batch buffer for the general `newMessages` tool-result channel.
        // A tool MAY return a `{ __toolEnvelope, result, newMessages }` envelope;
        // its newMessages (e.g. the Skill SKILL.md body as a role:'user' message)
        // are collected here across EVERY call in this assistant turn and flushed
        // ONCE, AFTER the batch's last tool_result is pushed — never interleaved
        // between two tool results of the same multi-tool turn (which would put a
        // user message between tool(A) and tool(B) and break provider pairing).
        const _batchNewMessages = [];
        // Finalize together after execution so the message-level output budget
        // can select the largest non-Read results before cache/history/UI see
        // any body.
        const _batchCompleted = [];
        const _batchToolResultByCallId = new Map();
        const _batchToolResultsWithoutId = [];
        const _stageToolResultMessage = (message) => {
            if (message?.toolCallId) _batchToolResultByCallId.set(message.toolCallId, message);
            else _batchToolResultsWithoutId.push(message);
        };
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (isBuiltinTool(call.name)) {
                call.name = canonicalizeBuiltinToolName(call.name);
            }
            // Per-call cross-turn signature, computed at most once (lazily, only
            // when the call is eager — both consumer sites are eager-gated).
            let _ctSig = null;
            if (_duplicateCallIds.has(call.id)) {
                const _firstId = _dupFirstId.get(call.id);
                const _stub = `[intra-turn-dedup] identical read-only \`${call.name}\` call was already executed in this same assistant turn as tool_use_id=${_firstId}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.`;
                _stageToolResultMessage({
                    role: 'tool',
                    content: _stub,
                    toolCallId: call.id,
                    // Explicitly NOT a success: no tool executed for this call.
                    // 'skipped' keeps the transcript/UI non-error (a benign
                    // dedup, not a failure) while the unresolved-tool-failure
                    // stop hook refuses to count it as the executed success
                    // that would resolve a prior failure.
                    toolKind: 'skipped',
                });
                continue;
            }
            // Cross-turn identical-call stub (Step 2): a SUCCESSFUL read-only
            // dedup-eligible call whose (name,args) signature already ran
            // in an EARLIER turn is not re-executed — its result is unchanged and
            // already in context. Warn at the 2nd occurrence; append the "stuck"
            // escalation tail once the session has emitted 5+ dedup stubs total.
            // Never applies to write/bash/MCP/skill tools (not eager-dispatchable).
            if (isToolCallDedupEligible(call.name, tools)) {
                _ctSig = crossTurnSignature(call.name, call.arguments);
                const _prior = crossTurnCalls.get(_ctSig);
                if (_prior && _prior.firstIteration < iterations) {
                    _prior.count += 1;
                    dedupStubTotal += 1;
                    const _stub = crossTurnDedupStub(call.name, _prior.firstIteration, dedupStubTotal >= 5);
                    _stageToolResultMessage({
                        role: 'tool',
                        content: _stub,
                        toolCallId: call.id,
                        // Same rule as the intra-turn stub above: the earlier
                        // result is replayed from context, nothing executed, so
                        // this can never resolve a prior tool failure.
                        toolKind: 'skipped',
                    });
                    try {
                        appendAgentTrace({
                            sessionId,
                            iteration: iterations,
                            kind: 'steer',
                            payload: {
                                tag: 'cross_turn_dedup',
                                tool: call.name,
                                occurrence: _prior.count,
                                first_iteration: _prior.firstIteration,
                                dedup_stub_total: dedupStubTotal,
                            },
                            agent: sessionAgent || null,
                        });
                    } catch { /* best-effort */ }
                    continue;
                }
            }
            // Cross-iteration repeat-failure guard. Distinct from the
            // intra-turn dedup above (which spans ONE assistant turn and
            // resets every turn): when the model re-issues an IDENTICAL
            // (name,args) call that has already failed repeatFailLimit times
            // in a row across iterations, stop re-executing — the result will
            // not change, and each retry burns a full (often slow) LLM
            // round-trip until the hard iteration cap.
            const _repeatFailSig = _intraTurnSig(call.name, call.arguments);
            const _repeatArgShapeSig = _argShapeSig(call.name, call.arguments);
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _repeatFailSig && _rfg.count >= repeatFailLimit) {
                    _stageToolResultMessage({
                        role: 'tool',
                        content: `[repeat-failure-guard] Identical \`${call.name}\` call failed ${_rfg.count} times; not re-executed. Retry only after its inputs or subject change; otherwise leave it unresolved.`,
                        toolCallId: call.id,
                        // The call is still unresolved; the guard only skips
                        // re-execution and must not read as success.
                        toolKind: 'error',
                    });
                    continue;
                }
            }
            {
                const _afg = sessionRef?._repeatArgShapeFailGuard;
                if (_afg && _afg.sig === _repeatArgShapeSig && _afg.count >= repeatFailLimit) {
                    _stageToolResultMessage({
                        role: 'tool',
                        content: `[repeat-argument-shape-guard] Equivalent malformed \`${call.name}\` arguments failed validation ${_afg.count} times; not re-executed. Correct required fields or types before retrying.`,
                        toolCallId: call.id,
                        toolKind: 'error',
                    });
                    continue;
                }
            }
            if (sessionId) markSessionToolCall(sessionId, call.name, resolveToolSelfDeadlineMs(call.name, call.arguments));
            let dispatchStartedAt = Date.now();
            let executionStartedAt;
            let result;
            let toolStartedAt;
            let toolEndedAt;
            let _localSearchTelemetry = null;
            let _resultTelemetry = {};
            const toolKind = getToolKind(call.name);
            // Cross-turn read dedup: if the path's stat tuple (mtime/size/ino/dev)
            // is unchanged since a prior read in THIS session, return the cached
            // body instead of executing. Both scalar and array/object-array path
            // forms are cached — keyed by (abs, offset, limit, mode, n) per entry.
            //
            // Scoped-tool cache (grep/glob/list + graph lookups): same idea
            // but keyed by (toolName, canonical args) without per-file stat.
            // These tools scan many files so a single stat tuple cannot cover
            // them. The scoped cache registers dependency roots and write-class
            // tools evict entries whose root contains the touched path.
            let _readCacheHit = null;
            let _scopedCacheHit = null;
            let _executeOk = false;
            let _resultKind = 'normal';
            // Invalid-args guard (native convergence): the provider parser tags
            // a tool call whose arguments JSON could not be parsed with an
            // invalid-args marker instead of throwing or swallowing to {}.
            // Such a call must NOT execute — there are no usable arguments and
            // permission/cache checks are meaningless. Skip straight to the
            // error-feedback path so the model gets an is_error tool_result and
            // re-issues the call with valid JSON in the same turn.
            const _invalidArgs = isInvalidToolArgsMarker(call.arguments);
            if (_invalidArgs) {
                // no cache lookup for an un-parseable call
            } else if (sessionId && _isReadTool(call.name)) {
                _readCacheHit = tryReadCached({ sessionId, args: call.arguments, cwd });
            } else if (sessionId && _isScopedCacheableTool(call.name)) {
                _scopedCacheHit = tryScopedToolCached({ sessionId, toolName: _stripMcpPrefix(call.name), args: call.arguments, cwd });
            }
            try {
                if (_invalidArgs) {
                    toolStartedAt = Date.now();
                    executionStartedAt = toolStartedAt;
                    toolEndedAt = toolStartedAt;
                    result = formatInvalidToolArgsResult(call);
                    _resultKind = 'error';
                    _executeOk = false;
                } else if (_readCacheHit !== null) {
                    toolStartedAt = Date.now();
                    executionStartedAt = toolStartedAt;
                    toolEndedAt = toolStartedAt;
                    const _body = _readCacheHit.content;
                    // Return the cached body byte-for-byte instead of a
                    // human-readable cache marker. The marker made public
                    // agents treat a successful cached read as a
                    // meta instruction and repeat the same read loop.
                    result = _body;
                    _resultKind = 'cache-hit';
                    _executeOk = true;
                } else if (_scopedCacheHit !== null) {
                    toolStartedAt = Date.now();
                    executionStartedAt = toolStartedAt;
                    toolEndedAt = toolStartedAt;
                    const _body = _scopedCacheHit.content;
                    result = _body;
                    _resultKind = 'scoped-cache-hit';
                    _executeOk = true;
                } else {
                // Fallback for providers that don't stream tool calls early:
                // dispatch the whole remaining batch. The eager dispatcher
                // keeps independent calls parallel while making shell wait
                // for earlier apply_patch calls.
                if (isParallelDispatchable(call.name)) {
                    startEagerRun(calls, callIndex, _duplicateCallIds);
                }
                let eager = pending.get(call.id);
                // Post-mutation invalidation applies ONLY to read-only results:
                // a read that raced an apply_patch re-executes for fresh
                // content. Non-read-only parallel calls (shell/MCP/...) already
                // ran — their side effects are real, so their results are
                // consumed as-is and NEVER re-executed.
                if (eager !== undefined && eager.mutationEpoch < epoch.mutation && isEagerDispatchable(call.name, tools)) {
                    pending.delete(call.id);
                    eager = undefined;
                }
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    dispatchStartedAt = eager.dispatchStartedAt ?? eager.startedAt;
                    executionStartedAt = eager.executionStartedAt ?? eager.endedAt;
                    _localSearchTelemetry = eager.localSearchTelemetry || null;
                    _resultTelemetry = eager.resultTelemetry || {};
                    const settled = await eager.promise;
                    if (!settled.ok) throw settled.error;
                    result = settled.value;
                    toolEndedAt = eager.endedAt ?? Date.now();
                    if (settled.skipped) {
                        _resultKind = 'skipped';
                        _executeOk = false;
                    } else {
                        const _eagerKind = classifyToolReturn(result);
                        if (_eagerKind === 'error') {
                            _resultKind = 'error';
                            _executeOk = false;
                        } else {
                            _executeOk = true;
                        }
                    }
                } else {
                    toolStartedAt = Date.now();
                    // Runtime pre-dispatch deny. Schema profiles may hide
                    // tools for routing efficiency, but this remains the
                    // control-plane boundary for any tool_use that still
                    // reaches the loop. preDispatchDenyForSession is the SHARED helper
                    // used by both the eager dispatch path (startEagerTool)
                    // and this serial path — keeps the agent-owned control-
                    // plane reject and no-tool role guards consistent across
                    // both paths.
                    const _denyMsg = preDispatchDenyForSession(sessionRef, call, toolKind);
                    if (_denyMsg !== null) {
                        executionStartedAt = toolStartedAt;
                        result = _denyMsg;
                        toolEndedAt = Date.now();
                        _resultKind = 'error';
                    } else {
                        await opts.beforeToolExecution?.();
                        executionStartedAt = Date.now();
                        _localSearchTelemetry = {};
                        result = await executeToolFn(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: iterations, localSearchTelemetry: _localSearchTelemetry, resultTelemetry: _resultTelemetry });
                        toolEndedAt = Date.now();
                        // Boundary: tool-return string convention → structural kind.
                        // The only prefix check in this codebase; downstream layers
                        // operate on _resultKind.
                        if (classifyToolReturn(result) === 'error') {
                            _resultKind = 'error';
                            _executeOk = false;
                        } else {
                            _executeOk = true;
                        }
                        // _resultKind stays 'normal' when tool returned a non-error string.
                    }
                }
                } // close: else branch of _readCacheHit check
            }
            catch (err) {
                if (toolStartedAt === undefined) toolStartedAt = Date.now();
                if (executionStartedAt === undefined) executionStartedAt = toolStartedAt;
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                _resultKind = 'error';
            }
            // Same-anchor batch occupation retry (_editSeqGroups above): an
            // ambiguity-rejected member of a known batch group re-executes once
            // in call order. With 2+ occurrences remaining it passes the
            // remaining count so the adapter deterministically consumes the
            // first one; with exactly 1 remaining (earlier members already
            // consumed theirs) a plain re-run resolves through the normal
            // unique path. The eager results being retried were computed
            // before earlier members applied, so re-execution is safe: a
            // rejected edit had no side effects.
            if (_resultKind === 'error' && typeof result === 'string'
                && /old_string found \d+ times/.test(result)) {
                const _group = _editSeqGroupFor(call);
                const _remaining = _group ? _group.total - _group.applied : 0;
                if (_group && _remaining >= 1) {
                    try {
                        const _retry = await executeToolFn(call.name, call.arguments, cwd, sessionId, sessionRef, {
                            toolCallId: call.id,
                            signal,
                            notifyFn: opts.notifyFn,
                            toolApprovalHook: opts.onToolApproval,
                            iteration: iterations,
                            localSearchTelemetry: _localSearchTelemetry || {},
                            resultTelemetry: _resultTelemetry,
                            ...(_remaining >= 2 ? { editOccurrence: { expected: _remaining } } : {}),
                        });
                        if (classifyToolReturn(_retry) !== 'error') {
                            result = _retry;
                            _resultKind = 'normal';
                            _executeOk = true;
                            toolEndedAt = Date.now();
                            // Mirror the eager mutation epoch: later read-only
                            // eager results computed against pre-edit content
                            // must re-execute.
                            epoch.mutation += 1;
                        }
                    } catch { /* keep the original ambiguity error */ }
                }
            }
            if (_executeOk && _resultKind !== 'skipped') {
                const _group = _editSeqGroupFor(call);
                if (_group) _group.applied += 1;
            }
            // CENTRAL ENVELOPE NORMALIZE (general newMessages channel).
            // executeTool (serial + eager) and cache/error paths above all
            // funnel into `result`. Split ONCE here: downstream post-processing
            // (classifyResultKind / maybeOffloadToolResult /
            // traceAgentTool / cache writes / messages.push) sees ONLY the
            // model-visible `result`; the `newMessages` ride a per-batch buffer
            // flushed after the batch's last tool_result (never interleaved).
            {
                const _env = normalizeToolEnvelope(result);
                result = _env.result;
                if (_env.newMessages.length) _batchNewMessages.push(..._env.newMessages);
            }
            // Bounded-map cleanup: a scoped-cache outcome recorded for this call.id
            // (via _scopedCacheOutcomeForCall) is only ever consumed/deleted on the
            // success path below (_executeOk && _resultKind==='normal'). A failed or
            // errored call would otherwise leak its entry in
            // sessionRef._scopedCacheOutcomeByCallId forever — reclaim it here.
            if (sessionRef?._scopedCacheOutcomeByCallId instanceof Map && call?.id && (!_executeOk || _resultKind === 'error')) {
                sessionRef._scopedCacheOutcomeByCallId.delete(call.id);
            }
            // PostToolUseFailure: a tool that resolved to a failure (thrown-error
            // path -> `Error:` string, or an is_error result classified as
            // 'error') fires the optional session failure hook. Same shape as
            // afterToolHook; `result` carries the error text. Best-effort — a
            // hook error must never wedge the tool loop.
            if (_resultKind !== 'skipped' && (!_executeOk || _resultKind === 'error')) {
                const _afterToolFailureHook = typeof opts.afterToolFailureHook === 'function'
                    ? opts.afterToolFailureHook
                    : sessionRef?.afterToolFailureHook;
                if (typeof _afterToolFailureHook === 'function') {
                    try {
                        await _afterToolFailureHook({
                            name: call.name,
                            args: call.arguments,
                            cwd,
                            sessionId,
                            toolCallId: call.id,
                            result: typeof result === 'string' ? result : String(result ?? ''),
                        });
                    } catch { /* best-effort: PostToolUseFailure hook must never break the loop */ }
                }
            }
            // Update the cross-iteration repeat-failure guard with this call's
            // outcome: bump the consecutive-failure count for an identical
            // signature, or clear the chain on ANY success. A successful
            // different tool is the requested "change approach" and may have
            // mutated the inputs/environment (apply_patch → verification is
            // the common case), so retaining the old failure count would no
            // longer describe consecutive failures.
            if (sessionRef && _resultKind !== 'skipped') {
                const _failed = !_executeOk || _resultKind === 'error';
                if (_failed) {
                    sessionRef._repeatFailGuard = (sessionRef._repeatFailGuard?.sig === _repeatFailSig)
                        ? { sig: _repeatFailSig, count: sessionRef._repeatFailGuard.count + 1 }
                        : { sig: _repeatFailSig, count: 1 };
                } else {
                    sessionRef._repeatFailGuard = null;
                }
                if (_failed && _isToolArgShapeFailure(result)) {
                    sessionRef._repeatArgShapeFailGuard = (sessionRef._repeatArgShapeFailGuard?.sig === _repeatArgShapeSig)
                        ? { sig: _repeatArgShapeSig, count: sessionRef._repeatArgShapeFailGuard.count + 1 }
                        : { sig: _repeatArgShapeSig, count: 1 };
                } else {
                    sessionRef._repeatArgShapeFailGuard = null;
                }
            }
            // A failed executed call keeps its FULL argument body in history so the
            // model can retry against the original (a large apply_patch `patch`
            // would otherwise be hidden behind a
            // `[mixdog compacted …]` placeholder). Restored IMMEDIATELY — not at end
            // of loop — so an abort or post-processing throw after this point cannot
            // leave a failed patch compacted. Cache-safe: assistantTurnMsg is not
            // transmitted until the next provider.send. Early-continue paths (dedup /
            // repeat-failure-guard) never reach here and stay compacted.
            if (_resultKind !== 'skipped' && (!_executeOk || _resultKind === 'error') && call?.id) {
                restoreToolCallBodyForId(assistantTurnMsg, calls, call.id);
            }
            // Cross-turn cache maintenance — gate on both _executeOk and _resultKind==='normal'.
            // _executeOk=false catches permission-blocked / catch-path / partial-fail results.
            // _resultKind==='normal' ensures cache-hit refs are never re-stored (structural,
            // no prefix sniffing).
            // NOTE: setReadCached / setScopedToolCached are deferred below (after
            // lossless offload) so the cache holds the same content as conversation
            // history. Cache-hit refs point to a tool_use_id whose message body matches
            // exactly what's stored — no phantom full body.
            if (sessionId && _executeOk && _resultKind === 'normal') {
                const _toolBare = _stripMcpPrefix(call.name);
                if (_toolBare === 'apply_patch') {
                    // apply_patch's args are a unified-diff text in `patch`
                    // (resolved against `base_path` or cwd). Parse the diff
                    // headers (`--- a/path` / `+++ b/path`) to extract the
                    // touched paths and invalidate each one. Falls
                    // back to a full session clear only when no paths could
                    // be parsed (malformed diff or unknown format).
                    const _argsBase = call.arguments?.base_path;
                    const _patchBase = (typeof _argsBase === 'string' && _argsBase.length > 0)
                        ? (isAbsolute(_argsBase) ? _argsBase : resolvePath(cwd || process.cwd(), _argsBase))
                        : (cwd || process.cwd());
                    const _touched = extractTouchedPathsFromPatch(call.arguments?.patch);
                    if (_touched.length > 0) {
                        for (const _p of _touched) {
                            invalidatePathForSession(sessionId, _p, _patchBase);
                            // R20: cross-dispatch prefetch cache invalidation.
                            invalidatePrefetchCache(_p, _patchBase);
                        }
                    } else {
                        clearReadDedupSession(sessionId);
                        // R20: path unknown — can't target; no-op on prefetch cache
                        // (stat-validation at lookup time will naturally reject stale entries).
                    }
                    // Targeted scoped-cache invalidation: only evict entries whose
                    // dep paths intersect the touched set. Full wipe is the fallback
                    // when no paths were extracted (D).
                    if (_touched.length > 0) {
                        clearScopedToolsForSessionPaths(sessionId, _touched, _patchBase);
                    } else {
                        clearScopedToolsForSession(sessionId);
                    }
                }
            } // end _executeOk+_resultKind gate (scoped tool cache set)
            // E: mutation tools (apply_patch) must invalidate caches
            // even on returned-error/partial-fail — the file state is unknown after
            // an error exit, and some tools report failure as an Error: result string
            // rather than throwing.
            // This block runs unconditionally (not gated on _executeOk or _resultKind).
            if (sessionId && (!_executeOk || _resultKind === 'error') && _stripMcpPrefix(call.name) === 'apply_patch') {
                clearReadDedupSession(sessionId);
                // Scoped caches (grep/glob/list/code_graph) are refreshed only in
                // the success-gated block above, so a FAILED/errored patch would
                // otherwise leave later non-mutation tools in this batch reading
                // stale scoped-cache entries for the (possibly partially-written)
                // files. Invalidate targeted paths when the diff parses, else full
                // wipe — file state is unknown after an error exit.
                const _failBaseArg = call.arguments?.base_path;
                const _failBase = (typeof _failBaseArg === 'string' && _failBaseArg.length > 0)
                    ? (isAbsolute(_failBaseArg) ? _failBaseArg : resolvePath(cwd || process.cwd(), _failBaseArg))
                    : (cwd || process.cwd());
                const _failTouched = extractTouchedPathsFromPatch(call.arguments?.patch);
                if (_failTouched.length > 0) {
                    clearScopedToolsForSessionPaths(sessionId, _failTouched, _failBase);
                    for (const _p of _failTouched) invalidatePrefetchCache(_p, _failBase);
                } else {
                    clearScopedToolsForSession(sessionId);
                }
            }
            if (_isMutationTool(call.name)) {
                epoch.mutation += 1;
            }
            // Bash always clears scoped cache UNCONDITIONALLY — a mutating bash
            // that throws or fails partway can still leave stale find_symbol / grep entries.
            // Must not be gated on _executeOk or _resultKind.
            if (sessionId && _isShellTool(call.name) && _resultKind !== 'skipped') {
                clearScopedToolsForSession(sessionId);
            }
            _batchCompleted.push({
                call,
                result,
                dispatchStartedAt,
                executionStartedAt,
                toolStartedAt,
                toolEndedAt,
                toolKind,
                resultKind: _resultKind,
                executeOk: _executeOk,
                readCacheHit: _readCacheHit,
                scopedCacheHit: _scopedCacheHit,
                localSearchTelemetry: _localSearchTelemetry,
                resultTelemetry: _resultTelemetry,
                crossTurnSig: _ctSig,
                mutationEpoch: epoch.mutation,
                nativeToolSearch: null,
                postError: null,
            });
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
        }
        for (const completed of _batchCompleted) {
            try {
                completed.nativeToolSearch = parseNativeToolSearchPayload(completed.call.name, completed.result);
                if (completed.nativeToolSearch?.summary) completed.result = completed.nativeToolSearch.summary;
            } catch (error) {
                completed.postError = error;
            }
        }
        let _offloadStates;
        try {
            _offloadStates = await maybeOffloadToolResultBatch(
                sessionId,
                _batchCompleted.map((completed) => ({
                    toolCallId: completed.call.id,
                    toolName: _stripMcpPrefix(completed.call.name),
                    result: completed.postError ? null : completed.result,
                })),
            );
        } catch (error) {
            _offloadStates = _batchCompleted.map(() => ({ result: null, error }));
        }
        // Assistant-message pipeline: lossless offload → trace → cache →
        // push. The cache and transcript therefore receive the same body.
        for (let completedIndex = 0; completedIndex < _batchCompleted.length; completedIndex += 1) {
            const completed = _batchCompleted[completedIndex];
            const {
                call, dispatchStartedAt, executionStartedAt, toolStartedAt, toolEndedAt, toolKind,
                executeOk: _executeOk, resultKind: _resultKind,
                readCacheHit: _readCacheHit, scopedCacheHit: _scopedCacheHit,
            } = completed;
            const postprocessStartedAt = Date.now();
            let _ctSig = completed.crossTurnSig;
            let result = completed.result;
            const _nativeToolSearch = completed.nativeToolSearch;
            try {
                if (completed.postError) throw completed.postError;
                if (_offloadStates[completedIndex]?.error) throw _offloadStates[completedIndex].error;
                const _preOffloadBytes = typeof completed.result === 'string'
                    ? Buffer.byteLength(completed.result, 'utf8')
                    : 0;
                result = _offloadStates[completedIndex]?.result;
                const _offloaded = isOffloadedToolResultText(result);
                const _postOffloadBytes = typeof result === 'string'
                    ? Buffer.byteLength(result, 'utf8')
                    : 0;
                if (_isShellTool(call.name)) {
                    traceAgentShellOutput({
                        sessionId,
                        toolName: call.name,
                        toolCallId: call.id,
                        telemetry: completed.resultTelemetry,
                        preOffloadBytes: _preOffloadBytes,
                        postOffloadBytes: _postOffloadBytes,
                        modelVisibleBytes: typeof result === 'string' ? Buffer.byteLength(result, 'utf8') : 0,
                        offloaded: _offloaded,
                        resultKind: _resultKind,
                    });
                } else if (_offloaded) {
                    traceAgentToolOutput({
                        sessionId,
                        toolName: call.name,
                        toolCallId: call.id,
                        preOffloadBytes: _preOffloadBytes,
                        postOffloadBytes: _postOffloadBytes,
                        modelVisibleBytes: _postOffloadBytes,
                        offloaded: true,
                        resultKind: _resultKind,
                    });
                }
                traceAgentTool({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt - toolStartedAt,
                    toolArgs: call.arguments,
                    agent: sessionRef?.agent || null,
                    model: turnModel,
                    resultKind: _resultKind,
                    resultText: result,
                    localSearchTelemetry: completed.localSearchTelemetry,
                    cwd,
                });
                // Deferred writes that predate a later mutation are skipped;
                // immediate writes used to be invalidated by that mutation.
                const _outcomeMap = sessionRef?._scopedCacheOutcomeByCallId instanceof Map
                    ? sessionRef._scopedCacheOutcomeByCallId : null;
                if (sessionId && _executeOk && _resultKind === 'normal' && completed.mutationEpoch === epoch.mutation) {
                    if (_scopedCacheHit === null && _isScopedCacheableTool(call.name)) {
                        const _outcome = _outcomeMap?.get(call.id);
                        setScopedToolCached({
                            sessionId,
                            toolName: _stripMcpPrefix(call.name),
                            args: call.arguments,
                            cwd,
                            content: result,
                            toolUseId: call.id,
                            complete: _outcome ? _outcome.complete : true,
                        });
                    }
                    if (_readCacheHit === null && _isReadTool(call.name)) {
                        setReadCached({ sessionId, args: call.arguments, cwd, content: result, toolUseId: call.id });
                    }
                }
                // A successful scoped lookup from before a later mutation is
                // intentionally not cached, but its per-call completeness
                // record still has to be reclaimed.
                if (_scopedCacheHit === null && _isScopedCacheableTool(call.name)) {
                    _outcomeMap?.delete(call.id);
                }
                // Both edit dialects publish the same per-call UI diff side
                // channel: apply_patch via registerCommittedPatchUiDiff, edit
                // (and its foreign str-replace aliases) via recordEditUiDiff.
                const _applyPatchUiDiff = _MUTATION_UI_DIFF_TOOLS.has(_stripMcpPrefix(call.name))
                    ? takeApplyPatchUiDiff(call.id)
                    : null;
                const resultCompletedAt = Date.now();
                _stageToolResultMessage({
                    role: 'tool',
                    content: result,
                    toolCallId: call.id,
                    toolKind: _resultKind,
                    toolTiming: {
                        dispatchStartedAt,
                        executionStartedAt: executionStartedAt ?? toolStartedAt,
                        executionCompletedAt: toolEndedAt,
                        postprocessStartedAt,
                        resultCompletedAt,
                    },
                    ...(_nativeToolSearch ? { nativeToolSearch: _nativeToolSearch } : {}),
                    ...(_applyPatchUiDiff !== null ? { uiDiff: _applyPatchUiDiff } : {}),
                });
                if (_executeOk) {
                    const _isEager = isEagerDispatchable(call.name, tools);
                    if (isToolCallDedupEligible(call.name, tools)) {
                        if (_ctSig === null) _ctSig = crossTurnSignature(call.name, call.arguments);
                        if (!crossTurnCalls.has(_ctSig)) {
                            crossTurnCalls.set(_ctSig, { count: 1, firstIteration: iterations });
                            if (crossTurnCalls.size > crossTurnCap) {
                                const _oldest = crossTurnCalls.keys().next().value;
                                crossTurnCalls.delete(_oldest);
                            }
                        }
                    } else if (!_isEager && isEditProgressTool(call.name, false)) {
                        crossTurnCalls.clear();
                        editCount += 1;
                    }
                }
            } catch (postErr) {
                if (_executeOk && !isEagerDispatchable(call.name, tools) && isEditProgressTool(call.name, false)) {
                    crossTurnCalls.clear();
                    editCount += 1;
                }
                if (sessionRef?._scopedCacheOutcomeByCallId instanceof Map && call?.id) {
                    sessionRef._scopedCacheOutcomeByCallId.delete(call.id);
                }
                if (call?.id) restoreToolCallBodyForId(assistantTurnMsg, calls, call.id);
                const _postMsg = `Error: tool result post-processing failed for "${call.name}": ${postErr instanceof Error ? postErr.message : String(postErr)}`;
                traceAgentToolFailure({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt && toolStartedAt ? toolEndedAt - toolStartedAt : null,
                    toolArgs: call.arguments,
                    agent: sessionRef?.agent || null,
                    model: turnModel,
                    cwd,
                    resultText: _postMsg,
                    resultKind: 'error',
                });
                const resultCompletedAt = Date.now();
                _stageToolResultMessage({
                    role: 'tool',
                    content: _postMsg,
                    toolCallId: call.id,
                    toolKind: 'error',
                    toolTiming: {
                        dispatchStartedAt,
                        executionStartedAt: executionStartedAt ?? toolStartedAt,
                        executionCompletedAt: toolEndedAt,
                        postprocessStartedAt,
                        resultCompletedAt,
                    },
                });
            }
            throwIfAborted();
        }
        // Early dedup/guard skips and deferred execution results share this
        // ordered flush so provider tool_result blocks always follow the
        // assistant's original tool_use order.
        for (const call of calls) {
            const message = _batchToolResultByCallId.get(call?.id);
            if (message) pushToolResultMessage(message);
        }
        for (const message of _batchToolResultsWithoutId) {
            pushToolResultMessage(message);
        }
        // Flush the per-batch newMessages channel. All tool_results for this
        // assistant turn are now pushed; appending the injected role:'user'
        // messages here (AFTER the last tool_result, BEFORE the next provider
        // send) keeps provider pairing valid — no user message is interleaved
        // between tool(A) and tool(B). pre-send repairTranscriptBeforeProviderSend
        // normalizes any residual ordering. The injected messages carry their
        // own meta flag (e.g. meta:'skill') so compaction's latest-human-prompt
        // selection does not mistake them for the user's request.
        for (const _nm of _batchNewMessages) {
            if (!_nm || _nm.role !== 'user' || typeof _nm.content !== 'string' || !_nm.content) continue;
            messages.push({ role: 'user', content: _nm.content, ...(_nm.meta ? { meta: _nm.meta } : {}) });
        }
        // PostToolBatch: the full parallel batch of tool calls for this
        // assistant turn has resolved and all tool_results are pushed. Fire the
        // optional session hook before the next model call. No matcher event.
        // Block support: if the hook returns blocked===true, inject its reason
        // as a system-note user message for the next send (natural mechanism —
        // same channel the newMessages flush just used). Best-effort otherwise.
        {
            const _afterToolBatchHook = typeof opts.afterToolBatchHook === 'function'
                ? opts.afterToolBatchHook
                : sessionRef?.afterToolBatchHook;
            if (typeof _afterToolBatchHook === 'function' && calls.length > 0) {
                try {
                    const _batchDecision = await _afterToolBatchHook({
                        sessionId,
                        cwd,
                        toolCount: calls.length,
                    });
                    if (_batchDecision?.blocked === true) {
                        const _reason = String(_batchDecision.reason || 'PostToolBatch hook blocked continuation').trim();
                        if (_reason) {
                            messages.push({ role: 'user', content: `<system-reminder>\n${_reason}\n</system-reminder>`, meta: 'hook' });
                        }
                    }
                } catch { /* best-effort: PostToolBatch hook must never break the loop */ }
            }
        }
        // Mid-turn steering is drained at the next loop's pre-send point,
        // AFTER any auto-compact pass. Draining here would put the steering
        // user turn after the fresh tool results before compaction runs; then
        // semantic/recall compaction would treat those fresh tool results as
        // prior history before the model sees them.
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    return { dedupStubTotal, editCount };
}
