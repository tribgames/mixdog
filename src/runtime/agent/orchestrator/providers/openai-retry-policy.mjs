// OpenAI retry schedule: 200ms base, factor 2, ±10%.
// Provider-owned values; the shared retry core only takes them as options.
//   CODEX_STREAM_BACKOFF_MS        — indexed by the 1-based retry number
//                                    (midstreamBackoffFor).
//   CODEX_REQUEST_RETRY_BACKOFF_MS — leading duplicate for withRetry's
//                                    sleep-before-attempt index.
export const CODEX_STREAM_BACKOFF_MS = Object.freeze([200, 400, 800, 1600, 3200]);
export const CODEX_REQUEST_RETRY_BACKOFF_MS = Object.freeze([200, ...CODEX_STREAM_BACKOFF_MS]);
export const CODEX_RETRY_JITTER_RATIO = 0.1;
