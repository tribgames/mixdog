import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
import {
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
  approvalGranted,
  approvalReason,
} from './loop/tool-helpers.mjs';
import { repairTranscriptBeforeProviderSend } from './loop/transcript-repair.mjs';
import { resetAccountProbePacing } from '../providers/account-pool.mjs';
import { createLoopState, finishLoop, shouldSuppressAgentMidTurnText } from './loop/loop-state.mjs';
import { applyRetryAction, beginIteration, sendProviderRequest, settleSendResult } from './loop/send-phase.mjs';
import { runToolPhase } from './loop/tool-phase.mjs';

// Facade re-exports: these symbols moved to split modules under ./loop/ but
// remain part of loop.mjs's public surface (imported by scripts/tests and other
// runtime modules). Re-export the already-imported local bindings so every
// existing import path keeps working (no duplicate module binding).
export {
  preDispatchDenyForSession,
  repairTranscriptBeforeProviderSend,
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
  approvalGranted,
  approvalReason,
  shouldSuppressAgentMidTurnText,
};

/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 *   - `liveProjection` — when true, Agent sessions keep provider onTextDelta / mid-turn text
 *
 * The per-ask state lives in one explicit record (./loop/loop-state.mjs); the
 * send and tool halves of a round are ./loop/send-phase.mjs and
 * ./loop/tool-phase.mjs.
 */
export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
  // An explicit request asks for a current answer. Let the account pool
  // re-measure quota it recorded as exhausted instead of refusing from the old
  // reading — once per loop entry, not per provider round inside the turn.
  resetAccountProbePacing();
  const state = createLoopState({ provider, messages, model, tools, cwd, sendOpts });
  // Completion, cancellation, and terminal failures end execution.
  while (true) {
    const round = await beginIteration(state);
    const sent = await sendProviderRequest(state, round);
    if (applyRetryAction(state, sent.result)) continue;
    settleSendResult(state, round, sent);
    // A turn without client tool calls is not automatically the final answer:
    // the provider may have hit its output ceiling, been cut by a safety
    // classifier, declared the turn unfinished, or returned nothing. Each case
    // owns a bounded recovery ladder in ./loop/no-tool-turn.mjs, which either
    // appended a recovery turn ('continue') or produced the terminal response.
    if (!state.response.toolCalls?.length) {
      const outcome = state.noToolTurn.resolve(state.response, state.iterations);
      state.response = outcome.response;
      if (outcome.action === 'continue') continue;
      break;
    }
    await runToolPhase(state, round, sent, onToolCall);
  }
  return finishLoop(state);
}
