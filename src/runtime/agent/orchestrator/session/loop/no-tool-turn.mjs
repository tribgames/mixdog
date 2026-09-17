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
import { buildIntermediateAssistantMessage, commitAssistantMessage } from './assistant-commit.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';

// A provider max-output stop is not a completed assistant turn, even when it
// contains useful text. Preserve each partial in the provider transcript and
// grant at most this many direct continuations before surfacing a hard
// truncation.
const MAX_OUTPUT_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_EXHAUSTED_NOTICE = `[mixdog-runtime] Output remained truncated after ${MAX_OUTPUT_RECOVERY_LIMIT} continuation attempts.`;
const MAX_OUTPUT_RESUME_PROMPT =
  'Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.';
const REFUSAL_RECOVERY_PROMPT =
  '[mixdog-runtime] The previous completion was refused by the provider safety classifier (stopReason=refusal). Do not repeat it. Complete your assigned output within policy by omitting or reframing disallowed content; if no compliant output is possible, briefly state the refusal.';
// Consecutive empty-turn contract nudges. A model that answers the same nudge
// with another empty turn is in a deterministic livelock (same context in →
// same empty completion out). Bound that failed recovery and end the loop as an
// explicit empty termination instead.
const EMPTY_NUDGE_MAX = 3;
// Structured provider continuations (endTurn=false / pause_turn) are honored,
// but must not sustain an unbounded text-only loop: a lead session was observed
// burning a 30-minute agent budget (26K output tokens, zero tool calls) on
// back-to-back continuations. After this many continuations with no intervening
// tool batch, the current text is accepted as the final answer.
const PROVIDER_CONTINUATION_NO_TOOL_LIMIT = Math.max(
  1,
  Number(process.env.MIXDOG_PROVIDER_CONTINUATION_NO_TOOL_LIMIT) || 8
);

function writeDiagnostic(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* diagnostics only */
  }
}

