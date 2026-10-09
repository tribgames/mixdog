/**
 * openai-startup-prewarm.mjs — helpers for the openai-oauth session-startup
 * WebSocket prewarm.
 *
 * The prewarm is connection-only: it opens (or confirms) a pooled socket for
 * the session and releases it back to the pool, where the first turn picks it
 * up. Nothing is reserved. The in-flight registry stays a provider field
 * (OpenAIOAuthProvider._startupPrewarmByPoolKey).
 */
import { appendAgentTrace } from '../agent-trace.mjs';

/** Prewarm telemetry is best-effort: tracing must never fail a prewarm. */
export function traceStartupPrewarm(poolKey, payload) {
  try {
    appendAgentTrace({
      sessionId: poolKey,
      kind: 'spawn_ws_prewarm',
      provider: 'openai-oauth',
      transport: 'websocket',
      payload,
    });
  } catch {}
}

/**
 * Drop an in-flight prewarm's bookkeeping, but only while it is still the
 * current one: a later prewarm for the same session owns the slot from the
 * moment it registers.
 */
export function retireStartupPrewarmRecord(inFlight, poolKey, record) {
  if (inFlight.get(poolKey) === record) inFlight.delete(poolKey);
}
