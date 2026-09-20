// Eager admission gates. A call is eagerly dispatched only when the serial
// for-body would execute it too: single-call reservation, parseable args,
// pre-dispatch authorization, intra-turn dedup, the repeat-failure guards,
// cross-turn dedup and the session cache short-circuit — in that order.
import { isInvalidToolArgsMarker } from '../../providers/openai-compat-stream.mjs';
import { crossTurnSignature } from '../loop/completion-guards.mjs';
import { preDispatchDenyForSession } from '../loop/pre-dispatch-deny.mjs';
import {
  _argShapeSig,
  _intraTurnSig,
  _isReadTool,
  _isScopedCacheableTool,
  _repeatFailurePatternWouldContinue,
  _repeatFailureSig,
  _stripMcpPrefix,
} from '../loop/tool-classify.mjs';
import { getToolKind, isSingleCallPerTurnTool, isToolCallDedupEligible } from '../loop/tool-helpers.mjs';
import { tryReadCached, tryScopedToolCached } from '../read-dedup.mjs';

export function createEagerAdmission({
  tools,
  cwd,
  sessionId,
  sessionRef,
  crossTurnCalls,
  getIterations,
  repeatFailLimit,
}) {
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
  // eager promise settles: a streaming onToolCall
  // can deliver a same-turn identical call AFTER the first promise
  // settles but BEFORE the deferred cache set, and the static
  // pre-pass only runs after send() returns — so clearing the
  // sig on settle would let that second streaming eager call
  // re-execute. A fresh Map() is created per turn, so the sig set
  // resets at the turn boundary without leaking across getIterations().
  const _eagerInFlightSigs = new Map();
  // Computer Use owns stateful agent-scoped target claims and each mutation
  // returns the fresh state required by the next decision. A provider may still
  // stream parallel calls despite the tool contract, so reserve only the
  // first call before any eager execution starts.
  const _singleCallFirstIdByName = new Map();

  function repeatFailureBlocks(call) {
    const _rfg = sessionRef?._repeatFailGuard;
    const _repeatSig = _repeatFailureSig(call.name, call.arguments, cwd);
    if (_rfg && _rfg.sig === _repeatSig && _rfg.count >= repeatFailLimit) return true;
    if (_repeatFailurePatternWouldContinue(sessionRef?._repeatFailHistory, _repeatSig, repeatFailLimit) > 0)
      return true;
    const _afg = sessionRef?._repeatArgShapeFailGuard;
    return Boolean(_afg && _afg.sig === _argShapeSig(call.name, call.arguments) && _afg.count >= repeatFailLimit);
  }

  // Cache short-circuit (mirrors the serial-body lookup at
  // tool-batch.mjs). If this read / scoped-cacheable call would be
  // served from the session cache in the serial for-body, do NOT
  // execute it eagerly — the serial path returns the cached body
  // (read cache is stat-validated; scoped cache is dep-root evicted).
  // Skipping here avoids redundant IO under concurrent agents
  // and, combined with the non-barrier `continue` in startEagerRun,
  // never blocks a later independent eager read behind a cache stub.
  // If the entry is invalidated before the serial body re-checks,
  // that call simply executes serially — correctness is preserved.
  function cacheWouldServe(call) {
    if (!sessionId) return false;
    if (_isReadTool(call.name)) return tryReadCached({ sessionId, args: call.arguments, cwd }) !== null;
    if (!_isScopedCacheableTool(call.name)) return false;
    return (
      tryScopedToolCached({
        sessionId,
        toolName: _stripMcpPrefix(call.name),
        args: call.arguments,
        cwd,
        countStats: false,
        touch: false,
      }) !== null
    );
  }

  /** Returns { sig, dedupEligible } when the call may run eagerly, else null. */
  function admit(call) {
    if (isSingleCallPerTurnTool(call.name)) {
      const firstId = _singleCallFirstIdByName.get(call.name);
      if (firstId && firstId !== call.id) return null;
      if (!firstId) _singleCallFirstIdByName.set(call.name, call.id);
    }
    // Never eager-execute a call whose arguments failed to parse
    // (invalid-args marker). It has no usable arguments; the serial
    // body handles it via the invalid-args feedback path.
    if (isInvalidToolArgsMarker(call.arguments)) return null;
    // Authorization precedes cache lookup and dedup, not just IO.
    const toolKind = getToolKind(call.name, sessionRef?.mcpScopeId);
    if (preDispatchDenyForSession(sessionRef, call, toolKind) !== null) return null;
    const sig = _intraTurnSig(call.name, call.arguments);
    const dedupEligible = isToolCallDedupEligible(call.name, tools);
    if (dedupEligible && _eagerInFlightSigs.has(sig)) return null;
    // Repeat-failure guard also gates eager dispatch (reviewer-flagged):
    // streaming onToolCall / startEagerRun would otherwise re-run an
    // identical read-only call that already failed repeatFailLimit
    // times before the serial for-body guard runs. Returning null here
    // lets the serial body push the [repeat-failure-guard] stub.
    if (repeatFailureBlocks(call)) return null;
    // Cross-turn dedup also gates eager dispatch (mirror of the
    // repeat-failure guard above): a read-only call whose (name,args)
    // signature already ran in an EARLIER turn must NOT be eagerly
    // re-executed — the serial for-body pushes the [cross-turn-dedup]
    // stub instead. Without this gate startEagerRun/onToolCall would
    // re-run the call before the serial dedup check ever sees it.
    if (dedupEligible) {
      const _prior = crossTurnCalls.get(crossTurnSignature(call.name, call.arguments));
      if (_prior && _prior.firstIteration < getIterations()) return null;
    }
    if (cacheWouldServe(call)) return null;
    return { sig, dedupEligible };
  }

  function markInFlight(call, admitted) {
    if (admitted.dedupEligible) _eagerInFlightSigs.set(admitted.sig, call.id);
  }

  return { admit, markInFlight };
}
