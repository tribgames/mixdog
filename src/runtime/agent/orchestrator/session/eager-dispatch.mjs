// Eager tool-dispatch controller, extracted from agent-loop.mjs. Owns the
// per-turn pending promise map, the intra-turn in-flight signature set, and
// the mutation epoch. Every valid call dispatches while the provider is still
// streaming. Calls execute in parallel except that repository-wide Git writes
// serialize against file edits, while shell waits for every earlier mutation;
// results are collected later in call order.
import { resolve as pathResolve } from 'node:path';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { classifyResultKind } from './result-classification.mjs';
import { isInvalidToolArgsMarker } from '../providers/openai-compat-stream.mjs';
import {
    _intraTurnSig,
    _argShapeSig,
    _isEditTool,
    _isGitMutationTool,
    _isMutationTool,
    _isReadTool,
    _isScopedCacheableTool,
    _isShellTool,
    _repeatFailurePatternWouldContinue,
    _repeatFailureSig,
    _stripMcpPrefix,
} from './loop/tool-classify.mjs';
import { tryReadCached, tryScopedToolCached } from './read-dedup.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { crossTurnSignature } from './loop/completion-guards.mjs';
import { getToolKind, isEagerDispatchable, isParallelDispatchable, isToolCallDedupEligible } from './loop/tool-helpers.mjs';

function eagerSettlementFailed(settled) {
    if (!settled?.ok) return true;
    try {
        const normalized = normalizeToolEnvelope(settled.value);
        return classifyResultKind(normalized.result, normalized.explicitSuccess) === 'error';
    } catch {
        return true;
    }
}

