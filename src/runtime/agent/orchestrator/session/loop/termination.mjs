// Loop termination-reason classification.
// Pure functions over the final response + loop-end flags.
import { HIDDEN_AGENT_NAMES } from './hidden-agents.mjs';

// Stop reasons that signal the turn was cut short mid-synthesis. This broad set
// retains the pre-existing EMPTY-turn nudge semantics for provider pauses and
// unknown Gemini stops; only OUTPUT_LIMIT_STOP_REASONS below is eligible for
// non-empty continuation recovery.
export const INCOMPLETE_STOP_REASONS = new Set(['pause_turn', 'max_tokens', 'length', 'MAX_TOKENS', 'OTHER']);

// True provider output ceilings. pause_turn is a provider-controlled pause and
// Gemini OTHER is intentionally opaque; neither is safe to treat as a token-cap
// continuation. Compare case-insensitively so provider spelling variants do not
// create a second policy.
const OUTPUT_LIMIT_STOP_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);

export function isOutputLimitStopReason(reason) {
  return typeof reason === 'string' && OUTPUT_LIMIT_STOP_REASONS.has(reason.trim().toLowerCase());
}

// Provider-declared continuation signals. A response carrying one of these is
// NOT a completed assistant turn even when it holds final-looking text: the
// provider explicitly stated it intends to keep sampling inside the SAME user
// turn. Two structured shapes are honored:
//   - `endTurn === false` (Responses `end_turn=false` on the completed frame,
//     which means the turn needs a follow-up)
//   - Anthropic `stop_reason: 'pause_turn'` (server-side pause; the turn is
//     resumed by replaying the transcript unchanged)
// Structural only — no lexical/progress-text heuristic is consulted, and a
// provider that omits both fields is unaffected (returns null → terminal).
const CONTINUATION_STOP_REASONS = new Set(['pause_turn']);

export function providerContinuationSignal(response) {
  if (!response || typeof response !== 'object') return null;
  // Only an explicit boolean false continues; undefined/null/absent means
  // "provider did not signal" and keeps legacy terminal semantics.
  if (response.endTurn === false || response.end_turn === false) return 'end_turn_false';
  const stopReason = response.stopReason ?? response.stop_reason ?? null;
  if (typeof stopReason === 'string' && CONTINUATION_STOP_REASONS.has(stopReason.trim().toLowerCase())) {
    return 'pause_turn';
  }
  return null;
}

// Classify WHY the loop ended so agent-tool can promote an empty/abnormal
// finish to an explicit Lead-facing error instead of a silent empty
// "completed". Determine "has content" exactly the way the no-tool-call
// branch in agentLoop does (trimmed string content, or any reasoning content).
export function classifyTerminationReason(response, { sessionAgent } = {}) {
  const hasContent =
    (typeof response?.content === 'string' && response.content.trim().length > 0) ||
    (typeof response?.reasoningContent === 'string' && response.reasoningContent.trim().length > 0);
  const stopReason = response?.stopReason ?? response?.stop_reason ?? null;
  if (stopReason === 'refusal') {
    return 'refusal';
  }
  const incompleteStop = stopReason && INCOMPLETE_STOP_REASONS.has(stopReason);
  if (isOutputLimitStopReason(stopReason) || (!hasContent && incompleteStop)) {
    // Exhausted token-cap recovery is abnormal even with preserved partial
    // text. pause_turn/OTHER retain their prior non-empty completion
    // semantics, while their empty forms remain abnormal.
    return 'truncated';
  }
  if (!hasContent && !HIDDEN_AGENT_NAMES.has(sessionAgent)) {
    // Empty terminal turn. Only public agents violate their contract by
    // finishing empty — hidden agents (cycle/…) legitimately emit
    // text-only/empty terminal turns per their own role contract, so leave
    // terminationReason undefined for them.
    return 'empty';
  }
  return undefined;
}
