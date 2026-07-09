// Eager tool-dispatch controller, extracted from agent-loop.mjs. Owns the
// per-turn pending promise map, the intra-turn in-flight signature set, and
// the mutation epoch. Read-only tool calls start executing the instant the
// provider streams a tool_use event so execution overlaps the remaining SSE
// parse; writes/unknown tools wait for the serial batch loop. Behavior
// identical to the inline closures it replaced.
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { isInvalidToolArgsMarker } from '../providers/openai-compat-stream.mjs';
import { _intraTurnSig, _isReadTool, _isScopedCacheableTool, _stripMcpPrefix } from './loop/tool-classify.mjs';
import { tryReadCached, tryScopedToolCached } from './read-dedup.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import { executeTool } from './loop/tool-exec.mjs';
import { crossTurnSignature } from './loop/completion-guards.mjs';
import { getToolKind, isEagerDispatchable } from './loop/tool-helpers.mjs';

export function createEagerDispatcher({
    tools, cwd, sessionId, sessionRef, signal, opts,
    crossTurnCalls, getIterations, getNextIteration, repeatFailLimit,
}) {
        const pending = new Map();
        // Streaming-time intra-turn dedup. When the LLM emits two
        // tool_use blocks with identical (name, args) signatures in
        // sequence, the provider's onToolCall fires for both BEFORE
        // the iter for-body runs, so the batch-level pre-pass would be
        // too late to prevent the eager dispatch of the second one.
        // Track signatures of in-flight eager calls and skip starting a
        // second one for the same sig. The duplicate's executeTool is
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
            if (!call?.id || pending.has(call.id) || !isEagerDispatchable(call.name, tools)) return null;
            // Never eager-execute a call whose arguments failed to parse
            // (invalid-args marker). It has no usable arguments; the serial
            // body handles it via the invalid-args feedback path.
            if (isInvalidToolArgsMarker(call.arguments)) return null;
            const _sig = _intraTurnSig(call.name, call.arguments);
            if (_eagerInFlightSigs.has(_sig)) return null;
            // Repeat-failure guard also gates eager dispatch (reviewer-flagged):
            // streaming onToolCall / startEagerRun would otherwise re-run an
            // identical read-only call that already failed repeatFailLimit
            // times before the serial for-body guard runs. Returning null here
            // lets the serial body push the [repeat-failure-guard] stub.
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _sig && _rfg.count >= repeatFailLimit) return null;
            }
            // Cross-turn dedup also gates eager dispatch (mirror of the
            // repeat-failure guard above): a read-only call whose (name,args)
            // signature already ran in an EARLIER turn must NOT be eagerly
            // re-executed — the serial for-body pushes the [cross-turn-dedup]
            // stub instead. Without this gate startEagerRun/onToolCall would
            // re-run the call before the serial dedup check ever sees it.
            {
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
            const entry = { startedAt: Date.now(), endedAt: null, mutationEpoch: epoch.mutation };
            _eagerInFlightSigs.set(_sig, call.id);
            entry.promise = (async () => {
                try {
                    return { ok: true, value: await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: getNextIteration() }) };
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
            return entry;
        };
        const startEagerRun = (calls, startIndex, dupSet) => {
            for (let j = startIndex; j < calls.length; j += 1) {
                const call = calls[j];
                if (!call?.id || !isEagerDispatchable(call.name, tools)) break;
                if (dupSet && dupSet.has(call.id)) continue;
                // A null return here is NOT a state barrier: the loop above
                // already breaks at the first non-eager (mutation/bash/unknown)
                // tool, so every call reached here is read-only. A null means a
                // non-barrier stub — intra-turn in-flight dup, repeat-failure /
                // cross-turn dedup, pre-dispatch-deny, invalid-args, or a cache
                // short-circuit. `continue` (not `break`) so a stub in the
                // middle of a contiguous eager run does not stop LATER
                // independent eager reads from starting early.
                if (!startEagerTool(call) && !pending.has(call.id)) continue;
            }
        };
        let _streamEagerBlocked = false;
        const onToolCall = (call) => {
            if (!isEagerDispatchable(call?.name, tools)) {
                _streamEagerBlocked = true;
                return;
            }
            if (_streamEagerBlocked) return;
            startEagerTool(call);
        };
    return { pending, epoch, startEagerTool, startEagerRun, onToolCall };
}
