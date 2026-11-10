/**
 * Recovery-only encrypted-reasoning replay policy (codex full-frame parity).
 *
 * The request body may carry retained `reasoning` items
 * (opts.replayEncryptedReasoning; default ON for openai-oauth, kill switch
 * MIXDOG_OAI_DISABLE_REASONING_REPLAY=1).
 *
 * They stay in the LOGICAL request history, always. The reference client never
 * removes reasoning from the history it chains on: its incremental-request
 * check proves the new request extends the exact previous request + response,
 * and only THEN does the delta builder drop those already-anchored items from
 * the wire tail. An rs_* item is therefore never sent twice on a live chain,
 * while a full frame — which carries no previous_response_id — still replays
 * retained reasoning instead of making the model re-reason the transcript.
 *
 * Removing reasoning HERE, before the delta computation, broke that proof: the
 * previous response's reasoning could no longer be matched against the request
 * prefix, so every reasoning-model session fell back to full frames from its
 * second call onward and lost previous_response_id with it.
 *
 * `suppress` is the rejection safety net only. Once the server rejects a
 * replayed rs_* item as a duplicate, the retry drops reasoning for the rest of
 * the send and the chain degrades to full frames, exactly as any broken chain
 * does.
 */
export function _applyReasoningReplayPolicy(entry, body, { suppress = false } = {}) {
  const input = Array.isArray(body?.input) ? body.input : null;
  if (!entry || !input) return body;
  if (!suppress) {
    entry.replayReasoning = true;
    return body;
  }
  entry.replayReasoning = false;
  if (!input.some((item) => item?.type === 'reasoning')) return body;
  return { ...body, input: input.filter((item) => item?.type !== 'reasoning') };
}
