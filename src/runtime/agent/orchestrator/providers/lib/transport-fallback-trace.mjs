import { appendAgentTrace } from '../../agent-trace.mjs';

/** Best-effort trace of a dead stream re-issued as a non-streaming request. */
export function traceNonStreamingFallback({ provider, model, opts, streamErr }) {
  try {
    appendAgentTrace({
      sessionId: opts?.sessionId || opts?.session?.id || null,
      iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
      kind: 'transport_fallback',
      provider,
      model,
      transport: 'non-streaming',
      payload: {
        from: 'stream',
        to: 'non-streaming',
        reason: streamErr?.retryClassifier || streamErr?.code || streamErr?.message || 'stream_failed',
        error_code: streamErr?.code || null,
        error_http_status: Number(streamErr?.httpStatus || streamErr?.status || 0) || null,
        error_classifier: streamErr?.retryClassifier || streamErr?.midstreamClassifier || null,
      },
    });
  } catch {
    /* best-effort */
  }
}
