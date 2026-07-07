// Tool-call batch processor, extracted from agent-loop.mjs. Runs the whole
// per-assistant-turn tool phase: intra-turn duplicate pre-pass, the serial
// call loop (eager-result collection, cross-turn dedup, repeat-failure guard,
// cache read/write, offload/compress, hooks, envelope newMessages), the
// per-batch newMessages flush, PostToolBatch hook, and completion-first
// steering. Mutable counters (dedupStubTotal/editCount) are threaded in/out;
// crossTurnCalls/epoch/pending mutate by reference. Behavior identical.
import { resolve as resolvePath, isAbsolute } from 'path';
import { canonicalizeBuiltinToolName, isBuiltinTool } from '../tools/builtin.mjs';
import { takeApplyPatchUiDiff } from '../tools/patch.mjs';
import { compressToolResult } from '../tools/result-compression.mjs';
import { appendAgentTrace, traceAgentTool, traceAgentToolFailure } from '../agent-trace.mjs';
import { markSessionToolCall, updateSessionStage } from './manager.mjs';
import { resolveToolSelfDeadlineMs } from '../agent-runtime/agent-progress-watchdog.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import {
    tryReadCached, setReadCached, invalidatePathForSession, markPostEdit,
    consumePostEditMark, clearReadDedupSession, extractTouchedPathsFromPatch,
    tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession,
    clearScopedToolsForSessionPaths, invalidatePrefetchCache,
} from './read-dedup.mjs';
import { isInvalidToolArgsMarker, formatInvalidToolArgsResult } from '../providers/openai-compat-stream.mjs';
import {
    _stripMcpPrefix, _isReadTool, _isMutationTool, _isScopedCacheableTool,
    _isShellTool, _intraTurnSig,
} from './loop/tool-classify.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { crossTurnSignature, crossTurnDedupStub, isEditProgressTool } from './loop/completion-guards.mjs';
import { getToolKind, isEagerDispatchable, parseNativeToolSearchPayload } from './loop/tool-helpers.mjs';
import { restoreToolCallBodyForId, dropCompactedBodyArgsForId } from './loop/stored-tool-args.mjs';

