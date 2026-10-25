// Resolution of a provider turn that returned NO client tool calls.
//
// Such a turn is not automatically the final answer: the provider may have hit
// its output ceiling, been cut by a safety classifier, explicitly declared the
// turn unfinished, or returned nothing at all. Each case owns a bounded
// recovery ladder, and every ladder must terminate — an unbounded one turns a
// deterministic provider state into an infinite loop.
//
// The resolver owns the per-turn text/recovery counters because the same state
// decides both the recovery and the caller-facing aggregate; the loop reports
// tool-call turns and completed tool batches back so the counters that reset at
// those boundaries stay accurate.
import { HIDDEN_AGENT_NAMES } from './hidden-agents.mjs';
import { INCOMPLETE_STOP_REASONS, isOutputLimitStopReason, providerContinuationSignal } from './termination.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { createTurnSegments } from './no-tool-turn/segments.mjs';
import { resetOutputLimitRecovery, resolveOutputLimit } from './no-tool-turn/output-limit.mjs';
import { resolveRefusal } from './no-tool-turn/refusal.mjs';
import { resumeContinuation } from './no-tool-turn/continuation.mjs';
import { nudgeEmptyTurn } from './no-tool-turn/empty-nudge.mjs';
import { isReactionSuccess, reactionCallIds, takeReactionTarget } from '../../runtime-core/reaction-tool-defs.mjs';
import { messageIdOf } from '../message-ids.mjs';
import { isReactableMessage } from '../message-reactions.mjs';