export function createEagerDispatcher({
    tools, cwd, sessionId, sessionRef, signal, opts,
    crossTurnCalls, getIterations, getNextIteration, repeatFailLimit,
    executeToolFn = executeTool,
}) {
        const pending = new Map();
        // Cumulative success barrier for patches already emitted in this
        // assistant turn. Patches remain path-parallel with each other; a later
        // shell waits for all of them and is skipped if any patch failed.
        let patchBarrier = Promise.resolve({ failedPatchIds: [] });
        // Exact-string edits are single-replacement calls. Same-FILE edits in
        // one model turn must observe prior writes, so each target path keeps
        // its own barrier chain; DIFFERENT files stay parallel (a single global
        // chain here serialized every edit in the turn — user report: batched
        // multi-file edits ran one by one). An edit whose target path cannot be
        // determined serializes against every prior edit, and later edits on
        // any path wait for it (conservative fallback).
        const editBarriersByPath = new Map();
        let editBarrierPathless = Promise.resolve();
        const _editPathKey = (args) => {
            const raw = args && typeof args === 'object'
                ? (args.file_path ?? args.path ?? args.file)
                : null;
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (!text) return null;
            try {
                // Case-folded + separator-normalized. Merging two spellings of
                // one file is required for correctness; merging two distinct
                // files can only over-serialize, never under-serialize.
                return pathResolve(cwd || '.', text).replace(/\\/g, '/').toLowerCase();
            } catch {
                return null;
            }
        };
        // Git mutations have repository-wide effects. They wait for earlier
        // file edits, and later edits/shell verification wait for them.
        let gitMutationBarrier = Promise.resolve();
        // Streaming-time intra-turn dedup. When the LLM emits two
        // tool_use blocks with identical (name, args) signatures in
        // sequence, the provider's onToolCall fires for both BEFORE
        // the iter for-body runs, so the batch-level pre-pass would be
        // too late to prevent the eager dispatch of the second one.
        // Track signatures of in-flight eager calls and skip starting a
        // second one for the same sig. Loader calls are the narrow exception:
        // each invocation must run and report loaded vs already-active state.
        // Every other duplicate's executeTool is
        // never invoked; the for-body's pre-pass marks it as a duplicate
        // and emits a stub tool_result. The sig is NOT cleared when the
        // eager promise settles (see finally below): a streaming onToolCall
        // can deliver a same-turn identical call AFTER the first promise
        // settles but BEFORE the deferred cache set (:1256), and the static
        // pre-pass (:909) only runs after send() returns — so clearing the
        // sig on settle would let that second streaming eager call
        // re-execute. A fresh Map() is created per turn, so the sig set
        // resets at the turn boundary without leaking across getIterations().
        const _eagerInFlightSigs = new Map();
        const epoch = { mutation: 0 };
        const startEagerTool = (call) => {
            if (!call?.id || pending.has(call.id) || !isParallelDispatchable(call.name)) return null;
            // Never eager-execute a call whose arguments failed to parse
            // (invalid-args marker). It has no usable arguments; the serial
            // body handles it via the invalid-args feedback path.
            if (isInvalidToolArgsMarker(call.arguments)) return null;
            const _sig = _intraTurnSig(call.name, call.arguments);
            const _dedupEligible = isToolCallDedupEligible(call.name, tools);
            if (_dedupEligible && _eagerInFlightSigs.has(_sig)) return null;
            // Repeat-failure guard also gates eager dispatch (reviewer-flagged):
            // streaming onToolCall / startEagerRun would otherwise re-run an
            // identical read-only call that already failed repeatFailLimit
            // times before the serial for-body guard runs. Returning null here
            // lets the serial body push the [repeat-failure-guard] stub.
            {
                const _rfg = sessionRef?._repeatFailGuard;
                const _repeatSig = _repeatFailureSig(call.name, call.arguments, cwd);
                if (_rfg && _rfg.sig === _repeatSig && _rfg.count >= repeatFailLimit) return null;
                if (_repeatFailurePatternWouldContinue(
                    sessionRef?._repeatFailHistory,
                    _repeatSig,
                    repeatFailLimit,
                ) > 0) return null;
            }
            {
                const _afg = sessionRef?._repeatArgShapeFailGuard;
                if (_afg && _afg.sig === _argShapeSig(call.name, call.arguments) && _afg.count >= repeatFailLimit) return null;
            }
            // Cross-turn dedup also gates eager dispatch (mirror of the
            // repeat-failure guard above): a read-only call whose (name,args)
            // signature already ran in an EARLIER turn must NOT be eagerly
            // re-executed — the serial for-body pushes the [cross-turn-dedup]
            // stub instead. Without this gate startEagerRun/onToolCall would
            // re-run the call before the serial dedup check ever sees it.
            if (isToolCallDedupEligible(call.name, tools)) {
                const _ctSig = crossTurnSignature(call.name, call.arguments);
                const _prior = crossTurnCalls.get(_ctSig);
                if (_prior && _prior.firstIteration < getIterations()) return null;
            }
            // Cache short-circuit (mirrors the serial-body lookup at
            // tool-batch.mjs). If this read / scoped-cacheable call would be
            // served from the session cache in the serial for-body, do NOT
            // execute it eagerly — the serial path returns the cached body
            // (read cache is stat-validated; scoped cache is dep-root evicted).
            // Returning null here skips redundant IO under concurrent agents
            // and, combined with the non-barrier `continue` in startEagerRun,
            // never blocks a later independent eager read behind a cache stub.
            // If the entry is invalidated before the serial body re-checks,
            // that call simply executes serially — correctness is preserved.
            if (sessionId) {
                if (_isReadTool(call.name)) {
                    if (tryReadCached({ sessionId, args: call.arguments, cwd }) !== null) return null;
                } else if (_isScopedCacheableTool(call.name)) {
                    if (tryScopedToolCached({ sessionId, toolName: _stripMcpPrefix(call.name), args: call.arguments, cwd, countStats: false, touch: false }) !== null) return null;
                }
            }
            const toolKind = getToolKind(call.name);
            // Shared pre-dispatch deny: identical predicate runs in the
            // serial path below. If any role/permission guard would reject
            // this call there, never start it eagerly here.
            if (preDispatchDenyForSession(sessionRef, call, toolKind) !== null) return null;
            const dispatchedAt = Date.now();
            const entry = {
                startedAt: dispatchedAt,
                dispatchStartedAt: dispatchedAt,
                executionStartedAt: null,
                endedAt: null,
                mutationEpoch: epoch.mutation,
                localSearchTelemetry: {},
                resultTelemetry: {},
            };
            const gitMutation = _isGitMutationTool(call.name, call.arguments);
            const mutation = _isMutationTool(call.name, call.arguments);
            const precedingPatches = (_isShellTool(call.name) || gitMutation) ? patchBarrier : null;
            const precedingGitMutation = (_isShellTool(call.name) || mutation) ? gitMutationBarrier : null;
            let precedingEdits = null;
            let editPathKey = null;
            if (_isEditTool(call.name)) {
                editPathKey = _editPathKey(call.arguments);
                precedingEdits = editPathKey
                    ? Promise.all([editBarriersByPath.get(editPathKey), editBarrierPathless])
                    : Promise.all([...editBarriersByPath.values(), editBarrierPathless]);
            }
            if (_dedupEligible) _eagerInFlightSigs.set(_sig, call.id);
            entry.promise = (async () => {
                try {
                    if (precedingEdits) await precedingEdits;
                    if (precedingGitMutation) await precedingGitMutation;
                    if (precedingPatches) {
                        const patchState = await precedingPatches;
                        if (patchState.failedPatchIds.length > 0) {
                            return {
                                ok: true,
                                skipped: true,
                                value: `[mutation-dependency-guard] \`${call.name}\` skipped because earlier mutation call(s) failed: ${patchState.failedPatchIds.join(', ')}; no verification ran.`,
                            };
                        }
                    }
                    await opts.beforeToolExecution?.();
                    entry.executionStartedAt = Date.now();
                    return { ok: true, value: await executeToolFn(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: getNextIteration(), localSearchTelemetry: entry.localSearchTelemetry, resultTelemetry: entry.resultTelemetry }) };
                } catch (error) {
                    return { ok: false, error };
                }
            })()
                .then((settled) => {
                    entry.endedAt = Date.now();
                    // EARLY UI-ONLY NOTIFY (completion-order, NOT history).
                    // The serial result-collection loop below `await`s each
                    // eager promise strictly in CALL order, so a fast call[1]
                    // that settles before a slow call[0] cannot surface its
                    // tool card completion until call[0] resolves. Fire
                    // onToolResult here — the instant THIS eager tool settles —
                    // so parallel cards complete independently in the order they
                    // actually finish.
                    //
                    // This message is NOT pushed into `messages`: provider
                    // history ordering stays exactly call-order. The serial loop
                    // still builds the REAL tool_result and pushes it via
                    // pushToolResultMessage (which fires onToolResult AGAIN for
                    // the same toolCallId in call order — the TUI dedupes by id,
                    // so the duplicate notify is harmless). __earlyNotify marks
                    // this as the pre-history, UI-only signal.
                    //
                    // Only genuinely-executed eager promises reach here:
                    // startEagerTool never creates an entry for dedup /
                    // repeat-failure-guard / pre-dispatch-deny / invalid-args
                    // calls (they return null above), so those `continue`-before-
                    // execution stub paths can never early-notify (contract #5).
                    try {
                        // UI-only: surface the model-VISIBLE result (envelope
                        // stub for envelope returns), never the envelope object
                        // or its injected newMessages body — no [object Object],
                        // no full skill body in the tool card.
                        const _earlyVisible = settled && settled.ok
                            ? normalizeToolEnvelope(settled.value).result
                            : null;
                        const _earlyContent = settled && settled.ok
                            ? (typeof _earlyVisible === 'string'
                                ? _earlyVisible
                                : (_earlyVisible == null ? '' : String(_earlyVisible)))
                            : `Error: ${settled && settled.error instanceof Error ? settled.error.message : String(settled && settled.error)}`;
                        opts.onToolResult?.({
                            role: 'tool',
                            toolCallId: call.id,
                            content: _earlyContent,
                            isError: !(settled && settled.ok),
                            __earlyNotify: true,
                            toolTiming: {
                                dispatchStartedAt: entry.dispatchStartedAt,
                                executionStartedAt: entry.executionStartedAt ?? entry.endedAt,
                                executionCompletedAt: entry.endedAt,
                            },
                        });
                    } catch { /* best-effort — UI notify must never break the eager path */ }
                    // Intentionally do NOT delete _sig here — see the block
                    // comment above. The sig must outlive promise settlement
                    // so a later same-turn streaming duplicate stays blocked
                    // at the _eagerInFlightSigs.has(_sig) guard until the turn
                    // boundary recreates the Map.
                    return settled;
                });
            pending.set(call.id, entry);
            if (_isEditTool(call.name)) {
                const settledEdit = entry.promise.then(() => undefined, () => undefined);
                if (editPathKey) {
                    editBarriersByPath.set(editPathKey, settledEdit);
                } else {
                    // A pathless edit acts as a full barrier: it already waited
                    // for every prior chain, so later edits on any path only
                    // need to wait for it (they all await editBarrierPathless).
                    const priorChains = [...editBarriersByPath.values(), editBarrierPathless];
                    editBarrierPathless = Promise.all([...priorChains, settledEdit])
                        .then(() => undefined, () => undefined);
                }
            }
            if (_isMutationTool(call.name, call.arguments)) {
                const precedingPatchState = patchBarrier;
                const currentPatch = entry.promise;
                patchBarrier = Promise.all([precedingPatchState, currentPatch]).then(([state, settled]) => ({
                    failedPatchIds: eagerSettlementFailed(settled)
                        ? [...state.failedPatchIds, call.id]
                        : state.failedPatchIds,
                }));
            }
            if (gitMutation) {
                gitMutationBarrier = entry.promise.then(() => undefined, () => undefined);
            }
            return entry;
        };
        const startEagerRun = (calls, startIndex, dupSet) => {
            for (let j = startIndex; j < calls.length; j += 1) {
                const call = calls[j];
                if (!call?.id || !isParallelDispatchable(call.name)) continue;
                if (dupSet && dupSet.has(call.id)) continue;
                // A null return here is NOT a state barrier. It means a
                // non-barrier stub — intra-turn in-flight dup, repeat-failure /
                // cross-turn dedup, pre-dispatch-deny, invalid-args, or a cache
                // short-circuit. `continue` (not `break`) so a stub in the
                // middle of the run does not stop LATER independent calls from
                // starting early.
                if (!startEagerTool(call) && !pending.has(call.id)) continue;
            }
        };
        const onToolCall = (call) => {
            startEagerTool(call);
        };
    return { pending, epoch, startEagerTool, startEagerRun, onToolCall };
}