export async function processToolBatch(ctx) {
    const {
        calls, messages, tools, cwd, sessionId, sessionRef, signal, opts,
        iterations, assistantTurnMsg, pending, epoch, startEagerRun,
        crossTurnCalls, crossTurnCap, sessionAgent, steeringLadder,
        pushToolResultMessage, throwIfAborted, repeatFailLimit,
    } = ctx;
    let dedupStubTotal = ctx.dedupStubTotal;
    let editCount = ctx.editCount;
        // Execute each tool and append results.
        //
        // Intra-turn duplicate suppression: when an LLM emits two tool_use
        // blocks with identical (name, args) inside the SAME assistant turn,
                // re-executing wastes tokens. Restricted to tools with
                // `readOnlyHint:true` (= isEagerDispatchable) — bash/apply_patch
                // may be intentional repeats with distinct side effects.
        // Pre-pass identifies duplicates BEFORE startEagerRun so eager
        // dispatch also skips them, not just the for-body.
        const _duplicateCallIds = new Set();
        const _dupFirstId = new Map();
        {
            const _firstIdBySig = new Map();
            for (const c of calls) {
                if (!c?.id) continue;
                if (!isEagerDispatchable(c.name, tools)) {
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
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (isBuiltinTool(call.name)) {
                call.name = canonicalizeBuiltinToolName(call.name);
            }
            if (_duplicateCallIds.has(call.id)) {
                const _firstId = _dupFirstId.get(call.id);
                const _stub = `[intra-turn-dedup] identical read-only \`${call.name}\` call was already executed in this same assistant turn as tool_use_id=${_firstId}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.`;
                pushToolResultMessage({
                    role: 'tool',
                    content: _stub,
                    toolCallId: call.id,
                });
                continue;
            }
            // Cross-turn identical-call stub (Step 2): a SUCCESSFUL read-only
            // (isEagerDispatchable) call whose (name,args) signature already ran
            // in an EARLIER turn is not re-executed — its result is unchanged and
            // already in context. Warn at the 2nd occurrence; append the "stuck"
            // escalation tail once the session has emitted 5+ dedup stubs total.
            // Never applies to write/bash/MCP/skill tools (not eager-dispatchable).
            if (isEagerDispatchable(call.name, tools)) {
                const _ctSig = crossTurnSignature(call.name, call.arguments);
                const _prior = crossTurnCalls.get(_ctSig);
                if (_prior && _prior.firstIteration < iterations) {
                    _prior.count += 1;
                    dedupStubTotal += 1;
                    const _stub = crossTurnDedupStub(call.name, _prior.firstIteration, dedupStubTotal >= 5);
                    pushToolResultMessage({
                        role: 'tool',
                        content: _stub,
                        toolCallId: call.id,
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
            // round-trip until the hard iteration cap. Steer it to change
            // approach instead.
            const _repeatFailSig = _intraTurnSig(call.name, call.arguments);
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _repeatFailSig && _rfg.count >= repeatFailLimit) {
                    pushToolResultMessage({
                        role: 'tool',
                        content: `[repeat-failure-guard] This exact \`${call.name}\` call (identical arguments) has already failed ${_rfg.count} times in a row; not re-executing because the result will not change. Change approach: use different arguments, a different tool, or skip this step.`,
                        toolCallId: call.id,
                    });
                    continue;
                }
            }
            if (sessionId) markSessionToolCall(sessionId, call.name, resolveToolSelfDeadlineMs(call.name, call.arguments));
            let result;
            let toolStartedAt;
            let toolEndedAt;
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
                    toolEndedAt = toolStartedAt;
                    result = formatInvalidToolArgsResult(call);
                    _resultKind = 'error';
                    _executeOk = false;
                } else if (_readCacheHit !== null) {
                    toolStartedAt = Date.now();
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
                    toolEndedAt = toolStartedAt;
                    const _body = _scopedCacheHit.content;
                    result = _body;
                    _resultKind = 'scoped-cache-hit';
                    _executeOk = true;
                } else {
                // Fallback for providers that don't stream tool calls early:
                // execute a contiguous read-only run in parallel, but never
                // cross a write/bash/MCP boundary that may change state.
                if (isEagerDispatchable(call.name, tools)) {
                    startEagerRun(calls, callIndex, _duplicateCallIds);
                }
                let eager = pending.get(call.id);
                if (eager !== undefined && eager.mutationEpoch < epoch.mutation) {
                    pending.delete(call.id);
                    eager = undefined;
                }
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    const settled = await eager.promise;
                    if (!settled.ok) throw settled.error;
                    result = settled.value;
                    toolEndedAt = eager.endedAt ?? Date.now();
                    const _eagerKind = classifyResultKind(result);
                    if (_eagerKind === 'error') {
                        _resultKind = 'error';
                        _executeOk = false;
                    } else {
                        _executeOk = true;
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
                        result = _denyMsg;
                        toolEndedAt = Date.now();
                        _resultKind = 'error';
                    } else {
                        result = await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: iterations });
                        toolEndedAt = Date.now();
                        // Boundary: tool-return string convention → structural kind.
                        // The only prefix check in this codebase; downstream layers
                        // operate on _resultKind.
                        if (classifyResultKind(result) === 'error') {
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
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                _resultKind = 'error';
            }
            // CENTRAL ENVELOPE NORMALIZE (general newMessages channel).
            // executeTool (serial + eager) and cache/error paths above all
            // funnel into `result`. Split ONCE here: downstream post-processing
            // (classifyResultKind / maybeOffloadToolResult / compressToolResult /
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
            if (!_executeOk || _resultKind === 'error') {
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
            // signature, or clear it the moment the same call succeeds.
            if (sessionRef) {
                const _failed = !_executeOk || _resultKind === 'error';
                if (_failed) {
                    sessionRef._repeatFailGuard = (sessionRef._repeatFailGuard?.sig === _repeatFailSig)
                        ? { sig: _repeatFailSig, count: sessionRef._repeatFailGuard.count + 1 }
                        : { sig: _repeatFailSig, count: 1 };
                } else if (sessionRef._repeatFailGuard?.sig === _repeatFailSig) {
                    sessionRef._repeatFailGuard = null;
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
            if ((!_executeOk || _resultKind === 'error') && call?.id) {
                restoreToolCallBodyForId(assistantTurnMsg, calls, call.id);
            }
            // Cross-turn cache maintenance — gate on both _executeOk and _resultKind==='normal'.
            // _executeOk=false catches permission-blocked / catch-path / partial-fail results.
            // _resultKind==='normal' ensures cache-hit refs are never re-stored (structural,
            // no prefix sniffing).
            // NOTE: setReadCached / setScopedToolCached are deferred below (after
            // compressToolResult) so the cache holds the same content as conversation
            // history. Cache-hit refs point to a tool_use_id whose message body matches
            // exactly what's stored — no phantom full body.
            if (sessionId && _executeOk && _resultKind === 'normal') {
                const _toolBare = _stripMcpPrefix(call.name);
                if (_readCacheHit === null && _isReadTool(call.name)) {
                    // Post-patch advisory: handle BOTH scalar and array forms
                    // of args.path. The array form (path:[a,b,c] or
                    // path:[{path:a},{path:b}]) was a coverage gap in R1 —
                    // an LLM that patches X then reads [X,Y] should still see
                    // the advisory for X.
                    const _argsPath = call.arguments?.path;
                    const _pathList = [];
                    if (typeof _argsPath === 'string') {
                        _pathList.push(_argsPath);
                    } else if (typeof call.arguments?.file_path === 'string') {
                        _pathList.push(call.arguments.file_path);
                    } else if (Array.isArray(_argsPath)) {
                        for (const _item of _argsPath) {
                            if (typeof _item === 'string') _pathList.push(_item);
                            else if (_item && typeof _item === 'object') {
                                const _itemPath = typeof _item.path === 'string' ? _item.path : _item.file_path;
                                if (typeof _itemPath === 'string') _pathList.push(_itemPath);
                            }
                        }
                    }
                    const _marks = [];
                    for (const _p of _pathList) {
                        const _m = consumePostEditMark({ sessionId, path: _p, cwd });
                        if (_m) _marks.push({ path: _p, mark: _m });
                    }
                } else if (_toolBare === 'apply_patch') {
                    // apply_patch's args are a unified-diff text in `patch`
                    // (resolved against `base_path` or cwd). Parse the diff
                    // headers (`--- a/path` / `+++ b/path`) to extract the
                    // touched paths and invalidate / mark each one. Falls
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
                            markPostEdit({ sessionId, path: _p, cwd: _patchBase, toolName: 'apply_patch' });
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
            }
            if (_isMutationTool(call.name)) {
                epoch.mutation += 1;
            }
            // Bash always clears scoped cache UNCONDITIONALLY — a mutating bash
            // that throws or fails partway can still leave stale find_symbol / grep entries.
            // Must not be gated on _executeOk or _resultKind.
            if (sessionId && _isShellTool(call.name)) {
                clearScopedToolsForSession(sessionId);
            }
            // R17 compression pipeline — correct ordering (compress → cache → push):
            //   1. compressToolResult: lossless ANSI/dedup/separator passes.
            //   2. setReadCached / setScopedToolCached: cache stores the SAME result that
            //      goes into conversation history. Cache-hit refs point to the tool_use_id
            //      whose message body matches — no phantom full body.
            //   3. offload → hint → message push.
            // Offload FIRST — before compress. Large RAW output goes to a disk sidecar
            // + ~2K preview before any in-place shrink (lossless compress) can reduce
            // it below the offload threshold and pre-empt the sidecar. When offload
            // fires it replaces `result` with a short preview stub (<2K) referencing
            // the on-disk path; the later compress is a no-op on that stub. compress
            // then only touches output that stayed inline (<= threshold).
            // Per-tool post-processing backstop. The executeTool try/catch
            // above terminates BEFORE offload/compress/trim/hint/cache writes/
            // trace/messages.push, so a maybeOffloadToolResult rejection (or
            // any downstream throw) would otherwise leave the assistant
            // tool_use message with no matching tool result. Wrap the whole
            // post-processing window through messages.push() in a catch; on
            // failure push a synthetic Error: tool result for this call.id
            // and skip the cache writes for it.
            let _postProcessOk = true;
            let _nativeToolSearch = null;
            try {
                // Offload thresholds are keyed by BARE tool name
                // (INLINE_THRESHOLD_BY_TOOL: grep=20k, bash=30k, read=Infinity, ...),
                // so strip the MCP prefix exactly as the cache write below does.
                // Otherwise an mcp__..__grep name misses its 20k grep cap and
                // silently falls back to the 50k default — per-tool limits ignored.
                const _toolBare = _stripMcpPrefix(call.name);
                _nativeToolSearch = parseNativeToolSearchPayload(call.name, result);
                if (_nativeToolSearch?.summary) result = _nativeToolSearch.summary;
                result = await maybeOffloadToolResult(sessionId, call.id, _toolBare, result);
                result = compressToolResult(call.name, call.arguments, result, { sessionId, toolKind });
                traceAgentTool({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt - toolStartedAt,
                    toolArgs: call.arguments,
                    agent: sessionRef?.agent || null,
                    model: sessionRef?.model || null,
                    resultKind: _resultKind,
                    resultText: result,
                    cwd,
                });
                // Cache stores run AFTER compress+trim+offload+hint AND after all other
                // post-processing (trace) so stored content == history content. Placing
                // the cache writes immediately before messages.push ensures ANY throw
                // earlier in post-processing skips the cache entirely — no stale or
                // partial result is ever cached. Cache-hit refs pointing to an offloaded
                // tool_use will show the offload stub; LLM can still recover the full
                // body via the disk path in that stub.
                if (sessionId && _executeOk && _resultKind === 'normal') {
                    if (_scopedCacheHit === null && _isScopedCacheableTool(call.name)) {
                        const _outcomeMap = sessionRef?._scopedCacheOutcomeByCallId instanceof Map
                            ? sessionRef._scopedCacheOutcomeByCallId : null;
                        const _outcome = _outcomeMap?.get(call.id);
                        setScopedToolCached({
                            sessionId,
                            toolName: _toolBare,
                            args: call.arguments,
                            cwd,
                            content: result,
                            toolUseId: call.id,
                            complete: _outcome ? _outcome.complete : true,
                        });
                        _outcomeMap?.delete(call.id);
                    }
                    if (_readCacheHit === null && _isReadTool(call.name)) {
                        // Pass tool_use id so future cache-hits can reference the body's location in history.
                        setReadCached({ sessionId, args: call.arguments, cwd, content: result, toolUseId: call.id });
                    }
                }
                // UI-only: apply_patch stashes the standard unified diff keyed
                // by tool_use id (never in the model-visible result). Attach it
                // here as a side-channel field so the TUI's expanded (ctrl+o)
                // raw view renders a colored +/- diff. The provider lowering
                // (anthropic/openai/etc.) never reads `uiDiff`, so the model
                // sees only `content` (the compact summary) — no token bloat.
                const _applyPatchUiDiff = _stripMcpPrefix(call.name) === 'apply_patch'
                    ? takeApplyPatchUiDiff(call.id)
                    : null;
                pushToolResultMessage({
                    role: 'tool',
                    content: result,
                    toolCallId: call.id,
                    toolKind: _resultKind,
                    ...(_nativeToolSearch ? { nativeToolSearch: _nativeToolSearch } : {}),
                    ...(_applyPatchUiDiff ? { uiDiff: _applyPatchUiDiff } : {}),
                });
                // Completion-first bookkeeping (Steps 1 & 2). Only successful
                // executions count. Edit/progress = any executed tool whose def
                // lacks readOnlyHint (apply_patch/bash/MCP-write/skill/...).
                // Read-only successful calls seed the cross-turn dedup map.
                if (_executeOk) {
                    const _isEager = isEagerDispatchable(call.name, tools);
                    if (_isEager) {
                        const _ctSig = crossTurnSignature(call.name, call.arguments);
                        if (!crossTurnCalls.has(_ctSig)) {
                            crossTurnCalls.set(_ctSig, { count: 1, firstIteration: iterations });
                            if (crossTurnCalls.size > crossTurnCap) {
                                const _oldest = crossTurnCalls.keys().next().value;
                                crossTurnCalls.delete(_oldest);
                            }
                        }
                    } else {
                        // A successful mutating (non-eager) tool invalidates the
                        // cross-turn dedup map wholesale: any prior read/grep may
                        // now return different content, so a post-edit
                        // verification read must NOT be stubbed as "unchanged".
                        if (isEditProgressTool(call.name, false)) {
                            crossTurnCalls.clear();
                            editCount += 1;
                        }
                    }
                }
            } catch (postErr) {
                _postProcessOk = false;
                // Reviewer fix: the exec itself succeeded — if it was a
                // mutating edit-progress tool, the file changes are real even
                // though post-processing failed, so the cross-turn dedup map
                // must still be invalidated (otherwise a later verification
                // read could be stubbed as "unchanged" against stale sigs).
                if (_executeOk && !isEagerDispatchable(call.name, tools) && isEditProgressTool(call.name, false)) {
                    crossTurnCalls.clear();
                    editCount += 1;
                }
                // Post-processing failed AFTER a successful exec: the result is
                // replaced with an error below, so preserve this call's full body
                // too for a clean retry (mirrors the failed-exec path above).
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
                    model: sessionRef?.model || null,
                    cwd,
                    resultText: _postMsg,
                    resultKind: 'error',
                });
                // Always emit a matching tool result so the assistant
                // tool_use isn't orphaned. Cache writes are placed at the
                // end of the try block (immediately before messages.push),
                // so ANY throw in post-processing reaches this catch before
                // the cache is written — stale/partial results are never
                // cached. The next read on the same path/scope re-executes
                // naturally.
                pushToolResultMessage({
                    role: 'tool',
                    content: _postMsg,
                    toolCallId: call.id,
                    toolKind: 'error',
                });
            }
            // Successful call: its compacted body/long args are never needed
            // again. Drop any `[mixdog compacted …]` placeholder from the stored
            // assistant tool_use so a prior apply_patch INPUT never surfaces a
            // resubmittable placeholder patch body the model copies back verbatim
            // (the patch guard catches it, but only after a wasted turn). Gated on
            // full success + clean post-processing; the failed/post-fail paths run
            // restoreToolCallBodyForId instead (mutually exclusive per call id).
            // Cache-safe: assistantTurnMsg is not transmitted until the next send.
            if (_postProcessOk && _executeOk && _resultKind === 'normal' && call?.id) {
                dropCompactedBodyArgsForId(assistantTurnMsg, call.id);
            }
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
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
        // Completion-first steering hints (missed-parallelism / all-read-only /
        // serial-rewording). At most ONE hint per turn. The ladder controller
        // owns the cumulative counters and streaks.
        steeringLadder.emitPostBatchSteering(calls, false);
        // Mid-turn steering is drained at the next loop's pre-send point,
        // AFTER any auto-compact pass. Draining here would put the steering
        // user turn after the fresh tool results before compaction runs; then
        // semantic/recall compaction would treat those fresh tool results as
        // prior history before the model sees them.
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    return { dedupStubTotal, editCount };
}