// `escalateMaxTokens()` asks the live provider for a higher one-shot max_tokens
// (number) or reports none (null/undefined) — the loop stays provider-agnostic.
export function createNoToolTurnResolver({
  messages,
  opts,
  sessionId,
  sessionAgent,
  drainSteering,
  escalateMaxTokens = () => null,
  streamedChars = () => 0,
}) {
  const segments = createTurnSegments({ messages, opts });
  // Per-turn recovery counters shared by the ladders.
  const state = {
    maxOutputRecoveryCount: 0,
    outputEscalationUsed: false,
    refusalRetryUsed: false,
    emptyNudgeStreak: 0,
    // Successful reactions (react tool): the input each was left against and
    // whether it answered that input.
    reactions: [],
    // Structured provider continuation signals honored this turn. Diagnostic
    // only: this count bounds nothing (the turn's step limit bounds provider
    // calls made without progress, turn-limits.mjs). A
    // text-only continuation runaway is bounded by continuationsSinceToolBatch
    // below; continuations interleaved with tool batches are not limited.
    providerContinuationCount: 0,
    // Continuations since the last executed tool batch — bounds the text-only
    // continuation runaway (see PROVIDER_CONTINUATION_NO_TOOL_LIMIT).
    continuationsSinceToolBatch: 0,
  };
  // The stable id (message-ids.mjs, kept across compaction) of the newest
  // real user input; runtime reminders and notices are not reactable.
  // A group-room member turn's prompt is a runtime message (not reactable)
  // that carries the newest room-log user row it shows (`roomRow`).
  const roomRowOf = (message) => message?.meta?.transcript?.roomRow || '';
  const latestInput = () => messages.findLast((message) => isReactableMessage(message) || roomRowOf(message));
  const latestInputId = () => messageIdOf(latestInput());
  // A reaction exempts the input only while no newer input arrived since it
  // landed (same latest input id) and it answered that input.
  const reactionAnswersLatest = () => {
    const id = latestInputId();
    return state.reactions.some((reaction) => reaction.answered && reaction.inputId === id);
  };
  // What this batch's react calls hit, from the id the react tool recorded
  // for each (never rebuilt from this transcript: a room reaction runs
  // against the room's own log). Every record is consumed; a success that
  // recorded none exempts nothing. A home-chat reaction answers the input
  // only when it hit that very message; a room reaction, whose message is in
  // another log, only when it hit the row this turn's prompt showed.
  const batchReactions = (calls, results) => {
    const input = latestInput();
    const inputId = messageIdOf(input);
    const hit = [];
    for (const id of reactionCallIds(calls)) {
      const target = takeReactionTarget(sessionId, id);
      if (!target || !results.some((message) => isReactionSuccess(message, new Set([id])))) continue;
      const answered = target.room
        ? roomRowOf(input) === target.messageId
        : inputId !== '' && target.messageId === inputId;
      hit.push({ inputId, answered });
    }
    return hit;
  };
  const trace = (iteration, kind, payload) => {
    try {
      appendAgentTrace({ sessionId, iteration, kind, payload, agent: sessionAgent || null });
    } catch {
      /* best-effort telemetry */
    }
  };
  const ladder = { state, segments, messages, opts, sessionId, trace, escalateMaxTokens, streamedChars };

  // A no-tool message ends the turn. Unresolved tool failures remain visible
  // in history and can be reported directly without a synthetic continuation
  // turn. Earlier committed segments are re-prepended so the caller receives
  // the whole answer while history keeps only the terminal segment.
  const finishTurn = (response) => {
    if (segments.parts.length === 0) return { action: 'break', response };
    const terminalSegment = typeof response.content === 'string' ? response.content : '';
    return {
      action: 'break',
      response: {
        ...response,
        content: `${segments.parts.join('')}${terminalSegment}`,
        historyContent: terminalSegment,
        ...(state.maxOutputRecoveryCount > 0 ? { maxOutputRecoveryAttempts: state.maxOutputRecoveryCount } : {}),
      },
    };
  };

  return {
    // { action: 'continue' | 'break', response }. 'continue' means the
    // recovery appended to the transcript and the loop must re-send;
    // 'break' returns the (possibly aggregated) terminal response.
    async resolve(response, iteration) {
      const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
      const stopReason = response.stopReason ?? response.stop_reason ?? null;
      const isOutputLimitStop = isOutputLimitStopReason(stopReason);
      if (isOutputLimitStop || (hasContent && response.streamCut === true)) {
        return resolveOutputLimit(response, ladder);
      }
      if (stopReason === 'refusal') return resolveRefusal(response, hasContent, ladder);
      // Output-limit stops keep the bounded max-output ladder above and
      // refusals (already returned) keep the bounded refusal retry; both
      // own their own continuation semantics. No lexical/progress-text
      // heuristic is consulted.
      const continuationSignal = isOutputLimitStop ? null : providerContinuationSignal(response);
      if (
        continuationSignal &&
        resumeContinuation(response, { iteration, signal: continuationSignal, hasContent, stopReason }, ladder)
      ) {
        return { action: 'continue', response };
      }
      // Hidden roles are exempt from the empty-turn nudge: their own role
      // rules define a different output contract (pipe-separated chunker
      // output, …) and a text-only terminal turn is the correct shape —
      // nudging them produces a contradictory user message that traps the
      // model in a tool-call-blocked vs contract-required oscillation.
      // A turn that left a reaction on the user's message may end with no
      // text: the reaction is its answer (react tool), never an empty turn.
      if (!hasContent && !HIDDEN_AGENT_NAMES.has(sessionAgent) && !reactionAnswersLatest()) {
        return nudgeEmptyTurn(
          response,
          { stopReason, isIncompleteStop: stopReason && INCOMPLETE_STOP_REASONS.has(stopReason) },
          ladder
        );
      }
      // Pending-input rule: queued user input is folded into
      // needs_follow_up before terminal completion. Commit the terminal
      // text first (beforeAppend), then resume.
      if (
        drainSteering('terminal', {
          maxPriority: 'next',
          beforeAppend: () => {
            if (segments.commitIntermediate(response) && hasContent)
              segments.record(response.content, { committed: true });
          },
        })
      ) {
        state.emptyNudgeStreak = 0;
        resetOutputLimitRecovery(state);
        return { action: 'continue', response };
      }
      return finishTurn(response);
    },
    // A turn that produced tool calls is never an empty contract violation,
    // and it is real progress: a later output-limit cut starts a fresh ladder.
    noteToolCallTurn() {
      state.emptyNudgeStreak = 0;
      resetOutputLimitRecovery(state);
    },
    // `results` are the batch's tool result messages: only a react call that
    // succeeded marks the turn as having reacted.
    noteToolBatchCompleted(calls = [], results = []) {
      state.continuationsSinceToolBatch = 0;
      segments.clear();
      state.reactions.push(...batchReactions(calls, results));
    },
    // The loop ended on a reaction that answered the latest user input.
    get reactionCompleted() {
      return reactionAnswersLatest();
    },
    get providerContinuations() {
      return state.providerContinuationCount;
    },
  };
}