export function createNoToolTurnResolver({
  messages,
  opts,
  sessionId,
  sessionAgent,
  suppressMidTurnText,
  drainSteering,
}) {
  // Committed-but-unsealed text segments for the caller-facing aggregate:
  // max-output recovery parts plus (Lead/TUI only) text-only continuation
  // segments (provider pause_turn / terminal steering / stop hook). The
  // terminal response returns content = parts + terminal so the UI row that
  // accumulated every streamed segment is not overwritten down to only the
  // last segment; historyContent keeps persistence single-copy.
  const committedTextParts = [];
  let maxOutputRecoveryCount = 0;
  let refusalRetryUsed = false;
  let emptyNudgeStreak = 0;
  // Count of structured provider continuation signals honored this turn.
  // Diagnostic only; the hard iteration cap remains the sole bound on how long
  // a provider may keep declaring "not done" inside one user turn.
  let providerContinuationCount = 0;
  // Continuations since the last executed tool batch — bounds the text-only
  // continuation runaway (see PROVIDER_CONTINUATION_NO_TOOL_LIMIT).
  let continuationsSinceToolBatch = 0;

  const trace = (iteration, kind, payload) => {
    try {
      appendAgentTrace({ sessionId, iteration, kind, payload, agent: sessionAgent || null });
    } catch {
      /* best-effort telemetry */
    }
  };
  const commitIntermediate = (response) => {
    const message = buildIntermediateAssistantMessage(response, opts);
    if (!message) return false;
    commitAssistantMessage(messages, message, opts);
    return true;
  };
  // Record a mid-turn segment for the caller-facing aggregate and surface it
  // live. A suppressed sub-agent session neither surfaces nor accumulates
  // text — except on the max-output ladder, whose parts must still rebuild
  // the complete answer the caller receives (keepWhenSuppressed).
  const recordTextSegment = (text, { keepWhenSuppressed = false } = {}) => {
    if (suppressMidTurnText) {
      if (keepWhenSuppressed) committedTextParts.push(text);
      return;
    }
    committedTextParts.push(text);
    try {
      opts.onAssistantText?.(text);
    } catch {
      /* best-effort */
    }
  };

  const resolveOutputLimit = (response) => {
    recordTextSegment(response.content, { keepWhenSuppressed: true });
    if (maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
      // The partial assistant turn must be visible to the model so it can
      // resume at the exact cutoff instead of reconstructing or repeating
      // it. askSession persists this natural recovery chain;
      // historyContent below prevents the aggregate returned to callers
      // from being persisted a second time.
      commitIntermediate(response);
      maxOutputRecoveryCount += 1;
      messages.push({
        role: 'user',
        content: MAX_OUTPUT_RESUME_PROMPT,
        meta: { source: 'max-output-recovery', attempt: maxOutputRecoveryCount },
      });
      return { action: 'continue', response };
    }
    const terminalSegment = `${response.content}\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`;
    return {
      action: 'break',
      response: {
        ...response,
        content: `${committedTextParts.slice(0, -1).join('')}${terminalSegment}`,
        historyContent: terminalSegment,
        maxOutputRecoveryAttempts: maxOutputRecoveryCount,
      },
    };
  };

  const resolveRefusal = (response, hasContent) => {
    if (refusalRetryUsed) {
      writeDiagnostic(
        `[loop] safety-classifier refusal persisted after one context-changing retry (sess=${sessionId || 'unknown'}); ending loop as refusal termination.\n`
      );
      return { action: 'break', response };
    }
    refusalRetryUsed = true;
    // A provider may emit harmless narration before its safety classifier
    // terminates the turn. Preserve that partial turn and its stop reason,
    // but never mistake the non-empty text for a successful completion.
    if (hasContent && commitIntermediate(response)) recordTextSegment(response.content);
    messages.push({
      role: 'user',
      content: REFUSAL_RECOVERY_PROMPT,
      meta: { source: 'refusal-recovery', attempt: 1 },
    });
    return { action: 'continue', response };
  };

  // The provider declared the assistant turn unfinished, so this text is
  // mid-turn output, not a final answer: commit it EXACTLY ONCE to history/UI
  // and resume sampling in the same user turn. Returns false when the
  // continuation is not honored (runaway cap, or nothing committable — a
  // re-send of an unchanged transcript would livelock), leaving the turn to
  // the terminal handling below.
  const resumeContinuation = (response, { iteration, signal, hasContent, stopReason }) => {
    if (continuationsSinceToolBatch >= PROVIDER_CONTINUATION_NO_TOOL_LIMIT) {
      writeDiagnostic(
        `[loop] provider continuation cap ${PROVIDER_CONTINUATION_NO_TOOL_LIMIT} reached without tool calls (sess=${sessionId || 'unknown'}); accepting current text as final.\n`
      );
      trace(iteration, 'steer', {
        tag: 'provider_continuation_no_tool_cap',
        count: continuationsSinceToolBatch,
      });
      return false;
    }
    if (!commitIntermediate(response)) return false;
    if (hasContent) recordTextSegment(response.content);
    providerContinuationCount += 1;
    continuationsSinceToolBatch += 1;
    emptyNudgeStreak = 0;
    trace(iteration, 'provider_continuation', {
      signal,
      stop_reason: stopReason,
      count: providerContinuationCount,
      content_len: typeof response.content === 'string' ? response.content.length : 0,
    });
    return true;
  };

  // The agent contract (rules/agent/AGENT.md) requires either a tool call
  // or final handoff text, so a public agent's empty turn is re-prompted with
  // a bounded contract nudge. Hidden roles are exempt: their own role rules
  // define a different output contract (pipe-separated chunker output, …) and
  // a text-only terminal turn is the correct shape — nudging them produces a
  // contradictory user message that traps the model in a tool-call-blocked vs
  // contract-required oscillation.
  const nudgeEmptyTurn = (response, { stopReason, isIncompleteStop }) => {
    emptyNudgeStreak += 1;
    if (emptyNudgeStreak > EMPTY_NUDGE_MAX) {
      // Livelock: identical nudges keep producing identical empty
      // completions. Stop re-prompting; classifyTerminationReason tags
      // this final empty response as 'empty' so the caller surfaces an
      // explicit error instead of a silent finish.
      writeDiagnostic(
        `[loop] empty-turn nudge cap ${EMPTY_NUDGE_MAX} reached (sess=${sessionId || 'unknown'}); ending loop as empty termination.\n`
      );
      return { action: 'break', response };
    }
    messages.push({
      role: 'user',
      content: isIncompleteStop
        ? `[mixdog-runtime] Empty truncated continuation (stopReason=${stopReason}). Return the remaining final handoff; use tools only for required evidence still missing.`
        : `[mixdog-runtime] Empty response (${emptyNudgeStreak}/${EMPTY_NUDGE_MAX}). Return final text, or use tools only for required evidence still missing.`,
    });
    return { action: 'continue', response };
  };

  // A no-tool message ends the turn. Unresolved tool failures remain visible
  // in history and can be reported directly without a synthetic continuation
  // turn. Earlier committed segments are re-prepended so the caller receives
  // the whole answer while history keeps only the terminal segment.
  const finishTurn = (response) => {
    if (committedTextParts.length === 0) return { action: 'break', response };
    const terminalSegment = typeof response.content === 'string' ? response.content : '';
    return {
      action: 'break',
      response: {
        ...response,
        content: `${committedTextParts.join('')}${terminalSegment}`,
        historyContent: terminalSegment,
        ...(maxOutputRecoveryCount > 0 ? { maxOutputRecoveryAttempts: maxOutputRecoveryCount } : {}),
      },
    };
  };

  return {
    // { action: 'continue' | 'break', response }. 'continue' means the
    // recovery appended to the transcript and the loop must re-send;
    // 'break' returns the (possibly aggregated) terminal response.
    resolve(response, iteration) {
      const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
      const stopReason = response.stopReason ?? response.stop_reason ?? null;
      const isOutputLimitStop = isOutputLimitStopReason(stopReason);
      if (hasContent && isOutputLimitStop) return resolveOutputLimit(response);
      if (stopReason === 'refusal') return resolveRefusal(response, hasContent);
      // Output-limit stops keep the bounded max-output ladder above and
      // refusals (already returned) keep the bounded refusal retry; both
      // own their own continuation semantics. No lexical/progress-text
      // heuristic is consulted.
      const continuationSignal = isOutputLimitStop ? null : providerContinuationSignal(response);
      if (
        continuationSignal &&
        resumeContinuation(response, { iteration, signal: continuationSignal, hasContent, stopReason })
      ) {
        return { action: 'continue', response };
      }
      if (!hasContent && !HIDDEN_AGENT_NAMES.has(sessionAgent)) {
        return nudgeEmptyTurn(response, {
          stopReason,
          isIncompleteStop: stopReason && INCOMPLETE_STOP_REASONS.has(stopReason),
        });
      }
      // Pending-input rule: queued user input is folded into
      // needs_follow_up before terminal completion. Commit the terminal
      // text first (beforeAppend), then resume.
      if (
        drainSteering('terminal', {
          maxPriority: 'next',
          beforeAppend: () => {
            if (commitIntermediate(response) && hasContent) recordTextSegment(response.content);
          },
        })
      ) {
        emptyNudgeStreak = 0;
        return { action: 'continue', response };
      }
      return finishTurn(response);
    },
    // A turn that produced tool calls is never an empty contract violation.
    noteToolCallTurn() {
      emptyNudgeStreak = 0;
    },
    // The UI sealed its streaming row at this tool boundary; earlier
    // committed parts must not re-prepend at terminal (duplicate rows).
    noteToolBatchCompleted() {
      continuationsSinceToolBatch = 0;
      committedTextParts.length = 0;
    },
    get providerContinuations() {
      return providerContinuationCount;
    },
  };
}
