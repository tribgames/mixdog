/**
 * openai-ws-send-span.mjs — one compact timing row per logical WS send.
 *
 * The counters aggregate every handshake and mid-stream attempt of one
 * iteration, including warmup, without retaining request data. The frame
 * sender and the stream loop add to the same object (request build time,
 * pre-created and first-event gaps); `emit` publishes the row exactly once
 * and stamps the timing onto the result or error it is handed.
 */

export function createWsSendSpan({ sendOpts, traceProvider, useModel, poolKey, iteration, traceFn }) {
  const span = {
    admissionQueueWaitMs: Math.max(0, Number(sendOpts?._providerAdmission?.queueWaitMs) || 0),
    providerConcurrentRequests: Math.max(1, Number(sendOpts?._providerAdmission?.active) || 1),
    providerQueuedRequests: Math.max(0, Number(sendOpts?._providerAdmission?.queued) || 0),
    poolOwnerWaitMs: 0,
    poolAcquireMs: 0,
    requestBuildSerializationMs: 0,
    preResponseCreatedMs: 0,
    firstEventMs: 0,
    retryBackoffMs: 0,
    handshakeRetries: 0,
    acquireAttempts: 0,
    acquireMode: null,
    emitted: false,
    timing: null,
    emit(outcome, target = null) {
      if (span.emitted) {
        if (target && span.timing) {
          try {
            target.transportTiming = span.timing;
          } catch {}
        }
        return span.timing;
      }
      span.emitted = true;
      const socketAcquireMs = Math.max(0, span.poolAcquireMs - span.poolOwnerWaitMs);
      const timing = {
        transport: 'websocket',
        outcome,
        admissionQueueWaitMs: span.admissionQueueWaitMs,
        providerConcurrentRequests: span.providerConcurrentRequests,
        providerQueuedRequests: span.providerQueuedRequests,
        poolOwnerWaitMs: span.poolOwnerWaitMs,
        socketAcquireMs,
        poolAcquireMs: span.poolAcquireMs,
        requestBuildSerializationMs: span.requestBuildSerializationMs,
        preResponseCreatedMs: span.preResponseCreatedMs,
        providerFirstEventMs: span.firstEventMs,
        retryBackoffMs: span.retryBackoffMs,
        handshakeRetries: span.handshakeRetries,
        acquireAttempts: span.acquireAttempts,
        acquireMode: span.acquireMode || 'failed',
      };
      span.timing = timing;
      const payload = {
        provider: traceProvider,
        model: useModel,
        transport: 'websocket',
        admission_queue_wait_ms: timing.admissionQueueWaitMs,
        provider_concurrent_requests: timing.providerConcurrentRequests,
        provider_queued_requests: timing.providerQueuedRequests,
        pool_owner_wait_ms: timing.poolOwnerWaitMs,
        socket_acquire_ms: timing.socketAcquireMs,
        acquire_mode: span.acquireMode || 'failed',
        acquire_attempts: span.acquireAttempts,
        handshake_retries: span.handshakeRetries,
        pool_acquire_ms: span.poolAcquireMs,
        request_build_serialization_ms: span.requestBuildSerializationMs,
        pre_response_created_ms: span.preResponseCreatedMs,
        first_event_ms: span.firstEventMs,
        retry_backoff_ms: span.retryBackoffMs,
        outcome,
      };
      try {
        traceFn({
          sessionId: poolKey,
          iteration,
          kind: 'send_spans',
          ...payload,
          payload,
        });
      } catch {}
      if (target) {
        try {
          target.transportTiming = timing;
        } catch {}
      }
      return timing;
    },
  };
  return span;
}
