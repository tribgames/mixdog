// manager/ask-turn-execute.mjs
// Running one turn against the provider: assemble the user turn and
// pre-commit it to the live session (prepareAskTurn), then drive agentLoop
// under the abort-aware wrapper with the caller's approval hook installed
// (runAskAgentLoop). Provider-not-available and trim failures throw here so
// the caller marks the session errored instead of leaving stage='connecting'.
import { getProvider } from '../../providers/registry.mjs';
import { prepareExplicitSkills } from '../explicit-skills.mjs';
import { prepareTurnEffortConfiguration } from '../../providers/effort-configuration.mjs';
import { saveSessionAsync } from '../store.mjs';
import { hasUserConversationMessage, refreshSessionBp3Environment } from './prompt-utils.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';
import { _getAgentLoop } from './runtime-loaders.mjs';
import { runAbortable, throwIfAborted } from '../../../../shared/abort-race.mjs';
import { applyTurnContextMeta, buildUserTurn, startProviderPrewarm, traceTurnContext } from './ask-turn-prepare.mjs';
import { rewindUnansweredPrompt } from './failed-turn-rewind.mjs';
import { buildAgentLoopOptions, trackedToolCallHook } from './ask-turn-loop-options.mjs';
import { _api_call_with_interrupt } from './ask-call-interrupt.mjs';

/** Resolves the provider, builds the user turn and pre-commits it; returns
 *  what the loop and the commit need from this preparation. */
export async function prepareAskTurn({ sessionId, opened, input, cwdOverride, transcriptMeta }) {
  const { turn, runtime, turnSignal, askGeneration, checkpoint, turnToken, startedAt, codexTurnId } = opened;
  const session = turn.session;
  const provider = getProvider(session.provider);
  // Register the live session object for synchronous close snapshots.
  runtime.session = session;
  if (!provider) throw new Error(`Provider "${session.provider}" not available`);
  const turnEffort = session.effort || null;
  const effortConfiguration = prepareTurnEffortConfiguration(session, provider);
  applyTurnContextMeta(session, provider);
  const effectiveCwd = cwdOverride || session.cwd;
  // A failed-turn retry resubmits the prompt the failure left unanswered;
  // rewind that copy so the model sees the prompt once (an answered tail is
  // kept and the retry continues from it).
  if (input.retryFailedTurn === true) rewindUnansweredPrompt(session, input.prompt);
  if (session.sessionStartMetaInjected !== true && !hasUserConversationMessage(session.messages)) {
    refreshSessionBp3Environment(session, effectiveCwd);
  }
  const startupProviderPrewarm = startProviderPrewarm({
    sessionId,
    session,
    provider,
    turnEffort,
    effortConfiguration,
    codexTurnId,
    startedAtMs: startedAt,
  });
  const userTurn = await buildUserTurn({
    session,
    prompt: input.prompt,
    context: input.context,
    explicitPrefetch: input.explicitPrefetch,
    turnSignal,
    transcriptMeta,
    turnPromptSource: input.promptSource,
    effortConfiguration,
  });
  const { historyMessages, outgoing } = userTurn;
  turn.userTurnContent = userTurn.userTurnMessage.content;
  turn.outgoing = outgoing;
  // Expose the in-flight working transcript so contextStatus() can
  // estimate the LIVE context footprint mid-turn. agentLoop mutates
  // `outgoing` in place (user turn + tool calls/results + compaction),
  // so the statusline context gauge climbs as the turn accumulates
  // tool output instead of freezing at the pre-turn snapshot. Cleared
  // on turn commit and in the ask finally.
  //
  // Also commit the user turn to the live session BEFORE the provider
  // call. Previously the prompt only reached session.messages after
  // agentLoop returned. If a worker/lead session was closed or aborted
  // before first response, closeSession() wrote a tombstone from the
  // still-system-only session and the handoff brief vanished forever
  // (agent row showed messages=2). Pre-committing makes cancellation,
  // close, and post-mortem files retain the exact user task; completion
  // overwrites this provisional transcript with the fully mutated
  // outgoing history and appends the assistant result, so no duplicate
  // user turn is introduced.
  session.messages = filterModelVisibleSessionMessages(outgoing);
  session.liveTurnMessages = outgoing;
  session.activeTurnCheckpoint = {
    version: 1,
    turnToken,
    startedAt,
  };
  // The sidecar lands synchronously before provider execution. Even
  // if the async canonical-session preflight save has not reached its
  // worker when the process is killed, recovery still has the prompt.
  checkpoint.schedule(true);
  saveSessionAsync(session, { expectedGeneration: askGeneration }).catch((err) => {
    try {
      process.stderr.write(`[session] preflight user-turn save failed: ${err?.message || err}\n`);
    } catch {}
  });
  traceTurnContext({
    sessionId,
    session,
    context: input.context,
    explicitPrefetchResult: userTurn.explicitPrefetchResult,
    prompt: input.prompt,
    userTurnContent: turn.userTurnContent,
    historyMessages,
  });
  if (startupProviderPrewarm) {
    try {
      await runAbortable(turnSignal, () => startupProviderPrewarm);
    } catch {
      throwIfAborted(turnSignal);
    }
  }
  return {
    provider,
    effectiveCwd,
    turnEffort,
    effortConfiguration,
    outgoing,
    beforeCount: historyMessages.length + 1,
    deferredToolDelta: userTurn.deferredToolDelta,
    goalReminder: userTurn.goalReminder,
  };
}

/** Runs agentLoop for the prepared turn and returns its result; the caller's
 *  tool-approval hook is installed for the call and restored afterwards. */
export async function runAskAgentLoop({
  sessionId,
  opened,
  prepared,
  input,
  askOpts,
  onToolCall,
  takeAssistantTranscriptMetadata,
}) {
  const { turn, turnSignal, interruption, checkpoint, codexTurnId, startedAt } = opened;
  const { provider, effectiveCwd, turnEffort, effortConfiguration, outgoing } = prepared;
  const session = turn.session;
  const agentLoop = await runAbortable(turnSignal, () => _getAgentLoop());
  const priorToolApprovalHook = session.toolApprovalHook;
  if (typeof askOpts?.onToolApproval === 'function') {
    session.toolApprovalHook = askOpts.onToolApproval;
  }
  try {
    if (!input.promptSource) {
      await prepareExplicitSkills(input.prompt, outgoing, session, { cwd: effectiveCwd, signal: turnSignal });
      session.messages = filterModelVisibleSessionMessages(outgoing);
      checkpoint.schedule(true);
    }
    return await _api_call_with_interrupt(sessionId, (signal) =>
      agentLoop(
        provider,
        outgoing,
        session.model,
        session.tools,
        trackedToolCallHook({ onToolCall, interruption, checkpoint }),
        effectiveCwd,
        buildAgentLoopOptions({
          sessionId,
          session,
          outgoing,
          turn,
          askOpts,
          onToolCall,
          interruption,
          checkpoint,
          turnEffort,
          effortConfiguration,
          codexTurnId,
          startedAtMs: startedAt,
          signal,
          takeAssistantTranscriptMetadata,
        })
      )
    );
  } finally {
    if (priorToolApprovalHook === undefined) {
      delete session.toolApprovalHook;
    } else {
      session.toolApprovalHook = priorToolApprovalHook;
    }
  }
}
