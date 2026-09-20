import { isVisibleStreamProgress } from '../../../runtime/shared/stream-progress.mjs';

// The askSession callback bridge: caller callbacks pass through, with the
// transcript, first-visible timing, title release and warmup arming folded in.
export function createAskCallbacks({ transcript, notifyFnForSession, scheduleSearchRuntimeWarmup, hooks }) {
  function plannedToolCalls(session0, options) {
    return async (iter, calls) => {
      for (const call of calls || []) {
        hooks.emit('tool:planned', {
          sessionId: session0.id,
          name: call?.name || 'tool',
          callId: call?.id || null,
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

  function askCallbacks(turn, session0, options) {
    return {
      beforeToolExecution: () => turn.snapshot.promise || Promise.resolve(),
      transcriptMeta: options.transcriptMeta,
      promptSource: options.promptSource,
      retryFailedTurn: options.retryFailedTurn === true,
      onTextDelta: options.onTextDelta,
      onTextReset: options.onTextReset,
      onReasoningDelta: options.onReasoningDelta,
      onAssistantText: (text) => {
        transcript.appendAssistantText(text);
        return options.onAssistantText?.(text);
      },
      onUsageDelta: options.onUsageDelta,
      onAssistantToolCallObserved: options.onAssistantToolCallObserved,
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
      notifyFn: notifyFnForSession(session0.id),
      signal: turn.signal,
    };
  }

  return { askCallbacks, plannedToolCalls };
}
