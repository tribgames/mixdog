import { isVisibleStreamProgress } from '../../../runtime/shared/stream-progress.mjs';
import { toolCallDisplayIdentity } from '../../../runtime/shared/tool-primitives.mjs';

// The askSession callback bridge: caller callbacks pass through, with the
// transcript, first-visible timing, title release and warmup arming folded in.
export function createAskCallbacks({ transcript, notifyFnForSession, scheduleSearchRuntimeWarmup, hooks }) {
  function plannedToolCalls(session0, options) {
    return async (iter, calls) => {
      for (const call of calls || []) {
        // A bridged call reports the tool it runs; the transcript keeps the wire call.
        const identity = toolCallDisplayIdentity(call?.name, call?.arguments);
        hooks.emit('tool:planned', {
          sessionId: session0.id,
          name: identity.name || 'tool',
          callId: call?.id || null,
          ...(identity.via ? { via: identity.via } : {}),
        });
      }
      if (typeof options.onToolCall === 'function') {
        return await options.onToolCall(iter, calls);
      }
      return undefined;
    };
  }

  // Emitted immediately before provider.send, after session locking, history
  // shaping and pre-send compact — so Mixdog's own preflight work is not
  // mislabeled as provider latency. The two small native helpers warm only
  // once provider.send owns the request, overlapping network/model time.
  function providerSendStarted(timing, options) {
    return (...args) => {
      if (!timing.providerStartedAt) {
        timing.providerStartedAt = performance.now();
        try {
          scheduleSearchRuntimeWarmup?.(0);
        } catch {
          /* best-effort */
        }
      }
      return options.onProviderSendStarted?.(...args);
    };
  }

  function streamDelta(turn, options) {
    const { timing } = turn;
    return (...args) => {
      let value;
      try {
        value = options.onStreamDelta?.(...args);
      } finally {
        if (isVisibleStreamProgress(args[0])) {
          turn.releaseFirstTitle?.();
          timing.status = 'first-visible';
          turn.emitTiming(timing.status);
          turn.armHeavyRuntimeWarmup('first-visible');
        }
      }
      return value;
    };
  }

  // The turn's change-record key rides the caller's transcript metadata (in
  // place: the stream stamps assistantAt on this same object), so the
  // persisted user row and completion carry it across restore. A merged
  // batch also names every submission it delivers, so a queued-input restore
  // can tell each one delivered.
  function stampCheckpoint(options) {
    const meta = options.transcriptMeta;
    if (!meta || typeof meta !== 'object') return meta;
    const checkpointId = String(options.id || '').trim();
    if (checkpointId) meta.checkpointId = checkpointId;
    if (Array.isArray(options.submissionIds) && options.submissionIds.length > 1) {
      meta.submissionIds = options.submissionIds.map(String);
    }
    return meta;
  }

  function askCallbacks(turn, session0, options) {
    return {
      beforeToolExecution: () => turn.snapshot.promise || Promise.resolve(),
      transcriptMeta: stampCheckpoint(options),
      promptSource: options.promptSource,
      // A routine turn's trusted selection text (its instructions only).
      ...(typeof options.skillSelection === 'string' ? { skillSelection: options.skillSelection } : {}),
      retryFailedTurn: options.retryFailedTurn === true,
      retryTurnId: options.retryTurnId,
      retryAttemptId: options.retryAttemptId,
      onTextDelta: options.onTextDelta,
      onTextReset: options.onTextReset,
      onReasoningDelta: options.onReasoningDelta,
      onAssistantText: (text, detail) => {
        transcript.appendAssistantText(text);
        return options.onAssistantText?.(text, detail);
      },
      onUsageDelta: options.onUsageDelta,
      onAssistantToolCallObserved: options.onAssistantToolCallObserved,
      onStreamItemStart: options.onStreamItemStart,
      onToolResult: (message) => options.onToolResult?.(message),
      onToolApproval: options.onToolApproval,
      onCompactEvent: options.onCompactEvent,
      onContextPressure: options.onContextPressure,
      onStageChange: options.onStageChange,
      onProviderSendStarted: providerSendStarted(turn.timing, options),
      onToolPhaseStarted: options.onToolPhaseStarted,
      onToolPhaseCompleted: options.onToolPhaseCompleted,
      onStreamDelta: streamDelta(turn, options),
      drainSteering: options.drainSteering,
      onSteerMessage: options.onSteerMessage,
      onSkillsApplied: options.onSkillsApplied,
      notifyFn: notifyFnForSession(session0.id),
      signal: turn.signal,
    };
  }

  return { askCallbacks, plannedToolCalls };
}
