/**
 * tool-phase.mjs — the tool half of an agent-loop round: surface mid-turn
 * text, commit the assistant turn, run the batch and record its timing.
 */
import { recordToolBatch } from '../../tools/tool-batch-trace.mjs';
import { buildToolCallAssistantMessage, commitAssistantMessage } from './assistant-commit.mjs';
import { traceLoopPhaseTiming } from './diagnostics.mjs';
import { processToolBatch } from '../tool-batch.mjs';
import { CROSS_TURN_CAP, REPEAT_FAIL_LIMIT } from './loop-state.mjs';

function isSleepLikeToolCall(call) {
  const name = String(call?.name || call?.toolName || call?.function?.name || '').toLowerCase();
  return name === 'sleep' || name.endsWith('/sleep') || name.endsWith('.sleep');
}

export async function runToolPhase(state, round, sent, onToolCall) {
  const { opts, messages, tools, sessionId, sessionRef, signal, response, suppressMidTurnText } = state;
  state.noToolTurn.noteToolCallTurn();
  const calls = response.toolCalls;
  state.toolCallsTotal += calls.length;
  // Surface any mid-turn assistant text (preamble before a tool call) to the
  // UI. Providers that stream via onTextDelta already rendered it; providers
  // that return text only in response.content would otherwise show nothing
  // before the tool card. The engine de-dups against already-streamed text.
  // Sub-agent sessions suppress it entirely — Lead only consumes the answer.
  if (!suppressMidTurnText && typeof response.content === 'string' && response.content.trim()) {
    try {
      opts.onAssistantText?.(response.content);
    } catch {
      /* best-effort */
    }
  }
  // Per-turn batch shape — one row per assistant turn so trace consumers can
  // derive the multi-tool adoption ratio without scanning message bodies.
  const toolBatchId = recordToolBatch(sessionId, calls, state.iterations);
  await Promise.resolve(onToolCall?.(state.iterations, calls));
  const assistantTurnMsg = buildToolCallAssistantMessage(response, { calls, suppressMidTurnText, opts });
  commitAssistantMessage(messages, assistantTurnMsg, opts);
  try {
    opts.onToolPhaseStarted?.();
  } catch {}
  const toolsT0 = Date.now();
  ({ dedupStubTotal: state.dedupStubTotal, editCount: state.editCount } = await processToolBatch({
    calls,
    messages,
    tools,
    cwd: state.cwd,
    sessionId,
    sessionRef,
    signal,
    opts,
    iterations: state.iterations,
    assistantTurnMsg,
    toolBatchId,
    pending: round.eager.pending,
    epoch: round.eager.epoch,
    startEagerRun: round.eager.startEagerRun,
    crossTurnCalls: state.crossTurnCalls,
    crossTurnCap: CROSS_TURN_CAP,
    dedupStubTotal: state.dedupStubTotal,
    editCount: state.editCount,
    sessionAgent: state.sessionAgent,
    pushToolResultMessage: state.pushToolResultMessage,
    throwIfAborted: state.throwIfAborted,
    repeatFailLimit: REPEAT_FAIL_LIMIT,
  }));
  const toolsEndedAt = Date.now();
  try {
    opts.onToolPhaseCompleted?.({
      iteration: round.nextIteration,
      calls: calls.length,
      elapsedMs: toolsEndedAt - toolsT0,
    });
  } catch {}
  traceLoopPhaseTiming({
    iteration: round.nextIteration,
    preSendMs: sent.preSendMs,
    sendMs: sent.sendEndedAt - sent.sendStartedAt,
    toolsMs: toolsEndedAt - toolsT0,
    calls: calls.length,
  });
  state.lastToolBatchEndedAt = toolsEndedAt;
  state.toolBatchJustCompleted = true;
  state.noToolTurn.noteToolBatchCompleted();
  state.lastToolBatchHadSleep = calls.some(isSleepLikeToolCall);
}
